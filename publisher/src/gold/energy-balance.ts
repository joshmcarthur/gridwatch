import { existsSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { lit, type PublishResult } from "../silver/common.ts";
import { periodsInTradingDate, periodToUtc } from "../trading-time.ts";
import {
  dayTermSql,
  type GoldInput,
  type GoldPublishOptions,
  goldDataset,
  goldPartitionPath,
  goldStamp,
  ISLANDS,
  inputFingerprint,
  inputStatusesComplete,
  islandLiterals,
  islandsValuesSql,
  writeGoldTables,
} from "./common.ts";

/**
 * Bump by hand when the logic of any table in this file changes. The runner then rebuilds every
 * date (ADR-0011).
 */
export const ANALYSIS_VERSION = 1;

/** The gold tables of this module. The first is the sentinel: the runner reads it and it is written last. */
export const TABLES = ["energy_balance_period", "energy_balance_day"] as const;

const GENERATION: GoldInput = {
  table: "generation_by_fuel_period",
  layer: "gold",
  versionColumn: "inputs_sha256",
  completenessDataset: null,
};
const HVDC: GoldInput = {
  table: "hvdc_transfer_period",
  layer: "gold",
  versionColumn: "inputs_sha256",
  completenessDataset: null,
};
const LOAD: GoldInput = {
  table: "grid_load_period",
  layer: "gold",
  versionColumn: "inputs_sha256",
  completenessDataset: null,
};
export const INPUTS: GoldInput[] = [GENERATION, HVDC, LOAD];

/** The residual of an island: generation + HVDC import - load. Null when any term is null. */
const RESIDUAL = "generation_mwh + hvdc_import_mwh - load_mwh";
const PERCENT = "residual_mwh / nullif(load_mwh, 0) * 100";

/** Energy the island receives over the link. Exhaustive over `ISLANDS`; no `ELSE`. */
const hvdcImportSql = (islandExpr: string) =>
  `CASE ${ISLANDS.map((island) => {
    switch (island) {
      case "NI":
        return `WHEN ${islandExpr} = 'NI' THEN h.north_island_received_mwh`;
      case "SI":
        return `WHEN ${islandExpr} = 'SI' THEN -h.south_island_sent_mwh`;
      default: {
        const unreachable: never = island;
        return unreachable;
      }
    }
  }).join(" ")} END`;

/**
 * Publish the energy balance of each island for one trading date (ADR-0018):
 * `<goldDir>/energy_balance_period/trading_date=<date>/data.parquet` and
 * `<goldDir>/energy_balance_day/trading_date=<date>/data.parquet` (ADR-0011).
 *
 * Inputs are three gold tables: `generation_by_fuel_period`, `hvdc_transfer_period` and
 * `grid_load_period`. The registry order is the DAG (ADR-0011). This module joins those tables
 * and subtracts. It does not read silver.
 *
 * Every period and island has a row. The island is `NI` or `SI`. The terms, all in MWh:
 * - `generation_mwh`: `generation_by_fuel_period` summed over the fuels of the island, battery
 *   included. Null when the island has no row in the period. It is not 0.
 * - `hvdc_import_mwh`: the energy that the island receives over the link. `NI` is
 *   `north_island_received_mwh`. `SI` is `-south_island_sent_mwh`. The sign holds in both
 *   directions. The link loss is `-(NI import + SI import)`, which equals `losses_mwh` of
 *   `hvdc_transfer_period`. So the NI residual and the SI residual add up to national generation,
 *   minus load, minus link losses.
 * - `load_mwh` and `load_intervals`: grid load (modelled) from `grid_load_period`. Not metered
 *   consumption. Null when the island has no load in the period. It is not 0.
 * - `residual_mwh` = generation + HVDC import - load. Null when any term is null. It is never
 *   adjusted, clamped or spread. It holds transmission losses, the gap between RTD model load and
 *   metered generation, generation that Generation_MD omits and RTD dispatches, and embedded
 *   generation that is counted twice. `residual_pct_of_load` is the residual over the load, in
 *   percent.
 *
 * The day table sums the periods. A day term is the sum only when every period has the term
 * (46, 48 or 50 periods). Otherwise it is null, because a partial sum would give a false residual.
 * The day residual is built from the day terms.
 *
 * `inputs_complete` of a period row is true only when all of these hold:
 * - every generation row of the period has `inputs_complete`, and the HVDC and grid-load rows
 *   have it;
 * - no generation lacks an island. That energy goes to neither row and flags every row of the
 *   date;
 * - the residual is not null.
 * The day row is true only when every period row of the island is true.
 *
 * Missing (nothing written): an input has no partition for the date. With no `hvdc_transfer_period`
 * partition the date is not wanted at all, so the energy balance has the month lag of HVDC_Flows.
 * Repeatable: no `processed_at`. A total `ORDER BY` and one thread make the same inputs give the
 * same bytes.
 */
export async function publishEnergyBalance(
  options: GoldPublishOptions,
): Promise<PublishResult> {
  const { silverDir, goldDir, completeness: view, date } = options;
  const files = {
    generation: goldPartitionPath(goldDir, GENERATION.table, date),
    hvdc: goldPartitionPath(goldDir, HVDC.table, date),
    load: goldPartitionPath(goldDir, LOAD.table, date),
  };
  if (!Object.values(files).every((file) => existsSync(file)))
    return { date, status: "missing" };

  const periods = periodsInTradingDate(date);
  const statusOk = inputStatusesComplete(view, INPUTS, date);
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    await connection.run("SET threads = 1");

    await connection.run(
      `CREATE TEMP TABLE generation_by_period AS
       SELECT trading_period, island, sum(megawatt_hours) AS generation_mwh
       FROM read_parquet(${lit(files.generation)}) WHERE island IN (${islandLiterals().join(", ")})
       GROUP BY trading_period, island`,
    );

    // Energy with no island goes to neither row. It flags the date. Load mapping is on grid_load.
    const [unmapped] = (
      await connection.runAndReadAll(
        `SELECT count(*) AS n FROM read_parquet(${lit(files.generation)})
         WHERE island IS NULL AND coalesce(megawatt_hours, 0) <> 0`,
      )
    ).getRowObjectsJson() as Array<{ n: string }>;
    const islandsOk = Number(unmapped?.n) === 0;

    const spans = Array.from({ length: periods }, (_, i) => {
      const span = periodToUtc(date, i + 1);
      return `(${i + 1}, ${lit(span.eventStartUtc.toString())}::TIMESTAMPTZ, ${lit(span.eventEndUtc.toString())}::TIMESTAMPTZ)`;
    }).join(", ");
    const fingerprint = await inputFingerprint(
      silverDir,
      goldDir,
      ANALYSIS_VERSION,
      INPUTS,
      view,
      date,
    );
    const importSql = hvdcImportSql("isl.island");
    await connection.run(
      `CREATE TEMP TABLE balance AS
       SELECT trading_date, trading_period, event_start_utc, event_end_utc, island,
         generation_mwh, hvdc_import_mwh, load_mwh, load_intervals,
         ${RESIDUAL} AS residual_mwh,
         ${statusOk} AND ${islandsOk} AND terms_ok
           AND (${RESIDUAL}) IS NOT NULL AS period_complete
       FROM (
         SELECT DATE ${lit(date)} AS trading_date, s.trading_period, s.event_start_utc,
           s.event_end_utc, isl.island, g.generation_mwh,
           ${importSql} AS hvdc_import_mwh,
           l.load_mwh, coalesce(l.load_intervals, 0)::INTEGER AS load_intervals,
           coalesce(gk.ok, false) AND coalesce(h.inputs_complete, false)
             AND coalesce(l.inputs_complete, false) AS terms_ok
         FROM (VALUES ${spans}) s(trading_period, event_start_utc, event_end_utc)
         CROSS JOIN ${islandsValuesSql()} isl(island)
         LEFT JOIN generation_by_period g
           ON g.trading_period = s.trading_period AND g.island = isl.island
         LEFT JOIN (
           SELECT trading_period, bool_and(inputs_complete) AS ok
           FROM read_parquet(${lit(files.generation)}) GROUP BY trading_period
         ) gk ON gk.trading_period = s.trading_period
         LEFT JOIN read_parquet(${lit(files.hvdc)}) h ON h.trading_period = s.trading_period
         LEFT JOIN read_parquet(${lit(files.load)}) l
           ON l.trading_period = s.trading_period AND l.island = isl.island)`,
    );

    const complete = (
      (
        await connection.runAndReadAll(
          "SELECT bool_and(period_complete) AS ok FROM balance",
        )
      ).getRowObjectsJson() as Array<{ ok: boolean }>
    )[0]?.ok;
    const missingPeriods = (
      (
        await connection.runAndReadAll(
          `SELECT DISTINCT trading_period FROM balance
           WHERE residual_mwh IS NULL ORDER BY trading_period`,
        )
      ).getRowObjectsJson() as Array<{ trading_period: string }>
    ).map((row) => Number(row.trading_period));

    const dayTerm = (column: string) => dayTermSql(column, periods);
    const selects: Record<(typeof TABLES)[number], string> = {
      energy_balance_period: `SELECT trading_date, trading_period, event_start_utc, event_end_utc,
          island, generation_mwh, hvdc_import_mwh, load_mwh, load_intervals, residual_mwh,
          ${PERCENT} AS residual_pct_of_load,
          ${goldStamp(ANALYSIS_VERSION, fingerprint, "period_complete")}
        FROM balance ORDER BY trading_period, island`,
      energy_balance_day: `SELECT trading_date, island, generation_mwh, hvdc_import_mwh, load_mwh,
          ${RESIDUAL} AS residual_mwh, ${PERCENT} AS residual_pct_of_load,
          ${goldStamp(ANALYSIS_VERSION, fingerprint, "day_complete")}
        FROM (
          SELECT trading_date, island, ${dayTerm("generation_mwh")},
            ${dayTerm("hvdc_import_mwh")}, ${dayTerm("load_mwh")},
            bool_and(period_complete) AS day_complete
          FROM balance GROUP BY trading_date, island)
        ORDER BY island`,
    };

    await writeGoldTables(
      connection,
      TABLES.map((table) => [table, selects[table]] as const),
      goldDir,
      date,
    );
    const path = goldPartitionPath(goldDir, TABLES[0], date);
    const [count] = (
      await connection.runAndReadAll(
        `SELECT count(*) AS n FROM read_parquet(${lit(path)})`,
      )
    ).getRowObjectsJson() as Array<{ n: string }>;
    const rows = Number(count?.n);
    return complete
      ? { date, status: "complete", rows, path }
      : { date, status: "partial", rows, path, missingPeriods };
  } finally {
    connection.closeSync();
  }
}

export const energyBalance = goldDataset({
  id: "gold_energy_balance",
  tables: TABLES,
  inputs: INPUTS,
  analysisVersion: ANALYSIS_VERSION,
  publish: publishEnergyBalance,
});

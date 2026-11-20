import { existsSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { lit, type PublishResult } from "../silver/common.ts";
import { periodsInTradingDate, periodToUtc } from "../trading-time.ts";
import {
  type GoldInput,
  type GoldPublishOptions,
  goldDataset,
  goldPartitionPath,
  goldStamp,
  inputFingerprint,
  inputStatusesComplete,
  silverPartitionPath,
  writeGoldTables,
} from "./common.ts";

/**
 * Bump by hand when the logic of any table in this file changes. The runner then rebuilds every
 * date (ADR-0011).
 */
export const ANALYSIS_VERSION = 1;

/** The gold tables of this module. The first is the sentinel: the runner reads it and it is written last. */
export const TABLES = ["energy_balance_period", "energy_balance_day"] as const;

/** Two gold inputs (ADR-0018). They have no `_completeness` row, and their fingerprints carry their own inputs. */
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
const NODAL: GoldInput = {
  table: "nodal_prices_and_volumes",
  versionColumn: "bronze_sha256",
  completenessDataset: "nodal_prices_and_volumes",
};
const POINTS_OF_CONNECTION: GoldInput = {
  table: "entity_points_of_connection",
  versionColumn: "inputs_sha256",
  completenessDataset: "entity_mappings",
};
export const INPUTS: GoldInput[] = [
  GENERATION,
  HVDC,
  NODAL,
  POINTS_OF_CONNECTION,
];

/** The residual of an island: generation + HVDC import - load. Null when any term is null. */
const RESIDUAL = "generation_mwh + hvdc_import_mwh - load_mwh";
const PERCENT = "residual_mwh / nullif(load_mwh, 0) * 100";

/**
 * Publish the energy balance of each island for one trading date (ADR-0018):
 * `<goldDir>/energy_balance_period/trading_date=<date>/data.parquet` and
 * `<goldDir>/energy_balance_day/trading_date=<date>/data.parquet` (ADR-0011).
 *
 * Every period and island has a row. The island is `NI` or `SI`. The terms, all in MWh:
 * - `generation_mwh`: `generation_by_fuel_period` summed over the fuels of the island, battery
 *   included. Null when the island has no row in the period. It is not 0.
 * - `hvdc_import_mwh`: the energy that the island receives over the link. `NI` is
 *   `north_island_received_mwh`. `SI` is `-south_island_sent_mwh`. The sign holds in both
 *   directions. The link loss is `-(NI import + SI import)`, which equals `losses_mwh` of
 *   `hvdc_transfer_period`. So the NI residual and the SI residual add up to national generation,
 *   minus load, minus link losses.
 * - `load_mwh`: grid load (modelled), not metered consumption. It is the sum of `load_megawatts`
 *   over ALL nodal rows of the island: point of connection rows and unit rows (the unit rows carry
 *   battery and dispatchable load). For each 5-minute interval the latest RTD case is used. The
 *   case is chosen by `event_start_utc` (UTC, never local time, because the repeated hour of a
 *   DST-end day shares local times), then by `source_run_at` and `case_id`, both descending.
 *   The period load is the mean of the interval MW over the intervals that exist, times 0.5 hours.
 *   Every period is 30 minutes, also on a DST day. A period is not required to have 6 intervals,
 *   because the source omits some. A period with no interval has null load.
 * - The island of load is `island` of `entity_points_of_connection`. A point of connection that is
 *   not in that table takes the `Island` string of the nodal row (`North Island` or
 *   `South Island`).
 * - `residual_mwh` = generation + HVDC import - load. Null when any term is null. It is never
 *   adjusted, clamped or spread. It holds transmission losses, the gap between RTD model load and metered
 *   generation, generation that Generation_MD omits and RTD dispatches, and embedded generation
 *   that is counted twice. `residual_pct_of_load` is the residual over the load, in percent.
 *
 * The day table sums the periods. A day term is the sum only when every period has the term
 * (46, 48 or 50 periods). Otherwise it is null, because a partial sum would give a false residual.
 * The day residual is built from the day terms.
 *
 * `inputs_complete` of a period row is true only when all of these hold:
 * - every generation row of the period has `inputs_complete`, and the HVDC row has it;
 * - the `_completeness` status of `nodal_prices_and_volumes` and `entity_mappings` is `complete`;
 * - the period has at least one RTD interval;
 * - no energy lacks an island (load with no island, or generation with a null island). That energy
 *   goes to neither row and flags every row of the date;
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
    nodal: silverPartitionPath(silverDir, NODAL.table, date),
    poc: silverPartitionPath(silverDir, POINTS_OF_CONNECTION.table, date),
  };
  if (!Object.values(files).every((file) => existsSync(file)))
    return { date, status: "missing" };

  const periods = periodsInTradingDate(date);
  const statusOk = inputStatusesComplete(view, INPUTS, date);
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    await connection.run("SET threads = 1");

    // The latest RTD case of each interval, then the load of each island and interval.
    await connection.run(
      `CREATE TEMP TABLE nodal_rows AS
       SELECT n.trading_period, n.event_start_utc, n.load_megawatts,
         coalesce(poc.island,
           CASE n.island WHEN 'North Island' THEN 'NI' WHEN 'South Island' THEN 'SI' END) AS island
       FROM read_parquet(${lit(files.nodal)}) n
       JOIN (
         SELECT event_start_utc, case_id FROM (
           SELECT DISTINCT event_start_utc, source_run_at, case_id
           FROM read_parquet(${lit(files.nodal)}) WHERE case_type = 'RTD')
         QUALIFY row_number() OVER (
           PARTITION BY event_start_utc
           ORDER BY source_run_at DESC NULLS LAST, case_id DESC) = 1
       ) latest ON latest.event_start_utc = n.event_start_utc AND latest.case_id = n.case_id
       LEFT JOIN read_parquet(${lit(files.poc)}) poc ON poc.poc_id = n.point_of_connection
       WHERE n.case_type = 'RTD'`,
    );
    await connection.run(
      `CREATE TEMP TABLE load_by_period AS
       SELECT trading_period, island, avg(mw) * 0.5 AS load_mwh, count(*) AS load_intervals
       FROM (
         SELECT i.trading_period, i.event_start_utc, isl.island,
           coalesce(sum(r.load_megawatts), 0) AS mw
         FROM (SELECT DISTINCT trading_period, event_start_utc FROM nodal_rows) i
         CROSS JOIN (VALUES ('NI'), ('SI')) isl(island)
         LEFT JOIN nodal_rows r
           ON r.event_start_utc = i.event_start_utc AND r.island = isl.island
         GROUP BY i.trading_period, i.event_start_utc, isl.island)
       GROUP BY trading_period, island`,
    );
    await connection.run(
      `CREATE TEMP TABLE generation_by_period AS
       SELECT trading_period, island, sum(megawatt_hours) AS generation_mwh
       FROM read_parquet(${lit(files.generation)}) WHERE island IN ('NI', 'SI')
       GROUP BY trading_period, island`,
    );

    // Energy with no island goes to neither row. It flags the date.
    const [unmapped] = (
      await connection.runAndReadAll(
        `SELECT
           (SELECT count(*) FROM nodal_rows
            WHERE island IS NULL AND coalesce(load_megawatts, 0) <> 0)
           + (SELECT count(*) FROM read_parquet(${lit(files.generation)})
              WHERE island IS NULL AND coalesce(megawatt_hours, 0) <> 0) AS n`,
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
    // One row for each period and island. `terms_ok` is the upstream flags and the interval rule.
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
           CASE isl.island WHEN 'NI' THEN h.north_island_received_mwh
             ELSE -h.south_island_sent_mwh END AS hvdc_import_mwh,
           l.load_mwh, coalesce(l.load_intervals, 0)::INTEGER AS load_intervals,
           coalesce(gk.ok, false) AND coalesce(h.inputs_complete, false)
             AND coalesce(l.load_intervals, 0) > 0 AS terms_ok
         FROM (VALUES ${spans}) s(trading_period, event_start_utc, event_end_utc)
         CROSS JOIN (VALUES ('NI'), ('SI')) isl(island)
         LEFT JOIN generation_by_period g
           ON g.trading_period = s.trading_period AND g.island = isl.island
         LEFT JOIN (
           SELECT trading_period, bool_and(inputs_complete) AS ok
           FROM read_parquet(${lit(files.generation)}) GROUP BY trading_period
         ) gk ON gk.trading_period = s.trading_period
         LEFT JOIN read_parquet(${lit(files.hvdc)}) h ON h.trading_period = s.trading_period
         LEFT JOIN load_by_period l
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

    const dayTerm = (column: string) =>
      `CASE WHEN count(${column}) = ${periods} THEN sum(${column}) END AS ${column}`;
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

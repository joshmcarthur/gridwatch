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
  inputFingerprint,
  inputStatusesComplete,
  islandLiterals,
  islandsValuesSql,
  latestRtdCaseSql,
  silverPartitionPath,
  writeGoldTables,
} from "./common.ts";

/**
 * Bump by hand when the logic of any table in this file changes. The runner then rebuilds every
 * date (ADR-0011).
 */
export const ANALYSIS_VERSION = 1;

/** The gold tables of this module. The first is the sentinel: the runner reads it and it is written last. */
export const TABLES = ["grid_load_period", "grid_load_day"] as const;

const NODAL: GoldInput = {
  table: "nodal_prices_and_volumes",
  layer: "silver",
  versionColumn: "bronze_sha256",
  completenessDataset: "nodal_prices_and_volumes",
};
const POINTS_OF_CONNECTION: GoldInput = {
  table: "entity_points_of_connection",
  layer: "silver",
  versionColumn: "inputs_sha256",
  completenessDataset: "entity_mappings",
};
export const INPUTS: GoldInput[] = [NODAL, POINTS_OF_CONNECTION];

/**
 * Publish grid load (modelled) for each island for one trading date (ADR-0018):
 * `<goldDir>/grid_load_period/trading_date=<date>/data.parquet` and
 * `<goldDir>/grid_load_day/trading_date=<date>/data.parquet` (ADR-0011).
 *
 * Inputs: silver `nodal_prices_and_volumes` and silver `entity_points_of_connection` only.
 *
 * **Grid load (modelled)** is the RTD model load at grid exit points, net of embedded generation
 * behind them, plus dispatchable and battery load. It is not metered consumption. Docs and site
 * copy must not call it "consumption".
 *
 * Every period and island has a row. The island is `NI` or `SI`.
 * - `load_mwh`: the sum of `load_megawatts` over ALL nodal rows of the island: point of connection
 *   rows and unit rows (the unit rows carry battery and dispatchable load). For each 5-minute
 *   interval the latest RTD case is used. The case is chosen by `event_start_utc` (UTC, never
 *   local time, because the repeated hour of a DST-end day shares local times), then by
 *   `source_run_at` and `case_id`, both descending. The period load is the mean of the interval MW
 *   over the intervals that exist for that island, times 0.5 hours. Every period is 30 minutes,
 *   also on a DST day. A period is not required to have 6 intervals, because the source omits
 *   some. A period with no interval for the island has null load. It is not 0.
 * - The island is `island` of `entity_points_of_connection` only. The nodal `Island` string is not
 *   a fallback. Load that has no island, or an island other than `NI` or `SI`, goes to neither
 *   row and sets `inputs_complete = false` on every row of the date.
 *
 * The day table sums the periods. A day load is the sum only when every period has the term
 * (46, 48 or 50 periods). Otherwise it is null.
 *
 * `inputs_complete` of a period row is true only when all of these hold:
 * - the `_completeness` status of `nodal_prices_and_volumes` and `entity_mappings` is `complete`;
 * - the period has at least one RTD interval for the island;
 * - no load lacks an island (or has an island other than `NI` or `SI`). That energy goes to
 *   neither row and flags every row of the date;
 * - the load is not null.
 * The day row is true only when every period row of the island is true.
 *
 * Missing (nothing written): an input has no partition for the date.
 * Repeatable: no `processed_at`. A total `ORDER BY` and one thread make the same inputs give the
 * same bytes.
 */
export async function publishGridLoad(
  options: GoldPublishOptions,
): Promise<PublishResult> {
  const { silverDir, goldDir, completeness: view, date } = options;
  const files = {
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

    const niSi = islandLiterals().join(", ");
    // The latest RTD case of each interval, then the load of each island and interval.
    await connection.run(
      `CREATE TEMP TABLE nodal_rows AS
       SELECT n.trading_period, n.event_start_utc, n.load_megawatts, poc.island AS island
       FROM read_parquet(${lit(files.nodal)}) n
       JOIN (
         ${latestRtdCaseSql(files.nodal)}
       ) latest ON latest.event_start_utc = n.event_start_utc AND latest.case_id = n.case_id
       LEFT JOIN read_parquet(${lit(files.poc)}) poc ON poc.poc_id = n.point_of_connection
       WHERE n.case_type = 'RTD'`,
    );
    await connection.run(
      `CREATE TEMP TABLE load_by_period AS
       SELECT trading_period, island, avg(mw) * 0.5 AS load_mwh, count(*) AS load_intervals
       FROM (
         SELECT trading_period, event_start_utc, island, sum(load_megawatts) AS mw
         FROM nodal_rows
         WHERE island IN (${niSi})
         GROUP BY trading_period, event_start_utc, island)
       GROUP BY trading_period, island`,
    );

    // Load with no island, or an island other than NI/SI, goes to neither row. It flags the date.
    const [unmapped] = (
      await connection.runAndReadAll(
        `SELECT count(*) AS n FROM nodal_rows
         WHERE (island IS NULL OR island NOT IN (${niSi}))
           AND coalesce(load_megawatts, 0) <> 0`,
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
    await connection.run(
      `CREATE TEMP TABLE load AS
       SELECT trading_date, trading_period, event_start_utc, event_end_utc, island,
         load_mwh, load_intervals,
         ${statusOk} AND ${islandsOk} AND coalesce(load_intervals, 0) > 0
           AND load_mwh IS NOT NULL AS period_complete
       FROM (
         SELECT DATE ${lit(date)} AS trading_date, s.trading_period, s.event_start_utc,
           s.event_end_utc, isl.island, l.load_mwh,
           coalesce(l.load_intervals, 0)::INTEGER AS load_intervals
         FROM (VALUES ${spans}) s(trading_period, event_start_utc, event_end_utc)
         CROSS JOIN ${islandsValuesSql()} isl(island)
         LEFT JOIN load_by_period l
           ON l.trading_period = s.trading_period AND l.island = isl.island)`,
    );

    const complete = (
      (
        await connection.runAndReadAll(
          "SELECT bool_and(period_complete) AS ok FROM load",
        )
      ).getRowObjectsJson() as Array<{ ok: boolean }>
    )[0]?.ok;
    const missingPeriods = (
      (
        await connection.runAndReadAll(
          `SELECT DISTINCT trading_period FROM load
           WHERE load_mwh IS NULL ORDER BY trading_period`,
        )
      ).getRowObjectsJson() as Array<{ trading_period: string }>
    ).map((row) => Number(row.trading_period));

    const dayTerm = (column: string) => dayTermSql(column, periods);
    const selects: Record<(typeof TABLES)[number], string> = {
      grid_load_period: `SELECT trading_date, trading_period, event_start_utc, event_end_utc,
          island, load_mwh, load_intervals,
          ${goldStamp(ANALYSIS_VERSION, fingerprint, "period_complete")}
        FROM load ORDER BY trading_period, island`,
      grid_load_day: `SELECT trading_date, island, load_mwh,
          ${goldStamp(ANALYSIS_VERSION, fingerprint, "day_complete")}
        FROM (
          SELECT trading_date, island, ${dayTerm("load_mwh")},
            bool_and(period_complete) AS day_complete
          FROM load GROUP BY trading_date, island)
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

export const gridLoad = goldDataset({
  id: "gold_grid_load",
  tables: TABLES,
  inputs: INPUTS,
  analysisVersion: ANALYSIS_VERSION,
  publish: publishGridLoad,
});

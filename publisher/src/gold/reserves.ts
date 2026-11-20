import { existsSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { lit, type PublishResult } from "../silver/common.ts";
import {
  type GoldInput,
  goldDataset,
  goldPartitionPath,
  goldStamp,
  inputFingerprint,
  inputsComplete,
  silverPartitionPath,
  writeGoldTables,
} from "./common.ts";

/**
 * Bump by hand when the logic of any table in this file changes. The runner then rebuilds every
 * date (ADR-0011).
 */
export const ANALYSIS_VERSION = 1;

/** The gold tables of this module. The first is the sentinel: the runner reads it and it is written last. */
export const TABLES = [
  "reserve_by_class_island_period",
  "reserve_by_class_island_day",
] as const;

const DISPATCH: GoldInput = {
  table: "dispatch_reserve_prices",
  versionColumn: "bronze_sha256",
};
const INPUTS: GoldInput[] = [DISPATCH];

/**
 * Publish the reserve gold tables for one trading date, one partition for each table in
 * `TABLES`: `<goldDir>/<table>/trading_date=<date>/data.parquet` (ADR-0011, ADR-0013).
 *
 * Inputs: Dispatch Reserve Prices silver for the date. Long form: one row per reserve class
 * (FIR, SIR), island (NI or SI), trading period and publish time.
 *
 * Silver keeps every publish. Silver has no interval column. Publish times are irregular and
 * 5-minute-ish (sources 3.2). The interval is the 5-minute boundary nearest to the publish
 * time, kept inside the row's period. Gold keeps the latest `source_published_at` for each
 * reserve class, island and interval (owner decision on #9). Two points of connection on the
 * same island at the same interval keep the later publish.
 *
 * A period price is the time-weighted mean of those latest-case interval prices. Every
 * interval is 5 minutes, so this is the mean of the intervals that exist. A missing interval
 * has no weight and is not filled.
 *
 * Completeness: every row has `inputs_complete`. It is false when silver has no rows in some
 * trading periods of the day (`inputsComplete`, the same grain as gold generation). A day with
 * missing periods is written, flagged, and the result is `partial` with those periods. A period
 * with fewer than 6 intervals is not incomplete on its own.
 *
 * Missing (nothing written): the date has no dispatch reserve prices silver.
 * Repeatable: no `processed_at`. A total `ORDER BY` and one thread make the same inputs give the
 * same bytes (floating-point sums depend on the order of addition).
 */
export async function publishReserves(options: {
  silverDir: string;
  goldDir: string;
  date: string;
}): Promise<PublishResult> {
  const { silverDir, goldDir, date } = options;
  const input = silverPartitionPath(silverDir, DISPATCH.table, date);
  if (!existsSync(input)) return { date, status: "missing" };

  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    await connection.run("SET threads = 1");
    const completeness = await inputsComplete(connection, date, [input]);
    const stamp = goldStamp(
      ANALYSIS_VERSION,
      await inputFingerprint(silverDir, ANALYSIS_VERSION, INPUTS, date),
      completeness.complete,
    );

    await connection.run(
      `CREATE TEMP TABLE latest AS
       SELECT * EXCLUDE (rn) FROM (
         SELECT *, row_number() OVER (
           PARTITION BY reserve_class, island, interval_start_utc
           ORDER BY source_published_at DESC) AS rn
         FROM (
           SELECT reserve_class, island, trading_period, event_start_utc, event_end_utc,
             source_published_at, dollars_per_megawatt_hour AS price,
             least(greatest(
               to_timestamp(floor((epoch(source_published_at) + 150) / 300) * 300),
               event_start_utc), event_end_utc - INTERVAL 5 MINUTE) AS interval_start_utc
           FROM read_parquet(${lit(input)}))
       ) WHERE rn = 1`,
    );
    await connection.run(
      `CREATE TEMP TABLE class_periods AS
       SELECT reserve_class, island, trading_period,
         min(event_start_utc) AS event_start_utc,
         min(event_end_utc) AS event_end_utc,
         avg(price) AS dollars_per_megawatt_hour,
         min(price) AS min_interval_price,
         max(price) AS max_interval_price,
         count(*)::INTEGER AS intervals_present
       FROM latest
       GROUP BY reserve_class, island, trading_period`,
    );

    const tradingDate = `DATE ${lit(date)} AS trading_date`;
    const selects: Record<(typeof TABLES)[number], string> = {
      reserve_by_class_island_period: `SELECT ${tradingDate}, trading_period,
          event_start_utc, event_end_utc, reserve_class, island,
          dollars_per_megawatt_hour, min_interval_price, max_interval_price,
          intervals_present, ${stamp}
        FROM class_periods
        ORDER BY trading_period, reserve_class, island NULLS LAST`,
      reserve_by_class_island_day: `SELECT ${tradingDate}, reserve_class, island,
          avg(dollars_per_megawatt_hour) AS mean_price,
          sum(dollars_per_megawatt_hour * intervals_present)
            / nullif(sum(intervals_present), 0) AS time_weighted_mean_price,
          min(min_interval_price) AS min_price,
          max(max_interval_price) AS max_price,
          ${stamp}
        FROM class_periods
        GROUP BY reserve_class, island
        ORDER BY reserve_class, island NULLS LAST`,
    };

    await writeGoldTables(
      connection,
      TABLES.map((table) => [table, selects[table]] as const),
      goldDir,
      date,
    );
    const path = goldPartitionPath(goldDir, TABLES[0], date);
    const reader = await connection.runAndReadAll(
      `SELECT count(*) AS n FROM read_parquet(${lit(path)})`,
    );
    const rows = Number(
      (reader.getRowObjectsJson() as Array<{ n: string }>)[0]?.n,
    );
    return completeness.complete
      ? { date, status: "complete", rows, path }
      : {
          date,
          status: "partial",
          rows,
          path,
          missingPeriods: completeness.missingPeriods,
        };
  } finally {
    connection.closeSync();
  }
}

export const reserves = goldDataset({
  id: "gold_reserves",
  tables: TABLES,
  inputs: INPUTS,
  analysisVersion: ANALYSIS_VERSION,
  publish: publishReserves,
});

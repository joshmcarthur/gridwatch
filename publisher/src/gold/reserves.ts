import { existsSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { lit, type PublishResult } from "../silver/common.ts";
import { periodsInTradingDate } from "../trading-time.ts";
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
 * Rule B (owner decision, 2026-11-20, the same rule as gold prices, ADR-0012): silver's
 * `trading_period` is the period a row belongs to. Within one reserve class, island and period,
 * rows sort by `source_published_at`, then price. A price applies from its publish time until
 * the next row's publish time. The first row applies from the period start and the last until
 * the period end. Both ends are clamped into the period. Prices do not carry over between
 * periods. The period price is the time-weighted mean over the 30 minutes.
 *
 * There is one point of connection for each island and class (HAY2201 on NI, BEN2201 on SI).
 * Two on one island and class are not merged: the result is `invalid` and nothing is written
 * (ADR-0013).
 *
 * Completeness: a class-island-period is complete when it has at least one row. There is no
 * period spine, so a period with no row has no row in gold. A daily row is complete when its
 * class and island have a row in every expected period (46, 48 or 50). The result is `partial`
 * with the periods that have no row in any class (`inputsComplete`).
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
  const periods = periodsInTradingDate(date); // also rejects a malformed date
  const input = silverPartitionPath(silverDir, DISPATCH.table, date);
  if (!existsSync(input)) return { date, status: "missing" };

  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    await connection.run("SET threads = 1");

    const clashReader = await connection.runAndReadAll(
      `SELECT reserve_class, island,
         string_agg(DISTINCT point_of_connection, ', ') AS pocs
       FROM read_parquet(${lit(input)})
       GROUP BY reserve_class, island
       HAVING count(DISTINCT point_of_connection) > 1
       ORDER BY reserve_class, island NULLS LAST`,
    );
    const clashes = clashReader.getRowObjectsJson() as Array<{
      reserve_class: string;
      island: string | null;
      pocs: string;
    }>;
    if (clashes.length > 0)
      return {
        date,
        status: "invalid",
        errors: clashes.map(
          (c) =>
            `${c.reserve_class} on island ${c.island ?? "(none)"} has more than one point of connection: ${c.pocs}`,
        ),
      };

    const completeness = await inputsComplete(connection, date, [input]);
    const inputsSha256 = await inputFingerprint(
      silverDir,
      ANALYSIS_VERSION,
      INPUTS,
      date,
    );
    const stamp = (completeSql: string) =>
      goldStamp(ANALYSIS_VERSION, inputsSha256, completeSql);

    // Each row applies from its publish time to the next row's, inside its period.
    await connection.run(
      `CREATE TEMP TABLE segments AS
       SELECT reserve_class, island, trading_period, event_start_utc, event_end_utc, price,
         CASE WHEN rn = 1 THEN event_start_utc
              ELSE least(greatest(source_published_at, event_start_utc), event_end_utc)
         END AS segment_start,
         CASE WHEN next_published_at IS NULL THEN event_end_utc
              ELSE least(greatest(next_published_at, event_start_utc), event_end_utc)
         END AS segment_end
       FROM (
         SELECT r.reserve_class, r.island, r.trading_period,
           r.dollars_per_megawatt_hour AS price, r.source_published_at,
           r.event_start_utc, r.event_end_utc,
           row_number() OVER w AS rn,
           lead(r.source_published_at) OVER w AS next_published_at
         FROM read_parquet(${lit(input)}) r
         WINDOW w AS (PARTITION BY r.reserve_class, r.island, r.trading_period
                      ORDER BY r.source_published_at, r.dollars_per_megawatt_hour))`,
    );
    // One row per class, island and period that has a row.
    await connection.run(
      `CREATE TEMP TABLE class_periods AS
       SELECT reserve_class, island, trading_period,
         min(event_start_utc) AS event_start_utc,
         min(event_end_utc) AS event_end_utc,
         sum(price * epoch(segment_end - segment_start))
           / sum(epoch(segment_end - segment_start)) AS dollars_per_megawatt_hour,
         min(price) AS min_price,
         max(price) AS max_price,
         count(*)::INTEGER AS rows_present
       FROM segments GROUP BY reserve_class, island, trading_period`,
    );

    const tradingDate = `DATE ${lit(date)} AS trading_date`;
    const selects: Record<(typeof TABLES)[number], string> = {
      reserve_by_class_island_period: `SELECT ${tradingDate}, trading_period,
          event_start_utc, event_end_utc, reserve_class, island,
          dollars_per_megawatt_hour, min_price, max_price, rows_present,
          ${stamp("true")}
        FROM class_periods
        ORDER BY trading_period, reserve_class, island NULLS LAST`,
      reserve_by_class_island_day: `SELECT ${tradingDate}, reserve_class, island,
          avg(dollars_per_megawatt_hour) AS mean_price,
          min(min_price) AS min_price,
          max(max_price) AS max_price,
          count(*)::INTEGER AS periods_present,
          ${periods}::INTEGER AS periods_expected,
          sum(rows_present)::INTEGER AS rows_present,
          ${stamp(`count(*) = ${periods}`)}
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

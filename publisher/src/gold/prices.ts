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

const OTA = "OTA2201";
const HAY = "HAY2201";
const BEN = "BEN2201";

/** The reference nodes of ADR-0012. */
export const REFERENCE_NODES = [
  { pointOfConnection: OTA, priceRegion: "upper_north_island" },
  { pointOfConnection: HAY, priceRegion: "lower_north_island" },
  { pointOfConnection: BEN, priceRegion: "south_island" },
] as const;

/** Spread pairs, `[from, to]`. A spread is `from - to`: north minus south. */
export const SPREAD_PAIRS = [
  [OTA, HAY],
  [HAY, BEN],
  [OTA, BEN],
] as const;

/** The gold tables of this module. The first is the sentinel: the runner reads it and it is written last. */
export const TABLES = [
  "price_periods",
  "price_daily_summary",
  "price_spreads",
  "price_distribution",
] as const;

const DISPATCH: GoldInput = {
  table: "dispatch_energy_prices",
  layer: "silver",
  versionColumn: "bronze_sha256",
  completenessDataset: "dispatch_energy_prices",
};
export const INPUTS: GoldInput[] = [DISPATCH];

/**
 * Publish the gold price tables for one trading date, from the silver dispatch energy prices
 * of that date: `<goldDir>/<table>/trading_date=<date>/data.parquet` for each of `TABLES`
 * (ADR-0011, ADR-0012).
 *
 * Rule B (owner decision, 2026-11-20): silver's `trading_period` is the period a row belongs
 * to. Within one POC and period, rows sort by `source_published_at`. A price applies from its
 * publish time until the next row's publish time. The first row applies from the period start
 * and the last until the period end. Prices do not carry over between periods. The period
 * price is the time-weighted mean over the period, so a late publish gets little weight.
 *
 * Rows are flagged, not dropped: a node with no row in a period has a row with null prices
 * and `inputs_complete = false`. `inputs_complete` is true only when the `_completeness` status
 * of `dispatch_energy_prices` is `complete` for the date (this run's rows, ADR-0010) and the
 * node has at least one row in the period. A daily or spread row needs this of all its periods
 * or nodes.
 *
 * Missing (nothing written): the date has no dispatch energy prices silver.
 * Repeatable: no `processed_at`. A total `ORDER BY` and one thread make the same inputs give
 * the same bytes (floating-point sums depend on the order of addition).
 */
export async function publishGoldPrices(
  options: GoldPublishOptions,
): Promise<PublishResult> {
  const { silverDir, goldDir, completeness, date } = options;
  const periods = periodsInTradingDate(date); // also rejects a malformed date
  const input = silverPartitionPath(silverDir, DISPATCH.table, date);
  if (!existsSync(input)) return { date, status: "missing" };

  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    await connection.run("SET threads = 1");
    const inputsSha256 = await inputFingerprint(
      silverDir,
      goldDir,
      ANALYSIS_VERSION,
      INPUTS,
      completeness,
      date,
    );
    // A row is complete when its input status is `complete` and the data rule holds.
    const statusComplete = inputStatusesComplete(completeness, INPUTS, date);
    const stamp = (completeSql: string) =>
      goldStamp(
        ANALYSIS_VERSION,
        inputsSha256,
        `(${completeSql}) AND ${statusComplete}`,
      );

    const spans = Array.from({ length: periods }, (_, i) => {
      const span = periodToUtc(date, i + 1);
      return `(${i + 1}, ${lit(span.eventStartUtc.toString())}::TIMESTAMPTZ, ${lit(span.eventEndUtc.toString())}::TIMESTAMPTZ)`;
    }).join(", ");
    const nodes = REFERENCE_NODES.map(
      (n) => `(${lit(n.pointOfConnection)}, ${lit(n.priceRegion)})`,
    ).join(", ");
    const pairs = SPREAD_PAIRS.map(
      ([from, to]) => `(${lit(from)}, ${lit(to)})`,
    ).join(", ");

    await connection.run(
      `CREATE TEMP TABLE spans AS
       SELECT * FROM (VALUES ${spans}) s(trading_period, event_start_utc, event_end_utc)`,
    );
    await connection.run(
      `CREATE TEMP TABLE nodes AS
       SELECT * FROM (VALUES ${nodes}) n(point_of_connection, price_region)`,
    );
    // Each row applies from its publish time to the next row's, inside its period.
    await connection.run(
      `CREATE TEMP TABLE segments AS
       SELECT point_of_connection, trading_period, is_proxy_price, price,
         CASE WHEN rn = 1 THEN event_start_utc
              ELSE least(greatest(source_published_at, event_start_utc), event_end_utc)
         END AS segment_start,
         CASE WHEN next_published_at IS NULL THEN event_end_utc
              ELSE least(greatest(next_published_at, event_start_utc), event_end_utc)
         END AS segment_end
       FROM (
         SELECT r.point_of_connection, r.trading_period, r.is_proxy_price,
           r.dollars_per_megawatt_hour AS price, r.source_published_at,
           s.event_start_utc, s.event_end_utc,
           row_number() OVER w AS rn,
           lead(r.source_published_at) OVER w AS next_published_at
         FROM read_parquet(${lit(input)}) r
         JOIN spans s USING (trading_period)
         WINDOW w AS (PARTITION BY r.point_of_connection, r.trading_period
                      ORDER BY r.source_published_at, r.dollars_per_megawatt_hour))`,
    );
    // One row per POC and period that has a row.
    await connection.run(
      `CREATE TEMP TABLE poc_periods AS
       SELECT point_of_connection, trading_period,
         sum(price * epoch(segment_end - segment_start))
           / sum(epoch(segment_end - segment_start)) AS price,
         min(price) AS min_price,
         max(price) AS max_price,
         count(*)::INTEGER AS rows_present,
         bool_or(is_proxy_price) AS has_proxy_price
       FROM segments GROUP BY ALL`,
    );
    // The reference nodes on every expected period, with nulls where silver has no row.
    await connection.run(
      `CREATE TEMP TABLE node_periods AS
       SELECT n.point_of_connection, n.price_region, s.trading_period,
         s.event_start_utc, s.event_end_utc,
         p.price, p.min_price, p.max_price,
         coalesce(p.rows_present, 0)::INTEGER AS rows_present,
         coalesce(p.has_proxy_price, false) AS has_proxy_price,
         p.rows_present IS NOT NULL AS inputs_complete
       FROM nodes n CROSS JOIN spans s
       LEFT JOIN poc_periods p
         ON p.point_of_connection = n.point_of_connection AND p.trading_period = s.trading_period`,
    );

    const tradingDate = `DATE ${lit(date)} AS trading_date`;
    const selects: Record<(typeof TABLES)[number], string> = {
      price_periods: `SELECT ${tradingDate}, trading_period, event_start_utc, event_end_utc,
         point_of_connection, price_region, price, min_price, max_price,
         rows_present, has_proxy_price,
         ${stamp("inputs_complete")}
       FROM node_periods ORDER BY point_of_connection, trading_period`,
      price_daily_summary: `SELECT ${tradingDate}, point_of_connection, price_region,
         avg(price) AS mean_price,
         min(min_price) AS min_price,
         max(max_price) AS max_price,
         count(price)::INTEGER AS periods_present,
         ${periods}::INTEGER AS periods_expected,
         sum(rows_present)::INTEGER AS rows_present,
         ${stamp("bool_and(inputs_complete)")}
       FROM node_periods GROUP BY point_of_connection, price_region
       ORDER BY point_of_connection`,
      price_spreads: `SELECT ${tradingDate}, a.trading_period, a.event_start_utc, a.event_end_utc,
         a.point_of_connection AS from_point_of_connection,
         b.point_of_connection AS to_point_of_connection,
         a.price_region AS from_price_region, b.price_region AS to_price_region,
         a.price AS from_price, b.price AS to_price,
         a.price - b.price AS spread,
         ${stamp("a.inputs_complete AND b.inputs_complete")}
       FROM (VALUES ${pairs}) pair(from_poc, to_poc)
       JOIN node_periods a ON a.point_of_connection = pair.from_poc
       JOIN node_periods b ON b.point_of_connection = pair.to_poc
         AND b.trading_period = a.trading_period
       ORDER BY from_point_of_connection, to_point_of_connection, a.trading_period`,
      price_distribution: `SELECT ${tradingDate}, s.trading_period, s.event_start_utc, s.event_end_utc,
         count(p.price)::INTEGER AS poc_count,
         min(p.price) AS min_price,
         quantile_cont(p.price, 0.05) AS p05_price,
         quantile_cont(p.price, 0.25) AS p25_price,
         quantile_cont(p.price, 0.5) AS median_price,
         quantile_cont(p.price, 0.75) AS p75_price,
         quantile_cont(p.price, 0.95) AS p95_price,
         max(p.price) AS max_price,
         ${stamp("count(p.price) > 0")}
       FROM spans s
       LEFT JOIN poc_periods p ON p.trading_period = s.trading_period
       GROUP BY s.trading_period, s.event_start_utc, s.event_end_utc
       ORDER BY s.trading_period`,
    };

    await writeGoldTables(
      connection,
      TABLES.map((table) => [table, selects[table]] as const),
      goldDir,
      date,
    );
    const path = goldPartitionPath(goldDir, TABLES[0], date);
    const missingReader = await connection.runAndReadAll(
      `SELECT DISTINCT trading_period AS period
       FROM node_periods
       WHERE NOT inputs_complete
       ORDER BY 1`,
    );
    const missingPeriods = (
      missingReader.getRowObjectsJson() as Array<{ period: string }>
    ).map((row) => Number(row.period));
    const rows = REFERENCE_NODES.length * periods;
    return missingPeriods.length === 0 && statusComplete
      ? { date, status: "complete", rows, path }
      : { date, status: "partial", rows, path, missingPeriods };
  } finally {
    connection.closeSync();
  }
}

export const prices = goldDataset({
  id: "gold_prices",
  tables: TABLES,
  inputs: INPUTS,
  analysisVersion: ANALYSIS_VERSION,
  publish: publishGoldPrices,
});

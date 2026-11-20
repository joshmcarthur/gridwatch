import { existsSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { lit, type PublishResult } from "../silver/common.ts";
import { periodsInTradingDate, periodToUtc } from "../trading-time.ts";
import {
  type GoldInput,
  goldDataset,
  goldPartitionPath,
  goldStamp,
  inputFingerprint,
  silverPartitionPath,
  writeGoldTables,
} from "./common.ts";

/**
 * Bump by hand when the logic of any table in this file changes. The runner then rebuilds every
 * date (ADR-0011).
 */
export const ANALYSIS_VERSION = 1;

/** A trading period is 30 minutes and a dispatch interval is 5. */
const INTERVALS_PER_PERIOD = 6;

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
  versionColumn: "bronze_sha256",
};
const INPUTS: GoldInput[] = [DISPATCH];

/**
 * Publish the gold price tables for one trading date, from the silver dispatch energy prices
 * of that date: `<goldDir>/<table>/trading_date=<date>/data.parquet` for each of `TABLES`
 * (ADR-0011, ADR-0012).
 *
 * Silver keeps every RTD case. Here one dispatch interval has one price: the case with the
 * latest `source_published_at` (owner decision on #9). Silver has no interval column, so the
 * interval is the 5-minute boundary nearest to the publish time, kept inside the row's period.
 * A re-run published a few minutes after the first lands on the same boundary.
 *
 * A period price is the time-weighted mean of the latest-case interval prices in the period.
 * Every interval is 5 minutes, so this is the mean of the intervals that exist. Rows are
 * flagged, not dropped: a node with fewer than 6 intervals in a period has
 * `inputs_complete = false`, and a period with no price still has a row with null prices.
 * Completeness is this 6-interval count, not `inputsComplete()` (that helper counts trading
 * periods in silver fact files).
 *
 * Missing (nothing written): the date has no dispatch energy prices silver.
 * Repeatable: no `processed_at`. A total `ORDER BY` and one thread make the same inputs give
 * the same bytes (floating-point sums depend on the order of addition).
 */
export async function publishGoldPrices(options: {
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
    const query = async (sql: string) =>
      (await connection.runAndReadAll(sql)).getRowObjectsJson() as Array<
        Record<string, unknown>
      >;

    const inputsSha256 = await inputFingerprint(
      silverDir,
      ANALYSIS_VERSION,
      INPUTS,
      date,
    );
    const stamp = (complete: boolean | string) =>
      goldStamp(ANALYSIS_VERSION, inputsSha256, complete);

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
    // One row per POC and interval: the latest case.
    await connection.run(
      `CREATE TEMP TABLE latest AS
       SELECT * EXCLUDE (rn) FROM (
         SELECT *, row_number() OVER (
           PARTITION BY point_of_connection, interval_start_utc
           ORDER BY source_published_at DESC) AS rn
         FROM (
           SELECT point_of_connection, trading_period, source_published_at, is_proxy_price,
             dollars_per_megawatt_hour AS price,
             least(greatest(
               to_timestamp(floor((epoch(source_published_at) + 150) / 300) * 300),
               event_start_utc), event_end_utc - INTERVAL 5 MINUTE) AS interval_start_utc
           FROM read_parquet(${lit(input)}))
       ) WHERE rn = 1`,
    );
    // One row per POC and period that has a price.
    await connection.run(
      `CREATE TEMP TABLE poc_periods AS
       SELECT point_of_connection, trading_period,
         avg(price) AS price,
         min(price) AS min_interval_price,
         max(price) AS max_interval_price,
         count(*)::INTEGER AS intervals_present,
         bool_or(is_proxy_price) AS has_proxy_price
       FROM latest GROUP BY ALL`,
    );
    // Distinct intervals with a price from any POC, per period.
    await connection.run(
      `CREATE TEMP TABLE period_intervals AS
       SELECT trading_period, count(DISTINCT interval_start_utc)::INTEGER AS intervals_present
       FROM latest GROUP BY trading_period`,
    );
    // The reference nodes on every expected period, with nulls where silver has no price.
    await connection.run(
      `CREATE TEMP TABLE node_periods AS
       SELECT n.point_of_connection, n.price_region, s.trading_period,
         s.event_start_utc, s.event_end_utc,
         p.price, p.min_interval_price, p.max_interval_price,
         coalesce(p.intervals_present, 0)::INTEGER AS intervals_present,
         ${INTERVALS_PER_PERIOD}::INTEGER AS intervals_expected,
         coalesce(p.has_proxy_price, false) AS has_proxy_price,
         coalesce(p.intervals_present, 0) = ${INTERVALS_PER_PERIOD} AS inputs_complete
       FROM nodes n CROSS JOIN spans s
       LEFT JOIN poc_periods p
         ON p.point_of_connection = n.point_of_connection AND p.trading_period = s.trading_period`,
    );

    const tradingDate = `DATE ${lit(date)} AS trading_date`;
    const selects: Record<(typeof TABLES)[number], string> = {
      price_periods: `SELECT ${tradingDate}, trading_period, event_start_utc, event_end_utc,
         point_of_connection, price_region, price, min_interval_price, max_interval_price,
         intervals_present, intervals_expected, has_proxy_price,
         ${stamp("inputs_complete")}
       FROM node_periods ORDER BY point_of_connection, trading_period`,
      price_daily_summary: `SELECT ${tradingDate}, point_of_connection, price_region,
         avg(price) AS mean_price,
         sum(price * intervals_present) / nullif(sum(intervals_present), 0) AS time_weighted_mean_price,
         min(min_interval_price) AS min_price,
         max(max_interval_price) AS max_price,
         count(price)::INTEGER AS periods_present,
         ${periods}::INTEGER AS periods_expected,
         sum(intervals_present)::INTEGER AS intervals_present,
         ${periods * INTERVALS_PER_PERIOD}::INTEGER AS intervals_expected,
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
         coalesce(max(i.intervals_present), 0)::INTEGER AS intervals_present,
         ${INTERVALS_PER_PERIOD}::INTEGER AS intervals_expected,
         ${stamp(`coalesce(max(i.intervals_present), 0) = ${INTERVALS_PER_PERIOD}`)}
       FROM spans s
       LEFT JOIN poc_periods p ON p.trading_period = s.trading_period
       LEFT JOIN period_intervals i ON i.trading_period = s.trading_period
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
    const missingPeriods = (
      await query(
        `SELECT s.trading_period AS period FROM spans s
         WHERE EXISTS (
           SELECT 1 FROM node_periods n
           WHERE n.trading_period = s.trading_period AND NOT n.inputs_complete)
            OR coalesce((
              SELECT i.intervals_present FROM period_intervals i
              WHERE i.trading_period = s.trading_period), 0) < ${INTERVALS_PER_PERIOD}
         ORDER BY 1`,
      )
    ).map((row) => Number(row.period));
    const rows = REFERENCE_NODES.length * periods;
    return missingPeriods.length === 0
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

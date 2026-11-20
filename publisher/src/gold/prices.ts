import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { lit, writeParquetAtomically } from "../silver/common.ts";
import { periodsInTradingDate, periodToUtc } from "../trading-time.ts";

/** Bump by hand when the logic of any table here changes. Every gold row carries it. */
export const ANALYSIS_VERSION = 1;

const SILVER_DATASET = "dispatch_energy_prices";
/** A trading period is 30 minutes and a dispatch interval is 5. */
const INTERVALS_PER_PERIOD = 6;

/** The reference nodes of ADR-0011. */
export const REFERENCE_NODES = [
  { pointOfConnection: "OTA2201", region: "upper_north_island" },
  { pointOfConnection: "HAY2201", region: "lower_north_island" },
  { pointOfConnection: "BEN2201", region: "south_island" },
] as const;

export const TABLES = [
  "price_periods",
  "price_daily_summary",
  "price_spreads",
  "price_distribution",
] as const;
type Table = (typeof TABLES)[number];

export type GoldPricesResult =
  | { date: string; status: "missing" }
  | {
      date: string;
      status: "written";
      /** False when any row of any table has `inputs_complete = false`. */
      inputsComplete: boolean;
      inputsSha256: string;
      rows: Record<Table, number>;
    };

/**
 * Publish the gold price tables for one trading date, from the silver dispatch energy prices
 * of that date: `<goldDir>/<table>/trading_date=<date>/data.parquet` for each of `TABLES`.
 * Returns `missing` and writes nothing when silver has no partition for the date.
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
 */
export async function publishGoldPrices(options: {
  silverDir: string;
  goldDir: string;
  date: string;
  /** For tests. Default: now. */
  processedAt?: Date;
}): Promise<GoldPricesResult> {
  const { silverDir, goldDir, date } = options;
  const periods = periodsInTradingDate(date); // also rejects a malformed date
  const input = join(
    silverDir,
    SILVER_DATASET,
    `trading_date=${date}`,
    "data.parquet",
  );
  if (!existsSync(input)) return { date, status: "missing" };

  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    const query = async (sql: string) =>
      (await connection.runAndReadAll(sql)).getRowObjectsJson() as Array<
        Record<string, unknown>
      >;

    const inputsSha256 = fingerprint(
      (
        await query(
          `SELECT DISTINCT bronze_sha256 FROM read_parquet(${lit(input)}) ORDER BY 1`,
        )
      ).map((row) => `${relative(silverDir, input)} ${row.bronze_sha256}`),
    );
    const processedAt = (options.processedAt ?? new Date()).toISOString();
    const stamp = `DATE ${lit(date)} AS trading_date, ${ANALYSIS_VERSION}::INTEGER AS analysis_version, ${lit(inputsSha256)} AS inputs_sha256, ${lit(processedAt)}::TIMESTAMPTZ AS processed_at`;

    const spans = Array.from({ length: periods }, (_, i) => {
      const span = periodToUtc(date, i + 1);
      return `(${i + 1}, ${lit(span.eventStartUtc.toString())}::TIMESTAMPTZ, ${lit(span.eventEndUtc.toString())}::TIMESTAMPTZ)`;
    }).join(", ");
    const nodes = REFERENCE_NODES.map(
      (n) => `(${lit(n.pointOfConnection)}, ${lit(n.region)})`,
    ).join(", ");
    const [ota, hay, ben] = REFERENCE_NODES.map((n) =>
      lit(n.pointOfConnection),
    );
    // Spread = from - to. North minus south, so a positive spread means the north is dearer.
    const pairs = `(${ota}, ${hay}), (${hay}, ${ben}), (${ota}, ${ben})`;

    await connection.run(
      `CREATE TEMP TABLE spans AS
       SELECT * FROM (VALUES ${spans}) s(trading_period, event_start_utc, event_end_utc)`,
    );
    await connection.run(
      `CREATE TEMP TABLE nodes AS
       SELECT * FROM (VALUES ${nodes}) n(point_of_connection, region)`,
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
    // The reference nodes on every expected period, with nulls where silver has no price.
    await connection.run(
      `CREATE TEMP TABLE node_periods AS
       SELECT n.point_of_connection, n.region, s.trading_period,
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

    const selects: Record<Table, string> = {
      price_periods: `SELECT ${stamp}, trading_period, event_start_utc, event_end_utc,
         point_of_connection, region, price, min_interval_price, max_interval_price,
         intervals_present, intervals_expected, has_proxy_price, inputs_complete
       FROM node_periods ORDER BY point_of_connection, trading_period`,
      price_daily_summary: `SELECT ${stamp}, point_of_connection, region,
         avg(price) AS mean_price,
         sum(price * intervals_present) / nullif(sum(intervals_present), 0) AS time_weighted_mean_price,
         min(min_interval_price) AS min_price,
         max(max_interval_price) AS max_price,
         count(price)::INTEGER AS periods_present,
         ${periods}::INTEGER AS periods_expected,
         sum(intervals_present)::INTEGER AS intervals_present,
         ${periods * INTERVALS_PER_PERIOD}::INTEGER AS intervals_expected,
         bool_and(inputs_complete) AS inputs_complete
       FROM node_periods GROUP BY point_of_connection, region
       ORDER BY point_of_connection`,
      price_spreads: `SELECT ${stamp}, a.trading_period, a.event_start_utc, a.event_end_utc,
         a.point_of_connection AS from_point_of_connection,
         b.point_of_connection AS to_point_of_connection,
         a.region AS from_region, b.region AS to_region,
         a.price AS from_price, b.price AS to_price,
         a.price - b.price AS spread,
         a.inputs_complete AND b.inputs_complete AS inputs_complete
       FROM (VALUES ${pairs}) pair(from_poc, to_poc)
       JOIN node_periods a ON a.point_of_connection = pair.from_poc
       JOIN node_periods b ON b.point_of_connection = pair.to_poc
         AND b.trading_period = a.trading_period
       ORDER BY from_point_of_connection, to_point_of_connection, a.trading_period`,
      price_distribution: `SELECT ${stamp}, s.trading_period, s.event_start_utc, s.event_end_utc,
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
         coalesce(max(i.intervals_present), 0) = ${INTERVALS_PER_PERIOD} AS inputs_complete
       FROM spans s
       LEFT JOIN poc_periods p ON p.trading_period = s.trading_period
       LEFT JOIN (
         SELECT trading_period, count(DISTINCT interval_start_utc) AS intervals_present
         FROM latest GROUP BY trading_period) i ON i.trading_period = s.trading_period
       GROUP BY s.trading_period, s.event_start_utc, s.event_end_utc
       ORDER BY s.trading_period`,
    };

    const rows = {} as Record<Table, number>;
    let inputsComplete = true;
    for (const table of TABLES) {
      const path = join(goldDir, table, `trading_date=${date}`, "data.parquet");
      await writeParquetAtomically(connection, selects[table], path);
      const [summary] = await query(
        `SELECT count(*) AS n, coalesce(bool_and(inputs_complete), true) AS complete
         FROM read_parquet(${lit(path)})`,
      );
      rows[table] = Number(summary?.n);
      inputsComplete &&= summary?.complete === true;
    }
    return { date, status: "written", inputsComplete, inputsSha256, rows };
  } finally {
    connection.closeSync();
  }
}

/** `inputs_sha256`: the bronze version behind each input partition, plus the analysis version. */
function fingerprint(inputs: string[]): string {
  return createHash("sha256")
    .update(
      [...inputs.sort(), `analysis_version ${ANALYSIS_VERSION}`].join("\n"),
    )
    .digest("hex");
}

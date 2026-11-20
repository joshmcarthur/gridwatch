import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import type { PublisherDataset } from "../datasets.ts";
import {
  fingerprint,
  type GoldPublishOptions,
  goldPartitionPath,
  goldStamp,
  writeGoldTables,
} from "../gold/common.ts";
import {
  TABLES as PRICE_TABLES,
  prices,
  REFERENCE_NODES,
} from "../gold/prices.ts";
import { lit, type PublishResult } from "../silver/common.ts";
import type { CompletenessView } from "../silver/completeness.ts";
import { OBSERVATION_ID_SQL } from "./observation.ts";

/**
 * The price anomaly detector (ADR-0015). It reads the gold `price_periods` of the three
 * reference nodes and flags runs of periods whose price is far outside the node's own recent
 * history. Bump `ANALYSIS_VERSION` by hand with any change to the logic or to a config value
 * (ADR-0011). A test pins the config hash.
 */
export const ANALYSIS_VERSION = 1;

const DETECTOR_ID = "price_anomaly";
const PRICE_TABLE = PRICE_TABLES[0];
const MEASURED_UNIT = "$/MWh";

export interface PriceAnomalyConfig {
  /** Days before the date that form the baseline. The date itself is not in it. */
  baselineWindowDays: number;
  /** Fewer complete periods in the baseline: no baseline, no observations. */
  minBaselinePeriods: number;
  highPercentile: number;
  lowPercentile: number;
  /** A threshold is at least this far from the median, in $/MWh. */
  minDeviationFromMedian: number;
  /** Fewest consecutive periods in one observation. */
  minPeriods: number;
}

export const PRICE_ANOMALY_CONFIG: PriceAnomalyConfig = {
  baselineWindowDays: 28,
  minBaselinePeriods: 672,
  highPercentile: 0.99,
  lowPercentile: 0.01,
  minDeviationFromMedian: 25,
  minPeriods: 2,
};

/** The gold tables of this module. The first is the sentinel: the runner reads it and it is written last. */
export const TABLES = [
  "price_anomaly_baselines",
  `observations_${DETECTOR_ID}`,
] as const;

const shiftDate = (date: string, days: number) =>
  Temporal.PlainDate.from(date).add({ days }).toString();

/** The dates from `date` minus `days` to `date`, in order. */
const windowDates = (date: string, days: number) =>
  Array.from({ length: days + 1 }, (_, i) => shiftDate(date, i - days));

/**
 * The `inputs_sha256` of a date: the analysis version, the config and the version of each price
 * day in the window that has one. `window` holds `[date, version]` pairs, in any order.
 */
const detectorFingerprint = (
  config: PriceAnomalyConfig,
  date: string,
  versionOf: (day: string) => string | undefined,
): string => {
  const window = windowDates(date, config.baselineWindowDays).flatMap((day) => {
    const version = versionOf(day);
    return version === undefined ? [] : ([[day, version]] as const);
  });
  return fingerprint(ANALYSIS_VERSION, [
    [
      "config",
      createHash("sha256").update(JSON.stringify(config)).digest("hex"),
    ] as const,
    ...window.map(
      ([day, version]) => [`${PRICE_TABLE} ${day}`, version] as const,
    ),
  ]);
};

/** The wanted fingerprint of each date that has a wanted price fingerprint. */
const rollWindow = (
  priceVersions: ReadonlyMap<string, string>,
  config: PriceAnomalyConfig,
): Map<string, string> =>
  new Map(
    [...priceVersions.keys()].map((date) => [
      date,
      detectorFingerprint(config, date, (day) => priceVersions.get(day)),
    ]),
  );

/**
 * The price anomaly dataset for a config. The registry uses the default config. A test uses a
 * shorter one. It is a literal `PublisherDataset`, not `goldDataset`, because its wanted
 * versions come from the rolling window of `prices`, not from one date of silver.
 */
export const priceAnomalyDataset = (
  config: PriceAnomalyConfig = PRICE_ANOMALY_CONFIG,
): PublisherDataset => ({
  id: "gold_price_anomaly",
  table: TABLES[0],
  partitionKey: "trading_date",
  versionColumn: "inputs_sha256",
  partitionRoot: ({ goldDir }) => goldDir,
  wantedVersions: async (silverDir: string, completeness: CompletenessView) => {
    if (!prices.wantedVersions)
      throw new Error("gold_prices has no wanted versions");
    return rollWindow(
      await prices.wantedVersions(silverDir, completeness),
      config,
    );
  },
  publish: (options) => publishPriceAnomalies(options, config),
});

export const priceAnomaly = priceAnomalyDataset();

/**
 * Publish the sentinel and the observations of one trading date (ADR-0015):
 * `<goldDir>/price_anomaly_baselines/trading_date=<date>/data.parquet` and
 * `<goldDir>/observations_price_anomaly/trading_date=<date>/data.parquet`.
 *
 * Missing: the date has no `price_periods` partition. Nothing is written.
 * Partial: an input node-day is incomplete, or a node has no baseline. Both tables are still
 * written, and the missing periods are listed when rows are absent.
 */
export async function publishPriceAnomalies(
  options: GoldPublishOptions,
  config: PriceAnomalyConfig = PRICE_ANOMALY_CONFIG,
): Promise<PublishResult> {
  const { goldDir, date } = options;
  if (!existsSync(goldPartitionPath(goldDir, PRICE_TABLE, date)))
    return { date, status: "missing" };

  const days = windowDates(date, config.baselineWindowDays);
  const files = days
    .map((day) => goldPartitionPath(goldDir, PRICE_TABLE, day))
    .filter((file) => existsSync(file));
  const baselineStart = shiftDate(date, -config.baselineWindowDays);
  const baselineEnd = shiftDate(date, -1);

  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    await connection.run("SET threads = 1");
    await connection.run(
      `CREATE TEMP TABLE pp AS SELECT * FROM read_parquet([${files.map(lit).join(", ")}])`,
    );
    // The version of each price day on disk. A day with two versions is a broken file.
    const versionRows = await connection.runAndReadAll(
      `SELECT DISTINCT trading_date::VARCHAR AS day, inputs_sha256 AS version FROM pp ORDER BY 1`,
    );
    const onDisk = new Map<string, string>();
    for (const row of versionRows.getRowObjectsJson() as Array<{
      day: string;
      version: string;
    }>) {
      if (onDisk.has(row.day))
        throw new Error(`${PRICE_TABLE} ${row.day} holds two input versions`);
      onDisk.set(row.day, row.version);
    }
    const inputsSha256 = detectorFingerprint(config, date, (day) =>
      onDisk.get(day),
    );
    const stamp = (completeSql: string) =>
      goldStamp(ANALYSIS_VERSION, inputsSha256, completeSql);
    const parameters = JSON.stringify(config);

    await connection.run(
      `CREATE TEMP TABLE nodes AS
       SELECT * FROM (VALUES ${REFERENCE_NODES.map(
         (n) =>
           `(${lit(n.pointOfConnection)}, ${lit(n.priceRegion)}, ${lit(n.island)})`,
       ).join(", ")}) n(point_of_connection, price_region, island)`,
    );
    // Baseline of each node: complete prices of the earlier days in the window. The date
    // itself is left out, so a spike does not raise its own threshold.
    await connection.run(
      `CREATE TEMP TABLE baseline AS
       WITH stats AS (
         SELECT n.point_of_connection, n.price_region, n.island,
           count(b.price)::INTEGER AS sample_count,
           quantile_cont(b.price, 0.5) AS baseline_median,
           quantile_cont(b.price, ${config.highPercentile}) AS high_percentile_value,
           quantile_cont(b.price, ${config.lowPercentile}) AS low_percentile_value
         FROM nodes n
         LEFT JOIN pp b
           ON b.point_of_connection = n.point_of_connection
          AND b.trading_date < DATE ${lit(date)}
          AND b.trading_date >= DATE ${lit(baselineStart)}
          AND b.price IS NOT NULL AND b.inputs_complete
         GROUP BY ALL
       )
       SELECT *,
         sample_count >= ${config.minBaselinePeriods} AS baseline_ready,
         CASE WHEN sample_count >= ${config.minBaselinePeriods}
           THEN greatest(high_percentile_value, baseline_median + ${config.minDeviationFromMedian}) END AS high_threshold,
         CASE WHEN sample_count >= ${config.minBaselinePeriods}
           THEN least(low_percentile_value, baseline_median - ${config.minDeviationFromMedian}) END AS low_threshold
       FROM stats`,
    );
    // A period with a price beyond the threshold. A null price is never a hit.
    await connection.run(
      `CREATE TEMP TABLE hits AS
       SELECT t.point_of_connection, t.trading_period, t.event_start_utc, t.event_end_utc,
         t.price, 'price_high' AS observation_type
       FROM pp t JOIN baseline b USING (point_of_connection)
       WHERE t.trading_date = DATE ${lit(date)} AND b.baseline_ready AND t.price > b.high_threshold
       UNION ALL
       SELECT t.point_of_connection, t.trading_period, t.event_start_utc, t.event_end_utc,
         t.price, 'price_low' AS observation_type
       FROM pp t JOIN baseline b USING (point_of_connection)
       WHERE t.trading_date = DATE ${lit(date)} AND b.baseline_ready AND t.price < b.low_threshold`,
    );
    // Consecutive period numbers make one run. A run of fewer than minPeriods is dropped.
    await connection.run(
      `CREATE TEMP TABLE runs AS
       SELECT point_of_connection, observation_type,
         min(trading_period) AS start_trading_period,
         max(trading_period) AS end_trading_period,
         count(*)::INTEGER AS period_count,
         min(event_start_utc) AS event_start_utc,
         max(event_end_utc) AS event_end_utc,
         CASE WHEN observation_type = 'price_high' THEN max(price) ELSE min(price) END AS measured_value
       FROM (
         SELECT *, trading_period - row_number() OVER (
           PARTITION BY point_of_connection, observation_type ORDER BY trading_period) AS grp
         FROM hits
       )
       GROUP BY point_of_connection, observation_type, grp
       HAVING count(*) >= ${config.minPeriods}`,
    );
    // A node-day is complete when every price period of it is complete (ADR-0012).
    await connection.run(
      `CREATE TEMP TABLE node_day AS
       SELECT point_of_connection, bool_and(inputs_complete) AS node_complete
       FROM pp WHERE trading_date = DATE ${lit(date)}
       GROUP BY point_of_connection`,
    );

    const observationsSql = `SELECT ${OBSERVATION_ID_SQL} AS observation_id,
         detector_id, observation_type, trading_date, start_trading_period, end_trading_period,
         period_count, event_start_utc, event_end_utc, subject_type, subject_id,
         point_of_connection, island, region_id, plant_id, fuel_category, reserve_class,
         price_region, measured_value, measured_unit, baseline_value, threshold_value,
         baseline_sample_count, baseline_window_start, baseline_window_end, severity,
         parameters, input_tables,
         ${stamp("node_complete")}
       FROM (
         SELECT '${DETECTOR_ID}' AS detector_id, r.observation_type,
           ${lit(date)}::DATE AS trading_date,
           r.start_trading_period, r.end_trading_period, r.period_count,
           r.event_start_utc, r.event_end_utc,
           'point_of_connection' AS subject_type,
           r.point_of_connection AS subject_id,
           r.point_of_connection, b.island,
           NULL::INTEGER AS region_id, NULL::VARCHAR AS plant_id,
           NULL::VARCHAR AS fuel_category, NULL::VARCHAR AS reserve_class,
           b.price_region,
           r.measured_value,
           ${lit(MEASURED_UNIT)} AS measured_unit,
           b.baseline_median AS baseline_value,
           CASE WHEN r.observation_type = 'price_high'
             THEN b.high_threshold ELSE b.low_threshold END AS threshold_value,
           b.sample_count AS baseline_sample_count,
           ${lit(baselineStart)}::DATE AS baseline_window_start,
           ${lit(baselineEnd)}::DATE AS baseline_window_end,
           CASE WHEN r.observation_type = 'price_high'
             THEN (r.measured_value - b.baseline_median) / (b.high_threshold - b.baseline_median)
             ELSE (b.baseline_median - r.measured_value) / (b.baseline_median - b.low_threshold)
           END AS severity,
           ${lit(parameters)} AS parameters,
           ['gold/${PRICE_TABLE}'] AS input_tables,
           n.node_complete
         FROM runs r
         JOIN baseline b USING (point_of_connection)
         JOIN node_day n USING (point_of_connection)
       ) base
       ORDER BY observation_type, subject_id, start_trading_period`;

    const sentinelSql = `SELECT ${lit(date)}::DATE AS trading_date,
         b.point_of_connection, b.price_region,
         ${lit(baselineStart)}::DATE AS baseline_window_start,
         ${lit(baselineEnd)}::DATE AS baseline_window_end,
         b.sample_count AS baseline_sample_count,
         b.baseline_ready, b.baseline_median,
         b.low_percentile_value, b.high_percentile_value,
         b.low_threshold, b.high_threshold,
         coalesce(c.observation_count, 0)::INTEGER AS observation_count,
         ${stamp("node_complete")}
       FROM baseline b
       JOIN node_day n USING (point_of_connection)
       LEFT JOIN (
         SELECT point_of_connection, count(*)::INTEGER AS observation_count
         FROM runs GROUP BY point_of_connection
       ) c USING (point_of_connection)
       ORDER BY b.point_of_connection`;

    await writeGoldTables(
      connection,
      [
        [TABLES[0], sentinelSql],
        [TABLES[1], observationsSql],
      ],
      goldDir,
      date,
    );

    // A missing period (no row at all) is listed. A status-only failure is not, as in prices.ts.
    const missingReader = await connection.runAndReadAll(
      `SELECT DISTINCT trading_period AS period FROM pp
       WHERE trading_date = DATE ${lit(date)} AND rows_present = 0 ORDER BY 1`,
    );
    const missingPeriods = (
      missingReader.getRowObjectsJson() as Array<{ period: string }>
    ).map((row) => Number(row.period));
    const flags = await connection.runAndReadAll(
      `SELECT (SELECT bool_or(NOT node_complete) FROM node_day) AS incomplete,
              (SELECT bool_or(NOT baseline_ready) FROM baseline) AS no_baseline`,
    );
    const [{ incomplete, no_baseline }] = flags.getRowObjectsJson() as Array<{
      incomplete: boolean | null;
      no_baseline: boolean | null;
    }>;

    const rows = REFERENCE_NODES.length;
    const path = goldPartitionPath(goldDir, TABLES[0], date);
    return !incomplete && !no_baseline
      ? { date, status: "complete", rows, path }
      : { date, status: "partial", rows, path, missingPeriods };
  } finally {
    connection.closeSync();
  }
}

import type { DuckDBConnection } from "@duckdb/node-api";
import { lit } from "../silver/common.ts";
import { shiftDate, windowDates } from "./common.ts";

export { shiftDate, windowDates };

/**
 * The observation row of every detector (ADR-0019). A detector writes one gold table,
 * `observations_<detector_id>`, with these columns in this order. A consumer reads all
 * detectors with read_parquet over the folders gold/observations_* and union_by_name = true.
 */

export type SubjectType =
  | "point_of_connection"
  | "point_of_connection_pair"
  | "plant"
  | "fuel_category"
  | "reserve_class"
  | "island";

/** One row of an observation table. The keys are the Parquet column names. */
export interface ObservationRow {
  /** First 16 hex characters of `OBSERVATION_ID_SQL`. */
  observation_id: string;
  /** The detector, for example `price_anomaly`. */
  detector_id: string;
  /** For example `price_high` or `price_low`. */
  observation_type: string;
  /** DATE. An observation never crosses a trading date. */
  trading_date: string;
  /** Inclusive. */
  start_trading_period: number;
  /** Inclusive. */
  end_trading_period: number;
  period_count: number;
  /** Start of the first period (ADR-0003). */
  event_start_utc: Date;
  /** End of the last period. Exclusive. */
  event_end_utc: Date;
  /** Canonical subject, from ADR-0008. Columns that do not apply are null. */
  subject_type: SubjectType;
  subject_id: string;
  point_of_connection: string | null;
  island: "NI" | "SI" | null;
  /** ADR-0008 network reporting region. Null until a detector uses POC-to-region data. */
  region_id: number | null;
  plant_id: string | null;
  fuel_category: string | null;
  reserve_class: "FIR" | "SIR" | null;
  /** ADR-0012 label of a reference node. It is not `region_id`. */
  price_region: string | null;
  /** The extreme of the run: the maximum for a high run, the minimum for a low run. */
  measured_value: number;
  measured_unit: string;
  /** The baseline median. */
  baseline_value: number;
  /** The effective threshold that the run crossed. */
  threshold_value: number;
  baseline_sample_count: number;
  /** DATE, first day of the baseline window. */
  baseline_window_start: string;
  /** DATE, last day of the baseline window. */
  baseline_window_end: string;
  /** Unitless. 1 at the threshold. */
  severity: number;
  /** Canonical JSON of the detector configuration. The same text on every row. */
  parameters: string;
  /** The gold tables read, for example `gold/price_periods`. */
  input_tables: string[];
  /** ADR-0011 stamp. */
  analysis_version: number;
  inputs_sha256: string;
  inputs_complete: boolean;
}

/** The column names of an observation table, in table order. */
export const OBSERVATION_COLUMNS = [
  "observation_id",
  "detector_id",
  "observation_type",
  "trading_date",
  "start_trading_period",
  "end_trading_period",
  "period_count",
  "event_start_utc",
  "event_end_utc",
  "subject_type",
  "subject_id",
  "point_of_connection",
  "island",
  "region_id",
  "plant_id",
  "fuel_category",
  "reserve_class",
  "price_region",
  "measured_value",
  "measured_unit",
  "baseline_value",
  "threshold_value",
  "baseline_sample_count",
  "baseline_window_start",
  "baseline_window_end",
  "severity",
  "parameters",
  "input_tables",
  "analysis_version",
  "inputs_sha256",
  "inputs_complete",
] as const satisfies readonly (keyof ObservationRow)[];

/**
 * The observation ID as a SQL expression. It reads the columns `detector_id`,
 * `observation_type`, `subject_id` and `event_start_utc` of the select it is used in. It does
 * not include the analysis version, so a re-run that finds the same run start keeps the ID.
 */
export const OBSERVATION_ID_SQL =
  "left(sha256(concat_ws('|', detector_id, observation_type, subject_id, epoch(event_start_utc)::BIGINT)), 16)";

/** The config keys that the shared baseline, hit and run rules read (ADR-0019). */
export interface RunDetectorConfig {
  /** Days before the date that form the baseline. The date itself is not in it. */
  baselineWindowDays: number;
  /** Fewer complete periods in the baseline: no baseline, no observations. */
  minBaselinePeriods: number;
  highPercentile: number;
  lowPercentile: number;
  /** A threshold is at least this far from the median, in the unit of the series. */
  minDeviationFromMedian: number;
  /** Fewest consecutive periods in one observation. */
  minPeriods: number;
}

export interface RunTableOptions {
  config: RunDetectorConfig;
  date: string;
  /** Names of the observation types of a high run and a low run. */
  highType: string;
  lowType: string;
}

/**
 * The shared rule of the run detectors (ADR-0019). The detector first makes two temp tables:
 * `series(subject_id, trading_date, trading_period, event_start_utc, event_end_utc, value,
 * inputs_complete)` over the whole window and `subjects(subject_id)`, one row for each subject.
 * This function makes `baseline`, `hits` and `runs` from them.
 *
 * - `baseline`: one row for each subject, from the complete non-null values of the days before
 *   `date`. The date itself is left out, so a spike does not raise its own threshold.
 * - `hits`: a period of `date` strictly beyond a threshold. A null value is never a hit.
 * - `runs`: consecutive period numbers that hit. A run of fewer than `minPeriods` is dropped.
 *   Each run has its `direction` (`high` or `low`), the extreme `measured_value`, the
 *   `baseline_value` (median), the `threshold_value` and the `severity`.
 */
export async function createRunTables(
  connection: DuckDBConnection,
  { config, date, highType, lowType }: RunTableOptions,
): Promise<void> {
  const baselineStart = shiftDate(date, -config.baselineWindowDays);
  await connection.run(
    `CREATE TEMP TABLE baseline AS
     WITH stats AS (
       SELECT s.subject_id,
         count(b.value)::INTEGER AS sample_count,
         quantile_cont(b.value, 0.5) AS baseline_median,
         quantile_cont(b.value, ${config.highPercentile}) AS high_percentile_value,
         quantile_cont(b.value, ${config.lowPercentile}) AS low_percentile_value
       FROM subjects s
       LEFT JOIN series b
         ON b.subject_id = s.subject_id
        AND b.trading_date < DATE ${lit(date)}
        AND b.trading_date >= DATE ${lit(baselineStart)}
        AND b.value IS NOT NULL AND b.inputs_complete
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
  await connection.run(
    `CREATE TEMP TABLE hits AS
     SELECT t.subject_id, t.trading_period, t.event_start_utc, t.event_end_utc,
       t.value, 'high' AS direction
     FROM series t JOIN baseline b USING (subject_id)
     WHERE t.trading_date = DATE ${lit(date)} AND b.baseline_ready AND t.value > b.high_threshold
     UNION ALL
     SELECT t.subject_id, t.trading_period, t.event_start_utc, t.event_end_utc,
       t.value, 'low' AS direction
     FROM series t JOIN baseline b USING (subject_id)
     WHERE t.trading_date = DATE ${lit(date)} AND b.baseline_ready AND t.value < b.low_threshold`,
  );
  await connection.run(
    `CREATE TEMP TABLE runs AS
     SELECT r.subject_id, r.direction,
       CASE WHEN r.direction = 'high' THEN ${lit(highType)} ELSE ${lit(lowType)} END AS observation_type,
       r.start_trading_period, r.end_trading_period, r.period_count,
       r.event_start_utc, r.event_end_utc, r.measured_value,
       b.baseline_median AS baseline_value,
       CASE WHEN r.direction = 'high' THEN b.high_threshold ELSE b.low_threshold END AS threshold_value,
       b.sample_count AS baseline_sample_count,
       CASE WHEN r.direction = 'high'
         THEN (r.measured_value - b.baseline_median) / (b.high_threshold - b.baseline_median)
         ELSE (b.baseline_median - r.measured_value) / (b.baseline_median - b.low_threshold)
       END AS severity
     FROM (
       SELECT subject_id, direction,
         min(trading_period) AS start_trading_period,
         max(trading_period) AS end_trading_period,
         count(*)::INTEGER AS period_count,
         min(event_start_utc) AS event_start_utc,
         max(event_end_utc) AS event_end_utc,
         CASE WHEN direction = 'high' THEN max(value) ELSE min(value) END AS measured_value
       FROM (
         SELECT *, trading_period - row_number() OVER (
           PARTITION BY subject_id, direction ORDER BY trading_period) AS grp
         FROM hits
       )
       GROUP BY subject_id, direction, grp
       HAVING count(*) >= ${config.minPeriods}
     ) r
     JOIN baseline b USING (subject_id)`,
  );
}

/**
 * The observation row of every detector (ADR-0015). A detector writes one gold table,
 * `observations_<detector_id>`, with these columns in this order. A consumer reads all
 * detectors with read_parquet over the folders gold/observations_* and union_by_name = true.
 */

export type SubjectType =
  | "point_of_connection"
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

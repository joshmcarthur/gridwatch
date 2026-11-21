import { existsSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import type { PublisherDataset } from "../datasets.ts";
import { lit, type PublishResult } from "../silver/common.ts";
import {
  type GoldGoldInput,
  type GoldInput,
  type GoldPublishOptions,
  goldDataset,
  goldInputWindowDays,
  goldPartitionPath,
  goldStamp,
  inputFingerprint,
  shiftDate,
  windowDates,
  writeGoldTables,
} from "./common.ts";
import {
  createRunTables,
  OBSERVATION_ID_SQL,
  type RunDetectorConfig,
  type SubjectType,
} from "./observation.ts";

/** Typed observation columns. Pair subjects leave POC, island and price_region null (ADR-0019). */
export interface ObservationSubjectColumns {
  point_of_connection: string;
  island: string;
  region_id?: string;
  plant_id?: string;
  fuel_category?: string;
  reserve_class?: string;
  price_region: string;
}

/**
 * What a run detector keeps in its own file: series SQL, subjects SQL, config, observation
 * types and the subject column mapping. The kit owns DuckDB, the fingerprint, the stamp and
 * the write.
 */
export interface RunDetectorSpec {
  detectorId: string;
  analysisVersion: number;
  config: RunDetectorConfig;
  tables: readonly [string, string];
  inputs: readonly GoldInput[];
  highType: string;
  lowType: string;
  measuredUnit: string;
  subjectType: SubjectType;
  /**
   * SELECT that yields at least `subject_id`. Extra columns are `s.*` in the mapping. It may
   * read the temp table `input`. A function receives the date under test.
   */
  subjectsSql: string | ((date: string) => string);
  /**
   * SELECT that yields `subject_id, trading_date, trading_period, event_start_utc,
   * event_end_utc, value, inputs_complete`. It may read the temp table `input`.
   */
  seriesSql: string;
  subjectColumns: ObservationSubjectColumns;
  /** SQL that returns `{ period }` of missing trading periods on the date. Reads `input`. */
  missingPeriodsSql: (date: string) => string;
}

const windowedGoldInput = (
  inputs: readonly GoldInput[],
): GoldGoldInput & { windowDays: number } => {
  for (const input of inputs) {
    switch (input.layer) {
      case "gold": {
        const windowDays = goldInputWindowDays(input);
        if (windowDays !== undefined) return { ...input, windowDays };
        break;
      }
      case "silver":
        break;
      default: {
        const unreachable: never = input;
        return unreachable;
      }
    }
  }
  throw new Error("a run detector needs a gold input with windowDays");
};

const inputTableSql = (input: GoldInput): string => {
  switch (input.layer) {
    case "gold":
      return lit(`gold/${input.table}`);
    case "silver":
      return lit(`silver/${input.table}`);
    default: {
      const unreachable: never = input;
      return unreachable;
    }
  }
};

/** The registry entry of a run detector. Fingerprints go through `goldDataset`. */
export const runDetectorDataset = (spec: RunDetectorSpec): PublisherDataset =>
  goldDataset({
    id: `gold_${spec.detectorId}`,
    tables: spec.tables,
    inputs: spec.inputs,
    analysisVersion: spec.analysisVersion,
    publish: (options) => publishRunDetector(options, spec),
  });

/**
 * Publish the sentinel and the observations of one trading date (ADR-0019). Missing: the date
 * has no partition of the windowed gold input. Partial: a subject-day is incomplete, or a
 * subject has no baseline. Both tables are still written.
 */
export async function publishRunDetector(
  options: GoldPublishOptions,
  spec: RunDetectorSpec,
): Promise<PublishResult> {
  const { silverDir, goldDir, completeness, date } = options;
  const windowed = windowedGoldInput(spec.inputs);
  if (!existsSync(goldPartitionPath(goldDir, windowed.table, date)))
    return { date, status: "missing" };

  const files = windowDates(date, windowed.windowDays)
    .map((day) => goldPartitionPath(goldDir, windowed.table, day))
    .filter((file) => existsSync(file));
  const baselineStart = shiftDate(date, -spec.config.baselineWindowDays);
  const baselineEnd = shiftDate(date, -1);
  const columns = spec.subjectColumns;
  const parameters = JSON.stringify(spec.config);
  const byPeriod = spec.config.baselineByTradingPeriod === true;
  const subjectsSql =
    typeof spec.subjectsSql === "function"
      ? spec.subjectsSql(date)
      : spec.subjectsSql;

  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    await connection.run("SET threads = 1");
    const inputsSha256 = await inputFingerprint(
      silverDir,
      goldDir,
      spec.analysisVersion,
      spec.inputs,
      completeness,
      date,
    );
    const stamp = (completeSql: string) =>
      goldStamp(spec.analysisVersion, inputsSha256, completeSql);

    await connection.run(
      `CREATE TEMP TABLE input AS SELECT * FROM read_parquet([${files.map(lit).join(", ")}])`,
    );
    await connection.run(`CREATE TEMP TABLE subjects AS ${subjectsSql}`);
    await connection.run(`CREATE TEMP TABLE series AS ${spec.seriesSql}`);
    await createRunTables(connection, {
      config: spec.config,
      date,
      highType: spec.highType,
      lowType: spec.lowType,
    });
    await connection.run(
      `CREATE TEMP TABLE subject_day AS
       SELECT s.subject_id,
         coalesce(bool_and(t.inputs_complete), false) AS subject_complete
       FROM subjects s
       LEFT JOIN series t
         ON t.subject_id = s.subject_id AND t.trading_date = DATE ${lit(date)}
       GROUP BY s.subject_id`,
    );

    const observationsSql = `SELECT ${OBSERVATION_ID_SQL} AS observation_id,
         detector_id, observation_type, trading_date, start_trading_period, end_trading_period,
         period_count, event_start_utc, event_end_utc, subject_type, subject_id,
         point_of_connection, island, region_id, plant_id, fuel_category, reserve_class,
         price_region, measured_value, measured_unit, baseline_value, threshold_value,
         baseline_sample_count, baseline_window_start, baseline_window_end, severity,
         parameters, input_tables,
         ${stamp("subject_complete")}
       FROM (
         SELECT ${lit(spec.detectorId)} AS detector_id, r.observation_type,
           ${lit(date)}::DATE AS trading_date,
           r.start_trading_period, r.end_trading_period, r.period_count,
           r.event_start_utc, r.event_end_utc,
           ${lit(spec.subjectType)} AS subject_type,
           r.subject_id,
           ${columns.point_of_connection} AS point_of_connection,
           ${columns.island} AS island,
           ${columns.region_id ?? "NULL::INTEGER"} AS region_id,
           ${columns.plant_id ?? "NULL::VARCHAR"} AS plant_id,
           ${columns.fuel_category ?? "NULL::VARCHAR"} AS fuel_category,
           ${columns.reserve_class ?? "NULL::VARCHAR"} AS reserve_class,
           ${columns.price_region} AS price_region,
           r.measured_value,
           ${lit(spec.measuredUnit)} AS measured_unit,
           r.baseline_value,
           r.threshold_value,
           r.baseline_sample_count,
           ${lit(baselineStart)}::DATE AS baseline_window_start,
           ${lit(baselineEnd)}::DATE AS baseline_window_end,
           r.severity,
           ${lit(parameters)} AS parameters,
           [${spec.inputs.map(inputTableSql).join(", ")}] AS input_tables,
           coalesce(d.subject_complete, false) AS subject_complete
         FROM runs r
         JOIN subjects s ON s.subject_id = r.subject_id
         LEFT JOIN subject_day d ON d.subject_id = r.subject_id
       ) base
       ORDER BY observation_type, subject_id, start_trading_period`;

    const sentinelSql = `SELECT ${lit(date)}::DATE AS trading_date,
         b.subject_id,
         ${byPeriod ? "b.trading_period," : ""}
         ${lit(baselineStart)}::DATE AS baseline_window_start,
         ${lit(baselineEnd)}::DATE AS baseline_window_end,
         b.sample_count AS baseline_sample_count,
         b.baseline_ready, b.baseline_median,
         b.low_percentile_value, b.high_percentile_value,
         b.low_threshold, b.high_threshold,
         coalesce(c.observation_count, 0)::INTEGER AS observation_count,
         ${stamp("coalesce(d.subject_complete, false)")}
       FROM baseline b
       LEFT JOIN subject_day d ON d.subject_id = b.subject_id
       LEFT JOIN (
         SELECT subject_id, count(*)::INTEGER AS observation_count
         FROM runs GROUP BY subject_id
       ) c ON c.subject_id = b.subject_id
       ORDER BY b.subject_id${byPeriod ? ", b.trading_period" : ""}`;

    await writeGoldTables(
      connection,
      [
        [spec.tables[0], sentinelSql],
        [spec.tables[1], observationsSql],
      ],
      goldDir,
      date,
    );

    const missingReader = await connection.runAndReadAll(
      spec.missingPeriodsSql(date),
    );
    const missingPeriods = (
      missingReader.getRowObjectsJson() as Array<{ period: string }>
    ).map((row) => Number(row.period));
    const flags = await connection.runAndReadAll(
      `SELECT (SELECT bool_or(NOT subject_complete) FROM subject_day) AS incomplete,
              (SELECT bool_or(NOT baseline_ready) FROM baseline) AS no_baseline`,
    );
    const [{ incomplete, no_baseline }] = flags.getRowObjectsJson() as Array<{
      incomplete: boolean | null;
      no_baseline: boolean | null;
    }>;

    const path = goldPartitionPath(goldDir, spec.tables[0], date);
    const countReader = await connection.runAndReadAll(
      `SELECT count(*)::INTEGER AS n FROM read_parquet(${lit(path)})`,
    );
    const [{ n: rows }] = countReader.getRowObjectsJson() as Array<{
      n: number;
    }>;
    return !incomplete && !no_baseline
      ? { date, status: "complete", rows, path }
      : { date, status: "partial", rows, path, missingPeriods };
  } finally {
    connection.closeSync();
  }
}

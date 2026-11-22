import { lit } from "../silver/common.ts";
import { periodsInTradingDate } from "../trading-time.ts";
import {
  type GoldInput,
  type GoldPublishOptions,
  ISLANDS,
  islandLiterals,
} from "./common.ts";
import { TABLES as GRID_LOAD_TABLES } from "./grid-load.ts";
import type { RunDetectorConfig } from "./observation.ts";
import {
  publishRunDetector,
  type RunDetectorSpec,
  runDetectorDataset,
} from "./run-detector.ts";

/**
 * The demand-deviation detector (ADR-0020). It reads gold `grid_load_period` and flags runs
 * whose modelled grid load is far outside that subject's own same-weekday, same-period
 * history. The series is modelled RTD load, not consumption. Bump `ANALYSIS_VERSION` by hand
 * with any change to the logic or to a config value (ADR-0011). A test pins the config hash.
 */
export const ANALYSIS_VERSION = 1;

const DETECTOR_ID = "demand_deviation";
const LOAD_TABLE = GRID_LOAD_TABLES[0];
const MEASURED_UNIT = "MWh";
const NATIONAL = "NZ";

export type DemandDeviationConfig = RunDetectorConfig;

/** Provisional. Checked against the backfill and changed by a version bump. */
export const DEMAND_DEVIATION_CONFIG: DemandDeviationConfig = {
  baselineWindowDays: 56,
  minBaselinePeriods: 4,
  highPercentile: 0.99,
  lowPercentile: 0.01,
  minDeviationFromMedian: 50,
  minPeriods: 2,
  baselineByTradingPeriod: true,
  baselineSameWeekday: true,
};

/** The gold tables of this module. The first is the sentinel: the runner reads it and it is written last. */
export const TABLES = [
  "demand_deviation_baselines",
  `observations_${DETECTOR_ID}`,
] as const;

const islandSubjectsSql = (): string => {
  const islandRows = ISLANDS.map(
    (island) => `(${lit(island)}, ${lit(island)})`,
  );
  return `SELECT * FROM (VALUES ${islandRows.join(", ")}, (${lit(NATIONAL)}, NULL::VARCHAR)) s(subject_id, island)`;
};

const inputsFor = (config: DemandDeviationConfig): GoldInput[] => [
  {
    layer: "gold",
    table: LOAD_TABLE,
    versionColumn: "inputs_sha256",
    completenessDataset: null,
    windowDays: config.baselineWindowDays,
  },
];

const seriesSql = (): string => {
  const niSi = islandLiterals().join(", ");
  return `WITH island_day AS (
     SELECT island, trading_date, bool_and(inputs_complete) AS day_complete
     FROM input
     WHERE island IN (${niSi})
     GROUP BY island, trading_date
   ),
   islands AS (
     SELECT i.island AS subject_id, i.trading_date, i.trading_period,
       i.event_start_utc, i.event_end_utc, i.load_mwh AS value,
       i.inputs_complete AND d.day_complete AS inputs_complete
     FROM input i
     JOIN island_day d ON d.island = i.island AND d.trading_date = i.trading_date
     WHERE i.island IN (${niSi})
   )
   SELECT * FROM islands
   UNION ALL
   SELECT ${lit(NATIONAL)} AS subject_id, ni.trading_date, ni.trading_period,
     ni.event_start_utc, ni.event_end_utc,
     CASE WHEN ni.value IS NOT NULL AND si.value IS NOT NULL
       THEN ni.value + si.value END AS value,
     ni.inputs_complete AND si.inputs_complete AS inputs_complete
   FROM islands ni
   JOIN islands si
     ON si.subject_id = ${lit("SI")}
    AND si.trading_date = ni.trading_date
    AND si.trading_period = ni.trading_period
   WHERE ni.subject_id = ${lit("NI")}`;
};

const specFor = (config: DemandDeviationConfig): RunDetectorSpec => ({
  detectorId: DETECTOR_ID,
  analysisVersion: ANALYSIS_VERSION,
  config,
  tables: TABLES,
  inputs: inputsFor(config),
  highType: "demand_high",
  lowType: "demand_low",
  measuredUnit: MEASURED_UNIT,
  subjectType: "island",
  subjectsSql: islandSubjectsSql(),
  seriesSql: seriesSql(),
  subjectColumns: {
    point_of_connection: "NULL::VARCHAR",
    island: "s.island",
    price_region: "NULL::VARCHAR",
  },
  missingPeriodsSql: (date) =>
    `SELECT generate_series AS period
     FROM generate_series(1, ${periodsInTradingDate(date)})
     WHERE generate_series NOT IN (
       SELECT trading_period FROM input
       WHERE trading_date = DATE ${lit(date)}
         AND island IN (${islandLiterals().join(", ")})
         AND load_mwh IS NOT NULL
       GROUP BY trading_period
       HAVING count(*) = ${ISLANDS.length}
     )
     ORDER BY 1`,
});

export const demandDeviationDataset = (
  config: DemandDeviationConfig = DEMAND_DEVIATION_CONFIG,
) => runDetectorDataset(specFor(config));

export const demandDeviation = demandDeviationDataset();

export const publishDemandDeviation = (
  options: GoldPublishOptions,
  config: DemandDeviationConfig = DEMAND_DEVIATION_CONFIG,
) => publishRunDetector(options, specFor(config));

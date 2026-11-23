import { lit } from "../silver/common.ts";
import { periodsInTradingDate } from "../trading-time.ts";
import {
  type GoldInput,
  type GoldPublishOptions,
  shiftDate,
} from "./common.ts";
import type { RunDetectorConfig } from "./observation.ts";
import {
  publishRunDetector,
  type RunDetectorSpec,
  runDetectorDataset,
} from "./run-detector.ts";

/**
 * Plant and fuel generation-change detectors (ADR-0019). They read gold generation and flag
 * runs of periods whose average MW is far outside that subject's own same-period history.
 * Battery is not a subject (ADR-0008 / ADR-0017). Bump `ANALYSIS_VERSION` by hand with any
 * change to the logic or to a config value (ADR-0011). Tests pin the config hashes.
 */
export const ANALYSIS_VERSION = 2;

const MEASURED_UNIT = "MW";
const BATTERY = "battery";
const PLANT_TABLE = "generation_by_plant_period";
const FUEL_TABLE = "generation_by_fuel_period";

export type PlantGenerationChangeConfig = RunDetectorConfig & {
  /** Ignore plants whose mean `average_megawatts` over the baseline window is below this. */
  minPlantAverageMw: number;
};

export type FuelGenerationChangeConfig = RunDetectorConfig;

/** Floor 200 MW after the #179 backfill. Bump `ANALYSIS_VERSION` with any further change. */
export const PLANT_GENERATION_CHANGE_CONFIG: PlantGenerationChangeConfig = {
  baselineWindowDays: 28,
  minBaselinePeriods: 14,
  highPercentile: 0.99,
  lowPercentile: 0.01,
  minDeviationFromMedian: 200,
  minPeriods: 2,
  baselineByTradingPeriod: true,
  minPlantAverageMw: 30,
};

/** Floor 200 MW after the #179 backfill. Island-fuel series have no size cutoff. */
export const FUEL_GENERATION_CHANGE_CONFIG: FuelGenerationChangeConfig = {
  baselineWindowDays: 28,
  minBaselinePeriods: 14,
  highPercentile: 0.99,
  lowPercentile: 0.01,
  minDeviationFromMedian: 200,
  minPeriods: 2,
  baselineByTradingPeriod: true,
};

export const PLANT_TABLES = [
  "plant_generation_change_baselines",
  "observations_plant_generation_change",
] as const;

export const FUEL_TABLES = [
  "fuel_generation_change_baselines",
  "observations_fuel_generation_change",
] as const;

const goldInput = (table: string, windowDays: number): GoldInput => ({
  layer: "gold",
  table,
  versionColumn: "inputs_sha256",
  completenessDataset: null,
  windowDays,
});

const missingPeriodsSql = (date: string) =>
  `SELECT generate_series AS period
     FROM generate_series(1, ${periodsInTradingDate(date)})
     WHERE generate_series NOT IN (
       SELECT DISTINCT trading_period FROM input WHERE trading_date = DATE ${lit(date)}
     )
     ORDER BY 1`;

const plantSubjectsSql = (
  config: PlantGenerationChangeConfig,
  date: string,
): string => {
  const baselineStart = shiftDate(date, -config.baselineWindowDays);
  return `SELECT plant_id AS subject_id,
     any_value(island) AS island,
     any_value(fuel_category) AS fuel_category
     FROM input
     WHERE fuel_category IS DISTINCT FROM ${lit(BATTERY)}
       AND trading_date >= DATE ${lit(baselineStart)}
       AND trading_date < DATE ${lit(date)}
       AND inputs_complete
       AND average_megawatts IS NOT NULL
     GROUP BY plant_id
     HAVING avg(average_megawatts) >= ${config.minPlantAverageMw}`;
};

const plantSpecFor = (
  config: PlantGenerationChangeConfig,
): RunDetectorSpec => ({
  detectorId: "plant_generation_change",
  analysisVersion: ANALYSIS_VERSION,
  config,
  tables: PLANT_TABLES,
  inputs: [goldInput(PLANT_TABLE, config.baselineWindowDays)],
  highType: "generation_high",
  lowType: "generation_low",
  measuredUnit: MEASURED_UNIT,
  subjectType: "plant",
  subjectsSql: (date) => plantSubjectsSql(config, date),
  seriesSql: `SELECT plant_id AS subject_id, trading_date, trading_period,
     event_start_utc, event_end_utc, average_megawatts AS value, inputs_complete
     FROM input`,
  subjectColumns: {
    point_of_connection: "NULL::VARCHAR",
    island: "s.island",
    plant_id: "r.subject_id",
    fuel_category: "s.fuel_category",
    price_region: "NULL::VARCHAR",
  },
  missingPeriodsSql,
});

const fuelSpecFor = (config: FuelGenerationChangeConfig): RunDetectorSpec => ({
  detectorId: "fuel_generation_change",
  analysisVersion: ANALYSIS_VERSION,
  config,
  tables: FUEL_TABLES,
  inputs: [goldInput(FUEL_TABLE, config.baselineWindowDays)],
  highType: "generation_high",
  lowType: "generation_low",
  measuredUnit: MEASURED_UNIT,
  subjectType: "fuel_category",
  subjectsSql: `SELECT fuel_category || '|' || island AS subject_id,
     fuel_category, island
     FROM input
     WHERE fuel_category IS DISTINCT FROM ${lit(BATTERY)}
       AND island IS NOT NULL
     GROUP BY fuel_category, island`,
  seriesSql: `SELECT fuel_category || '|' || island AS subject_id, trading_date, trading_period,
     event_start_utc, event_end_utc, average_megawatts AS value, inputs_complete
     FROM input
     WHERE fuel_category IS DISTINCT FROM ${lit(BATTERY)}
       AND island IS NOT NULL`,
  subjectColumns: {
    point_of_connection: "NULL::VARCHAR",
    island: "s.island",
    fuel_category: "s.fuel_category",
    price_region: "NULL::VARCHAR",
  },
  missingPeriodsSql,
});

export const plantGenerationChangeDataset = (
  config: PlantGenerationChangeConfig = PLANT_GENERATION_CHANGE_CONFIG,
) => runDetectorDataset(plantSpecFor(config));

export const fuelGenerationChangeDataset = (
  config: FuelGenerationChangeConfig = FUEL_GENERATION_CHANGE_CONFIG,
) => runDetectorDataset(fuelSpecFor(config));

export const plantGenerationChange = plantGenerationChangeDataset();
export const fuelGenerationChange = fuelGenerationChangeDataset();

export const publishPlantGenerationChange = (
  options: GoldPublishOptions,
  config: PlantGenerationChangeConfig = PLANT_GENERATION_CHANGE_CONFIG,
) => publishRunDetector(options, plantSpecFor(config));

export const publishFuelGenerationChange = (
  options: GoldPublishOptions,
  config: FuelGenerationChangeConfig = FUEL_GENERATION_CHANGE_CONFIG,
) => publishRunDetector(options, fuelSpecFor(config));

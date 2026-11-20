import { lit } from "../silver/common.ts";
import type { GoldInput, GoldPublishOptions } from "./common.ts";
import type { RunDetectorConfig } from "./observation.ts";
import { TABLES as PRICE_TABLES, SPREAD_PAIRS } from "./prices.ts";
import {
  publishRunDetector,
  type RunDetectorSpec,
  runDetectorDataset,
} from "./run-detector.ts";

/**
 * The price separation detector (ADR-0019). It reads the gold `price_spreads` of the three
 * reference node pairs and flags runs of periods whose spread is far outside the pair's own
 * recent history. It does not say why. Pair rows leave the typed node columns null. Bump
 * `ANALYSIS_VERSION` by hand with any change to the logic or to a config value (ADR-0011). A
 * test pins the config hash.
 */
export const ANALYSIS_VERSION = 1;

const DETECTOR_ID = "price_separation";
const SPREAD_TABLE = PRICE_TABLES[2];
const MEASURED_UNIT = "$/MWh";

export type PriceSeparationConfig = RunDetectorConfig;

/** Provisional. The values are checked against the backfill and changed by a version bump. */
export const PRICE_SEPARATION_CONFIG: PriceSeparationConfig = {
  baselineWindowDays: 28,
  minBaselinePeriods: 672,
  highPercentile: 0.99,
  lowPercentile: 0.01,
  minDeviationFromMedian: 100,
  minPeriods: 2,
};

/** The gold tables of this module. The first is the sentinel: the runner reads it and it is written last. */
export const TABLES = [
  "price_separation_baselines",
  `observations_${DETECTOR_ID}`,
] as const;

const inputsFor = (config: PriceSeparationConfig): GoldInput[] => [
  {
    layer: "gold",
    table: SPREAD_TABLE,
    versionColumn: "inputs_sha256",
    completenessDataset: null,
    windowDays: config.baselineWindowDays,
  },
];

const specFor = (config: PriceSeparationConfig): RunDetectorSpec => ({
  detectorId: DETECTOR_ID,
  analysisVersion: ANALYSIS_VERSION,
  config,
  tables: TABLES,
  inputs: inputsFor(config),
  highType: "separation_high",
  lowType: "separation_low",
  measuredUnit: MEASURED_UNIT,
  subjectType: "point_of_connection_pair",
  subjectsSql: `SELECT from_poc || '-' || to_poc AS subject_id
     FROM (VALUES ${SPREAD_PAIRS.map(
       ([from, to]) => `(${lit(from)}, ${lit(to)})`,
     ).join(", ")}) p(from_poc, to_poc)`,
  seriesSql: `SELECT from_point_of_connection || '-' || to_point_of_connection AS subject_id,
     trading_date, trading_period, event_start_utc, event_end_utc,
     spread AS value, inputs_complete
     FROM input`,
  subjectColumns: {
    point_of_connection: "NULL::VARCHAR",
    island: "NULL::VARCHAR",
    price_region: "NULL::VARCHAR",
  },
  missingPeriodsSql: (date) =>
    `SELECT DISTINCT trading_period AS period FROM input
     WHERE trading_date = DATE ${lit(date)} AND spread IS NULL ORDER BY 1`,
});

export const priceSeparationDataset = (
  config: PriceSeparationConfig = PRICE_SEPARATION_CONFIG,
) => runDetectorDataset(specFor(config));

export const priceSeparation = priceSeparationDataset();

export const publishPriceSeparations = (
  options: GoldPublishOptions,
  config: PriceSeparationConfig = PRICE_SEPARATION_CONFIG,
) => publishRunDetector(options, specFor(config));

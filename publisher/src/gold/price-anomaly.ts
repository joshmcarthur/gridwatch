import { lit } from "../silver/common.ts";
import type { GoldInput, GoldPublishOptions } from "./common.ts";
import type { RunDetectorConfig } from "./observation.ts";
import { TABLES as PRICE_TABLES, REFERENCE_NODES } from "./prices.ts";
import {
  publishRunDetector,
  type RunDetectorSpec,
  runDetectorDataset,
} from "./run-detector.ts";

/**
 * The price anomaly detector (ADR-0019). It reads the gold `price_periods` of the three
 * reference nodes and flags runs of periods whose price is far outside the node's own recent
 * history. Bump `ANALYSIS_VERSION` by hand with any change to the logic or to a config value
 * (ADR-0011). A test pins the config hash.
 */
export const ANALYSIS_VERSION = 1;

const DETECTOR_ID = "price_anomaly";
const PRICE_TABLE = PRICE_TABLES[0];
const MEASURED_UNIT = "$/MWh";

/** Island of each reference node. Do not grow `REFERENCE_NODES` with this (ADR-0019). */
const NODE_ISLAND: {
  [K in (typeof REFERENCE_NODES)[number]["pointOfConnection"]]: "NI" | "SI";
} = {
  OTA2201: "NI",
  HAY2201: "NI",
  BEN2201: "SI",
};

export type PriceAnomalyConfig = RunDetectorConfig;

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

const inputsFor = (config: PriceAnomalyConfig): GoldInput[] => [
  {
    layer: "gold",
    table: PRICE_TABLE,
    versionColumn: "inputs_sha256",
    completenessDataset: null,
    windowDays: config.baselineWindowDays,
  },
];

const specFor = (config: PriceAnomalyConfig): RunDetectorSpec => ({
  detectorId: DETECTOR_ID,
  analysisVersion: ANALYSIS_VERSION,
  config,
  tables: TABLES,
  inputs: inputsFor(config),
  highType: "price_high",
  lowType: "price_low",
  measuredUnit: MEASURED_UNIT,
  subjectType: "point_of_connection",
  subjectsSql: `SELECT * FROM (VALUES ${REFERENCE_NODES.map(
    (n) =>
      `(${lit(n.pointOfConnection)}, ${lit(n.priceRegion)}, ${lit(NODE_ISLAND[n.pointOfConnection])})`,
  ).join(", ")}) n(subject_id, price_region, island)`,
  seriesSql: `SELECT point_of_connection AS subject_id, trading_date, trading_period,
     event_start_utc, event_end_utc, price AS value, inputs_complete
     FROM input`,
  subjectColumns: {
    point_of_connection: "r.subject_id",
    island: "s.island",
    price_region: "s.price_region",
  },
  missingPeriodsSql: (date) =>
    `SELECT DISTINCT trading_period AS period FROM input
     WHERE trading_date = DATE ${lit(date)} AND rows_present = 0 ORDER BY 1`,
});

export const priceAnomalyDataset = (
  config: PriceAnomalyConfig = PRICE_ANOMALY_CONFIG,
) => runDetectorDataset(specFor(config));

export const priceAnomaly = priceAnomalyDataset();

export const publishPriceAnomalies = (
  options: GoldPublishOptions,
  config: PriceAnomalyConfig = PRICE_ANOMALY_CONFIG,
) => publishRunDetector(options, specFor(config));

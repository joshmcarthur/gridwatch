import { lit } from "../silver/common.ts";
import {
  type GoldInput,
  type GoldPublishOptions,
  ISLANDS,
  type Island,
} from "./common.ts";
import type { RunDetectorConfig } from "./observation.ts";
import { TABLES as RESERVE_TABLES } from "./reserves.ts";
import {
  publishRunDetector,
  type RunDetectorSpec,
  runDetectorDataset,
} from "./run-detector.ts";

/**
 * The reserve-price anomaly detector (ADR-0019). It reads gold `reserve_by_class_island_period`
 * and flags runs whose FIR or SIR price on one island is far outside that class-island's own
 * recent history. Bump `ANALYSIS_VERSION` by hand with any change to the logic or to a config
 * value (ADR-0011). A test pins the config hash.
 */
export const ANALYSIS_VERSION = 1;

const DETECTOR_ID = "reserve_price_anomaly";
const RESERVE_TABLE = RESERVE_TABLES[0];
const MEASURED_UNIT = "$/MWh";

const RESERVE_CLASSES = ["FIR", "SIR"] as const;
export type ReserveClass = (typeof RESERVE_CLASSES)[number];

const reserveClassCode = (reserveClass: ReserveClass): ReserveClass => {
  switch (reserveClass) {
    case "FIR":
      return "FIR";
    case "SIR":
      return "SIR";
    default: {
      const unreachable: never = reserveClass;
      return unreachable;
    }
  }
};

const islandCode = (island: Island): Island => {
  switch (island) {
    case "NI":
      return "NI";
    case "SI":
      return "SI";
    default: {
      const unreachable: never = island;
      return unreachable;
    }
  }
};

/** The four class-island series. `subject_id` is `FIR|NI`. */
export const RESERVE_SUBJECTS: ReadonlyArray<{
  reserveClass: ReserveClass;
  island: Island;
  subjectId: string;
}> = RESERVE_CLASSES.flatMap((reserveClass) =>
  ISLANDS.map((island) => {
    const cls = reserveClassCode(reserveClass);
    const isl = islandCode(island);
    return { reserveClass: cls, island: isl, subjectId: `${cls}|${isl}` };
  }),
);

export type ReservePriceAnomalyConfig = RunDetectorConfig;

/**
 * Provisional. Reserve prices sit at $0 for long stretches, so the deviation floor is $10
 * rather than the energy detector's $25: $10 is large next to a typical $0–$1 FIR price, and
 * small enough that a genuine security spike still clears it. A test pins the hash.
 */
export const RESERVE_PRICE_ANOMALY_CONFIG: ReservePriceAnomalyConfig = {
  baselineWindowDays: 28,
  minBaselinePeriods: 672,
  highPercentile: 0.99,
  lowPercentile: 0.01,
  minDeviationFromMedian: 10,
  minPeriods: 2,
};

/** The gold tables of this module. The first is the sentinel: the runner reads it and it is written last. */
export const TABLES = [
  "reserve_price_anomaly_baselines",
  `observations_${DETECTOR_ID}`,
] as const;

const inputsFor = (config: ReservePriceAnomalyConfig): GoldInput[] => [
  {
    layer: "gold",
    table: RESERVE_TABLE,
    versionColumn: "inputs_sha256",
    completenessDataset: null,
    windowDays: config.baselineWindowDays,
  },
];

const specFor = (config: ReservePriceAnomalyConfig): RunDetectorSpec => ({
  detectorId: DETECTOR_ID,
  analysisVersion: ANALYSIS_VERSION,
  config,
  tables: TABLES,
  inputs: inputsFor(config),
  highType: "reserve_price_high",
  lowType: "reserve_price_low",
  measuredUnit: MEASURED_UNIT,
  subjectType: "reserve_class",
  subjectsSql: `SELECT * FROM (VALUES ${RESERVE_SUBJECTS.map(
    (s) => `(${lit(s.subjectId)}, ${lit(s.reserveClass)}, ${lit(s.island)})`,
  ).join(", ")}) n(subject_id, reserve_class, island)`,
  seriesSql: `SELECT reserve_class || '|' || island AS subject_id, trading_date, trading_period,
     event_start_utc, event_end_utc, dollars_per_megawatt_hour AS value, inputs_complete
     FROM input`,
  subjectColumns: {
    point_of_connection: "NULL::VARCHAR",
    island: "s.island",
    reserve_class: "s.reserve_class",
    price_region: "NULL::VARCHAR",
  },
  missingPeriodsSql: (date) =>
    `SELECT DISTINCT trading_period AS period FROM input
     WHERE trading_date = DATE ${lit(date)} AND rows_present = 0 ORDER BY 1`,
});

export const reservePriceAnomalyDataset = (
  config: ReservePriceAnomalyConfig = RESERVE_PRICE_ANOMALY_CONFIG,
) => runDetectorDataset(specFor(config));

export const reservePriceAnomaly = reservePriceAnomalyDataset();

export const publishReservePriceAnomalies = (
  options: GoldPublishOptions,
  config: ReservePriceAnomalyConfig = RESERVE_PRICE_ANOMALY_CONFIG,
) => publishRunDetector(options, specFor(config));

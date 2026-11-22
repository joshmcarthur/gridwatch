import { existsSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { lit, type PublishResult } from "../silver/common.ts";
import {
  asIso,
  type GoldInput,
  type GoldPublishOptions,
  goldDataset,
  goldPartitionPath,
  goldStamp,
  inputFingerprint,
  listSql,
  writeGoldTables,
} from "./common.ts";
import { TABLES as DEMAND_DEVIATION_TABLES } from "./demand-deviation.ts";
import {
  EPISODE_GROUPING_CONFIG,
  type EpisodeGroupingConfig,
  type GroupedEpisode,
  type GroupingObservation,
  groupObservations,
} from "./episodes-group.ts";
import { FUEL_TABLES as FUEL_GENERATION_CHANGE_TABLES } from "./generation-change.ts";
import type { SubjectType } from "./observation.ts";
import { TABLES as PRICE_ANOMALY_TABLES } from "./price-anomaly.ts";
import { TABLES as PRICE_SEPARATION_TABLES } from "./price-separation.ts";
import { TABLES as RESERVE_PRICE_ANOMALY_TABLES } from "./reserve-price-anomaly.ts";

/**
 * Bump by hand when the grouping rules or a config value change (ADR-0011, ADR-0021).
 */
export const ANALYSIS_VERSION = 2;

export { EPISODE_GROUPING_CONFIG, type EpisodeGroupingConfig };

/**
 * Detector sentinels, not observation tables: an empty observations partition has no
 * `inputs_sha256` rows, so fingerprinting it would drop quiet days (ADR-0021).
 */
const DETECTORS = [
  {
    sentinel: PRICE_ANOMALY_TABLES[0],
    observations: PRICE_ANOMALY_TABLES[1],
  },
  {
    sentinel: PRICE_SEPARATION_TABLES[0],
    observations: PRICE_SEPARATION_TABLES[1],
  },
  {
    sentinel: RESERVE_PRICE_ANOMALY_TABLES[0],
    observations: RESERVE_PRICE_ANOMALY_TABLES[1],
  },
] as const;

/** Observation partitions that grouping reads. Site export joins the same set for highlights. */
export const DETECTOR_OBSERVATION_TABLES = DETECTORS.map(
  (detector) => detector.observations,
);

/**
 * Observations that corroborate an episode without being members of it (issue #180, ADR-0021).
 * One matches when it is on the episode's trading date, overlaps its time span and has an island
 * that is one of the episode's islands. A null island (national demand) never matches. Plant-level
 * generation change is left out until its noise is cut (#179). Ranking and evidence share this list.
 */
export const CORROBORATION_RULES = [
  {
    table: FUEL_GENERATION_CHANGE_TABLES[1],
    observationType: "generation_low",
  },
  { table: DEMAND_DEVIATION_TABLES[1], observationType: "demand_high" },
] as const;

export const TABLES = ["episode_days", "episodes"] as const;

export const INPUTS: GoldInput[] = DETECTORS.map((detector) => ({
  layer: "gold" as const,
  table: detector.sentinel,
  versionColumn: "inputs_sha256" as const,
  completenessDataset: null,
}));

const SUBJECT_TYPES: readonly SubjectType[] = [
  "point_of_connection",
  "point_of_connection_pair",
  "plant",
  "fuel_category",
  "reserve_class",
  "island",
];

const asSubjectType = (value: string): SubjectType => {
  for (const type of SUBJECT_TYPES) if (type === value) return type;
  throw new TypeError(`unknown subject_type ${value}`);
};

interface ObservationRow {
  observation_id: string;
  observation_type: string;
  trading_date: string;
  start_trading_period: number;
  end_trading_period: number;
  event_start_utc: unknown;
  event_end_utc: unknown;
  subject_type: string;
  subject_id: string;
  island: string | null;
  plant_id: string | null;
  measured_value: number;
  severity: number;
  inputs_complete: boolean;
}

const toGrouping = (
  row: ObservationRow,
  date: string,
): GroupingObservation => ({
  observation_id: row.observation_id,
  observation_type: row.observation_type,
  trading_date: typeof row.trading_date === "string" ? row.trading_date : date,
  start_trading_period: Number(row.start_trading_period),
  end_trading_period: Number(row.end_trading_period),
  event_start_utc: asIso(row.event_start_utc),
  event_end_utc: asIso(row.event_end_utc),
  subject_type: asSubjectType(row.subject_type),
  subject_id: row.subject_id,
  island: row.island,
  plant_id: row.plant_id,
  measured_value: Number(row.measured_value),
  severity: Number(row.severity),
  inputs_complete: Boolean(row.inputs_complete),
});

const episodeValuesSql = (episode: GroupedEpisode): string =>
  `(${lit(episode.episode_id)}, ${lit(episode.seed_observation_id)},
    DATE ${lit(episode.trading_date)},
    ${episode.start_trading_period}::INTEGER, ${episode.end_trading_period}::INTEGER,
    ${episode.period_count}::INTEGER,
    ${lit(episode.event_start_utc)}::TIMESTAMPTZ,
    ${lit(episode.event_end_utc)}::TIMESTAMPTZ,
    ${listSql(episode.member_observation_ids)},
    ${episode.member_count}::INTEGER,
    ${listSql(episode.observation_types)},
    ${lit(episode.subjects)},
    ${listSql(episode.islands)},
    ${listSql(episode.plant_ids)},
    ${episode.severity}::DOUBLE,
    ${lit(episode.grouping_reason)},
    ${episode.inputs_complete})`;

const emptyEpisodesSelect = (
  inputTablesSql: string,
  stamp: (completeSql: string) => string,
) => `SELECT
   NULL::VARCHAR AS episode_id, NULL::VARCHAR AS seed_observation_id,
   NULL::DATE AS trading_date, NULL::INTEGER AS start_trading_period,
   NULL::INTEGER AS end_trading_period, NULL::INTEGER AS period_count,
   NULL::TIMESTAMPTZ AS event_start_utc, NULL::TIMESTAMPTZ AS event_end_utc,
   NULL::VARCHAR[] AS member_observation_ids, NULL::INTEGER AS member_count,
   NULL::VARCHAR[] AS observation_types, NULL::VARCHAR AS subjects,
   NULL::VARCHAR[] AS islands, NULL::VARCHAR[] AS plant_ids,
   NULL::DOUBLE AS severity, NULL::VARCHAR AS grouping_reason,
   NULL::VARCHAR AS parameters, ${inputTablesSql} AS input_tables, ${stamp("false")}
 WHERE false`;

/**
 * Publish episodes for one trading date (ADR-0021):
 * `gold/episode_days/trading_date=<date>/data.parquet` and
 * `gold/episodes/trading_date=<date>/data.parquet`.
 *
 * Inputs are the detector sentinel tables. Grouping reads the matching observation
 * tables. A date with no sentinel is `missing`. Quiet days still get a sentinel row
 * and an empty episodes partition.
 */
export async function publishEpisodes(
  options: GoldPublishOptions,
  config: EpisodeGroupingConfig = EPISODE_GROUPING_CONFIG,
): Promise<PublishResult> {
  const { silverDir, goldDir, completeness, date } = options;
  const sentinels = DETECTORS.map((detector) =>
    goldPartitionPath(goldDir, detector.sentinel, date),
  );
  if (sentinels.some((path) => !existsSync(path)))
    return { date, status: "missing" };

  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    await connection.run("SET threads = 1");
    const inputsSha256 = await inputFingerprint(
      silverDir,
      goldDir,
      ANALYSIS_VERSION,
      INPUTS,
      completeness,
      date,
    );
    const stamp = (completeSql: string) =>
      goldStamp(ANALYSIS_VERSION, inputsSha256, completeSql);
    const parameters = lit(JSON.stringify(config));
    const inputTablesSql = `[${INPUTS.map((input) => lit(`gold/${input.table}`)).join(", ")}]`;

    const observations: GroupingObservation[] = [];
    let tablesPresent = true;
    for (const detector of DETECTORS) {
      const path = goldPartitionPath(goldDir, detector.observations, date);
      if (!existsSync(path)) {
        tablesPresent = false;
        continue;
      }
      const reader = await connection.runAndReadAll(
        `SELECT observation_id, observation_type, trading_date::VARCHAR AS trading_date,
           start_trading_period, end_trading_period, event_start_utc, event_end_utc,
           subject_type, subject_id, island, plant_id, measured_value, severity,
           inputs_complete
         FROM read_parquet(${lit(path)})
         WHERE trading_date = DATE ${lit(date)}
         ORDER BY observation_id`,
      );
      for (const row of reader.getRowObjectsJson() as unknown as ObservationRow[])
        observations.push(toGrouping(row, date));
    }

    const episodes = groupObservations(observations, config);
    const membersComplete =
      episodes.length === 0 ||
      episodes.every((episode) => episode.inputs_complete);
    const inputsComplete = tablesPresent && membersComplete;

    const episodesSql =
      episodes.length === 0
        ? emptyEpisodesSelect(inputTablesSql, stamp)
        : `SELECT episode_id, seed_observation_id, trading_date, start_trading_period,
             end_trading_period, period_count, event_start_utc, event_end_utc,
             member_observation_ids, member_count, observation_types, subjects,
             islands, plant_ids, severity, grouping_reason,
             ${parameters} AS parameters, ${inputTablesSql} AS input_tables,
             ${stamp("member_complete")}
           FROM (VALUES ${episodes.map(episodeValuesSql).join(", ")})
             e(episode_id, seed_observation_id, trading_date, start_trading_period,
               end_trading_period, period_count, event_start_utc, event_end_utc,
               member_observation_ids, member_count, observation_types, subjects,
               islands, plant_ids, severity, grouping_reason, member_complete)
           ORDER BY episode_id`;

    const daysSql = `SELECT DATE ${lit(date)} AS trading_date,
       ${episodes.length}::INTEGER AS episode_count,
       ${observations.length}::INTEGER AS observation_count,
       ${stamp(inputsComplete ? "true" : "false")}`;

    await writeGoldTables(
      connection,
      [
        [TABLES[0], daysSql],
        [TABLES[1], episodesSql],
      ],
      goldDir,
      date,
    );
    const path = goldPartitionPath(goldDir, TABLES[0], date);
    return inputsComplete
      ? { date, status: "complete", rows: 1, path }
      : { date, status: "partial", rows: 1, path, missingPeriods: [] };
  } finally {
    connection.closeSync();
  }
}

export const episodes = goldDataset({
  id: "gold_episodes",
  tables: TABLES,
  inputs: INPUTS,
  analysisVersion: ANALYSIS_VERSION,
  publish: publishEpisodes,
});

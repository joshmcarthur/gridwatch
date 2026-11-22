import { existsSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { lit, type PublishResult } from "../silver/common.ts";
import {
  byString,
  type GoldGoldInput,
  type GoldPublishOptions,
  goldDataset,
  goldPartitionPath,
  goldStamp,
  inputFingerprint,
  shiftDate,
  windowDates,
  writeGoldTables,
} from "./common.ts";
import { TABLES as DEMAND_DEVIATION_TABLES } from "./demand-deviation.ts";
import { CORROBORATION_RULES, TABLES as EPISODE_TABLES } from "./episodes.ts";
import { FUEL_TABLES as FUEL_GENERATION_CHANGE_TABLES } from "./generation-change.ts";

/**
 * Bump by hand when a rule or a config value changes (ADR-0011, ADR-0024).
 */
export const ANALYSIS_VERSION = 3;

export const TABLES = ["episode_ranking_days", "episode_scores"] as const;

/** Owner values from #181. Weights stay as after #180. Reasons are in ADR-0024. */
export const EPISODE_RANKING_CONFIG = {
  weights: {
    severity: 0.3,
    duration: 0.2,
    breadth: 0.15,
    corroboration: 0.1,
    rarity: 0.25,
  },
  severityCapByType: {
    price_high: 30,
    reserve_price_high: 170,
    price_low: 1.49,
  } as Readonly<Record<string, number>>,
  defaultSeverityCap: 10,
  durationCapPeriods: 12,
  breadthCap: 4,
  /** Distinct corroborating observation types that score 1. Both rules of `CORROBORATION_RULES`. */
  corroborationCap: 2,
  corroborationRules: CORROBORATION_RULES,
  historyDays: 90,
  minPoolSize: 20,
  candidatesPerDay: 1,
  minScore: 0.5,
};

export type EpisodeRankingConfig = typeof EPISODE_RANKING_CONFIG;

export const INPUTS: GoldGoldInput[] = [
  {
    layer: "gold",
    table: EPISODE_TABLES[0],
    versionColumn: "inputs_sha256",
    completenessDataset: null,
    windowDays: EPISODE_RANKING_CONFIG.historyDays,
  },
  // Corroboration reads these observations for the episode's own date only (ADR-0024).
  ...[FUEL_GENERATION_CHANGE_TABLES[0], DEMAND_DEVIATION_TABLES[0]].map(
    (table) => ({
      layer: "gold" as const,
      table,
      versionColumn: "inputs_sha256" as const,
      completenessDataset: null,
      // Optional: the baselines need history, so early days have no sentinel. Those days still rank.
      optional: true,
    }),
  ),
];

export interface RankingEpisode {
  episode_id: string;
  trading_date: string;
  severity: number;
  period_count: number;
  observation_types: readonly string[];
  islands: readonly string[];
  /** Distinct corroborating observation types that overlap the episode (not members). */
  corroboration_count: number;
  inputs_complete: boolean;
}

/** One prior day: the shape keys of its episodes. See `shapeKey`. */
export type HistoryDay = ReadonlySet<string>;

export type CandidateReason = "top_n" | "below_min_score" | "beyond_top_n";

export interface ScoredEpisode {
  episode_id: string;
  trading_date: string;
  severity: number;
  period_count: number;
  island_count: number;
  type_count: number;
  severity_component: number;
  duration_component: number;
  breadth_component: number;
  corroboration_count: number;
  corroboration_component: number;
  rarity_component: number;
  score: number;
  day_rank: number;
  is_candidate: boolean;
  candidate_reason: CandidateReason;
  history_sample_size: number;
  inputs_complete: boolean;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** The observation-type set and island set of an episode. Both arrays are already sorted. */
export const shapeKey = (
  types: readonly string[],
  islands: readonly string[],
): string => JSON.stringify([[...types].sort(), [...islands].sort()]);

const severityCap = (
  types: readonly string[],
  config: EpisodeRankingConfig,
): number =>
  types.length === 0
    ? config.defaultSeverityCap
    : Math.max(
        ...types.map(
          (type) => config.severityCapByType[type] ?? config.defaultSeverityCap,
        ),
      );

/**
 * Score the episodes of one date (ADR-0024). `history` is one set of shape keys for each prior
 * day in the window that has an `episode_days` partition. Pure.
 */
export function scoreEpisodes(
  today: readonly RankingEpisode[],
  history: readonly HistoryDay[],
  config: EpisodeRankingConfig = EPISODE_RANKING_CONFIG,
): ScoredEpisode[] {
  const { weights } = config;
  const cold = history.length < config.minPoolSize;
  // Sorted by id first: the stable score sort below then breaks ties by episode_id.
  const byId = [...today].sort((a, b) => byString(a.episode_id, b.episode_id));
  const scored = byId.map((episode) => {
    const typeCount = episode.observation_types.length;
    const islandCount = episode.islands.length;
    const cap = severityCap(episode.observation_types, config);
    const severityComponent = clamp01(
      episode.severity > 0 && cap > 1
        ? Math.log10(episode.severity) / Math.log10(cap)
        : 0,
    );
    const durationComponent = clamp01(
      episode.period_count / config.durationCapPeriods,
    );
    const breadthComponent = clamp01(
      (Math.max(typeCount - 1, 0) + Math.max(islandCount - 1, 0)) /
        config.breadthCap,
    );
    const corroborationComponent = clamp01(
      episode.corroboration_count / config.corroborationCap,
    );
    let rarityComponent = 0.5;
    if (!cold) {
      const key = shapeKey(episode.observation_types, episode.islands);
      const seen = history.filter((day) => day.has(key)).length;
      rarityComponent = 1 - seen / history.length;
    }
    const score =
      weights.severity * severityComponent +
      weights.duration * durationComponent +
      weights.breadth * breadthComponent +
      weights.corroboration * corroborationComponent +
      weights.rarity * rarityComponent;
    return {
      episode,
      island_count: islandCount,
      type_count: typeCount,
      severity_component: round6(severityComponent),
      duration_component: round6(durationComponent),
      breadth_component: round6(breadthComponent),
      corroboration_component: round6(corroborationComponent),
      rarity_component: round6(rarityComponent),
      score: round6(score),
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((row, index) => {
    const dayRank = index + 1;
    const inTop = dayRank <= config.candidatesPerDay;
    const isCandidate = inTop && row.score >= config.minScore;
    return {
      episode_id: row.episode.episode_id,
      trading_date: row.episode.trading_date,
      severity: row.episode.severity,
      period_count: row.episode.period_count,
      island_count: row.island_count,
      type_count: row.type_count,
      severity_component: row.severity_component,
      duration_component: row.duration_component,
      breadth_component: row.breadth_component,
      corroboration_count: row.episode.corroboration_count,
      corroboration_component: row.corroboration_component,
      rarity_component: row.rarity_component,
      score: row.score,
      day_rank: dayRank,
      is_candidate: isCandidate,
      candidate_reason: isCandidate
        ? "top_n"
        : inTop
          ? "below_min_score"
          : "beyond_top_n",
      history_sample_size: history.length,
      inputs_complete: row.episode.inputs_complete,
    };
  });
}

const scoreValuesSql = (row: ScoredEpisode): string =>
  `(${lit(row.episode_id)}, DATE ${lit(row.trading_date)}, ${row.severity}::DOUBLE,
    ${row.period_count}::INTEGER, ${row.island_count}::INTEGER, ${row.type_count}::INTEGER,
    ${row.severity_component}::DOUBLE, ${row.duration_component}::DOUBLE,
    ${row.breadth_component}::DOUBLE, ${row.corroboration_count}::INTEGER,
    ${row.corroboration_component}::DOUBLE, ${row.rarity_component}::DOUBLE,
    ${row.score}::DOUBLE, ${row.day_rank}::INTEGER, ${row.is_candidate},
    ${lit(row.candidate_reason)}, ${row.history_sample_size}::INTEGER, ${row.inputs_complete})`;

/**
 * Publish the ranking of one trading date (ADR-0024):
 * `gold/episode_ranking_days/trading_date=<date>/data.parquet` and
 * `gold/episode_scores/trading_date=<date>/data.parquet`.
 *
 * Missing: the date has no `episode_days` partition. Partial: the date's episodes or their
 * inputs are incomplete. Quiet days write a sentinel row and an empty scores partition.
 */
export async function publishEpisodeRanking(
  options: GoldPublishOptions,
  config: EpisodeRankingConfig = EPISODE_RANKING_CONFIG,
): Promise<PublishResult> {
  const { silverDir, goldDir, completeness, date } = options;
  const dayPath = goldPartitionPath(goldDir, EPISODE_TABLES[0], date);
  if (!existsSync(dayPath)) return { date, status: "missing" };

  const priorDates = windowDates(date, config.historyDays)
    .filter((day) => day !== date)
    .filter((day) =>
      existsSync(goldPartitionPath(goldDir, EPISODE_TABLES[0], day)),
    );
  const priorFiles = priorDates
    .map((day) => goldPartitionPath(goldDir, EPISODE_TABLES[1], day))
    .filter((file) => existsSync(file));
  const todayPath = goldPartitionPath(goldDir, EPISODE_TABLES[1], date);

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
    const inputTablesSql = `[${INPUTS.map((input) => lit(`gold/${input.table}`)).join(", ")}]`;

    const dayRows = (
      await connection.runAndReadAll(
        `SELECT inputs_complete FROM read_parquet(${lit(dayPath)})
         WHERE trading_date = DATE ${lit(date)}`,
      )
    ).getRowObjectsJson() as Array<{ inputs_complete: boolean }>;
    const dayComplete =
      dayRows.length > 0 &&
      dayRows.every((row) => Boolean(row.inputs_complete));

    const todayRows = existsSync(todayPath)
      ? ((
          await connection.runAndReadAll(
            `SELECT episode_id, trading_date::VARCHAR AS trading_date, severity, period_count,
               observation_types, islands, inputs_complete
             FROM read_parquet(${lit(todayPath)})
             WHERE trading_date = DATE ${lit(date)}
             ORDER BY episode_id`,
          )
        ).getRowObjectsJson() as Array<
          Record<keyof RankingEpisode, unknown> & {
            observation_types: string[];
            islands: string[];
          }
        >)
      : [];
    // Corroborating observations: same date, overlapping span, same island (ADR-0024). Each rule
    // counts once per episode, so the count is the number of distinct rules that matched.
    const corroboration = new Map<string, number>();
    if (todayRows.length > 0)
      for (const rule of config.corroborationRules) {
        const observationsPath = goldPartitionPath(goldDir, rule.table, date);
        if (!existsSync(observationsPath)) continue;
        const matched = (
          await connection.runAndReadAll(
            `SELECT DISTINCT e.episode_id
             FROM read_parquet(${lit(todayPath)}) e
             JOIN read_parquet(${lit(observationsPath)}) o
               ON o.observation_type = ${lit(rule.observationType)}
              AND list_contains(e.islands, o.island)
              AND o.event_start_utc < e.event_end_utc
              AND e.event_start_utc < o.event_end_utc
             WHERE e.trading_date = DATE ${lit(date)}
               AND o.trading_date = DATE ${lit(date)}`,
          )
        ).getRowObjectsJson() as Array<{ episode_id: string }>;
        for (const row of matched)
          corroboration.set(
            row.episode_id,
            (corroboration.get(row.episode_id) ?? 0) + 1,
          );
      }
    const today: RankingEpisode[] = todayRows.map((row) => ({
      episode_id: String(row.episode_id),
      trading_date: String(row.trading_date),
      severity: Number(row.severity),
      period_count: Number(row.period_count),
      observation_types: row.observation_types,
      islands: row.islands,
      corroboration_count: corroboration.get(String(row.episode_id)) ?? 0,
      inputs_complete: Boolean(row.inputs_complete),
    }));

    const byDay = new Map<string, Set<string>>(
      priorDates.map((day) => [day, new Set<string>()]),
    );
    if (priorFiles.length > 0) {
      const rows = (
        await connection.runAndReadAll(
          `SELECT trading_date::VARCHAR AS trading_date, observation_types, islands
           FROM read_parquet([${priorFiles.map(lit).join(", ")}])
           WHERE trading_date >= DATE ${lit(shiftDate(date, -config.historyDays))}
             AND trading_date < DATE ${lit(date)}
           ORDER BY trading_date, episode_id`,
        )
      ).getRowObjectsJson() as unknown as Array<{
        trading_date: string;
        observation_types: string[];
        islands: string[];
      }>;
      for (const row of rows)
        byDay
          .get(row.trading_date)
          ?.add(shapeKey(row.observation_types, row.islands));
    }

    const scored = scoreEpisodes(today, [...byDay.values()], config);
    const inputsComplete =
      dayComplete && today.every((episode) => episode.inputs_complete);
    const candidateCount = scored.filter((row) => row.is_candidate).length;
    const parameters = lit(JSON.stringify(config));

    const scoresSql =
      scored.length === 0
        ? `SELECT NULL::VARCHAR AS episode_id, NULL::DATE AS trading_date,
             NULL::DOUBLE AS severity, NULL::INTEGER AS period_count,
             NULL::INTEGER AS island_count, NULL::INTEGER AS type_count,
             NULL::DOUBLE AS severity_component, NULL::DOUBLE AS duration_component,
             NULL::DOUBLE AS breadth_component, NULL::INTEGER AS corroboration_count,
             NULL::DOUBLE AS corroboration_component, NULL::DOUBLE AS rarity_component,
             NULL::DOUBLE AS score, NULL::INTEGER AS day_rank, NULL::BOOLEAN AS is_candidate,
             NULL::VARCHAR AS candidate_reason, NULL::INTEGER AS history_sample_size,
             NULL::VARCHAR AS parameters, ${inputTablesSql} AS input_tables,
             ${stamp("false")}
           WHERE false`
        : `SELECT episode_id, trading_date, severity, period_count, island_count, type_count,
             severity_component, duration_component, breadth_component, corroboration_count,
             corroboration_component, rarity_component,
             score, day_rank, is_candidate, candidate_reason, history_sample_size,
             ${parameters} AS parameters, ${inputTablesSql} AS input_tables,
             ${stamp("member_complete")}
           FROM (VALUES ${scored.map(scoreValuesSql).join(", ")})
             s(episode_id, trading_date, severity, period_count, island_count, type_count,
               severity_component, duration_component, breadth_component, corroboration_count,
               corroboration_component, rarity_component,
               score, day_rank, is_candidate, candidate_reason, history_sample_size,
               member_complete)
           ORDER BY episode_id`;

    const daysSql = `SELECT DATE ${lit(date)} AS trading_date,
       ${scored.length}::INTEGER AS episode_count,
       ${candidateCount}::INTEGER AS candidate_count,
       ${priorDates.length}::INTEGER AS history_days,
       ${stamp(inputsComplete ? "true" : "false")}`;

    await writeGoldTables(
      connection,
      [
        [TABLES[0], daysSql],
        [TABLES[1], scoresSql],
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

export const episodeRanking = goldDataset({
  id: "gold_episode_ranking",
  tables: TABLES,
  inputs: INPUTS,
  analysisVersion: ANALYSIS_VERSION,
  publish: publishEpisodeRanking,
});

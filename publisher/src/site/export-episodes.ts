import { existsSync } from "node:fs";
import type { DuckDBConnection } from "@duckdb/node-api";
import { goldPartitionPath } from "../gold/common.ts";
import {
  INPUTS as EPISODE_INPUTS,
  TABLES as EPISODE_TABLES,
} from "../gold/episodes.ts";
import { TABLES as PRICE_ANOMALY_TABLES } from "../gold/price-anomaly.ts";
import { TABLES as PRICE_SEPARATION_TABLES } from "../gold/price-separation.ts";
import { TABLES as RESERVE_PRICE_ANOMALY_TABLES } from "../gold/reserve-price-anomaly.ts";
import { lit } from "../silver/common.ts";
import type { CompletenessView } from "../silver/completeness.ts";
import type {
  EpisodesSection,
  Island,
  SiteEpisode,
  SiteEpisodeHighlight,
} from "./contract.ts";
import {
  type Section,
  sectionDatasets,
  sectionState,
} from "./export-common.ts";
import { readStamp, round, rowsOf } from "./gold-read.ts";

export const EPISODES_SECTION: Section = {
  name: "episodes",
  sentinel: EPISODE_TABLES[0],
  inputs: EPISODE_INPUTS,
};

const OBSERVATION_TABLES = [
  PRICE_ANOMALY_TABLES[1],
  PRICE_SEPARATION_TABLES[1],
  RESERVE_PRICE_ANOMALY_TABLES[1],
] as const;

const PAIR_SUBJECT = /^([A-Z0-9]{7})-([A-Z0-9]{7})$/;

interface MemberObservation {
  observation_id: string;
  observation_type: string;
  subject_id: string;
  point_of_connection: string | null;
  island: string | null;
  measured_value: number;
  baseline_value: number;
  severity: number;
}

const asUtc = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString().replace(/\.000Z$/, "Z");
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw new TypeError(`not an instant: ${value}`);
    return new Date(ms).toISOString().replace(/\.000Z$/, "Z");
  }
  throw new TypeError("event time is not a string or Date");
};

const stringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
};

const islandList = (value: unknown): Island[] =>
  stringList(value).flatMap((item) => {
    if (item === "NI" || item === "SI") return [item];
    return [];
  });

const nullableText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

function missingEpisodes(
  base: Pick<EpisodesSection, "silver_tables" | "gold_tables" | "datasets">,
): EpisodesSection {
  return {
    ...base,
    state: "missing",
    missing_periods: [],
    analysis_version: null,
    inputs_sha256: null,
    items: [],
  };
}

function winner(
  candidate: MemberObservation,
  held: MemberObservation,
): MemberObservation {
  if (candidate.severity !== held.severity)
    return candidate.severity > held.severity ? candidate : held;
  const candidateAbs = Math.abs(candidate.measured_value);
  const heldAbs = Math.abs(held.measured_value);
  if (candidateAbs !== heldAbs)
    return candidateAbs > heldAbs ? candidate : held;
  return candidate.observation_id <= held.observation_id ? candidate : held;
}

function highlightOf(row: MemberObservation): SiteEpisodeHighlight {
  const pair = PAIR_SUBJECT.exec(row.subject_id);
  return {
    observation_type: row.observation_type,
    point_of_connection: row.point_of_connection,
    pair_from: pair?.[1] ?? null,
    pair_to: pair?.[2] ?? null,
    island: islandList(row.island === null ? [] : [row.island])[0] ?? null,
    measured_value: round(row.measured_value, 2),
    baseline_value: round(row.baseline_value, 2),
  };
}

function highlightsFor(
  memberIds: string[],
  byId: Map<string, MemberObservation>,
): SiteEpisodeHighlight[] {
  const best = new Map<string, MemberObservation>();
  for (const id of memberIds) {
    const row = byId.get(id);
    if (!row) continue;
    const held = best.get(row.observation_type);
    best.set(row.observation_type, held ? winner(row, held) : row);
  }
  return [...best.values()]
    .sort((left, right) => {
      if (left.severity !== right.severity)
        return right.severity - left.severity;
      return left.observation_type.localeCompare(right.observation_type);
    })
    .map(highlightOf);
}

async function loadMembers(
  connection: DuckDBConnection,
  goldDir: string,
  date: string,
): Promise<Map<string, MemberObservation>> {
  const paths = OBSERVATION_TABLES.map((table) =>
    goldPartitionPath(goldDir, table, date),
  ).filter((path) => existsSync(path));
  const byId = new Map<string, MemberObservation>();
  if (paths.length === 0) return byId;
  const reader = await connection.runAndReadAll(
    `SELECT observation_id, observation_type, subject_id, point_of_connection,
            island, measured_value, baseline_value, severity
     FROM read_parquet([${paths.map((path) => lit(path)).join(", ")}], union_by_name = true)`,
  );
  for (const row of reader.getRowObjectsJson() as Array<
    Record<string, unknown>
  >) {
    const id = String(row.observation_id);
    byId.set(id, {
      observation_id: id,
      observation_type: String(row.observation_type),
      subject_id: String(row.subject_id),
      point_of_connection: nullableText(row.point_of_connection),
      island: nullableText(row.island),
      measured_value: Number(row.measured_value),
      baseline_value: Number(row.baseline_value),
      severity: Number(row.severity),
    });
  }
  return byId;
}

export async function buildEpisodes(
  connection: DuckDBConnection,
  goldDir: string,
  date: string,
  completeness: CompletenessView,
): Promise<EpisodesSection> {
  const section = EPISODES_SECTION;
  const base = {
    silver_tables: [] as string[],
    gold_tables: [...EPISODE_TABLES],
    datasets: sectionDatasets(section),
  };
  const stamp = await readStamp(
    connection,
    goldPartitionPath(goldDir, section.sentinel, date),
  );
  if (!stamp) return missingEpisodes(base);
  const itemsPath = goldPartitionPath(goldDir, EPISODE_TABLES[1], date);
  const rows = existsSync(itemsPath)
    ? await rowsOf(
        connection,
        goldDir,
        EPISODE_TABLES[1],
        date,
        `episode_id, seed_observation_id, event_start_utc, event_end_utc,
         start_trading_period, end_trading_period, member_count,
         member_observation_ids, observation_types, islands, severity`,
        "severity DESC, episode_id",
      )
    : [];
  const members = await loadMembers(connection, goldDir, date);
  const items: SiteEpisode[] = rows.map((row) => ({
    episode_id: String(row.episode_id),
    seed_observation_id: String(row.seed_observation_id),
    start_utc: asUtc(row.event_start_utc),
    end_utc: asUtc(row.event_end_utc),
    start_trading_period: Number(row.start_trading_period),
    end_trading_period: Number(row.end_trading_period),
    member_count: Number(row.member_count),
    observation_types: stringList(row.observation_types),
    islands: islandList(row.islands),
    severity: round(Number(row.severity), 2),
    highlights: highlightsFor(stringList(row.member_observation_ids), members),
  }));
  return {
    ...base,
    state: sectionState(stamp, section, completeness, date),
    missing_periods: [],
    analysis_version: stamp.analysis_version,
    inputs_sha256: stamp.inputs_sha256,
    items,
  };
}

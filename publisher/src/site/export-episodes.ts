import { existsSync } from "node:fs";
import type { DuckDBConnection } from "@duckdb/node-api";
import { goldPartitionPath } from "../gold/common.ts";
import {
  INPUTS as EPISODE_INPUTS,
  TABLES as EPISODE_TABLES,
} from "../gold/episodes.ts";
import type { CompletenessView } from "../silver/completeness.ts";
import type { EpisodesSection, Island, SiteEpisode } from "./contract.ts";
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
         observation_types, islands, severity`,
        "severity DESC, episode_id",
      )
    : [];
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

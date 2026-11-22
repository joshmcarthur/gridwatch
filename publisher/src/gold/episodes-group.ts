import { createHash } from "node:crypto";
import type { SubjectType } from "./observation.ts";

export type TimePredicate = "overlap" | "overlap_or_adjacent";
export type SubjectPredicate =
  | "same_island"
  | "same_island_or_plant"
  | "pair_grouping_island_matches_other";

export interface JoinRule {
  id: string;
  types: readonly [string, string];
  time: TimePredicate;
  subject: SubjectPredicate;
}

export interface EpisodeGroupingConfig {
  adjacentPeriodMax: number;
  adjacentGapMinutes: number;
  sameDateOnly: boolean;
  singletonEpisodes: boolean;
  episodeSeverity: "max";
}

export const EPISODE_GROUPING_CONFIG: EpisodeGroupingConfig = {
  adjacentPeriodMax: 2,
  adjacentGapMinutes: 60,
  sameDateOnly: true,
  singletonEpisodes: true,
  episodeSeverity: "max",
};

/** Typed join rules (ADR-0021). Types with no rows yet are no-ops. */
export const JOIN_RULES: readonly JoinRule[] = [
  {
    id: "price_high_price_high_adjacent_island",
    types: ["price_high", "price_high"],
    time: "overlap_or_adjacent",
    subject: "same_island",
  },
  {
    id: "reserve_price_high_reserve_price_high_adjacent_island",
    types: ["reserve_price_high", "reserve_price_high"],
    time: "overlap_or_adjacent",
    subject: "same_island",
  },
  {
    id: "price_high_reserve_price_high_adjacent_island",
    types: ["price_high", "reserve_price_high"],
    time: "overlap_or_adjacent",
    subject: "same_island",
  },
  {
    id: "generation_low_generation_low_adjacent_subject",
    types: ["generation_low", "generation_low"],
    time: "overlap_or_adjacent",
    subject: "same_island_or_plant",
  },
  {
    id: "generation_low_price_high_overlap_island",
    types: ["generation_low", "price_high"],
    time: "overlap",
    subject: "same_island",
  },
  {
    id: "generation_low_reserve_price_high_overlap_island",
    types: ["generation_low", "reserve_price_high"],
    time: "overlap",
    subject: "same_island",
  },
  {
    id: "separation_high_price_high_adjacent_island",
    types: ["separation_high", "price_high"],
    time: "overlap_or_adjacent",
    subject: "pair_grouping_island_matches_other",
  },
  {
    id: "demand_high_price_high_overlap_island",
    types: ["demand_high", "price_high"],
    time: "overlap",
    subject: "same_island",
  },
  {
    id: "price_low_price_low_adjacent_island",
    types: ["price_low", "price_low"],
    time: "overlap_or_adjacent",
    subject: "same_island",
  },
];

export interface GroupingObservation {
  observation_id: string;
  observation_type: string;
  trading_date: string;
  start_trading_period: number;
  end_trading_period: number;
  event_start_utc: string;
  event_end_utc: string;
  subject_type: SubjectType;
  subject_id: string;
  island: string | null;
  plant_id: string | null;
  measured_value: number;
  severity: number;
  inputs_complete: boolean;
}

export interface GroupedEpisode {
  episode_id: string;
  seed_observation_id: string;
  trading_date: string;
  start_trading_period: number;
  end_trading_period: number;
  period_count: number;
  event_start_utc: string;
  event_end_utc: string;
  member_observation_ids: string[];
  member_count: number;
  observation_types: string[];
  subjects: string;
  islands: string[];
  plant_ids: string[];
  severity: number;
  grouping_reason: string;
  inputs_complete: boolean;
}

const NODE_ISLAND: Record<string, "NI" | "SI"> = {
  OTA2201: "NI",
  HAY2201: "NI",
  BEN2201: "SI",
};

export const episodeIdOf = (seedObservationId: string): string =>
  createHash("sha256").update(seedObservationId).digest("hex").slice(0, 16);

const instantMs = (value: string): number => {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new TypeError(`not an instant: ${value}`);
  return ms;
};

const overlap = (a: GroupingObservation, b: GroupingObservation): boolean =>
  instantMs(a.event_start_utc) < instantMs(b.event_end_utc) &&
  instantMs(b.event_start_utc) < instantMs(a.event_end_utc);

const adjacent = (
  a: GroupingObservation,
  b: GroupingObservation,
  gapMinutes: number,
): boolean => {
  const aStart = instantMs(a.event_start_utc);
  const bStart = instantMs(b.event_start_utc);
  const earlierEnd =
    aStart <= bStart ? instantMs(a.event_end_utc) : instantMs(b.event_end_utc);
  const laterStart = Math.max(aStart, bStart);
  const gap = laterStart - earlierEnd;
  return gap >= 0 && gap <= gapMinutes * 60_000;
};

const timeMatches = (
  rule: JoinRule,
  a: GroupingObservation,
  b: GroupingObservation,
  config: EpisodeGroupingConfig,
): boolean => {
  switch (rule.time) {
    case "overlap":
      return overlap(a, b);
    case "overlap_or_adjacent":
      return overlap(a, b) || adjacent(a, b, config.adjacentGapMinutes);
    default: {
      const unreachable: never = rule.time;
      return unreachable;
    }
  }
};

const typesMatch = (rule: JoinRule, aType: string, bType: string): boolean =>
  (aType === rule.types[0] && bType === rule.types[1]) ||
  (aType === rule.types[1] && bType === rule.types[0]);

/**
 * Island used only for grouping. Pair rows have a null typed island; the dearer node
 * supplies one (ADR-0021). `OTA2201-HAY2201` is always NI.
 */
export const groupingIsland = (
  observation: GroupingObservation,
): "NI" | "SI" | null => {
  if (observation.island === "NI" || observation.island === "SI")
    return observation.island;
  if (observation.subject_type !== "point_of_connection_pair") return null;
  if (observation.subject_id === "OTA2201-HAY2201") return "NI";
  const dash = observation.subject_id.indexOf("-");
  if (dash < 0) return null;
  const from = observation.subject_id.slice(0, dash);
  const to = observation.subject_id.slice(dash + 1);
  if (observation.measured_value === 0) return null;
  const dearer = observation.measured_value > 0 ? from : to;
  return NODE_ISLAND[dearer] ?? null;
};

const subjectMatches = (
  rule: JoinRule,
  a: GroupingObservation,
  b: GroupingObservation,
): boolean => {
  switch (rule.subject) {
    case "same_island": {
      const island = groupingIsland(a);
      return island !== null && island === groupingIsland(b);
    }
    case "same_island_or_plant": {
      const island = groupingIsland(a);
      if (island !== null && island === groupingIsland(b)) return true;
      return (
        a.plant_id !== null && b.plant_id !== null && a.plant_id === b.plant_id
      );
    }
    case "pair_grouping_island_matches_other": {
      const pair =
        a.subject_type === "point_of_connection_pair"
          ? a
          : b.subject_type === "point_of_connection_pair"
            ? b
            : null;
      const other = pair === a ? b : pair === b ? a : null;
      if (pair === null || other === null) return false;
      const island = groupingIsland(pair);
      return island !== null && island === groupingIsland(other);
    }
    default: {
      const unreachable: never = rule.subject;
      return unreachable;
    }
  }
};

const firingRules = (
  a: GroupingObservation,
  b: GroupingObservation,
  config: EpisodeGroupingConfig,
): string[] => {
  const ids: string[] = [];
  for (const rule of JOIN_RULES) {
    if (!typesMatch(rule, a.observation_type, b.observation_type)) continue;
    if (!timeMatches(rule, a, b, config)) continue;
    if (!subjectMatches(rule, a, b)) continue;
    ids.push(rule.id);
  }
  return ids;
};

class UnionFind {
  readonly parent = new Map<string, string>();
  find(id: string): string {
    const parent = this.parent.get(id) ?? id;
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra];
    this.parent.set(drop, keep);
  }
}

const byString = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

const seedOf = (members: GroupingObservation[]): GroupingObservation => {
  const sorted = [...members].sort((a, b) => {
    const start = instantMs(a.event_start_utc) - instantMs(b.event_start_utc);
    if (start !== 0) return start;
    return byString(a.observation_id, b.observation_id);
  });
  const seed = sorted[0];
  if (seed === undefined) throw new Error("an episode needs a member");
  return seed;
};

const distinctPeriods = (members: GroupingObservation[]): Set<number> => {
  const periods = new Set<number>();
  for (const member of members) {
    for (
      let period = member.start_trading_period;
      period <= member.end_trading_period;
      period++
    )
      periods.add(period);
  }
  return periods;
};

const isoMin = (values: string[]): string =>
  values.reduce((best, value) =>
    instantMs(value) < instantMs(best) ? value : best,
  );

const isoMax = (values: string[]): string =>
  values.reduce((best, value) =>
    instantMs(value) > instantMs(best) ? value : best,
  );

const uniqueSorted = (values: string[]): string[] =>
  [...new Set(values)].sort();

const episodeSeverity = (
  members: GroupingObservation[],
  config: EpisodeGroupingConfig,
): number => {
  switch (config.episodeSeverity) {
    case "max":
      return members.reduce(
        (best, member) => Math.max(best, member.severity),
        Number.NEGATIVE_INFINITY,
      );
    default: {
      const unreachable: never = config.episodeSeverity;
      return unreachable;
    }
  }
};

const toEpisode = (
  members: GroupingObservation[],
  ruleIds: string[],
  config: EpisodeGroupingConfig,
): GroupedEpisode => {
  const seed = seedOf(members);
  const periods = distinctPeriods(members);
  const subjectRows = uniqueSorted(
    members.map((m) => `${m.subject_type}\0${m.subject_id}`),
  ).map((key) => {
    const sep = key.indexOf("\0");
    return {
      subject_type: key.slice(0, sep),
      subject_id: key.slice(sep + 1),
    };
  });
  const rules = uniqueSorted(ruleIds);
  return {
    episode_id: episodeIdOf(seed.observation_id),
    seed_observation_id: seed.observation_id,
    trading_date: seed.trading_date,
    start_trading_period: Math.min(
      ...members.map((m) => m.start_trading_period),
    ),
    end_trading_period: Math.max(...members.map((m) => m.end_trading_period)),
    period_count: periods.size,
    event_start_utc: isoMin(members.map((m) => m.event_start_utc)),
    event_end_utc: isoMax(members.map((m) => m.event_end_utc)),
    member_observation_ids: uniqueSorted(members.map((m) => m.observation_id)),
    member_count: members.length,
    observation_types: uniqueSorted(members.map((m) => m.observation_type)),
    subjects: JSON.stringify(subjectRows),
    islands: uniqueSorted(
      members
        .map((m) => groupingIsland(m))
        .filter((island): island is "NI" | "SI" => island !== null),
    ),
    plant_ids: uniqueSorted(
      members.map((m) => m.plant_id).filter((id): id is string => id !== null),
    ),
    severity: episodeSeverity(members, config),
    grouping_reason: JSON.stringify({
      rules: rules.length === 0 ? ["singleton"] : rules,
    }),
    inputs_complete: members.every((m) => m.inputs_complete),
  };
};

/**
 * Group observations of one trading date into episodes (ADR-0021). The graph is
 * undirected. Every observation is in exactly one episode, including singletons.
 */
export const groupObservations = (
  observations: readonly GroupingObservation[],
  config: EpisodeGroupingConfig = EPISODE_GROUPING_CONFIG,
): GroupedEpisode[] => {
  const ofDate = config.sameDateOnly
    ? observations.filter((row, _, all) => {
        const date = all[0]?.trading_date;
        return date === undefined || row.trading_date === date;
      })
    : [...observations];
  if (ofDate.length === 0) return [];

  const forest = new UnionFind();
  for (const row of ofDate) forest.find(row.observation_id);

  const ordered = [...ofDate].sort((a, b) =>
    byString(a.observation_id, b.observation_id),
  );
  const edges: { id: string; rules: string[] }[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < ordered.length; j++) {
      const b = ordered[j];
      if (b === undefined) continue;
      const rules = firingRules(a, b, config);
      if (rules.length === 0) continue;
      forest.union(a.observation_id, b.observation_id);
      edges.push({ id: a.observation_id, rules });
    }
  }

  const buckets = new Map<string, GroupingObservation[]>();
  for (const row of ordered) {
    const root = forest.find(row.observation_id);
    const bucket = buckets.get(root) ?? [];
    bucket.push(row);
    buckets.set(root, bucket);
  }
  const rulesByRoot = new Map<string, string[]>();
  for (const edge of edges) {
    const root = forest.find(edge.id);
    rulesByRoot.set(root, [...(rulesByRoot.get(root) ?? []), ...edge.rules]);
  }

  const episodes: GroupedEpisode[] = [];
  for (const [root, members] of buckets) {
    const ruleIds = rulesByRoot.get(root) ?? [];
    if (
      !config.singletonEpisodes &&
      members.length === 1 &&
      ruleIds.length === 0
    )
      continue;
    episodes.push(toEpisode(members, ruleIds, config));
  }
  return episodes.sort((a, b) => byString(a.episode_id, b.episode_id));
};

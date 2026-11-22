import type {
  SectionState,
  SiteDay,
  SiteIndex,
  SiteIndexDay,
} from "@gridwatch/publisher/site-contract";
import { headlineCopy } from "./daily-page.ts";
import {
  gasCoalShare,
  hayBenAbsSpread,
  meanWholesalePrice,
  peakReservePrice,
} from "./market-conditions.ts";
import {
  bandPhrase,
  MAX_HISTORY_DAYS,
  type Rank,
  rankAgainstHistory,
} from "./rank.ts";

const money = new Intl.NumberFormat("en-NZ", {
  style: "currency",
  currency: "NZD",
  maximumFractionDigits: 0,
});
const percent = new Intl.NumberFormat("en-NZ", {
  style: "percent",
  maximumFractionDigits: 0,
});

export type ConditionId = "prices" | "supply" | "reserves" | "regional";

export type ConditionCard = {
  id: ConditionId;
  title: string;
  date: string | null;
  value: string | null;
  headline: string;
  spark: number[];
  percentile: number | null;
  share: number | null;
};

export type LatestUpdate = {
  date: string;
  paragraphs: string[];
  spark: number[];
};

export type RecentDay = {
  date: string;
  complete: boolean;
};

type SectionName = "generation" | "prices" | "reserves";

type CardSpec = {
  id: ConditionId;
  title: string;
  section: SectionName;
  metric: (day: SiteDay) => number | null;
  format: (value: number) => string;
  unpublished: string;
  subject: string;
  verb: "was" | "were";
  gloss: string;
  share: boolean;
};

const CARD_SPECS: readonly CardSpec[] = [
  {
    id: "prices",
    title: "Wholesale prices",
    section: "prices",
    metric: meanWholesalePrice,
    format: (value) => money.format(value),
    unpublished: "Wholesale prices have not been published on this site yet.",
    subject: "Wholesale prices",
    verb: "were",
    gloss: "averaged across Otahuhu, Haywards and Benmore",
    share: false,
  },
  {
    id: "supply",
    title: "Supply",
    section: "generation",
    metric: gasCoalShare,
    format: (value) => percent.format(value),
    unpublished: "Generation numbers have not been published on this site yet.",
    subject: "Gas and coal's share of generation",
    verb: "was",
    gloss: "not counting batteries",
    share: true,
  },
  {
    id: "reserves",
    title: "Reserves",
    section: "reserves",
    metric: peakReservePrice,
    format: (value) => money.format(value),
    unpublished: "Reserve prices have not been published on this site yet.",
    subject: "Reserve prices",
    verb: "were",
    gloss:
      "taking the highest island cost of standing ready to lift or drop generation in seconds or minutes",
    share: false,
  },
  {
    id: "regional",
    title: "Regional prices",
    section: "prices",
    metric: hayBenAbsSpread,
    format: (value) => money.format(value),
    unpublished:
      "The island price gap has not been published on this site yet.",
    subject: "The island price gap",
    verb: "was",
    gloss: "between Haywards near Wellington and Benmore in the Waitaki",
    share: false,
  },
];

const LAG_NOTE =
  "Generation numbers for this day are not in yet; they usually arrive later than prices.";

const UNKNOWN =
  "There are not yet enough complete days on this site to say whether that was usual.";

const memoLoad = (loadDay: (date: string) => SiteDay) => {
  const cache = new Map<string, SiteDay>();
  return (date: string) => {
    const held = cache.get(date);
    if (held) return held;
    const day = loadDay(date);
    cache.set(date, day);
    return day;
  };
};

const sectionComplete = (day: SiteIndexDay, name: SectionName): boolean =>
  day.sections[name] === "complete";

function earlierValues(
  index: SiteIndex,
  section: SectionName,
  before: string,
  loadDay: (date: string) => SiteDay,
  metric: (day: SiteDay) => number | null,
): number[] {
  const earlier = index.days.filter(
    (day) => day.date < before && sectionComplete(day, section),
  );
  return earlier.slice(-MAX_HISTORY_DAYS).flatMap((entry) => {
    const value = metric(loadDay(entry.date));
    return value === null ? [] : [value];
  });
}

function cardHeadline(spec: CardSpec, date: string | null, rank: Rank): string {
  if (!date) return spec.unpublished;
  if (rank.kind === "unknown") return UNKNOWN;
  return `${spec.subject} ${spec.verb} ${bandPhrase(rank.band)}, ${spec.gloss}.`;
}

function generationParagraphs(
  state: SectionState,
  copy: { generation: string; prices: string },
): string[] {
  switch (state) {
    case "complete":
    case "incomplete":
      return [copy.generation, copy.prices];
    case "missing":
      return [copy.prices, LAG_NOTE];
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

export function latestUpdate(
  index: SiteIndex,
  loadDay: (date: string) => SiteDay,
): LatestUpdate | null {
  const date = index.latest_complete_sections.prices;
  if (!date) return null;
  const load = memoLoad(loadDay);
  const day = load(date);
  const spark = earlierValues(index, "prices", date, load, meanWholesalePrice);
  const current = meanWholesalePrice(day);
  return {
    date,
    paragraphs: generationParagraphs(day.generation.state, headlineCopy(day)),
    spark: current === null ? spark : [...spark, current],
  };
}

export function recentDays(index: SiteIndex, limit = 14): RecentDay[] {
  return [...index.days]
    .slice(-limit)
    .reverse()
    .map((day) => ({ date: day.date, complete: day.complete }));
}

export function conditionCards(
  index: SiteIndex,
  loadDay: (date: string) => SiteDay,
): ConditionCard[] {
  const load = memoLoad(loadDay);
  return CARD_SPECS.map((spec) => {
    const date = index.latest_complete_sections[spec.section] ?? null;
    const day = date ? load(date) : null;
    const value = day ? spec.metric(day) : null;
    const history =
      date === null
        ? []
        : earlierValues(index, spec.section, date, load, spec.metric);
    const rank =
      date === null || value === null
        ? ({ kind: "unknown", reason: "not_enough_days" } as const)
        : rankAgainstHistory(value, history);
    return {
      id: spec.id,
      title: spec.title,
      date,
      value: value === null ? null : spec.format(value),
      headline: cardHeadline(spec, date, rank),
      spark: value === null ? history : [...history, value],
      percentile: rank.kind === "ranked" ? rank.percentile : null,
      share: spec.share ? value : null,
    };
  });
}

import type {
  SectionState,
  SiteDay,
  SiteIndex,
  SiteIndexDay,
} from "@gridwatch/publisher/site-contract";
import { headlineParagraphs } from "./daily-page.ts";
import {
  gasCoalShare,
  hayBenAbsSpread,
  meanWholesalePrice,
  peakReservePrice,
} from "./market-conditions.ts";
import {
  bandPhrase,
  type Rank,
  type RankBand,
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
  band: RankBand | null;
  headline: string;
  detail: string;
};

export type LatestUpdate = {
  date: string;
  generationLagging: boolean;
  paragraphs: string[];
};

export type RecentDay = {
  date: string;
  complete: boolean;
};

type SectionName = "generation" | "prices" | "reserves";

const sectionState = (
  day: SiteIndexDay,
  name: SectionName,
): SectionState | undefined => {
  if (name === "reserves") return day.sections.reserves;
  return day.sections[name];
};

const LAG_NOTE =
  "Generation numbers for this day are not in yet. They usually arrive later than prices.";

const UNKNOWN =
  "There are not yet enough complete days on this site to say whether that was usual.";

function earlierValues(
  index: SiteIndex,
  section: SectionName,
  before: string,
  loadDay: (date: string) => SiteDay,
  metric: (day: SiteDay) => number | null,
): number[] {
  const earlier = index.days.filter(
    (day) => day.date < before && sectionState(day, section) === "complete",
  );
  return earlier.slice(-365).flatMap((entry) => {
    const value = metric(loadDay(entry.date));
    return value === null ? [] : [value];
  });
}

function cardHeadline(
  date: string | null,
  unpublished: string,
  subject: string,
  verb: "was" | "were",
  rank: Rank,
): string {
  if (!date) return unpublished;
  if (rank.kind === "unknown") return UNKNOWN;
  return `${subject} ${verb} ${bandPhrase(rank.band)}.`;
}

export function latestUpdate(
  index: SiteIndex,
  loadDay: (date: string) => SiteDay,
): LatestUpdate | null {
  const date = index.latest_complete_sections.prices;
  if (!date) return null;
  const day = loadDay(date);
  const generationLagging = day.generation.state !== "complete";
  const [generationParagraph, pricesParagraph] = headlineParagraphs(day);
  const paragraphs = generationLagging
    ? [pricesParagraph ?? "", LAG_NOTE]
    : [generationParagraph ?? "", pricesParagraph ?? ""];
  return { date, generationLagging, paragraphs };
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
  const priceDate = index.latest_complete_sections.prices;
  const generationDate = index.latest_complete_sections.generation;
  const reservesDate = index.latest_complete_sections.reserves ?? null;
  const priceDay = priceDate ? loadDay(priceDate) : null;
  const generationDay = generationDate ? loadDay(generationDate) : null;
  const reservesDay = reservesDate ? loadDay(reservesDate) : null;

  const rankOf = (
    section: SectionName,
    date: string | null,
    day: SiteDay | null,
    metric: (day: SiteDay) => number | null,
  ): Rank => {
    if (!date || !day) return { kind: "unknown", reason: "not_enough_days" };
    const value = metric(day);
    if (value === null) return { kind: "unknown", reason: "not_enough_days" };
    return rankAgainstHistory(
      value,
      earlierValues(index, section, date, loadDay, metric),
    );
  };

  const priceRank = rankOf("prices", priceDate, priceDay, meanWholesalePrice);
  const supplyRank = rankOf(
    "generation",
    generationDate,
    generationDay,
    gasCoalShare,
  );
  const reserveRank = rankOf(
    "reserves",
    reservesDate,
    reservesDay,
    peakReservePrice,
  );
  const regionalRank = rankOf("prices", priceDate, priceDay, hayBenAbsSpread);

  const priceValue = priceDay ? meanWholesalePrice(priceDay) : null;
  const supplyValue = generationDay ? gasCoalShare(generationDay) : null;
  const reserveValue = reservesDay ? peakReservePrice(reservesDay) : null;
  const regionalValue = priceDay ? hayBenAbsSpread(priceDay) : null;

  return [
    {
      id: "prices",
      title: "Wholesale prices",
      date: priceDate,
      value: priceValue === null ? null : money.format(priceValue),
      band: priceRank.kind === "ranked" ? priceRank.band : null,
      headline: cardHeadline(
        priceDate,
        "Wholesale prices have not been published on this site yet.",
        "Wholesale prices",
        "were",
        priceRank,
      ),
      detail:
        "That is the average of the three sample substations. Wholesale prices are what generators and retailers paid each other, not a household bill.",
    },
    {
      id: "supply",
      title: "Supply",
      date: generationDate,
      value: supplyValue === null ? null : percent.format(supplyValue),
      band: supplyRank.kind === "ranked" ? supplyRank.band : null,
      headline: cardHeadline(
        generationDate,
        "Generation numbers have not been published on this site yet.",
        "Gas and coal's share of generation",
        "was",
        supplyRank,
      ),
      detail:
        "Gas and coal as a share of what power stations made, not counting batteries.",
    },
    {
      id: "reserves",
      title: "Reserves",
      date: reservesDate,
      value: reserveValue === null ? null : money.format(reserveValue),
      band: reserveRank.kind === "ranked" ? reserveRank.band : null,
      headline: cardHeadline(
        reservesDate,
        "Reserve prices have not been published on this site yet.",
        "Reserve prices",
        "were",
        reserveRank,
      ),
      detail:
        "The highest of the island prices for standing ready to lift or drop generation in seconds or minutes, not a household bill.",
    },
    {
      id: "regional",
      title: "Regional prices",
      date: priceDate,
      value: regionalValue === null ? null : money.format(regionalValue),
      band: regionalRank.kind === "ranked" ? regionalRank.band : null,
      headline: cardHeadline(
        priceDate,
        "The island price gap has not been published on this site yet.",
        "The island price gap",
        "was",
        regionalRank,
      ),
      detail:
        "The average gap between wholesale prices at Haywards, near Wellington, and Benmore, in the Waitaki. The two islands can have different prices.",
    },
  ];
}

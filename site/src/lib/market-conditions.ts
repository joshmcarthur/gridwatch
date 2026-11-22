import type {
  SiteDay,
  SiteIndex,
  SiteIndexDay,
} from "@gridwatch/publisher/site-contract";
import { dailyPath, headlineParagraphs } from "./daily-page.ts";
import { formatTradingDate } from "./site-data.ts";

const RANK_WINDOW = 365;
const RANK_MINIMUM = 30;
const RECENT_DAYS = 14;
const HAY = "HAY2201";
const BEN = "BEN2201";

const money = new Intl.NumberFormat("en-NZ", {
  style: "currency",
  currency: "NZD",
  maximumFractionDigits: 0,
});
const moneyFine = new Intl.NumberFormat("en-NZ", {
  style: "currency",
  currency: "NZD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const percent = new Intl.NumberFormat("en-NZ", {
  style: "percent",
  maximumFractionDigits: 0,
});

export type RankBand =
  | "lower than most days in the past year"
  | "about usual"
  | "higher than most"
  | "one of the highest";

export type ConditionId = "prices" | "supply" | "reserves" | "regional";

export interface MarketConditionCard {
  id: ConditionId;
  title: string;
  date: string | null;
  href: string | null;
  dateLabel: string;
  figure: string;
  band: RankBand | null;
  bandNote: string | null;
}

export interface LatestMarketUpdate {
  date: string | null;
  href: string | null;
  dateLabel: string;
  headlines: string[];
  generationLag: string | null;
  generationDate: string | null;
  generationHref: string | null;
}

export interface RecentDay {
  date: string;
  href: string;
  label: string;
  complete: boolean;
}

export type DayLoader = (date: string) => SiteDay;

/**
 * Band for `value` against `earlier`. A tie counts half, so a value equal to most earlier days
 * ranks as usual. Null when there are fewer than 30 earlier values.
 */
export function rankAgainstEarlier(
  value: number,
  earlier: number[],
): RankBand | null {
  if (earlier.length < RANK_MINIMUM) return null;
  const window = earlier.slice(-RANK_WINDOW);
  const below = window.filter((candidate) => candidate < value).length;
  const tied = window.filter((candidate) => candidate === value).length;
  const rank = (below + tied / 2) / window.length;
  if (rank >= 0.95) return "one of the highest";
  if (rank >= 0.75) return "higher than most";
  if (rank >= 0.25) return "about usual";
  return "lower than most days in the past year";
}

export function meanReferencePrice(day: SiteDay): number | null {
  const means = day.prices.nodes
    .map((node) => node.daily.mean_price)
    .filter((value): value is number => value !== null);
  if (means.length === 0) return null;
  return means.reduce((sum, value) => sum + value, 0) / means.length;
}

export function gasCoalShare(day: SiteDay): number | null {
  const primary = day.generation.totals?.primary_megawatt_hours;
  if (primary === undefined || primary === null || primary <= 0) return null;
  const thermal = day.generation.daily
    .filter((row) => row.fuel === "gas" || row.fuel === "coal_gas")
    .reduce((sum, row) => sum + row.megawatt_hours, 0);
  return thermal / primary;
}

export function meanReservePrice(day: SiteDay): number | null {
  const means = (day.reserves?.classes ?? [])
    .map((row) => row.mean_price)
    .filter((value): value is number => value !== null);
  if (means.length === 0) return null;
  return means.reduce((sum, value) => sum + value, 0) / means.length;
}

/** Mean absolute Haywards−Benmore spread: Lower North Island vs South Island. */
export function meanIslandSpread(day: SiteDay): number | null {
  const pair = day.prices.spreads.find(
    (spread) => spread.from === HAY && spread.to === BEN,
  );
  if (!pair) return null;
  const values = pair.spread
    .filter((value): value is number => value !== null)
    .map((value) => Math.abs(value));
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function latestMarketUpdate(
  index: SiteIndex,
  loadDay: DayLoader,
): LatestMarketUpdate {
  const date = index.latest_complete_sections.prices;
  if (!date) {
    return {
      date: null,
      href: null,
      dateLabel: "No complete prices day yet",
      headlines: [
        "Wholesale prices (what generators and retailers paid each other, not the rate on a household bill) have no complete day on this site yet.",
      ],
      generationLag: null,
      generationDate: null,
      generationHref: null,
    };
  }
  const day = loadDay(date);
  const headlines = headlineParagraphs(day);
  const latestGeneration = index.latest_complete_sections.generation;
  const generationMissing = day.generation.state === "missing";
  const generationLag = generationMissing
    ? latestGeneration && latestGeneration !== date
      ? `Generation numbers for this day are not in yet. The latest complete generation day is ${formatTradingDate(latestGeneration)}.`
      : "Generation numbers for this day are not in yet."
    : null;
  return {
    date,
    href: dailyPath(date),
    dateLabel: formatTradingDate(date),
    headlines,
    generationLag,
    generationDate:
      generationMissing && latestGeneration ? latestGeneration : null,
    generationHref:
      generationMissing && latestGeneration
        ? dailyPath(latestGeneration)
        : null,
  };
}

export function recentDays(index: SiteIndex, limit = RECENT_DAYS): RecentDay[] {
  return [...index.days]
    .slice(-limit)
    .reverse()
    .map((entry) => ({
      date: entry.date,
      href: dailyPath(entry.date),
      label: formatTradingDate(entry.date),
      complete: entry.complete,
    }));
}

export function marketConditionCards(
  index: SiteIndex,
  loadDay: DayLoader,
): MarketConditionCard[] {
  return [
    pricesCard(index, loadDay),
    supplyCard(index, loadDay),
    reservesCard(index, loadDay),
    regionalCard(index, loadDay),
  ];
}

function pricesCard(index: SiteIndex, loadDay: DayLoader): MarketConditionCard {
  return conditionCard({
    id: "prices",
    title: "Wholesale prices",
    date: index.latest_complete_sections.prices,
    index,
    section: "prices",
    loadDay,
    metricFrom: meanReferencePrice,
    figure: (value) =>
      `Wholesale prices averaged ${money.format(value)} per megawatt-hour.`,
    empty: "No complete wholesale-prices day yet.",
    noFigure: "Wholesale prices for this day have no figure.",
  });
}

function supplyCard(index: SiteIndex, loadDay: DayLoader): MarketConditionCard {
  return conditionCard({
    id: "supply",
    title: "Supply",
    date: index.latest_complete_sections.generation,
    index,
    section: "generation",
    loadDay,
    metricFrom: gasCoalShare,
    figure: (value) =>
      `Gas and coal made ${percent.format(value)} of generation.`,
    empty: "No complete generation day yet.",
    noFigure: "Generation for this day has no gas and coal share.",
  });
}

function reservesCard(
  index: SiteIndex,
  loadDay: DayLoader,
): MarketConditionCard {
  return conditionCard({
    id: "reserves",
    title: "Reserves",
    date: index.latest_complete_sections.reserves ?? null,
    index,
    section: "reserves",
    loadDay,
    metricFrom: meanReservePrice,
    figure: (value) =>
      `Reserve prices, the cost of backup generation kept ready if something trips, averaged ${formatReserveMoney(value)} per megawatt-hour.`,
    empty:
      "Reserve prices, the cost of backup generation kept ready if something trips, have not been published yet.",
    noFigure: "Reserve prices for this day have no figure.",
  });
}

function regionalCard(
  index: SiteIndex,
  loadDay: DayLoader,
): MarketConditionCard {
  return conditionCard({
    id: "regional",
    title: "Regional price differences",
    date: index.latest_complete_sections.prices,
    index,
    section: "prices",
    loadDay,
    metricFrom: meanIslandSpread,
    figure: (value) =>
      `Wholesale prices in the Lower North Island (Haywards, near Wellington) and the South Island (Benmore, in the Waitaki) differed by ${money.format(value)} per megawatt-hour, on average.`,
    empty: "No complete wholesale-prices day yet.",
    noFigure: "Regional price differences for this day have no figure.",
  });
}

function conditionCard(options: {
  id: ConditionId;
  title: string;
  date: string | null | undefined;
  index: SiteIndex;
  section: "generation" | "prices" | "reserves";
  loadDay: DayLoader;
  metricFrom: (day: SiteDay) => number | null;
  figure: (value: number) => string;
  empty: string;
  noFigure: string;
}): MarketConditionCard {
  const date = options.date ?? null;
  if (!date) {
    return {
      id: options.id,
      title: options.title,
      date: null,
      href: null,
      dateLabel: "No complete day yet",
      figure: options.empty,
      band: null,
      bandNote: null,
    };
  }
  const day = options.loadDay(date);
  const value = options.metricFrom(day);
  if (value === null) {
    return {
      id: options.id,
      title: options.title,
      date,
      href: dailyPath(date),
      dateLabel: formatTradingDate(date),
      figure: options.noFigure,
      band: null,
      bandNote: null,
    };
  }
  const earlier = earlierValues(
    options.index,
    options.section,
    date,
    options.metricFrom,
    options.loadDay,
  );
  const band = rankAgainstEarlier(value, earlier);
  return {
    id: options.id,
    title: options.title,
    date,
    href: dailyPath(date),
    dateLabel: formatTradingDate(date),
    figure: options.figure(value),
    band,
    bandNote: bandLabel(band, earlier.length),
  };
}

function earlierValues(
  index: SiteIndex,
  section: "generation" | "prices" | "reserves",
  latestDate: string,
  metricFrom: (day: SiteDay) => number | null,
  loadDay: DayLoader,
): number[] {
  const dates = index.days
    .filter(
      (entry) => entry.date < latestDate && sectionIsComplete(entry, section),
    )
    .map((entry) => entry.date)
    .slice(-RANK_WINDOW);
  const values: number[] = [];
  for (const date of dates) {
    const value = metricFrom(loadDay(date));
    if (value !== null) values.push(value);
  }
  return values;
}

function sectionIsComplete(
  entry: SiteIndexDay,
  section: "generation" | "prices" | "reserves",
): boolean {
  return entry.sections[section] === "complete";
}

function bandLabel(band: RankBand | null, earlierCount: number): string | null {
  if (band === null) {
    return earlierCount < RANK_MINIMUM
      ? "Not enough complete days yet to compare with the past year."
      : null;
  }
  const days = Math.min(earlierCount, RANK_WINDOW);
  const pastYear = days >= RANK_WINDOW;
  const against = pastYear
    ? "the past year"
    : `the ${days} earlier complete days on this site`;
  const most = pastYear ? "most days in the past year" : `most of ${against}`;
  if (band === "lower than most days in the past year") {
    return `That was lower than ${most}.`;
  }
  if (band === "about usual") {
    return `That was about usual against ${against}.`;
  }
  if (band === "higher than most") {
    return `That was higher than ${most}.`;
  }
  return pastYear
    ? "That was one of the highest days in the past year."
    : `That was one of the highest of ${against}.`;
}

function formatReserveMoney(value: number): string {
  return Math.abs(value) < 10 ? moneyFine.format(value) : money.format(value);
}

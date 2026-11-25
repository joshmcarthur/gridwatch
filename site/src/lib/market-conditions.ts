import type {
  SiteDay,
  SiteIndex,
  SiteIndexDay,
} from "@gridwatch/publisher/site-contract";
import { centsPerKwh } from "@gridwatch/publisher/story/price-regions.ts";
import { dailyPath, pageLead } from "./daily-page.ts";
import { formatTradingDate } from "./site-data.ts";

const RANK_WINDOW = 365;
const RANK_MINIMUM = 30;
const RECENT_DAYS = 14;
const WEEK_DAYS = 7;
const HAY = "HAY2201";
const BEN = "BEN2201";

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
  summary: string;
  generationLag: GenerationLag | null;
}

export interface GenerationLag {
  text: string;
  latest: { label: string; href: string } | null;
}

export interface RecentDay {
  date: string;
  href: string;
  label: string;
  complete: boolean;
  lead: string | null;
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
  const rank = rankFraction(value, earlier);
  if (rank === null) return null;
  if (rank >= 0.95) return "one of the highest";
  if (rank >= 0.75) return "higher than most";
  if (rank >= 0.25) return "about usual";
  return "lower than most days in the past year";
}

function rankFraction(value: number, earlier: number[]): number | null {
  if (earlier.length < RANK_MINIMUM) return null;
  const window = earlier.slice(-RANK_WINDOW);
  const below = window.filter((candidate) => candidate < value).length;
  const tied = window.filter((candidate) => candidate === value).length;
  return (below + tied / 2) / window.length;
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
      summary: "No day on this site has complete wholesale prices yet.",
      generationLag: null,
    };
  }
  const day = loadDay(date);
  const generationLag = generationLagNote(
    day,
    date,
    index.latest_complete_sections.generation,
  );
  return {
    date,
    href: dailyPath(date),
    dateLabel: formatTradingDate(date),
    summary: pageLead(day, leadFact(index, date, loadDay)),
    generationLag,
  };
}

function generationLagNote(
  day: SiteDay,
  date: string,
  latestGeneration: string | null | undefined,
): GenerationLag | null {
  if (day.generation.state !== "missing") return null;
  const text = "Generation numbers for this day are not in yet.";
  if (!latestGeneration || latestGeneration === date) {
    return { text, latest: null };
  }
  return {
    text,
    latest: {
      label: formatTradingDate(latestGeneration),
      href: dailyPath(latestGeneration),
    },
  };
}

export interface StatContext {
  id: "power" | "price" | "islands";
  line: string | null;
  change: string | null;
}

const energyFormat = new Intl.NumberFormat("en-NZ", {
  maximumFractionDigits: 0,
});

const STAT_METRICS: Array<{
  id: StatContext["id"];
  label: string;
  section: "generation" | "prices";
  subject: string;
  metric: (day: SiteDay) => number | null;
  change: ((delta: number) => string) | null;
}> = [
  {
    id: "power",
    label: "Generation",
    section: "generation",
    subject: "Generation was",
    metric: primaryGenerationMwh,
    change: (delta) => `${energyFormat.format(Math.abs(delta))} MWh`,
  },
  {
    id: "price",
    label: "Prices",
    section: "prices",
    subject: "Wholesale prices were",
    metric: meanReferencePrice,
    change: (delta) => `${centsPerKwh(Math.abs(delta))} per kWh`,
  },
  {
    id: "islands",
    label: "Price gap",
    section: "prices",
    subject: "The gap between places was",
    metric: meanIslandSpread,
    change: null,
  },
];

type Metric = Omit<(typeof STAT_METRICS)[number], "id" | "section"> & {
  id: string;
  section: "generation" | "prices" | "reserves";
};

const EXTRA_LEAD_METRICS: Metric[] = [
  {
    id: "thermal",
    label: "Gas and coal share",
    section: "generation",
    subject: "The gas and coal share of generation was",
    metric: gasCoalShare,
    change: null,
  },
  {
    id: "reserves",
    label: "Reserve prices",
    section: "reserves",
    subject: "Reserve prices (the cost of backup generation kept ready) were",
    metric: meanReservePrice,
    change: null,
  },
];

/**
 * The one sentence that leads a day: the figure furthest from "about usual" against earlier
 * complete days, using the same ranking as the homepage cards. A day with no such figure says so.
 * Null when no figure has enough earlier days to compare.
 */
export function leadFact(
  index: SiteIndex,
  date: string,
  loadDay: DayLoader,
): string | null {
  return leadFinding(index, date, loadDay)?.sentence ?? null;
}

export interface LeadFinding {
  sentence: string;
  /** The same finding in a few words, for a list of days. */
  short: string;
}

const BAND_SHORT: Record<RankBand, string> = {
  "lower than most days in the past year": "lower than most",
  "about usual": "about usual",
  "higher than most": "higher than most",
  "one of the highest": "one of the highest",
};

export function leadFinding(
  index: SiteIndex,
  date: string,
  loadDay: DayLoader,
): LeadFinding | null {
  const day = loadDay(date);
  let best: (LeadFinding & { score: number }) | null = null;
  let compared = 0;
  let earlierCount = 0;
  for (const spec of [...STAT_METRICS, ...EXTRA_LEAD_METRICS] as Metric[]) {
    const value = spec.metric(day);
    if (value === null) continue;
    const earlier = earlierValues(
      index,
      spec.section,
      date,
      spec.metric,
      loadDay,
    );
    const rank = rankFraction(value, earlier);
    const band = rankAgainstEarlier(value, earlier);
    if (rank === null || band === null) continue;
    compared += 1;
    earlierCount = Math.max(earlierCount, earlier.length);
    if (band === "about usual") continue;
    const score = Math.abs(rank - 0.5);
    if (best === null || score > best.score) {
      best = {
        score,
        sentence: `${spec.subject} ${bandPhrase(band, earlier.length)}.`,
        short: `${spec.label}: ${BAND_SHORT[band]}`,
      };
    }
  }
  if (best) return { sentence: best.sentence, short: best.short };
  if (compared === 0) return null;
  return {
    sentence: `None of the day's main figures was far from usual for ${spanPhrase(earlierCount)}.`,
    short: "Main figures about usual",
  };
}

export function primaryGenerationMwh(day: SiteDay): number | null {
  const mwh = day.generation.totals?.primary_megawatt_hours;
  return mwh === undefined || mwh === null || mwh <= 0 ? null : mwh;
}

/**
 * One line per headline figure: where the day sits against earlier complete days, using the same
 * ranking as the homepage cards, and the change from the day before when that day is complete.
 */
export function dayContext(
  index: SiteIndex,
  date: string,
  loadDay: DayLoader,
): StatContext[] {
  const day = loadDay(date);
  const at = index.days.findIndex((entry) => entry.date === date);
  const previous = at > 0 ? index.days[at - 1] : undefined;
  const dayBefore = Temporal.PlainDate.from(date).subtract({ days: 1 });
  return STAT_METRICS.map((spec) => {
    const value = spec.metric(day);
    if (value === null) return { id: spec.id, line: null, change: null };
    const earlier = earlierValues(
      index,
      spec.section,
      date,
      spec.metric,
      loadDay,
    );
    const band = rankAgainstEarlier(value, earlier);
    const line = band
      ? `${spec.subject} ${bandPhrase(band, earlier.length)}.`
      : null;
    let change: string | null = null;
    if (
      spec.change &&
      previous &&
      previous.date === dayBefore.toString() &&
      previous.sections[spec.section] === "complete"
    ) {
      const before = spec.metric(loadDay(previous.date));
      if (before !== null) {
        const delta = value - before;
        change =
          Math.round(delta) === 0
            ? "About the same as the day before."
            : `${delta > 0 ? "Up" : "Down"} ${spec.change(delta)} from the day before.`;
      }
    }
    return { id: spec.id, line, change };
  });
}

/** The newest days first. With `loadDay`, the latest `WEEK_DAYS` carry their short finding. */
export function recentDays(
  index: SiteIndex,
  limit = RECENT_DAYS,
  loadDay?: DayLoader,
): RecentDay[] {
  return [...index.days]
    .slice(-limit)
    .reverse()
    .map((entry, position) => ({
      date: entry.date,
      href: dailyPath(entry.date),
      label: formatTradingDate(entry.date),
      complete: entry.complete,
      lead:
        loadDay && position < WEEK_DAYS
          ? (leadFinding(index, entry.date, loadDay)?.short ?? null)
          : null,
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
      `At Ōtāhuhu, Haywards and Benmore, wholesale prices averaged ${centsPerKwh(value)} per kWh.`,
    empty: "No complete wholesale-prices day yet.",
    noFigure: "Wholesale prices for this day have no figure.",
  });
}

function supplyCard(index: SiteIndex, loadDay: DayLoader): MarketConditionCard {
  return conditionCard({
    id: "supply",
    title: "Gas and coal",
    date: index.latest_complete_sections.generation,
    index,
    section: "generation",
    loadDay,
    metricFrom: gasCoalShare,
    figure: (value) => `Gas and coal made ${shareOf(value)} of generation.`,
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
      `Reserve prices, the cost of backup generation kept ready if something trips, averaged ${centsPerKwh(value)} per kWh across both islands and every kind of reserve.`,
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
      `Wholesale prices at Haywards, near Wellington, and Benmore, in the South Island, differed by ${centsPerKwh(value)} per kWh on average.`,
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
  if (band === null) return null;
  return `That was ${bandPhrase(band, earlierCount)}.`;
}

/**
 * Where a figure sits, in plain words. The span is "the past year" once a year of
 * earlier days exists, else the past N months (ADR-0029: no day counts in prose).
 */
function spanPhrase(earlierCount: number): string {
  const days = Math.min(earlierCount, RANK_WINDOW);
  const months = Math.round(days / 30.4);
  if (days >= RANK_WINDOW) return "the past year";
  return months >= 2
    ? `the past ${months} months`
    : `the ${days} earlier days on this site`;
}

function bandPhrase(band: RankBand, earlierCount: number): string {
  const span = spanPhrase(earlierCount);
  // "the past year" and "the past 11 months" read as periods; a short history reads as a count.
  const period = span.startsWith("the past");
  if (band === "lower than most days in the past year") {
    return period
      ? `lower than most days in ${span}`
      : `lower than most of ${span}`;
  }
  if (band === "about usual") return `about usual for ${span}`;
  if (band === "higher than most") {
    return period
      ? `higher than most days in ${span}`
      : `higher than most of ${span}`;
  }
  return period
    ? `one of the highest in ${span}`
    : `one of the highest of ${span}`;
}

/** A share that rounds to 0% but is not zero reads as "under 1%". */
function shareOf(value: number): string {
  return value > 0 && value < 0.005 ? "under 1%" : percent.format(value);
}

export interface RecentDayGroup {
  /** The shared finding, or null for days with none. */
  lead: string | null;
  days: RecentDay[];
}

/**
 * Runs of consecutive days with the same finding become one group, so five days of
 * "Reserve prices: one of the highest" read as one line, not five (ADR-0029).
 */
export function groupRecentDays(days: RecentDay[]): RecentDayGroup[] {
  const groups: RecentDayGroup[] = [];
  for (const day of days) {
    const last = groups.at(-1);
    if (last && day.lead !== null && last.lead === day.lead) {
      last.days.push(day);
    } else {
      groups.push({ lead: day.lead, days: [day] });
    }
  }
  return groups;
}

/** A short date for a list of days, for example `Sat 21 Nov`. */
export function shortDayLabel(date: string): string {
  return Temporal.PlainDate.from(date).toLocaleString("en-NZ", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

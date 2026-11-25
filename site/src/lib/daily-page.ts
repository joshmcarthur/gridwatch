import type {
  FuelCategory,
  SectionState,
  SiteDay,
  SiteEpisode,
  SiteIndex,
  SiteIndexDay,
} from "@gridwatch/publisher/site-contract";
import { episodeHeadline } from "@gridwatch/publisher/story/episode-copy.ts";
import { FUEL_LABELS, type StackFuel } from "@gridwatch/publisher/story/generation-mix.ts";
import { clockLabeller12, zonedAt } from "@gridwatch/publisher/story/period-clock.ts";
import { centsPerKwh, placeName } from "@gridwatch/publisher/story/price-regions.ts";

const energyFormat = new Intl.NumberFormat("en-NZ", {
  maximumFractionDigits: 0,
});
/** Daily mean prices this far apart still count as close. */
const CLOSE_DOLLARS = 10;
/** Daily mean prices this far apart or more are far apart. */
const APART_DOLLARS = 50;

export type HeadlineSource = {
  generation: {
    state: SectionState;
    totals: {
      primary_megawatt_hours: number;
      battery_megawatt_hours: number;
    } | null;
    daily: Array<{ fuel: FuelCategory; megawatt_hours: number }>;
  };
  prices: {
    state: SectionState;
    nodes: Array<{
      price_region: string;
      daily: { mean_price: number | null };
    }>;
  };
};

export type DayStat = {
  id: string;
  label: string;
  href: string;
  value: string;
};

export type DayHeadline = {
  sentence: string;
  stats: DayStat[];
};

export function dailyPath(date: string): string {
  const parsed = Temporal.PlainDate.from(date);
  const month = String(parsed.month).padStart(2, "0");
  const day = String(parsed.day).padStart(2, "0");
  return `/${parsed.year}/${month}/${day}/`;
}

export function mapPath(date: string): string {
  return `${dailyPath(date)}#map`;
}

export function dateFromParams(
  year: string,
  month: string,
  day: string,
): string {
  return Temporal.PlainDate.from(`${year}-${month}-${day}`).toString();
}

export function dailyStaticPaths(index: SiteIndex): Array<{
  params: { year: string; month: string; day: string };
}> {
  return index.days.map((entry) => {
    const [year, month, day] = entry.date.split("-");
    if (!year || !month || !day) {
      throw new Error(`Index day ${entry.date} is not YYYY-MM-DD`);
    }
    return { params: { year, month, day } };
  });
}

export function neighbouringDays(
  index: SiteIndex,
  date: string,
): { previous: SiteIndexDay | null; next: SiteIndexDay | null } {
  const at = index.days.findIndex((entry) => entry.date === date);
  if (at < 0) throw new Error(`No site day ${date} in the index`);
  return {
    previous: index.days[at - 1] ?? null,
    next: index.days[at + 1] ?? null,
  };
}

export function mixJsonPath(date: string): string {
  return `${dailyPath(date)}mix.json`;
}

function hasPublishedMix(state: SectionState): boolean {
  switch (state) {
    case "complete":
    case "incomplete":
      return true;
    case "missing":
      return false;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

/** Other index days whose generation mix can be drawn. */
export function mixCompareDays(index: SiteIndex, date: string): SiteIndexDay[] {
  return index.days.filter(
    (entry) =>
      entry.date !== date && hasPublishedMix(entry.sections.generation),
  );
}

/** Previous mix day if there is one, otherwise the next mix day. */
export function defaultMixCompareDay(
  index: SiteIndex,
  date: string,
): SiteIndexDay | null {
  const options = mixCompareDays(index, date);
  const earlier = options.filter((entry) => entry.date < date);
  return earlier.at(-1) ?? options[0] ?? null;
}

export function monthGroups(
  index: SiteIndex,
): Array<{ key: string; label: string; days: SiteIndexDay[] }> {
  const groups: Array<{ key: string; label: string; days: SiteIndexDay[] }> =
    [];
  for (const entry of index.days) {
    const parsed = Temporal.PlainDate.from(entry.date);
    const key = `${parsed.year}-${String(parsed.month).padStart(2, "0")}`;
    const last = groups.at(-1);
    if (last && last.key === key) {
      last.days.push(entry);
      continue;
    }
    groups.push({
      key,
      label: parsed.toLocaleString("en-NZ", { month: "long", year: "numeric" }),
      days: [entry],
    });
  }
  return groups;
}

export function dayHeadline(day: HeadlineSource): DayHeadline {
  const fuel = topFuelLabel(day);
  const places = meanPrices(day);
  const means = places.map((place) => place.price);
  const agreement = islandAgreement(means);
  return {
    sentence: kindOfDay(day, fuel, agreement),
    stats: [
      powerStat(day),
      priceStat(day, places, agreement),
      islandsStat(day, agreement),
    ],
  };
}

/**
 * Opening sentence for a daily page and the homepage latest update.
 * An episode line leads when the day has one. Quiet days use the history
 * lead, then the kind-of-day sentence.
 */
export function pageLead(
  day: HeadlineSource & {
    periods: Array<{ period: number; start_utc: string }>;
    episodes?: { items: SiteEpisode[] };
  },
  quietLead: string | null,
): string {
  const first = day.episodes?.items[0];
  if (first !== undefined) return episodeHeadline(first, day);
  return quietLead ?? dayHeadline(day).sentence;
}

export type GapSource = Pick<SiteDay, "complete" | "periods"> & {
  generation: { state: SectionState; missing_periods: number[] };
  prices: { state: SectionState; missing_periods: number[] };
};

/**
 * One line naming what an incomplete day is missing, as clock ranges (ADR-0029). Null for a
 * complete day. It sits beside the map rather than leading the page: most gaps are a
 * half-hour or two of prices.
 */
export function gapNote(day: GapSource): string | null {
  if (day.complete) return null;
  const ranges = (periods: number[]) => clockRanges(day, periods);
  const missing: string[] = [];
  const absent: string[] = [];
  if (day.prices.state === "missing") absent.push("wholesale prices");
  else if (day.prices.missing_periods.length > 0) {
    missing.push(`wholesale prices for ${ranges(day.prices.missing_periods)}`);
  }
  if (day.generation.state === "missing") absent.push("generation figures");
  else if (day.generation.missing_periods.length > 0) {
    missing.push(
      `generation figures for ${ranges(day.generation.missing_periods)}`,
    );
  }
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`The market files have no ${joinAnd(missing)}.`);
  }
  if (absent.length > 0) {
    const what = joinAnd(absent);
    parts.push(
      `${what.charAt(0).toUpperCase()}${what.slice(1)} for this day aren't in the files yet.`,
    );
  }
  return parts.length > 0
    ? parts.join(" ")
    : "Some of the market files for this day are incomplete.";
}

export type TotalsSource = Pick<SiteDay, "sankey"> & {
  generation: {
    state: SectionState;
    totals: { primary_megawatt_hours: number } | null;
  };
};

/**
 * The day's totals in one or two sentences (ADR-0031): what was generated, and what the
 * cable sent and what arrived. It replaces the stat cards. Null when there is nothing to say.
 */
export function totalsSentence(day: TotalsSource): string | null {
  const parts: string[] = [];
  const totals = day.generation.totals;
  if (day.generation.state !== "missing" && totals) {
    parts.push(
      `The two islands generated ${energyFormat.format(totals.primary_megawatt_hours)} MWh over the day.`,
    );
  }
  const islands = day.sankey?.islands ?? [];
  const sender = islands.find(
    (island) => (island.hvdc_import_megawatt_hours ?? 0) < 0,
  );
  const receiver = islands.find((island) => island !== sender);
  const sent = sender?.hvdc_import_megawatt_hours ?? null;
  if (sender && sent !== null) {
    const name = sender.island === "SI" ? "South Island" : "North Island";
    const direction = sender.island === "SI" ? "north" : "south";
    const arrived = receiver?.hvdc_import_megawatt_hours ?? null;
    parts.push(
      arrived !== null && arrived > 0
        ? `The ${name} sent ${energyFormat.format(-sent)} MWh ${direction} on the cable, and ${energyFormat.format(arrived)} MWh arrived.`
        : `The ${name} sent ${energyFormat.format(-sent)} MWh ${direction} on the cable.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/** Trading periods as clock ranges, for example `3:00pm to 3:30pm and 7:00pm to 8:00pm`. */
function clockRanges(day: Pick<SiteDay, "periods">, periods: number[]): string {
  const label = clockLabeller12(day);
  const indexOf = (period: number) =>
    day.periods.findIndex((item) => item.period === period);
  const startOf = (index: number) => {
    const period = day.periods[index];
    return period ? label(zonedAt(period.start_utc)) : "";
  };
  const endOf = (index: number) => {
    const next = day.periods[index + 1];
    if (next) return label(zonedAt(next.start_utc));
    const period = day.periods[index];
    return period ? label(zonedAt(period.start_utc).add({ minutes: 30 })) : "";
  };
  const indexes = [...new Set(periods.map(indexOf))]
    .filter((index) => index !== -1)
    .sort((a, b) => a - b);
  const runs: Array<[number, number]> = [];
  for (const index of indexes) {
    const last = runs.at(-1);
    if (last && index === last[1] + 1) last[1] = index;
    else runs.push([index, index]);
  }
  return joinAnd(runs.map(([from, to]) => `${startOf(from)} to ${endOf(to)}`));
}

function joinAnd(parts: string[]): string {
  if (parts.length < 2) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function kindOfDay(
  day: HeadlineSource,
  fuel: string | null,
  agreement: IslandAgreement | null,
): string {
  const genMissing =
    day.generation.state === "missing" || day.generation.totals === null;
  const priceMissing = day.prices.state === "missing" || agreement === null;
  if (genMissing && priceMissing) {
    return "Generation and wholesale prices for this day are missing.";
  }
  const fuelClause = fuel ? `${fuel} made most of the power` : null;
  const priceClause = agreementPhrase(agreement);
  const parts = [fuelClause, priceClause].filter(
    (part): part is string => part !== null,
  );
  if (parts.length === 0) {
    if (day.generation.state === "incomplete") {
      return "Generation numbers for this day are incomplete.";
    }
    return "Wholesale prices for this day are incomplete.";
  }
  const joined =
    parts.length === 1
      ? `${capitalize(parts[0])}.`
      : `${parts[0]}, and ${parts[1]}.`;
  if (day.generation.state === "incomplete" && fuelClause) {
    return `Incomplete generation numbers. ${capitalize(joined)}`;
  }
  if (day.prices.state === "incomplete" && priceClause && !fuelClause) {
    return `Incomplete wholesale prices. ${capitalize(joined)}`;
  }
  return capitalize(joined);
}

function powerStat(day: HeadlineSource): DayStat {
  const totals = day.generation.totals;
  const value =
    day.generation.state === "missing" || totals === null
      ? "No numbers yet"
      : `${energyFormat.format(totals.primary_megawatt_hours)} MWh`;
  return {
    id: "power",
    label: "Electricity generated",
    href: "#word-megawatt-hour",
    value,
  };
}

function priceStat(
  day: HeadlineSource,
  places: PlacePrice[],
  agreement: IslandAgreement | null,
): DayStat {
  const means = places.map((place) => place.price);
  let value = "No numbers yet";
  if (means.length === 1) {
    value = `${centsPerKwh(means[0] ?? 0)} per kWh`;
  } else if (means.length > 1 && agreement === "close") {
    const typical = means.reduce((sum, price) => sum + price, 0) / means.length;
    value = `${centsPerKwh(typical)} per kWh`;
  } else if (means.length > 1) {
    const sorted = [...places].sort((a, b) => a.price - b.price);
    const low = sorted[0];
    const high = sorted[sorted.length - 1];
    if (low && high) {
      value = `${centsPerKwh(low.price)} (${low.place}) to ${centsPerKwh(high.price)} (${high.place}) per kWh`;
    }
  }
  return {
    id: "price",
    label: "Average wholesale price",
    href: "#word-wholesale-price",
    value:
      day.prices.state === "missing" && means.length === 0
        ? "No numbers yet"
        : value,
  };
}

function islandsStat(
  day: HeadlineSource,
  agreement: IslandAgreement | null,
): DayStat {
  const value =
    day.prices.state === "missing" || agreement === null
      ? "No numbers yet"
      : agreement === "close"
        ? "Stayed close"
        : agreement === "differed"
          ? "Differed"
          : "Far apart";
  return {
    id: "islands",
    label: "The three places",
    href: "#word-places",
    value,
  };
}

type IslandAgreement = "close" | "differed" | "apart";

function islandAgreement(means: number[]): IslandAgreement | null {
  if (means.length === 0) return null;
  if (means.length === 1) return "close";
  const range = Math.max(...means) - Math.min(...means);
  if (range < CLOSE_DOLLARS) return "close";
  if (range < APART_DOLLARS) return "differed";
  return "apart";
}

function agreementPhrase(agreement: IslandAgreement | null): string | null {
  switch (agreement) {
    case "close":
      return "wholesale prices stayed close across Ōtāhuhu, Haywards and Benmore";
    case "differed":
      return "wholesale prices differed across Ōtāhuhu, Haywards and Benmore";
    case "apart":
      return "wholesale prices were far apart across Ōtāhuhu, Haywards and Benmore";
    default:
      return null;
  }
}

function topFuelLabel(day: HeadlineSource): string | null {
  if (day.generation.state === "missing" || day.generation.totals === null) {
    return null;
  }
  const sums = new Map<string, number>();
  for (const row of day.generation.daily) {
    if (row.fuel === "battery") continue;
    sums.set(row.fuel, (sums.get(row.fuel) ?? 0) + row.megawatt_hours);
  }
  let best: { fuel: string; mwh: number } | null = null;
  for (const [fuel, mwh] of sums) {
    if (!best || mwh > best.mwh) best = { fuel, mwh };
  }
  if (!best || best.mwh <= 0) return null;
  return FUEL_LABELS[best.fuel as StackFuel] ?? best.fuel;
}

type PlacePrice = { place: string; price: number };

function meanPrices(day: HeadlineSource): PlacePrice[] {
  if (day.prices.state === "missing") return [];
  return day.prices.nodes.flatMap((node) =>
    typeof node.daily.mean_price === "number"
      ? [
          {
            place: placeName(node.price_region),
            price: node.daily.mean_price,
          },
        ]
      : [],
  );
}

function capitalize(text: string): string {
  if (text.length === 0) return text;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

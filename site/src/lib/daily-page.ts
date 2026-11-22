import type {
  DatasetState,
  FuelCategory,
  SectionState,
  SiteIndex,
  SiteIndexDay,
} from "@gridwatch/publisher/site-contract";
import { FUEL_LABELS, type StackFuel } from "./generation-mix.ts";

const energyFormat = new Intl.NumberFormat("en-NZ", {
  maximumFractionDigits: 0,
});
const moneyFormat = new Intl.NumberFormat("en-NZ", {
  style: "currency",
  currency: "NZD",
  maximumFractionDigits: 0,
});

/** Daily mean prices this far apart still count as close. */
const CLOSE_DOLLARS = 10;
/** Daily mean prices this far apart or more have pulled apart. */
const APART_DOLLARS = 50;

const DATASET_LABELS: Record<string, string> = {
  dispatch_energy_prices: "wholesale energy prices",
  dispatch_reserve_prices:
    "reserve prices (the cost of standing ready to lift or drop generation)",
  generation_md: "generation",
  entity_mappings: "plant names and locations",
};

export type CompletenessSource = {
  complete: boolean;
  datasets: Record<string, { status: DatasetState }>;
  generation: { state: SectionState };
  prices: { state: SectionState };
};

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
  return `${dailyPath(date)}map/`;
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
  const means = meanPrices(day);
  const agreement = islandAgreement(means);
  return {
    sentence: kindOfDay(day, fuel, agreement),
    stats: [
      powerStat(day),
      priceStat(day, means, agreement),
      islandsStat(day, agreement),
    ],
  };
}

export function completenessNotice(day: CompletenessSource): {
  tone: "warn";
  paragraphs: string[];
} | null {
  if (day.complete) return null;
  const paragraphs = ["This day is incomplete."];
  for (const [id, dataset] of Object.entries(day.datasets)) {
    if (dataset.status === "complete") continue;
    paragraphs.push(
      `${datasetStatusHeading(dataset.status)}: ${datasetLabel(id)}.`,
    );
  }
  if (day.generation.state !== "complete") {
    paragraphs.push(
      `Generation numbers ${sectionStatusPhrase(day.generation.state)}.`,
    );
  }
  if (day.prices.state !== "complete") {
    paragraphs.push(
      `Wholesale prices ${sectionStatusPhrase(day.prices.state)}.`,
    );
  }
  return { tone: "warn", paragraphs };
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
    label: "Power made",
    href: "#word-megawatt-hour",
    value,
  };
}

function priceStat(
  day: HeadlineSource,
  means: number[],
  agreement: IslandAgreement | null,
): DayStat {
  let value = "No numbers yet";
  if (means.length === 1) {
    value = `${moneyFormat.format(means[0] ?? 0)} / MWh`;
  } else if (means.length > 1 && agreement === "close") {
    const typical = means.reduce((sum, price) => sum + price, 0) / means.length;
    value = `${moneyFormat.format(typical)} / MWh`;
  } else if (means.length > 1) {
    const low = moneyFormat.format(Math.min(...means));
    const high = moneyFormat.format(Math.max(...means));
    value = `${low} to ${high} / MWh`;
  }
  return {
    id: "price",
    label: "Wholesale price",
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
          : "Pulled apart";
  return {
    id: "islands",
    label: "The two islands",
    href: "#word-islands",
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
      return "wholesale prices at the sample points stayed close";
    case "differed":
      return "wholesale prices differed between the islands";
    case "apart":
      return "wholesale prices pulled apart between the islands";
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

function meanPrices(day: HeadlineSource): number[] {
  if (day.prices.state === "missing") return [];
  return day.prices.nodes
    .map((node) => node.daily.mean_price)
    .filter((price): price is number => typeof price === "number");
}

function datasetLabel(id: string): string {
  return DATASET_LABELS[id] ?? id.replaceAll("_", " ");
}

function datasetStatusHeading(status: DatasetState): string {
  switch (status) {
    case "complete":
      return "Complete";
    case "partial":
      return "Only partial";
    case "missing":
      return "Missing";
    case "invalid":
      return "Failed a check";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function sectionStatusPhrase(status: SectionState): string {
  switch (status) {
    case "complete":
      return "look complete";
    case "incomplete":
      return "are incomplete";
    case "missing":
      return "are missing";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function capitalize(text: string): string {
  if (text.length === 0) return text;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

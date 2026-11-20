import type {
  DatasetState,
  SectionState,
  SiteIndex,
  SiteIndexDay,
} from "@gridwatch/publisher/site-contract";

const energyFormat = new Intl.NumberFormat("en-NZ", {
  maximumFractionDigits: 0,
});
const moneyFormat = new Intl.NumberFormat("en-NZ", {
  style: "currency",
  currency: "NZD",
  maximumFractionDigits: 0,
});

const DATASET_LABELS: Record<string, string> = {
  dispatch_energy_prices:
    "wholesale energy prices (the prices generators and retailers traded at, not a household bill)",
  generation_md: "generation (what power stations made)",
  entity_mappings: "plant names and locations",
};

export const PRICE_REGIONS: Record<string, string> = {
  upper_north_island: "the Upper North Island (Otahuhu, Auckland)",
  lower_north_island: "the Lower North Island (Haywards, near Wellington)",
  south_island: "the South Island (Benmore, in the Waitaki)",
};

export const CHART_SLOTS = [
  {
    id: "wholesale-prices",
    title: "What it sold for",
    body: "A chart of wholesale prices, and how they differed between regions, will sit here. It is not drawn yet.",
  },
  {
    id: "energy-flow",
    title: "Where the energy went",
    body: "A chart of how energy moved through the system will sit here. It is not drawn yet.",
  },
] as const;

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
  };
  prices: {
    state: SectionState;
    nodes: Array<{
      price_region: string;
      daily: { mean_price: number | null };
    }>;
  };
};

export function dailyPath(date: string): string {
  const parsed = Temporal.PlainDate.from(date);
  const month = String(parsed.month).padStart(2, "0");
  const day = String(parsed.day).padStart(2, "0");
  return `/${parsed.year}/${month}/${day}/`;
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

export function headlineParagraphs(day: HeadlineSource): string[] {
  return [generationHeadline(day), pricesHeadline(day)];
}

export function completenessNotice(day: CompletenessSource): {
  tone: "ok" | "warn";
  paragraphs: string[];
} {
  if (day.complete) {
    return {
      tone: "ok",
      paragraphs: ["The files behind this page look complete."],
    };
  }
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

function generationHeadline(day: HeadlineSource): string {
  const totals = day.generation.totals;
  if (day.generation.state === "missing" || totals === null) {
    return "Generation numbers for this day are missing.";
  }
  const made = energyFormat.format(totals.primary_megawatt_hours);
  const battery = energyFormat.format(totals.battery_megawatt_hours);
  const intro =
    day.generation.state === "incomplete"
      ? `Incomplete generation numbers say power stations made about ${made} megawatt-hours of electricity.`
      : `Power stations made about ${made} megawatt-hours of electricity.`;
  return `${intro} A megawatt-hour is 1,000 kilowatt-hours, the same kWh unit as the line on a power bill. Batteries moved another ${battery} megawatt-hours, charging and discharging rather than making new power.`;
}

function pricesHeadline(day: HeadlineSource): string {
  const means = day.prices.nodes.filter(
    (node) => node.daily.mean_price !== null,
  );
  if (day.prices.state === "missing" || means.length === 0) {
    return "Wholesale prices for this day are missing.";
  }
  const parts = means.map((node) => {
    const region = regionLabel(node.price_region);
    const price = moneyFormat.format(node.daily.mean_price ?? 0);
    return `${price} per megawatt-hour in ${region}`;
  });
  const list = joinAnd(parts);
  const prefix =
    day.prices.state === "incomplete"
      ? "Incomplete wholesale prices"
      : "Wholesale prices";
  return `${prefix} (what generators and retailers paid each other, not the rate on a household bill) averaged ${list}. New Zealand's electricity system runs as two islands joined by a cable; those three substations are sample points, not your house.`;
}

function datasetLabel(id: string): string {
  return DATASET_LABELS[id] ?? id.replaceAll("_", " ");
}

function regionLabel(id: string): string {
  return PRICE_REGIONS[id] ?? id.replaceAll("_", " ");
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

function joinAnd(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

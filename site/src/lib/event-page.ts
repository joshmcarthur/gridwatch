import type {
  EventConfidence,
  ReviewStatus,
  SiteDay,
  SiteEvent,
  SiteEventClaim,
  SiteIndex,
} from "@gridwatch/publisher/site-contract";
import { dailyPath } from "./daily-page.ts";
import type { LinePlot, PlotLine } from "./line-plot.ts";
import {
  clockLabeller,
  clockLabeller12,
  timeTicks,
  zonedAt,
} from "./period-clock.ts";
import { placeName } from "./price-regions.ts";

const NODE_ORDER = ["OTA2201", "HAY2201", "BEN2201"] as const;

const NODE_LINE: Record<
  (typeof NODE_ORDER)[number],
  { colour: string; dashed: boolean }
> = {
  OTA2201: { colour: "var(--color-island-north)", dashed: false },
  HAY2201: { colour: "var(--color-island-north)", dashed: true },
  BEN2201: { colour: "var(--color-island-south)", dashed: false },
};

const SOURCE_TABLE: Record<string, string> = {
  price_periods: "wholesale period prices",
  dispatch_energy_prices: "dispatch energy prices",
  reserve_by_class_island_period: "daily reserve prices",
  price_spreads: "period price spreads",
};

const GROUP_ORDER = [
  "price",
  "price_max",
  "reserve",
  "generation",
  "hvdc",
  "dispatch",
  "episode",
  "other",
] as const;

type ClaimGroup = (typeof GROUP_ORDER)[number];

const GROUP_HEADING: Record<ClaimGroup, string> = {
  price: "Wholesale prices",
  price_max: "Highest publishes",
  reserve: "Reserve prices",
  generation: "Generation",
  hvdc: "Cook Strait link",
  dispatch: "Dispatch publishes",
  episode: "This stretch",
  other: "Other figures",
};

const money = new Intl.NumberFormat("en-NZ", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function eventPath(date: string, id: string): string {
  return `${dailyPath(date)}events/${id}/`;
}

export function eventStaticPaths(
  index: SiteIndex,
  loadDay: (date: string) => SiteDay,
): Array<{ params: { year: string; month: string; day: string; id: string } }> {
  return index.days.flatMap((entry) => {
    const [year, month, day] = entry.date.split("-");
    if (!year || !month || !day) {
      throw new Error(`Index day ${entry.date} is not YYYY-MM-DD`);
    }
    return (loadDay(entry.date).events?.items ?? []).map((event) => ({
      params: { year, month, day, id: event.episode_id },
    }));
  });
}

export function claimLabelForSite(label: string): string {
  return label
    .replaceAll("OTA2201", "Ōtāhuhu")
    .replaceAll("HAY2201", "Haywards")
    .replaceAll("BEN2201", "Benmore")
    .replace(/\bFIR\b/g, "6-second")
    .replace(/\bSIR\b/g, "60-second")
    .replace(/\bNI\b/g, "North Island")
    .replace(/\bSI\b/g, "South Island");
}

export function confidenceWord(level: EventConfidence): string {
  switch (level) {
    case "confirmed":
      return "Confirmed";
    case "strong_evidence":
      return "Strong evidence";
    case "possible_explanation":
      return "Possible explanation";
    default: {
      const unreachable: never = level;
      return unreachable;
    }
  }
}

export function reviewWord(status: ReviewStatus): string {
  switch (status) {
    case "unreviewed":
      return "Unreviewed";
    case "reviewed":
      return "Reviewed";
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

export function claimDomId(id: string): string {
  return `claim-${id.split(".").map(claimIdToken).join("-")}`;
}

export function sourceTableWords(table: string): string {
  return SOURCE_TABLE[table] ?? table.replaceAll("_", " ");
}

export function formatClaimValue(
  value: number | string | boolean,
  unit: string,
): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value;
  if (unit === "$/MWh") return `$${money.format(value)}`;
  const number = new Intl.NumberFormat("en-NZ").format(value);
  return unit === "" ? number : `${number} ${unit}`;
}

export function groupClaims(
  claims: SiteEventClaim[],
): Array<{ id: ClaimGroup; heading: string; claims: SiteEventClaim[] }> {
  const buckets = new Map<ClaimGroup, SiteEventClaim[]>();
  for (const claim of claims) {
    const group = claimGroup(claim.id);
    const list = buckets.get(group) ?? [];
    list.push(claim);
    buckets.set(group, list);
  }
  return GROUP_ORDER.flatMap((group) => {
    const items = buckets.get(group);
    if (items === undefined || items.length === 0) return [];
    return [{ id: group, heading: GROUP_HEADING[group], claims: items }];
  });
}

export interface EventWindowChart {
  axis: {
    periods: Array<{ start: Date; title: string }>;
    ticks: Array<{ at: Date; label: string }>;
  };
  pricePlot: LinePlot;
  priceSummary: string;
  reservePlot: LinePlot | null;
  reserveSummary: string;
  headers: string[];
  rows: string[][];
  caption: string;
}

export function eventWindowChart(
  event: SiteEvent,
  day: Pick<SiteDay, "periods">,
): EventWindowChart {
  const clock = clockLabeller(day);
  const clock12 = clockLabeller12(day);
  const axisPeriods = event.window.periods.map((period, index) => {
    const startUtc = event.window.start_utc[index];
    if (startUtc === undefined) {
      throw new Error(`Event ${event.episode_id} window is missing start_utc`);
    }
    const zoned = zonedAt(startUtc);
    return {
      period,
      start: new Date(startUtc),
      title: clock(zoned),
    };
  });
  const ticks = timeTicks({
    periods: event.window.periods.map((period, index) => ({
      period,
      start_utc: event.window.start_utc[index] ?? "",
    })),
  });
  const axis = { periods: axisPeriods, ticks };
  const priceLines = NODE_ORDER.flatMap((poc) => {
    const series = event.window.prices.find(
      (row) => row.point_of_connection === poc,
    );
    if (!series) return [];
    const style = NODE_LINE[poc];
    const line: PlotLine = {
      id: poc,
      values: series.price,
      colour: style.colour,
      dashed: style.dashed,
    };
    return [line];
  });
  const priceValues = priceLines.flatMap((line) =>
    line.values.filter((value): value is number => value !== null),
  );
  const first = event.window.start_utc[0];
  const last = event.window.start_utc.at(-1);
  const span =
    first !== undefined && last !== undefined
      ? `${clock12(zonedAt(first))}–${clock12(zonedAt(last))}`
      : "this stretch";
  const pricePlot: LinePlot = {
    id: "event-price-chart",
    title: "Wholesale price at three places",
    yLabel: "Wholesale price ($ per megawatt-hour, $/MWh)",
    domain: numericDomain(priceValues),
    lines: priceLines,
  };
  const reserve = event.window.reserves.find(
    (row) => row.reserve_class === "SIR" && row.island === "NI",
  );
  const reserveValues = reserve
    ? reserve.price.filter((value): value is number => value !== null)
    : [];
  const reservePlot: LinePlot | null =
    reserve && reserveValues.length > 0
      ? {
          id: "event-reserve-chart",
          title: "North Island 60-second reserve",
          yLabel: "60-second reserve ($ per megawatt-hour, $/MWh)",
          domain: numericDomain(reserveValues),
          lines: [
            {
              id: "reserve-60s-north",
              values: reserve.price,
              colour: "var(--color-island-north)",
              dashed: false,
            },
          ],
        }
      : null;
  const headers = [
    "Time",
    ...NODE_ORDER.map((poc) => placeName(poc)),
    ...(reservePlot ? ["North Island 60-second reserve"] : []),
  ];
  const rows = axisPeriods.map((period, index) => {
    const priceCells = NODE_ORDER.map((poc) => {
      const series = event.window.prices.find(
        (row) => row.point_of_connection === poc,
      );
      return moneyCell(series?.price[index] ?? null);
    });
    const reserveCell = reservePlot
      ? [moneyCell(reserve?.price[index] ?? null)]
      : [];
    return [period.title, ...priceCells, ...reserveCell];
  });
  return {
    axis,
    pricePlot,
    priceSummary: `Wholesale prices at Ōtāhuhu, Haywards and Benmore from ${span}, New Zealand time.`,
    reservePlot,
    reserveSummary: `North Island 60-second reserve from ${span}, New Zealand time.`,
    headers,
    rows,
    caption: `Wholesale prices at Ōtāhuhu, Haywards and Benmore from ${span}, New Zealand time.`,
  };
}

function claimIdToken(part: string): string {
  switch (part) {
    case "FIR":
      return "6s";
    case "SIR":
      return "60s";
    case "NI":
      return "north";
    case "SI":
      return "south";
    default:
      return part;
  }
}

function claimGroup(id: string): ClaimGroup {
  const head = id.split(".")[0] ?? "other";
  switch (head) {
    case "price":
    case "price_max":
    case "reserve":
    case "generation":
    case "hvdc":
    case "dispatch":
    case "episode":
      return head;
    default:
      return "other";
  }
}

function numericDomain(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  return [Math.min(0, ...values), Math.max(0, ...values)];
}

function moneyCell(value: number | null): string {
  if (value === null) return "No data";
  return `$${money.format(value)}`;
}

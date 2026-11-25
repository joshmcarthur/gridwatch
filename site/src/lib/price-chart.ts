import type {
  PricesSection,
  SiteDay,
} from "@gridwatch/publisher/site-contract";
import { episodeClockRange } from "@gridwatch/publisher/story/episode-copy.ts";
import {
  clockLabeller,
  timeTicks,
  zonedAt,
} from "@gridwatch/publisher/story/period-clock.ts";
import {
  placeLegend,
  placeName,
} from "@gridwatch/publisher/story/price-regions.ts";

export const PRICE_MISSING =
  "Wholesale prices for this day are missing, so there is no chart.";

export const PRICE_NOTICE =
  "Some wholesale price numbers are missing. A place with no price has a gap in its line, and the table says No data.";

export type PriceIsland = "NI" | "SI";

/** Island and line style for each reference node (ADR-0012, Landscape colour rules). */
export const NODE_STYLE: Record<
  string,
  { island: PriceIsland; dashed: boolean }
> = {
  OTA2201: { island: "NI", dashed: false },
  HAY2201: { island: "NI", dashed: true },
  BEN2201: { island: "SI", dashed: false },
};

const money = new Intl.NumberFormat("en-NZ", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export interface PriceNodeLine {
  poc: string;
  /** Place and region, for example `Ōtāhuhu (Upper North Island)`. */
  label: string;
  island: PriceIsland;
  dashed: boolean;
  /** $/MWh for each period. Null where silver has no price. */
  values: Array<number | null>;
  /** True where the period price is a proxy price. */
  proxy: boolean[];
  daily: {
    mean: number | null;
    min: number | null;
    max: number | null;
  };
}

export interface PriceSpreadLine {
  from: string;
  to: string;
  /** Short form, for example `OTA-HAY`. */
  name: string;
  /** First minus second, in $/MWh. */
  values: Array<number | null>;
}

export interface PlottedSpreadLine extends PriceSpreadLine {
  dashed: boolean;
}

export interface PricePeriod {
  period: number;
  start: Date;
  /** Local clock time, for example `03:00`. */
  time: string;
  /** Every node has no price for this period. */
  gap: boolean;
  /** Text for the native hover tooltip. */
  title: string;
}

export interface PriceChartBand {
  x1: Date;
  x2: Date;
  title: string;
}

export interface PriceChart {
  /** The prices section is `incomplete`. */
  incomplete: boolean;
  periods: PricePeriod[];
  nodes: PriceNodeLine[];
  /** Spreads drawn as chart lines. OTA-BEN is not here. */
  plottedSpreads: PlottedSpreadLine[];
  /** Spreads in the table and hover text, including OTA-BEN, in contract order. */
  tableSpreads: PriceSpreadLine[];
  /** Y domain of the price chart. Built from the period prices, with zero included. */
  priceDomain: [number, number];
  /** Y domain of the spread chart, over the plotted spreads, with zero included. */
  spreadDomain: [number, number];
  ticks: Array<{ at: Date; label: string }>;
  /** Clock windows of wholesale-price or spread episodes. */
  bands: PriceChartBand[];
}

type SpreadPlacement = { kind: "plotted"; dashed: boolean } | { kind: "table" };

/**
 * Builds the price chart for one day. Returns null when the prices section is missing.
 * Uses the periods the day lists, so a 46 or 50 period day needs no clock arithmetic.
 */
export function priceChart(day: SiteDay): PriceChart | null {
  const section: PricesSection = day.prices;
  if (section.state === "missing" || section.nodes.length === 0) return null;

  const clockOf = clockLabeller(day);

  const nodes: PriceNodeLine[] = section.nodes.map((node) => {
    const style = NODE_STYLE[node.point_of_connection];
    if (!style) {
      throw new Error(`No chart style for ${node.point_of_connection}`);
    }
    const values = node.price;
    const proxyPeriods = new Set(node.proxy_periods);
    return {
      poc: node.point_of_connection,
      label: placeLegend(node.point_of_connection, node.price_region),
      island: style.island,
      dashed: style.dashed,
      values,
      proxy: day.periods.map((period) => proxyPeriods.has(period.period)),
      daily: {
        mean: node.daily.mean_price,
        min: node.daily.min_price,
        max: node.daily.max_price,
      },
    };
  });

  const plottedSpreads: PlottedSpreadLine[] = [];
  const tableSpreads: PriceSpreadLine[] = [];
  for (const spread of section.spreads) {
    const line: PriceSpreadLine = {
      from: spread.from,
      to: spread.to,
      name: `${spread.from.slice(0, 3)}-${spread.to.slice(0, 3)}`,
      values: spread.spread,
    };
    tableSpreads.push(line);
    const placement = spreadPlacement(spread.from, spread.to);
    switch (placement.kind) {
      case "plotted":
        plottedSpreads.push({ ...line, dashed: placement.dashed });
        break;
      case "table":
        break;
      default: {
        const _exhaustive: never = placement;
        return _exhaustive;
      }
    }
  }

  const periods: PricePeriod[] = day.periods.map((period, index) => {
    // A gap is a period with no price at any node. One missing node only breaks its own line.
    const gap = nodes.every((n) => n.values[index] === null);
    const time = clockOf(zonedAt(period.start_utc));
    const start = new Date(period.start_utc);
    const title = gap
      ? `${time} · No price numbers for this period`
      : hoverText(time, index, nodes, tableSpreads);
    return { period: period.period, start, time, gap, title };
  });

  const plotted = nodes.flatMap((node) => node.values).filter(isNumber);
  const plottedSpreadValues = plottedSpreads
    .flatMap((spread) => spread.values)
    .filter(isNumber);

  return {
    incomplete: section.state === "incomplete",
    periods,
    nodes,
    plottedSpreads,
    tableSpreads,
    priceDomain: domain(plotted),
    spreadDomain: domain(plottedSpreadValues),
    ticks: timeTicks(day),
    bands: priceChartBands(day),
  };
}

/** One row per period. Cells hold the price, or `No data`. Spreads are the last columns. */
export function priceChartTable(chart: PriceChart): {
  headers: string[];
  rows: string[][];
} {
  const headers = [
    "Time",
    ...chart.nodes.map((node) => `${node.poc} $/MWh`),
    ...chart.tableSpreads.map((spread) => `Spread ${spread.name} ($/MWh)`),
  ];
  const rows = chart.periods.map((period, index) => {
    const incomplete =
      !period.gap && chart.nodes.some((node) => node.values[index] === null);
    return [
      incomplete ? `${period.time} (incomplete)` : period.time,
      ...chart.nodes.map((node) => {
        if (period.gap) return "No data";
        return priceCell(
          node.values[index] ?? null,
          node.proxy[index] ?? false,
        );
      }),
      ...chart.tableSpreads.map((spread) => {
        if (period.gap) return "No data";
        const value = spread.values[index] ?? null;
        return value === null ? "No data" : signedMoney(value);
      }),
    ];
  });
  return { headers, rows };
}

/** One sentence for the price chart text alternative. */
export function priceChartSummary(chart: PriceChart): string {
  const parts = chart.nodes
    .map((node) => {
      const plotted = node.values.filter(isNumber);
      if (plotted.length === 0) return null;
      return `${placeName(node.poc)} from ${signedMoney(Math.min(...plotted))} to ${signedMoney(Math.max(...plotted))}`;
    })
    .filter((part): part is string => part !== null);
  if (parts.length === 0) {
    return `Period prices for this day are missing.${bandSummary(chart.bands)}`;
  }
  return `Period prices per megawatt-hour: ${parts.join(", ")}.${bandSummary(chart.bands)}`;
}

function spreadPlaces(spread: { from: string; to: string }): string {
  return `${placeName(spread.from)}–${placeName(spread.to)}`;
}

/** One sentence for the spread chart text alternative. */
export function priceSpreadSummary(chart: PriceChart): string {
  const parts = chart.plottedSpreads.map((spread) => {
    const plotted = spread.values.filter(isNumber);
    const label = spreadPlaces(spread);
    if (plotted.length === 0) return `${label} has no data`;
    return `${label} from ${signedMoney(Math.min(...plotted))} to ${signedMoney(Math.max(...plotted))}`;
  });
  return `Spreads in $/MWh, first place minus second: ${parts.join(", ")}. Ōtāhuhu–Benmore is in the table.${bandSummary(chart.bands)}`;
}

/** Three sentences for the daily figures. Highest and lowest are raw row prices, not period averages. */
export function priceChartDaily(chart: PriceChart): string[] {
  const lines: Array<[string, (node: PriceNodeLine) => number | null]> = [
    ["Average of the period prices for the day", (node) => node.daily.mean],
    [
      "Lowest single price published (not a period average)",
      (node) => node.daily.min,
    ],
    [
      "Highest single price published (not a period average)",
      (node) => node.daily.max,
    ],
  ];
  return lines.flatMap(([heading, pick]) => {
    const values = chart.nodes
      .map((node) => ({ place: placeName(node.poc), value: pick(node) }))
      .filter((item): item is { place: string; value: number } =>
        isNumber(item.value),
      );
    if (values.length === 0) return [];
    const list = values
      .map((item) => `${item.place} ${signedMoney(item.value)}`)
      .join(", ");
    return [`${heading}: ${list}, per megawatt-hour.`];
  });
}

const WHOLESALE_BAND_TYPES = new Set([
  "price_high",
  "price_low",
  "separation_high",
  "separation_low",
]);

function isWholesaleBandType(type: string): boolean {
  return WHOLESALE_BAND_TYPES.has(type);
}

function priceChartBands(day: SiteDay): PriceChartBand[] {
  const section = day.episodes;
  if (section === undefined || section.state === "missing") return [];
  const bands: PriceChartBand[] = [];
  for (const episode of section.items) {
    if (!episode.observation_types.some(isWholesaleBandType)) continue;
    const x1 = new Date(episode.start_utc);
    const x2 = new Date(episode.end_utc);
    if (!(x2.getTime() > x1.getTime())) continue;
    bands.push({
      x1,
      x2,
      title: `Unusual stretch ${episodeClockRange(episode, day)}`,
    });
  }
  return bands;
}

function bandSummary(bands: PriceChartBand[]): string {
  if (bands.length === 0) return "";
  if (bands.length === 1) return " A shaded band marks an unusual stretch.";
  return " Shaded bands mark unusual stretches.";
}

function spreadPlacement(from: string, to: string): SpreadPlacement {
  const key = `${from}-${to}`;
  switch (key) {
    case "OTA2201-HAY2201":
      return { kind: "plotted", dashed: true };
    case "HAY2201-BEN2201":
      return { kind: "plotted", dashed: false };
    case "OTA2201-BEN2201":
      return { kind: "table" };
    default:
      throw new Error(`No chart style for ${from} to ${to}`);
  }
}

function hoverText(
  time: string,
  index: number,
  nodes: PriceNodeLine[],
  spreads: PriceSpreadLine[],
): string {
  const parts = [time];
  for (const node of nodes) {
    const value = node.values[index] ?? null;
    if (value === null) {
      parts.push(`${node.poc} no data`);
      continue;
    }
    const proxy = node.proxy[index] ? " (copied from a nearby place)" : "";
    parts.push(`${node.poc} ${signedMoney(value)}/MWh${proxy}`);
  }
  for (const spread of spreads) {
    const value = spread.values[index] ?? null;
    parts.push(
      value === null
        ? `Spread ${spread.name} no data`
        : `Spread ${spread.name} ${signedMoney(value)}/MWh`,
    );
  }
  return parts.join(" · ");
}

function priceCell(value: number | null, proxy: boolean): string {
  if (value === null) return "No data";
  return `${signedMoney(value)}${proxy ? " (copied from a nearby place)" : ""}`;
}

/** Money with a sign before the dollar sign, for example `-$5.00`. */
function signedMoney(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${money.format(Math.abs(value))}`;
}

/** Zero is always in the domain. An empty list gives a unit domain, so the axis still draws. */
function domain(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  return [Math.min(0, ...values), Math.max(0, ...values)];
}

function isNumber(value: number | null | undefined): value is number {
  return typeof value === "number";
}

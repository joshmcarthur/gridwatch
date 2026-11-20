import type {
  PricesSection,
  SiteDay,
} from "@gridwatch/publisher/site-contract";
import { PRICE_REGIONS } from "./daily-page.ts";
import { clockLabeller, timeTicks, zonedAt } from "./period-clock.ts";

export const PRICE_MISSING =
  "We do not have wholesale prices for this day, so there is no chart.";

export const PRICE_NOTICE =
  "Some wholesale price numbers are missing. A node with no price has a gap in its line, and the table says No data.";

/** Island and line style for each reference node (ADR-0012, Landscape colour rules). */
const NODE_STYLE: Record<string, { island: "NI" | "SI"; dashed: boolean }> = {
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
  /** The label from `PRICE_REGIONS`. */
  label: string;
  island: "NI" | "SI";
  dashed: boolean;
  /** $/MWh for each period. Null where silver has no price. */
  values: Array<number | null>;
  /** True where the period price is a proxy price. */
  proxy: boolean[];
  /** A valid period whose neighbours are both null. A line draws nothing for it, so it gets a dot. */
  lone: boolean[];
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
  /** Only two spreads are drawn. The third is in the table and in the hover text. */
  drawn: boolean;
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

export interface PriceChart {
  /** The prices section is `incomplete`. */
  incomplete: boolean;
  periods: PricePeriod[];
  nodes: PriceNodeLine[];
  /** The spreads in the contract order. */
  spreads: PriceSpreadLine[];
  /** Y domain of the price chart. Built from the period prices, with zero included. */
  priceDomain: [number, number];
  /** Y domain of the spread chart, over the drawn spreads, with zero included. */
  spreadDomain: [number, number];
  ticks: Array<{ at: Date; label: string }>;
}

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
      label: PRICE_REGIONS[node.price_region] ?? node.price_region,
      island: style.island,
      dashed: style.dashed,
      values,
      proxy: day.periods.map((period) => proxyPeriods.has(period.period)),
      lone: values.map(
        (value, index) =>
          value !== null &&
          (values[index - 1] ?? null) === null &&
          (values[index + 1] ?? null) === null,
      ),
      daily: {
        mean: node.daily.mean_price,
        min: node.daily.min_price,
        max: node.daily.max_price,
      },
    };
  });

  const spreads: PriceSpreadLine[] = section.spreads.map((spread) => {
    // OTA-BEN is the sum of the other two, so it is not drawn (ADR-0012).
    const undrawn = spread.from === "OTA2201" && spread.to === "BEN2201";
    return {
      from: spread.from,
      to: spread.to,
      name: `${spread.from.slice(0, 3)}-${spread.to.slice(0, 3)}`,
      values: spread.spread,
      drawn: !undrawn,
      dashed: spread.from === "OTA2201" && spread.to === "HAY2201",
    };
  });

  const periods: PricePeriod[] = day.periods.map((period, index) => {
    // A gap is a period with no price at any node. One missing node only breaks its own line.
    const gap = nodes.every((n) => n.values[index] === null);
    const time = clockOf(zonedAt(period.start_utc));
    const start = new Date(period.start_utc);
    const title = gap
      ? `${time} · No price numbers for this period`
      : hoverText(time, index, nodes, spreads);
    return { period: period.period, start, time, gap, title };
  });

  const plotted = nodes.flatMap((node) => node.values).filter(isNumber);
  const drawnSpreads = spreads
    .filter((spread) => spread.drawn)
    .flatMap((spread) => spread.values)
    .filter(isNumber);

  return {
    incomplete: section.state === "incomplete",
    periods,
    nodes,
    spreads,
    priceDomain: domain(plotted),
    spreadDomain: domain(drawnSpreads),
    ticks: timeTicks(day),
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
    ...chart.spreads.map((spread) => `Spread ${spread.name} ($/MWh)`),
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
      ...chart.spreads.map((spread) => {
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
      return `${node.poc} from ${signedMoney(Math.min(...plotted))} to ${signedMoney(Math.max(...plotted))}`;
    })
    .filter((part): part is string => part !== null);
  if (parts.length === 0) return "We have no period prices for this day.";
  return `Period prices per megawatt-hour: ${parts.join(", ")}.`;
}

/** One sentence for the spread chart text alternative. */
export function priceSpreadSummary(chart: PriceChart): string {
  const parts = chart.spreads
    .filter((spread) => spread.drawn)
    .map((spread) => {
      const plotted = spread.values.filter(isNumber);
      if (plotted.length === 0) return `${spread.name} has no data`;
      return `${spread.name} from ${signedMoney(Math.min(...plotted))} to ${signedMoney(Math.max(...plotted))}`;
    });
  return `Spreads in $/MWh, first node minus second: ${parts.join(", ")}. OTA-BEN is in the table.`;
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
      .map((node) => ({ poc: node.poc, value: pick(node) }))
      .filter((item): item is { poc: string; value: number } =>
        isNumber(item.value),
      );
    if (values.length === 0) return [];
    const list = values
      .map((item) => `${item.poc} ${signedMoney(item.value)}`)
      .join(", ");
    return [`${heading}: ${list}, per megawatt-hour.`];
  });
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
    const proxy = node.proxy[index] ? " (proxy price)" : "";
    parts.push(`${node.poc} ${signedMoney(value)}/MWh${proxy}`);
  }
  for (const spread of spreads) {
    const value = spread.values[index] ?? null;
    parts.push(
      value === null
        ? `Spread ${spread.name} no data`
        : `Spread ${spread.name} ${signedMoney(value)}`,
    );
  }
  return parts.join(" · ");
}

function priceCell(value: number | null, proxy: boolean): string {
  if (value === null) return "No data";
  return `${signedMoney(value)}${proxy ? " (proxy price)" : ""}`;
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

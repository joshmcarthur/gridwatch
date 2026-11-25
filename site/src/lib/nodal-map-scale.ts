import type { Island } from "@gridwatch/publisher/site-contract";
import { centsPerKwh } from "@gridwatch/publisher/story/price-regions.ts";
import type { Lane } from "./day-lanes.ts";

const cableMegawatts = new Intl.NumberFormat("en-NZ", {
  maximumFractionDigits: 0,
});

export const MISSING_FILL = "#b7c5c0";
export const DOT_RADIUS = 3.5;
export const OUTLIER_RADIUS = 5.5;

/**
 * Fixed price bands in $/MWh, so a colour means the same thing at every time of day
 * (ADR-0029). `below` is exclusive; the last band has no upper limit.
 */
export const PRICE_BANDS = [
  { label: "Very cheap", range: "under 3c", below: 30, fill: "#72bcae" },
  { label: "Usual", range: "3c to 8c", below: 80, fill: "#869792" },
  { label: "High", range: "8c to 20c", below: 200, fill: "#b06a08" },
  { label: "Very high", range: "20c and over", below: null, fill: "#8a2716" },
] as const;

export interface NodalMapRow {
  point_of_connection: string;
  location: string;
  island: string;
  price: number | null;
  outlier: boolean;
  proxy: boolean;
}

export interface NodalMapPayloadPoc {
  point_of_connection: string;
  island: string;
  prices: Array<number | null>;
  proxy_periods: number[];
}

/** One beat as the browser needs it (ADR-0029). Text only; the page renders it. */
export interface NodalMapBeat {
  at: number;
  from: number;
  to: number;
  /** Fuels the beat names. The generation lane and island bars dim the others. */
  fuels?: string[];
}

/** One island's generation by fuel, average MW per period. Null in a gap. */
export interface NodalMapIsland {
  key: "north" | "south";
  fuels: Array<{
    fuel: string;
    label: string;
    colour: string;
    megawatts: Array<number | null>;
  }>;
}

/** What the page sends to the browser as JSON. Plain data, no coastline. */
export interface NodalMapPayload {
  defaultPeriod: number;
  periods: Array<{ period: number; time: string }>;
  /** Reference places drawn and labelled on the map, with their prices. */
  places: Array<{ point_of_connection: string; prices: Array<number | null> }>;
  beats: NodalMapBeat[];
  islands: NodalMapIsland[];
  /** Average MW sent over the cable in each half-hour, positive north. */
  cable?: Array<number | null> | null;
  /** The lanes beside the map, for tooltips (ADR-0031). */
  lanes?: Lane[];
  p05: Array<number | null>;
  p95: Array<number | null>;
  min: Array<number | null>;
  max: Array<number | null>;
  pocs: NodalMapPayloadPoc[];
  unlocated: NodalMapPayloadPoc[];
}

export function islandLabel(island: Island | null): string {
  switch (island) {
    case "NI":
      return "North Island";
    case "SI":
      return "South Island";
    case null:
      return "";
    default: {
      const _exhaustive: never = island;
      return _exhaustive;
    }
  }
}

export function formatPrice(value: number | null): string {
  if (value === null) return "No data";
  return new Intl.NumberFormat("en-NZ", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** Fill for a dot: its fixed price band, or grey when the price is missing. */
export function priceBandFill(price: number | null): string {
  if (price === null) return MISSING_FILL;
  const band = PRICE_BANDS.find(
    (item) => item.below === null || price < item.below,
  );
  return band?.fill ?? MISSING_FILL;
}

export function isOutlier(
  price: number | null,
  p05: number | null,
  p95: number | null,
): boolean {
  if (price === null || p05 === null || p95 === null) return false;
  return price < p05 || price > p95;
}

export function sortRows(
  rows: NodalMapRow[],
  column: "point_of_connection" | "location" | "island" | "price" | "outlier",
  dir: "asc" | "desc",
): NodalMapRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (column === "price") {
      if (a.price === null && b.price === null) return 0;
      if (a.price === null) return 1;
      if (b.price === null) return -1;
      return (a.price - b.price) * sign;
    }
    if (column === "outlier") {
      return (Number(a.outlier) - Number(b.outlier)) * sign;
    }
    return a[column].localeCompare(b[column]) * sign;
  });
}

export function periodSummary(
  view: Pick<NodalMapPayload, "periods" | "min" | "max">,
  period: number,
): string {
  const clock = view.periods.find((p) => p.period === period)?.time ?? "";
  const i = period - 1;
  const min = view.min[i];
  const max = view.max[i];
  if (min === null || max === null || min === undefined || max === undefined) {
    return `At ${clock}, wholesale prices for this half-hour are missing.`;
  }
  return `At ${clock}, wholesale prices on the grid ranged from ${centsPerKwh(min)} to ${centsPerKwh(max)} per kWh.`;
}

export function rowsForPeriod(
  payload: NodalMapPayload,
  period: number,
): NodalMapRow[] {
  const i = period - 1;
  const p05 = payload.p05[i] ?? null;
  const p95 = payload.p95[i] ?? null;
  const rowOf = (poc: NodalMapPayloadPoc, location: string): NodalMapRow => {
    const price = poc.prices[i] ?? null;
    return {
      point_of_connection: poc.point_of_connection,
      location,
      island: poc.island,
      price,
      outlier: isOutlier(price, p05, p95),
      proxy: poc.proxy_periods.includes(period),
    };
  };
  return [
    ...payload.pocs.map((poc) => rowOf(poc, "On the map")),
    ...payload.unlocated.map((poc) => rowOf(poc, "")),
  ];
}

export function cableLabels(megawatts: number): {
  label: string;
  amount: string;
} {
  return {
    label:
      Math.round(megawatts) === 0
        ? "Cable idle"
        : `Cable ${megawatts > 0 ? "north" : "south"}`,
    amount: `about ${cableMegawatts.format(Math.abs(megawatts))} MW`,
  };
}

export function cableWidth(megawatts: number): number {
  return Math.min(8, Math.max(2, Math.abs(megawatts) / 120));
}

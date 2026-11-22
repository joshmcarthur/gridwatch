import type { Island } from "@gridwatch/publisher/site-contract";

export const MISSING_FILL = "#b7c5c0";
export const DOT_RADIUS = 3.5;
export const OUTLIER_RADIUS = 5.5;

type Rgb = [number, number, number];
const LOW: Rgb = [31, 111, 120];
const MID: Rgb = [242, 181, 68];
const HIGH: Rgb = [183, 121, 31];

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

/** What the page sends to the browser as JSON. Plain data, no coastline. */
export interface NodalMapPayload {
  defaultPeriod: number;
  periods: Array<{ period: number; time: string }>;
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

function hex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/** Sequential fill from tarn (low) through solar (mid) to amber (high). */
export function priceFill(
  price: number | null,
  min: number | null,
  max: number | null,
): string {
  if (price === null || min === null || max === null) return MISSING_FILL;
  if (max <= min) return hex(MID);
  const t = Math.min(1, Math.max(0, (price - min) / (max - min)));
  return hex(t < 0.5 ? mix(LOW, MID, t * 2) : mix(MID, HIGH, (t - 0.5) * 2));
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
  if (min === null || max === null) {
    return `Trading period ${period} (${clock}). Wholesale prices for this slice are missing.`;
  }
  return `Trading period ${period} (${clock}). Wholesale prices range from ${formatPrice(min)} to ${formatPrice(max)} dollars per megawatt-hour.`;
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

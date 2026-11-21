import type {
  Island,
  NodalMapUnlocated,
  SiteDay,
} from "@gridwatch/publisher/site-contract";
import coastlineJson from "../data/nz-coastline.json";
import {
  DOT_RADIUS,
  formatPrice,
  islandLabel,
  isOutlier,
  type NodalMapRow,
  OUTLIER_RADIUS,
  priceFill,
} from "./nodal-map-scale.ts";
import { clockLabeller, zonedAt } from "./period-clock.ts";

export {
  DOT_RADIUS,
  formatPrice,
  islandLabel,
  isOutlier,
  MISSING_FILL,
  type NodalMapRow,
  OUTLIER_RADIUS,
  priceFill,
  sortRows,
} from "./nodal-map-scale.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

export const MAP_WIDTH = 330;
export const MAP_HEIGHT = 480;
const MAP_PAD = 14;

type Ring = number[][];
type GeoJson = {
  features: Array<{
    geometry: {
      type: string;
      coordinates: number[][][] | number[][][][];
    };
  }>;
};

export interface ProjectedPoc {
  point_of_connection: string;
  island: Island | null;
  cx: number;
  cy: number;
  latitude: number;
  longitude: number;
  price: Array<number | null>;
  proxy_periods: number[];
}

export interface MapPeriod {
  period: number;
  /** Local clock, for example `07:30`. */
  time: string;
}

export interface NodalMapView {
  defaultPeriod: number;
  periods: MapPeriod[];
  pocs: ProjectedPoc[];
  unlocated: NodalMapUnlocated[];
  landPaths: string[];
  p05: Array<number | null>;
  p95: Array<number | null>;
  min: Array<number | null>;
  max: Array<number | null>;
  incomplete: boolean;
  plotted: number;
  priced: number;
}

export function loadCoastline(): GeoJson {
  return coastlineJson as GeoJson;
}

export function defaultPeriod(day: SiteDay): number {
  const dist = day.prices.distribution;
  let best = 1;
  let bestRange = Number.NEGATIVE_INFINITY;
  for (const period of day.periods) {
    const i = period.period - 1;
    const min = dist.min[i];
    const max = dist.max[i];
    if (min === null || max === null) continue;
    const range = max - min;
    if (range > bestRange) {
      bestRange = range;
      best = period.period;
    }
  }
  return bestRange === Number.NEGATIVE_INFINITY ? 1 : best;
}

function ringsOf(geometry: GeoJson["features"][number]["geometry"]): Ring[] {
  if (geometry.type === "Polygon")
    return (geometry.coordinates as number[][][]).map((ring) => ring);
  if (geometry.type === "MultiPolygon")
    return (geometry.coordinates as number[][][][]).flatMap((poly) =>
      poly.map((ring) => ring),
    );
  return [];
}

function projectRaw(lon: number, lat: number): [number, number] {
  const x = (lon - 173) * Math.cos((-41 * Math.PI) / 180);
  const y = -41 - lat;
  return [x, y];
}

function boundsOf(rings: Ring[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const point of ring) {
      const lon = point[0];
      const lat = point[1];
      if (lon === undefined || lat === undefined) continue;
      const [x, y] = projectRaw(lon, lat);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

export function makeProjector(coastline: GeoJson) {
  const rings = coastline.features.flatMap((feature) =>
    ringsOf(feature.geometry),
  );
  const { minX, minY, maxX, maxY } = boundsOf(rings);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const innerW = MAP_WIDTH - MAP_PAD * 2;
  const innerH = MAP_HEIGHT - MAP_PAD * 2;
  const scale = Math.min(innerW / spanX, innerH / spanY);
  const ox = MAP_PAD + (innerW - spanX * scale) / 2;
  const oy = MAP_PAD + (innerH - spanY * scale) / 2;
  const project = (lon: number, lat: number): [number, number] => {
    const [x, y] = projectRaw(lon, lat);
    return [ox + (x - minX) * scale, oy + (y - minY) * scale];
  };
  const pathOf = (ring: Ring): string => {
    return ring
      .map((point, i) => {
        const lon = point[0];
        const lat = point[1];
        if (lon === undefined || lat === undefined) return "";
        const [x, y] = project(lon, lat);
        return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  };
  return {
    project,
    landPaths: rings.map((ring) => `${pathOf(ring)}Z`),
  };
}

export function nodalMapView(
  day: SiteDay,
  coastline: GeoJson = loadCoastline(),
): NodalMapView | null {
  const section = day.nodal_map;
  if (!section || section.state === "missing") return null;
  const { project, landPaths } = makeProjector(coastline);
  const label = clockLabeller(day);
  return {
    defaultPeriod: defaultPeriod(day),
    periods: day.periods.map((period) => ({
      period: period.period,
      time: label(zonedAt(period.start_utc)),
    })),
    pocs: section.pocs.map((poc) => {
      const [cx, cy] = project(poc.longitude, poc.latitude);
      return {
        point_of_connection: poc.point_of_connection,
        island: poc.island,
        cx,
        cy,
        latitude: poc.latitude,
        longitude: poc.longitude,
        price: poc.price,
        proxy_periods: poc.proxy_periods,
      };
    }),
    unlocated: section.unlocated,
    landPaths,
    p05: day.prices.distribution.p05,
    p95: day.prices.distribution.p95,
    min: day.prices.distribution.min,
    max: day.prices.distribution.max,
    incomplete: section.state === "incomplete",
    plotted: section.pocs.length,
    priced: section.pocs.length + section.unlocated.length,
  };
}

export function rowsForPeriod(
  view: NodalMapView,
  period: number,
): NodalMapRow[] {
  const i = period - 1;
  const p05 = view.p05[i] ?? null;
  const p95 = view.p95[i] ?? null;
  const rows: NodalMapRow[] = [];
  for (const poc of view.pocs) {
    const price = poc.price[i] ?? null;
    rows.push({
      point_of_connection: poc.point_of_connection,
      location: "On the map",
      island: islandLabel(poc.island),
      price,
      outlier: isOutlier(price, p05, p95),
      proxy: poc.proxy_periods.includes(period),
    });
  }
  for (const poc of view.unlocated) {
    const price = poc.price[i] ?? null;
    rows.push({
      point_of_connection: poc.point_of_connection,
      location: "",
      island: islandLabel(poc.island),
      price,
      outlier: isOutlier(price, p05, p95),
      proxy: poc.proxy_periods.includes(period),
    });
  }
  return rows;
}

export function periodSummary(view: NodalMapView, period: number): string {
  const clock = view.periods.find((p) => p.period === period)?.time ?? "";
  const i = period - 1;
  const min = view.min[i];
  const max = view.max[i];
  if (min === null || max === null) {
    return `Trading period ${period} (${clock}). Wholesale prices for this slice are missing.`;
  }
  return `Trading period ${period} (${clock}). Wholesale prices range from ${formatPrice(min)} to ${formatPrice(max)} dollars per megawatt-hour.`;
}

export function renderMapSvg(
  view: NodalMapView,
  period: number,
  labels: { id: string; title: string; summary: string },
): string {
  const i = period - 1;
  const min = view.min[i] ?? null;
  const max = view.max[i] ?? null;
  const p05 = view.p05[i] ?? null;
  const p95 = view.p95[i] ?? null;
  const land = view.landPaths
    .map(
      (d) =>
        `<path d="${d}" fill="var(--color-header-body)" stroke="var(--color-rule)" stroke-width="0.6"/>`,
    )
    .join("");
  const dots = view.pocs
    .map((poc) => {
      const price = poc.price[i] ?? null;
      const outlier = isOutlier(price, p05, p95);
      const r = outlier ? OUTLIER_RADIUS : DOT_RADIUS;
      const title = `${poc.point_of_connection}, ${formatPrice(price)} dollars per megawatt-hour`;
      return `<circle data-poc="${escapeAttr(poc.point_of_connection)}" cx="${poc.cx.toFixed(2)}" cy="${poc.cy.toFixed(2)}" r="${r}" fill="${priceFill(price, min, max)}" stroke="var(--color-ink)" stroke-width="0.4"><title>${escapeText(title)}</title></circle>`;
    })
    .join("");
  return `<svg xmlns="${SVG_NS}" viewBox="0 0 ${MAP_WIDTH} ${MAP_HEIGHT}" role="img" aria-labelledby="${labels.id}-title ${labels.id}-summary" id="${labels.id}">
<title id="${labels.id}-title">${escapeText(labels.title)}</title>
<desc id="${labels.id}-summary">${escapeText(labels.summary)}</desc>
<g class="land">${land}</g>
<g class="nodes">${dots}</g>
</svg>`;
}

export function clientPayload(view: NodalMapView): {
  defaultPeriod: number;
  periods: MapPeriod[];
  p05: Array<number | null>;
  p95: Array<number | null>;
  min: Array<number | null>;
  max: Array<number | null>;
  pocs: Array<{
    point_of_connection: string;
    island: string;
    prices: Array<number | null>;
    proxy_periods: number[];
  }>;
  unlocated: Array<{
    point_of_connection: string;
    island: string;
    prices: Array<number | null>;
    proxy_periods: number[];
  }>;
} {
  return {
    defaultPeriod: view.defaultPeriod,
    periods: view.periods,
    p05: view.p05,
    p95: view.p95,
    min: view.min,
    max: view.max,
    pocs: view.pocs.map((poc) => ({
      point_of_connection: poc.point_of_connection,
      island: islandLabel(poc.island),
      prices: poc.price,
      proxy_periods: poc.proxy_periods,
    })),
    unlocated: view.unlocated.map((poc) => ({
      point_of_connection: poc.point_of_connection,
      island: islandLabel(poc.island),
      prices: poc.price,
      proxy_periods: poc.proxy_periods,
    })),
  };
}

function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;");
}

export function coverageSentence(view: NodalMapView): string {
  const plotted = view.plotted;
  const priced = view.priced;
  const skipped = priced - plotted;
  if (priced === 0) {
    return "No wholesale prices for named places on the grid were published for this day.";
  }
  if (plotted === 0) {
    return `None of the ${priced} named places with a wholesale price have map coordinates, so the map is empty. Those places, including some large substations, are in the table.`;
  }
  if (skipped === 0) {
    return `The map plots all ${plotted} named places that have a wholesale price and a map location.`;
  }
  return `The map plots ${plotted} of ${priced} named places that have a wholesale price. The other ${skipped} have no coordinates in the public mapping files, so they are in the table only. Grid substations such as Haywards and Benmore often have no coordinates.`;
}

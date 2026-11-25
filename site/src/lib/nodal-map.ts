import type {
  Island,
  NodalMapUnlocated,
  SiteDay,
} from "@gridwatch/publisher/site-contract";
import {
  FUEL_LABELS,
  STACK_ORDER,
} from "@gridwatch/publisher/story/generation-mix.ts";
import {
  clockLabeller12,
  clockText12,
  zonedAt,
} from "@gridwatch/publisher/story/period-clock.ts";
import { centsPerKwh } from "@gridwatch/publisher/story/price-regions.ts";
import coastlineJson from "../data/nz-coastline.json";
import {
  cableLaneSentence,
  generationLaneSentence,
  type Lane,
  type LaneTick,
  priceLaneSentence,
  reserveLaneSentence,
} from "./day-lanes.ts";
import { FUEL_COLOUR } from "./generation-mix-chart.ts";
import {
  cableLabels,
  cableWidth,
  DOT_RADIUS,
  formatPrice,
  islandLabel,
  isOutlier,
  type NodalMapBeat,
  type NodalMapIsland,
  type NodalMapPayload,
  OUTLIER_RADIUS,
  priceBandFill,
} from "./nodal-map-scale.ts";

export {
  DOT_RADIUS,
  formatPrice,
  islandLabel,
  isOutlier,
  MISSING_FILL,
  type NodalMapRow,
  OUTLIER_RADIUS,
  PRICE_BANDS,
  periodSummary,
  priceBandFill,
  rowsForPeriod,
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

/** A reference place drawn and labelled on the map. */
export interface MapPlace {
  point_of_connection: string;
  name: string;
  cx: number;
  cy: number;
  /** Label offset from the dot, in map units. */
  dx: number;
  dy: number;
  prices: Array<number | null>;
}

/**
 * The Cook Strait cable. With half-hourly flow in the day file the arrow follows the slider;
 * older files give only the day's average.
 */
export interface MapCable {
  d: string;
  /** Arrow paths for each direction, so the client can turn the arrow round. */
  north: string;
  south: string;
  width: number;
  labelX: number;
  labelY: number;
  label: string;
  amount: string;
  note: string;
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
  places: MapPlace[];
  cable: MapCable | null;
  /** Average MW sent over the cable in each half-hour, positive north. Null without it. */
  cableFlow: Array<number | null> | null;
  /** Null when generation for the day is missing. */
  islands: NodalMapIsland[] | null;
}

/**
 * The three reference places. Haywards and Benmore have no coordinates in the mapping
 * files, so their positions are fixed here (approximate substation locations).
 */
const REFERENCE_PLACES = [
  { poc: "OTA2201", name: "Ōtāhuhu", lon: 174.85, lat: -36.95, dx: -7, dy: 0 },
  {
    poc: "HAY2201",
    name: "Haywards",
    lon: 174.95,
    lat: -41.15,
    dx: -7,
    dy: -8,
  },
  { poc: "BEN2201", name: "Benmore", lon: 170.2, lat: -44.56, dx: -7, dy: -12 },
] as const;

/** Cable ends: Marlborough (South Island) to the Wellington coast (North Island). */
const CABLE_SOUTH = [173.95, -41.7] as const;
const CABLE_NORTH = [174.9, -41.2] as const;

function islandGeneration(day: SiteDay): NodalMapIsland[] | null {
  const section = day.generation;
  if (section.state === "missing" || section.series.length === 0) return null;
  const count = day.periods.length;
  const gaps = new Set(section.missing_periods);
  return (["NI", "SI"] as const).map((island) => ({
    key: island === "NI" ? "north" : "south",
    fuels: STACK_ORDER.flatMap((fuel) => {
      const rows = section.series.filter(
        (row) => row.island === island && row.fuel === fuel,
      );
      if (rows.length === 0) return [];
      const megawatts = Array.from({ length: count }, (_, index) => {
        if (gaps.has(day.periods[index]?.period ?? index + 1)) return null;
        let sum = 0;
        for (const row of rows) sum += (row.megawatt_hours[index] ?? 0) * 2;
        return sum;
      });
      if (!megawatts.some((value) => value !== null && value > 0)) return [];
      return [
        {
          fuel,
          label: FUEL_LABELS[fuel],
          colour: FUEL_COLOUR[fuel],
          megawatts,
        },
      ];
    }),
  }));
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
  const label = clockLabeller12(day);
  const places = REFERENCE_PLACES.flatMap((place) => {
    const node = day.prices.nodes.find(
      (item) => item.point_of_connection === place.poc,
    );
    if (!node) return [];
    const [cx, cy] = project(place.lon, place.lat);
    return [
      {
        point_of_connection: place.poc,
        name: place.name,
        cx,
        cy,
        dx: place.dx,
        dy: place.dy,
        prices: node.price,
      },
    ];
  });
  const flow = cableFlow(day);
  const [sx, sy] = project(CABLE_SOUTH[0], CABLE_SOUTH[1]);
  const [nx, ny] = project(CABLE_NORTH[0], CABLE_NORTH[1]);
  const curve = (north: boolean) => {
    const [ax, ay, bx, by] = north ? [sx, sy, nx, ny] : [nx, ny, sx, sy];
    return `M${ax.toFixed(1)},${ay.toFixed(1)} Q${((sx + nx) / 2 + 6).toFixed(1)},${((sy + ny) / 2 + 10).toFixed(1)} ${bx.toFixed(1)},${by.toFixed(1)}`;
  };
  const startPeriod = defaultPeriod(day);
  const south = day.sankey?.islands.find((island) => island.island === "SI");
  const sent = south?.hvdc_import_megawatt_hours ?? null;
  const megawattsNow = flow
    ? (flow[startPeriod - 1] ?? null)
    : sent !== null && sent !== 0
      ? -sent / 24
      : null;
  let cable: MapCable | null = null;
  if (megawattsNow !== null) {
    cable = {
      d: curve(megawattsNow >= 0),
      north: curve(true),
      south: curve(false),
      width: cableWidth(megawattsNow),
      labelX: nx + 8,
      labelY: ny + 22,
      ...cableLabels(megawattsNow),
      note: flow ? "this half-hour" : "day average",
    };
  }
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
    places,
    cable,
    cableFlow: flow,
    islands: islandGeneration(day),
  };
}

export function renderMapSvg(
  view: NodalMapView,
  period: number,
  labels: { id: string; title: string; summary: string },
): string {
  const i = period - 1;
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
      return `<circle data-poc="${escapeAttr(poc.point_of_connection)}" cx="${poc.cx.toFixed(2)}" cy="${poc.cy.toFixed(2)}" r="${r}" fill="${priceBandFill(price)}" stroke="var(--color-ink)" stroke-width="0.4"><title>${escapeText(title)}</title></circle>`;
    })
    .join("");
  return `<svg xmlns="${SVG_NS}" viewBox="0 0 ${MAP_WIDTH} ${MAP_HEIGHT}" role="img" aria-labelledby="${labels.id}-title ${labels.id}-summary" id="${labels.id}">
<title id="${labels.id}-title">${escapeText(labels.title)}</title>
<desc id="${labels.id}-summary">${escapeText(labels.summary)}</desc>
<g class="land">${land}</g>
<g class="nodes">${dots}</g>
${cableSvg(cableAt(view, period))}
<g class="places">${view.places.map((place) => placeSvg(place, i)).join("")}</g>
</svg>`;
}

/** Average MW sent over the cable in each half-hour, positive north (ADR-0031). */
export function cableFlow(day: SiteDay): Array<number | null> | null {
  const islands = day.sankey?.islands ?? [];
  const southSeries = islands.find(
    (island) => island.island === "SI",
  )?.hvdc_import_by_period;
  const northSeries = islands.find(
    (island) => island.island === "NI",
  )?.hvdc_import_by_period;
  if (!southSeries || !northSeries) return null;
  const flow = day.periods.map((_, index) => {
    const fromSouth = southSeries[index] ?? null;
    const fromNorth = northSeries[index] ?? null;
    // What the sending island put on the cable, as average MW for the half-hour.
    if (fromSouth !== null && fromSouth < 0) return -fromSouth * 2;
    if (fromNorth !== null && fromNorth < 0) return fromNorth * 2;
    if (fromSouth === null && fromNorth === null) return null;
    return 0;
  });
  return flow.some((value) => value !== null) ? flow : null;
}

/** The cable arrow for one half-hour, when the day file has the half-hourly flow. */
export function cableAt(view: NodalMapView, period: number): MapCable | null {
  const cable = view.cable;
  if (!cable || !view.cableFlow) return cable;
  const megawatts = view.cableFlow[period - 1] ?? null;
  if (megawatts === null) return null;
  return {
    ...cable,
    ...cableLabels(megawatts),
    ...cablePath(cable, megawatts),
  };
}

function cablePath(
  cable: Pick<MapCable, "north" | "south">,
  megawatts: number,
): { d: string; width: number } {
  return {
    d: megawatts >= 0 ? cable.north : cable.south,
    width: cableWidth(megawatts),
  };
}

function cableSvg(cable: MapCable | null): string {
  if (!cable) return "";
  const lines = [cable.label, cable.amount, cable.note]
    .map(
      (line, index) =>
        `<text x="${cable.labelX.toFixed(1)}" y="${(cable.labelY + index * 11).toFixed(1)}" class="map-note${index === 2 ? " muted" : ""}" data-cable-line="${index}">${escapeText(line)}</text>`,
    )
    .join("");
  return `<g class="cable"><defs><marker id="cable-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--color-ink)"/></marker></defs><path data-cable-path data-north="${cable.north}" data-south="${cable.south}" d="${cable.d}" fill="none" stroke="var(--color-ink)" stroke-opacity="0.75" stroke-width="${cable.width.toFixed(1)}" stroke-linecap="round" marker-end="url(#cable-arrow)"/>${lines}</g>`;
}

function placeSvg(place: MapPlace, index: number): string {
  const price = place.prices[index] ?? null;
  const x = (place.cx + place.dx).toFixed(1);
  const y = place.cy + place.dy;
  return `<g data-place="${escapeAttr(place.point_of_connection)}"><circle cx="${place.cx.toFixed(1)}" cy="${place.cy.toFixed(1)}" r="3.2" fill="var(--color-ink)" stroke="#fff" stroke-width="1.2"/><text x="${x}" y="${y.toFixed(1)}" text-anchor="end" class="place-name">${escapeText(place.name)}</text><text x="${x}" y="${(y + 14).toFixed(1)}" text-anchor="end" class="place-price" data-place-price>${price === null ? "No data" : centsPerKwh(price)}</text></g>`;
}

export function clientPayload(
  view: NodalMapView,
  beats: NodalMapBeat[] = [],
): NodalMapPayload {
  const pocOf = (poc: {
    point_of_connection: string;
    island: Island | null;
    price: Array<number | null>;
    proxy_periods: number[];
  }) => ({
    point_of_connection: poc.point_of_connection,
    island: islandLabel(poc.island),
    prices: poc.price,
    proxy_periods: poc.proxy_periods,
  });
  return {
    defaultPeriod: view.defaultPeriod,
    periods: view.periods,
    places: view.places.map((place) => ({
      point_of_connection: place.point_of_connection,
      prices: place.prices,
    })),
    beats,
    islands: view.islands ?? [],
    cable: view.cableFlow,
    p05: view.p05,
    p95: view.p95,
    min: view.min,
    max: view.max,
    pocs: view.pocs.map(pocOf),
    unlocated: view.unlocated.map(pocOf),
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

/** Line colours for the three places, in the map's lanes. */
const PLACE_COLOUR: Record<string, string> = {
  OTA2201: "var(--color-island-north)",
  HAY2201: "var(--color-fuel-battery)",
  BEN2201: "var(--color-island-south)",
};

function fuelTotals(
  islands: NodalMapIsland[],
  count: number,
): Array<{
  fuel: string;
  label: string;
  colour: string;
  values: Array<number | null>;
}> {
  const byFuel = new Map<
    string,
    {
      fuel: string;
      label: string;
      colour: string;
      values: Array<number | null>;
    }
  >();
  for (const fuel of STACK_ORDER) {
    const rows = islands.flatMap((island) =>
      island.fuels.filter((item) => item.fuel === fuel),
    );
    if (rows.length === 0) continue;
    const first = rows[0];
    if (!first) continue;
    byFuel.set(fuel, {
      fuel,
      label: first.label,
      colour: first.colour,
      values: Array.from({ length: count }, (_, index) => {
        const values = rows.map((row) => row.megawatts[index] ?? null);
        if (values.every((value) => value === null)) return null;
        return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
      }),
    });
  }
  return [...byFuel.values()];
}

/**
 * The price and generation lanes beside the map (ADR-0031). Generation is null when the
 * day has no generation numbers.
 */
export function dayLanes(
  day: SiteDay,
  view: NodalMapView,
  beats: Array<{ rule: string; at: number }>,
): Lane[] {
  const count = view.periods.length;
  const times = view.periods.map((item) => item.time);
  const pricesOf = (poc: string) =>
    view.places.find((place) => place.point_of_connection === poc)?.prices ??
    new Array<number | null>(count).fill(null);
  const peakHours = beats
    .filter((beat) => beat.rule === "price_peak")
    .flatMap((beat) => {
      const start = day.periods[beat.at - 1]?.start_utc;
      return start ? [zonedAt(start).hour] : [];
    });
  const lanes: Lane[] = [
    {
      id: "price",
      name: "Price",
      sentence: priceLaneSentence(
        pricesOf("OTA2201"),
        pricesOf("BEN2201"),
        peakHours,
      ),
      unit: "price",
      stacked: false,
      series: view.places.map((place) => ({
        key: place.point_of_connection,
        label: place.name,
        colour: PLACE_COLOUR[place.point_of_connection] ?? "var(--color-ink)",
        values: place.prices,
      })),
      gap: {
        from: "OTA2201",
        to: "BEN2201",
        label: "Gap between Ōtāhuhu and Benmore",
      },
      extra: [],
    },
  ];
  const islands = view.islands;
  if (islands) {
    const fuels = fuelTotals(islands, count);
    const islandTotal = (island: NodalMapIsland) =>
      Array.from({ length: count }, (_, index) => {
        const values = island.fuels.map(
          (fuel) => fuel.megawatts[index] ?? null,
        );
        if (values.every((value) => value === null)) return null;
        return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
      });
    const totals = Array.from({ length: count }, (_, index) => {
      const values = fuels.map((fuel) => fuel.values[index] ?? null);
      if (values.every((value) => value === null)) return null;
      return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    });
    lanes.push({
      id: "generation",
      name: "Generation",
      sentence: generationLaneSentence(totals, times),
      unit: "megawatts",
      stacked: true,
      series: fuels.map((fuel) => ({
        key: fuel.fuel,
        label: fuel.label,
        colour: fuel.colour,
        values: fuel.values,
      })),
      gap: null,
      extra: [
        { key: "total", label: "Total", colour: "", values: totals },
        ...islands.map((island) => ({
          key: island.key,
          label: island.key === "north" ? "North Island" : "South Island",
          colour: "",
          values: islandTotal(island),
        })),
      ],
    });
  }
  return lanes;
}

/** Time labels under the last lane: midnight, 6am, noon, 6pm and the next midnight. */
export function laneAxis(day: SiteDay): LaneTick[] {
  const ticks: LaneTick[] = [];
  day.periods.forEach((period, index) => {
    const zoned = zonedAt(period.start_utc);
    if (zoned.minute === 0 && zoned.hour % 6 === 0) {
      ticks.push({ index, label: clockText12(zoned).replace(":00", "") });
    }
  });
  ticks.push({ index: day.periods.length, label: "12am" });
  return ticks;
}

/**
 * Lanes under the map that show only on days that call for them (ADR-0031). Reserve shows
 * when an episode had high reserve prices. The cable shows when it ran south for part of the
 * day, or a cable beat covers part of the day (the all-day cable beat does not count).
 */
export function conditionalLanes(
  day: SiteDay,
  view: NodalMapView,
  beats: Array<{ rule: string; from: number; to: number }> = [],
): Lane[] {
  const lanes: Lane[] = [];
  const highReserve = (day.episodes?.items ?? []).some((episode) =>
    episode.observation_types.includes("reserve_price_high"),
  );
  const classes =
    day.reserves && day.reserves.state !== "missing"
      ? day.reserves.classes
      : [];
  const north = (reserveClass: "FIR" | "SIR") =>
    classes.find(
      (item) => item.reserve_class === reserveClass && item.island === "NI",
    )?.price ?? null;
  const fast = north("FIR");
  const slow = north("SIR");
  if (highReserve && (fast || slow)) {
    const count = view.periods.length;
    const higher = Array.from({ length: count }, (_, index) => {
      const values = [fast?.[index] ?? null, slow?.[index] ?? null].filter(
        (value): value is number => value !== null,
      );
      return values.length === 0 ? null : Math.max(...values);
    });
    lanes.push({
      id: "reserve",
      name: "Reserve",
      sentence: reserveLaneSentence(
        higher,
        view.periods.map((item) => item.time),
      ),
      unit: "price",
      stacked: false,
      series: [
        {
          key: "reserve",
          label: "Reserve, North Island",
          colour: "var(--color-ink)",
          values: higher,
        },
      ],
      gap: null,
      extra: [
        {
          key: "SIR",
          label: "Slow reserve (60 seconds)",
          colour: "",
          values: slow ?? new Array<number | null>(count).fill(null),
        },
        {
          key: "FIR",
          label: "Fast reserve (6 seconds)",
          colour: "",
          values: fast ?? new Array<number | null>(count).fill(null),
        },
      ],
    });
  }
  const flow = view.cableFlow;
  const southward = flow?.some((value) => value !== null && value < -0.5);
  const cableBeat = beats.some(
    (beat) =>
      beat.rule === "cable" &&
      !(beat.from === 1 && beat.to === view.periods.length),
  );
  if (flow && (southward || cableBeat)) {
    lanes.push({
      id: "cable",
      name: "Cable",
      sentence: cableLaneSentence(flow),
      unit: "megawatts",
      stacked: false,
      series: [
        {
          key: "cable",
          label: "Flow, north above zero and south below",
          colour: "var(--color-ink)",
          values: flow,
        },
      ],
      gap: null,
      extra: [],
    });
  }
  return lanes;
}

import { centsPerKwh } from "./price-regions.ts";

/**
 * Lanes beside the day map (ADR-0031): small charts that share the slider's time axis,
 * its cursor and the beat shading. Pure functions, so the page renders the SVG and the
 * client builds tooltips from the same data.
 */

/** Above 40c per kWh ($400/MWh) a price lane squeezes its scale. */
export const LANE_CAP = 400;
export const LANE_PLOT_WIDTH = 320;
export const LANE_TICK_WIDTH = 40;
/** A lane across the full card, under the map. */
export const WIDE_PLOT_WIDTH = 1000;
const LANE_HEIGHT = 68;
const LANE_HEIGHT_SQUEEZED = 86;
const WIDE_HEIGHT = 110;
const WIDE_HEIGHT_SQUEEZED = 130;
const AXIS_HEIGHT = 14;
const PAD_TOP = 6;
const PAD_BOTTOM = 4;
/** Share of the plot height given to the squeezed band above the cap. */
const SQUEEZE_SHARE = 0.35;

const SVG_NS = "http://www.w3.org/2000/svg";

export type LaneUnit = "price" | "megawatts";

export interface LaneSeries {
  key: string;
  label: string;
  colour: string;
  values: Array<number | null>;
}

export interface Lane {
  id: string;
  name: string;
  sentence: string;
  unit: LaneUnit;
  stacked: boolean;
  series: LaneSeries[];
  /** Shade between these two series (keys), coloured by whichever is higher. */
  gap: { from: string; to: string; label: string } | null;
  /** Shown in the tooltip only, under the drawn series. */
  extra: LaneSeries[];
}

export interface LaneBeat {
  from: number;
  to: number;
}

export interface LaneTick {
  index: number;
  label: string;
}

export interface LaneScale {
  height: number;
  squeezed: boolean;
  top: number;
  y: (value: number) => number;
  ticks: Array<{ value: number; dashed: boolean }>;
}

export interface TooltipRow {
  label: string;
  colour: string | null;
  value: string;
  note: string;
}

const megawatts = new Intl.NumberFormat("en-NZ", { maximumFractionDigits: 0 });

export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  return (steps.find((step) => step * power >= value - 1e-9) ?? 10) * power;
}

function known(values: Array<number | null>): number[] {
  return values.filter((value): value is number => value !== null);
}

function stackTotals(lane: Lane): number[] {
  const count = lane.series[0]?.values.length ?? 0;
  return Array.from({ length: count }, (_, index) =>
    lane.series.reduce((sum, series) => sum + (series.values[index] ?? 0), 0),
  );
}

/** The highest value a lane draws: the stack top, or the highest single series. */
function laneMax(lane: Lane): number {
  const values = lane.stacked
    ? stackTotals(lane)
    : lane.series.flatMap((series) => known(series.values));
  return values.length === 0 ? 0 : Math.max(...values);
}

export function isSqueezed(lane: Lane): boolean {
  return lane.unit === "price" && laneMax(lane) > LANE_CAP;
}

export function laneScale(lane: Lane, wide = false): LaneScale {
  const squeezed = isSqueezed(lane);
  const height = wide
    ? squeezed
      ? WIDE_HEIGHT_SQUEEZED
      : WIDE_HEIGHT
    : squeezed
      ? LANE_HEIGHT_SQUEEZED
      : LANE_HEIGHT;
  const top = PAD_TOP;
  const bottom = height - PAD_BOTTOM;
  const max = laneMax(lane);
  const lows = lane.stacked
    ? [0]
    : lane.series.flatMap((series) => known(series.values));
  const lo = Math.min(0, ...lows);
  if (squeezed) {
    const split = top + (bottom - top) * SQUEEZE_SHARE;
    const y = (value: number) =>
      value <= LANE_CAP
        ? bottom - ((value - lo) / (LANE_CAP - lo)) * (bottom - split)
        : split - ((value - LANE_CAP) / (max - LANE_CAP)) * (split - top);
    return {
      height,
      squeezed,
      top,
      y,
      ticks: [
        { value: 0, dashed: false },
        { value: LANE_CAP / 2, dashed: false },
        { value: LANE_CAP, dashed: true },
        { value: max, dashed: false },
      ],
    };
  }
  const hi = niceMax(max);
  const y = (value: number) =>
    bottom - ((value - lo) / (hi - lo)) * (bottom - top);
  // A small negative low would print on top of the zero tick, so it is left out.
  const values = [...new Set([lo, 0, hi / 2, hi])].filter(
    (value) => value >= 0 || y(value) - y(0) >= 12,
  );
  return {
    height,
    squeezed,
    top,
    y,
    ticks: values.map((value) => ({ value, dashed: false })),
  };
}

export function formatLaneValue(unit: LaneUnit, value: number): string {
  if (unit === "megawatts") return `${megawatts.format(value)} MW`;
  return centsPerKwh(value);
}

function tickLabel(unit: LaneUnit, value: number): string {
  if (value === 0) return "0";
  if (unit === "megawatts") return megawatts.format(value);
  return centsPerKwh(value);
}

function linePoints(
  values: Array<number | null>,
  x: (index: number) => number,
  y: (value: number) => number,
): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 1) segments.push(current.join(" "));
      current = [];
      return;
    }
    current.push(`${x(index).toFixed(1)},${y(value).toFixed(1)}`);
  });
  if (current.length > 1) segments.push(current.join(" "));
  return segments;
}

/** The lane as SVG. The client moves `[data-lane-cursor]` and `[data-lane-hover]`. */
export function laneSvg(
  lane: Lane,
  beats: LaneBeat[],
  period: number,
  axis: LaneTick[] | null = null,
  wide = false,
): string {
  const count = lane.series[0]?.values.length ?? 0;
  const scale = laneScale(lane, wide);
  const plotWidth = wide ? WIDE_PLOT_WIDTH : LANE_PLOT_WIDTH;
  const plotBottom = scale.height;
  const height = plotBottom + (axis ? AXIS_HEIGHT : 0);
  const width = plotWidth + LANE_TICK_WIDTH;
  const band = count > 0 ? plotWidth / count : 0;
  const x0 = (index: number) => index * band;
  const xc = (index: number) => (index + 0.5) * band;
  const right = plotWidth;

  const shading = beats
    .filter((beat) => !(beat.from === 1 && beat.to === count))
    .map(
      (beat) =>
        `<rect x="${x0(beat.from - 1).toFixed(1)}" y="0" width="${((beat.to - beat.from + 1) * band).toFixed(1)}" height="${plotBottom}" class="lane-beat"/>`,
    )
    .join("");

  const squeeze = scale.squeezed
    ? `<rect x="0" y="${scale.top}" width="${right}" height="${(scale.y(LANE_CAP) - scale.top).toFixed(1)}" class="lane-squeeze"/>`
    : "";

  const grid = scale.ticks
    .map((tick) => {
      const y = scale.y(tick.value).toFixed(1);
      return `<line x1="0" x2="${right}" y1="${y}" y2="${y}" class="lane-grid${tick.dashed ? " dashed" : ""}"/><text x="${right + 4}" y="${(Number(y) + 3).toFixed(1)}" class="lane-tick">${tickLabel(lane.unit, tick.value)}</text>`;
    })
    .join("");

  let body = "";
  if (lane.stacked) {
    const base = new Array<number>(count).fill(0);
    const edges: number[][] = [];
    for (const series of lane.series) {
      let rects = "";
      for (let index = 0; index < count; index++) {
        const value = series.values[index] ?? 0;
        const y1 = scale.y(base[index] ?? 0);
        const y2 = scale.y((base[index] ?? 0) + value);
        if (y1 - y2 > 0.2) {
          rects += `<rect x="${x0(index).toFixed(2)}" y="${y2.toFixed(2)}" width="${(band + 0.4).toFixed(2)}" height="${(y1 - y2).toFixed(2)}"/>`;
        }
        base[index] = (base[index] ?? 0) + value;
      }
      edges.push(base.slice());
      body += `<g data-lane-fuel="${series.key}" fill="${series.colour}">${rects}</g>`;
    }
    const step = (tops: number[], className: string) => {
      if (tops.length === 0) return "";
      let d = `M0,${scale.y(tops[0] ?? 0).toFixed(1)}`;
      tops.forEach((_, index) => {
        d += `H${x0(index + 1).toFixed(1)}`;
        const next = tops[index + 1];
        if (next !== undefined) d += `V${scale.y(next).toFixed(1)}`;
      });
      return `<path d="${d}" class="${className}"/>`;
    };
    body += edges
      .slice(0, -1)
      .map((tops) => step(tops, "lane-edge"))
      .join("");
    const last = edges.at(-1);
    if (last) body += step(last, "lane-top");
  } else {
    if (lane.gap) {
      const a = lane.series.find((series) => series.key === lane.gap?.from);
      const b = lane.series.find((series) => series.key === lane.gap?.to);
      if (a && b) {
        for (let index = 0; index < count - 1; index++) {
          const values = [
            a.values[index],
            a.values[index + 1],
            b.values[index],
            b.values[index + 1],
          ];
          if (values.some((value) => value === null || value === undefined))
            continue;
          const [a0, a1, b0, b1] = values as number[];
          const colour = a0 + a1 >= b0 + b1 ? a.colour : b.colour;
          body += `<path d="M${xc(index).toFixed(1)},${scale.y(a0).toFixed(1)} L${xc(index + 1).toFixed(1)},${scale.y(a1).toFixed(1)} L${xc(index + 1).toFixed(1)},${scale.y(b1).toFixed(1)} L${xc(index).toFixed(1)},${scale.y(b0).toFixed(1)}Z" fill="${colour}" class="lane-gap"/>`;
        }
      }
    }
    // The first series is drawn last, so it sits on top.
    for (const series of [...lane.series].reverse()) {
      for (const points of linePoints(series.values, xc, scale.y)) {
        body += `<polyline points="${points}" class="lane-halo"/><polyline points="${points}" fill="none" stroke="${series.colour}" class="lane-line"/>`;
      }
    }
  }

  const axisLabels = axis
    ? axis
        .map((tick) => {
          const anchor =
            tick.index === 0 ? "start" : tick.index >= count ? "end" : "middle";
          return `<text x="${x0(tick.index).toFixed(1)}" y="${plotBottom + 11}" text-anchor="${anchor}" class="lane-tick">${tick.label}</text>`;
        })
        .join("")
    : "";

  const cx = xc(period - 1).toFixed(1);
  return `<svg xmlns="${SVG_NS}" viewBox="0 0 ${width} ${height}" class="lane-svg${wide ? " wide" : ""}" data-lane-svg data-count="${count}" data-plot-width="${plotWidth}" aria-hidden="true" focusable="false">${shading}${squeeze}${grid}${body}${axisLabels}<line data-lane-hover x1="0" x2="0" y1="0" y2="${plotBottom}" class="lane-hover" visibility="hidden"/><line data-lane-cursor x1="${cx}" x2="${cx}" y1="0" y2="${plotBottom}" class="lane-cursor"/></svg>`;
}

/** x of a half-hour's centre, as a share of the whole SVG width (plot plus ticks). */
export function laneCentreShare(
  index: number,
  count: number,
  plotWidth = LANE_PLOT_WIDTH,
): number {
  const band = count > 0 ? plotWidth / count : 0;
  return ((index + 0.5) * band) / (plotWidth + LANE_TICK_WIDTH);
}

/** Which half-hour (0-based) a point at `share` of the SVG width falls in. */
export function laneIndexAt(
  share: number,
  count: number,
  plotWidth = LANE_PLOT_WIDTH,
): number {
  const plotShare = plotWidth / (plotWidth + LANE_TICK_WIDTH);
  const index = Math.floor((share / plotShare) * count);
  return Math.min(count - 1, Math.max(0, index));
}

export function tooltipRows(lane: Lane, index: number): TooltipRow[] {
  const row = (series: LaneSeries): TooltipRow | null => {
    const value = series.values[index] ?? null;
    if (value === null) {
      return lane.stacked
        ? null
        : {
            label: series.label,
            colour: series.colour,
            value: "No data",
            note: "",
          };
    }
    if (lane.stacked && value < 1) return null;
    return {
      label: series.label,
      colour: series.colour,
      value: formatLaneValue(lane.unit, value),
      note: lane.unit === "price" ? `$${megawatts.format(value)}/MWh` : "",
    };
  };
  const drawn = lane.series.map(row).filter((item) => item !== null);
  if (lane.stacked) {
    drawn.sort(
      (a, b) =>
        (lane.series.find((s) => s.label === b.label)?.values[index] ?? 0) -
        (lane.series.find((s) => s.label === a.label)?.values[index] ?? 0),
    );
  }
  const extra = lane.extra
    .map((series) => {
      const value = series.values[index] ?? null;
      return value === null
        ? null
        : {
            label: series.label,
            colour: null,
            value: formatLaneValue(lane.unit, value),
            note: "",
          };
    })
    .filter((item) => item !== null);
  return [...drawn, ...extra];
}

/** Morning, afternoon, evening or overnight, from a local hour. */
export function partOfDay(hour: number): string {
  if (hour < 6) return "overnight";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

const ROUND_CENTS = [1, 2, 3, 5, 10, 15, 20, 30, 50];

/**
 * One sentence for the price lane: the shape of Ōtāhuhu's day, from its price-peak beats,
 * and how high Benmore went. No cause.
 */
export function priceLaneSentence(
  otahuhu: Array<number | null>,
  benmore: Array<number | null>,
  peakHours: number[],
): string {
  const ota = known(otahuhu);
  const ben = known(benmore);
  if (ota.length === 0) return "No prices for Ōtāhuhu were published.";
  const parts = [
    ...new Set([...peakHours].sort((a, b) => a - b).map(partOfDay)),
  ].map((part) => (part === "overnight" ? part : `in the ${part}`));
  const first =
    parts.length === 0
      ? `Ōtāhuhu stayed between ${centsPerKwh(Math.min(...ota))} and ${centsPerKwh(Math.max(...ota))}`
      : parts.length === 1
        ? `Ōtāhuhu was highest ${parts[0]}`
        : `Ōtāhuhu rose ${parts[0]} and again ${parts.at(-1)}`;
  if (ben.length === 0) return `${first}.`;
  const benMax = Math.max(...ben);
  const under = ROUND_CENTS.find((cents) => cents * 10 >= benMax);
  const second =
    benMax < 100 && under !== undefined
      ? `Benmore stayed under ${under}c`
      : `Benmore reached ${centsPerKwh(benMax)}`;
  return `${first}, while ${second}.`;
}

/** One sentence for the generation lane: its lowest and highest half-hour. */
export function generationLaneSentence(
  totals: Array<number | null>,
  times: string[],
): string {
  let low = -1;
  let high = -1;
  totals.forEach((value, index) => {
    if (value === null) return;
    if (low === -1 || value < (totals[low] ?? 0)) low = index;
    if (high === -1 || value > (totals[high] ?? 0)) high = index;
  });
  if (low === -1) return "No generation numbers were published.";
  return `It ran from ${megawatts.format(totals[low] ?? 0)} MW at ${times[low]} to ${megawatts.format(totals[high] ?? 0)} MW at ${times[high]}.`;
}

/** One sentence for the reserve lane: the North Island's highest half-hour. */
export function reserveLaneSentence(
  values: Array<number | null>,
  times: string[],
): string {
  let high = -1;
  values.forEach((value, index) => {
    if (value === null) return;
    if (high === -1 || value > (values[high] ?? 0)) high = index;
  });
  if (high === -1) return "No reserve prices were published.";
  return `The North Island reserve price reached ${centsPerKwh(values[high] ?? 0)} per kWh at ${times[high]}.`;
}

/** One sentence for the cable lane: how many half-hours it ran each way. */
export function cableLaneSentence(flow: Array<number | null>): string {
  const north = flow.filter((value) => value !== null && value > 0.5).length;
  const south = flow.filter((value) => value !== null && value < -0.5).length;
  if (south === 0) return `The cable ran north for ${north} half-hours.`;
  if (north === 0) return `The cable ran south for ${south} half-hours.`;
  return `The cable ran north for ${north} half-hours and south for ${south}.`;
}

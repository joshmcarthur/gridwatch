import type {
  FuelCategory,
  GenerationSection,
  SiteDay,
} from "@gridwatch/publisher/site-contract";
import { clockLabeller, timeTicks, zonedAt } from "./period-clock.ts";

/** Bottom to top. Battery is not here: it is never in the stack (ADR-0014, glossary). */
export const STACK_ORDER = [
  "hydro",
  "geothermal",
  "wind",
  "solar",
  "gas",
  "coal_gas",
  "other",
  "unmapped",
] as const satisfies readonly FuelCategory[];

export type StackFuel = (typeof STACK_ORDER)[number];

export const BATTERY_HEADER = "Battery (stored power, not counted above)";

export const FUEL_LABELS: Record<StackFuel, string> = {
  hydro: "Hydro",
  geothermal: "Geothermal",
  wind: "Wind",
  solar: "Solar",
  gas: "Gas",
  coal_gas: "Coal/gas",
  other: "Other",
  unmapped: "Not yet matched to a plant",
};

const megawatts1 = new Intl.NumberFormat("en-NZ", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const percent1 = new Intl.NumberFormat("en-NZ", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const megawattsWhole = new Intl.NumberFormat("en-NZ", {
  maximumFractionDigits: 0,
});
const percentWhole = new Intl.NumberFormat("en-NZ", {
  style: "percent",
  maximumFractionDigits: 0,
});

export interface MixLayer {
  fuel: StackFuel;
  label: string;
}

/** Local clock time, for example `03:00`. On a DST-change day it ends with `NZDT` or `NZST`. */
export type MixPoint =
  | { kind: "gap"; period: number; start: Date; time: string }
  | {
      kind: "complete" | "incomplete";
      period: number;
      start: Date;
      time: string;
      megawatts: Record<FuelCategory, number>;
      primary: number;
    };

/** One stacked band for one period. `base` and `top` are null in a gap. */
export interface MixArea {
  fuel: StackFuel;
  start: Date;
  base: number | null;
  top: number | null;
}

/** One period on the battery panel. `megawatts` is null in a gap. */
export interface BatteryPoint {
  start: Date;
  megawatts: number | null;
}

export interface GenerationMix {
  /** The generation section is `incomplete`. */
  incomplete: boolean;
  /** Fuels with at least one value above zero, in stack order. */
  layers: MixLayer[];
  points: MixPoint[];
  areas: MixArea[];
  /** Battery average MW per period, never stacked with primary generation. */
  battery: BatteryPoint[];
  /** Every third local hour, as two digits, for the time axis. */
  ticks: Array<{ at: Date; label: string }>;
}

/**
 * Builds the stacked-area data for one day. Returns null when the generation section is missing.
 * The series is in MWh per period. Average MW is MWh x 2, because a period is 30 minutes.
 */
export function generationMix(day: SiteDay): GenerationMix | null {
  const section: GenerationSection = day.generation;
  if (section.state === "missing" || section.series.length === 0) return null;

  const count = day.periods.length;
  const gaps = new Set(section.missing_periods);
  const clockOf = clockLabeller(day);
  const series: Record<FuelCategory, Array<number | null>> = {
    hydro: fuelSeries(section, "hydro", count),
    geothermal: fuelSeries(section, "geothermal", count),
    wind: fuelSeries(section, "wind", count),
    solar: fuelSeries(section, "solar", count),
    gas: fuelSeries(section, "gas", count),
    coal_gas: fuelSeries(section, "coal_gas", count),
    other: fuelSeries(section, "other", count),
    unmapped: fuelSeries(section, "unmapped", count),
    battery: fuelSeries(section, "battery", count),
  };
  const reported = [...new Set(section.series.map((row) => row.fuel))];

  const layers: MixLayer[] = STACK_ORDER.filter((fuel) =>
    series[fuel].some((value) => value !== null && value > 0),
  ).map((fuel) => ({ fuel, label: FUEL_LABELS[fuel] }));

  const points: MixPoint[] = day.periods.map((period, index) => {
    const zoned = zonedAt(period.start_utc);
    const time = clockOf(zoned);
    const start = new Date(period.start_utc);
    if (gaps.has(period.period)) {
      return { kind: "gap", period: period.period, start, time };
    }
    // A null cell in a reported fuel counts as 0 and marks the period incomplete.
    const incomplete = reported.some((fuel) => series[fuel][index] === null);
    const megawatts = valuedMegawatts(series, index);
    return {
      kind: incomplete ? "incomplete" : "complete",
      period: period.period,
      start,
      time,
      megawatts,
      primary: STACK_ORDER.reduce((sum, fuel) => sum + megawatts[fuel], 0),
    };
  });

  const areas: MixArea[] = [];
  for (const layer of layers) {
    const below = STACK_ORDER.slice(0, STACK_ORDER.indexOf(layer.fuel));
    for (const point of points) {
      areas.push(mixAreaFor(layer, point, below));
    }
  }

  return {
    incomplete: section.state === "incomplete",
    layers,
    points,
    areas,
    battery: points.map(batteryPointFor),
    ticks: timeTicks(day),
  };
}

/** One row per period, with a header row. Cells hold the share in brackets. Battery is last. */
export function generationMixTable(mix: GenerationMix): {
  headers: string[];
  rows: string[][];
} {
  const headers = [
    "Time",
    ...mix.layers.map((layer) => layer.label),
    "Primary total",
    BATTERY_HEADER,
  ];
  const rows = mix.points.map((point) => tableRow(point, mix.layers, headers));
  return { headers, rows };
}

/** One sentence for the battery panel text alternative. */
export function generationMixBatterySummary(mix: GenerationMix): string {
  const data = valuedPoints(mix.points);
  if (data.length === 0) {
    return "No battery numbers in the periods that have data.";
  }
  const average = mean(data.map((point) => point.megawatts.battery));
  if (average === 0) {
    return "Batteries did not send power in the periods that have data. Battery is storage, not new generation.";
  }
  return `Batteries sent about ${megawattsWhole.format(average)} megawatts on average. That power is stored, not new generation.`;
}

/** Method note when the mix is dispatch, not meters. Null for metered and older files. */
export function generationMixSourceNote(
  section: GenerationSection,
): string | null {
  switch (section.source) {
    case "dispatch":
      return "These numbers are the market dispatch, not meters. They will change when the monthly meter file is published.";
    case "metered":
    case undefined:
      return null;
    default: {
      const _exhaustive: never = section.source;
      return _exhaustive;
    }
  }
}

/** One sentence for the chart text alternative. Uses the periods that have data. */
export function generationMixSummary(mix: GenerationMix): string {
  const data = valuedPoints(mix.points);
  if (mix.layers.length === 0 || data.length === 0) {
    return "No fuel made power in the periods that have data.";
  }
  const averages = mix.layers.map((layer) => ({
    layer,
    average: mean(data.map((point) => point.megawatts[layer.fuel])),
  }));
  const top = averages.reduce((best, next) =>
    next.average > best.average ? next : best,
  );
  const primary = mean(data.map((point) => point.primary));
  const share = primary > 0 ? top.average / primary : 0;
  return `${top.layer.label} made the most, about ${megawattsWhole.format(top.average)} megawatts on average, ${percentWhole.format(share)} of the day's primary generation.`;
}

function gapTitle(point: { time: string }): string {
  return `${point.time} · No generation numbers for this period`;
}

const INCOMPLETE_NOTE = "Some plant data missing, counted as 0";

/** Native hover tooltip for one period. */
export function mixPointTitle(point: MixPoint, layers: MixLayer[]): string {
  switch (point.kind) {
    case "gap":
      return gapTitle(point);
    case "complete":
    case "incomplete": {
      const parts = layers.map((layer) => {
        const value = point.megawatts[layer.fuel];
        return `${layer.label} ${megawatts1.format(value)} MW${shareText(value, point.primary)}`;
      });
      parts.push(`Total ${megawatts1.format(point.primary)} MW`);
      if (point.kind === "incomplete") {
        parts.push(INCOMPLETE_NOTE);
      }
      return [point.time, ...parts].join(" · ");
    }
    default: {
      const _exhaustive: never = point;
      return _exhaustive;
    }
  }
}

/** Native hover tooltip for the battery panel. */
export function batteryPointTitle(point: MixPoint): string {
  switch (point.kind) {
    case "gap":
      return gapTitle(point);
    case "complete":
    case "incomplete": {
      const parts = [
        `Battery ${megawatts1.format(point.megawatts.battery)} MW`,
        "stored power, not in the primary total",
      ];
      if (point.kind === "incomplete") {
        parts.push(INCOMPLETE_NOTE);
      }
      return [point.time, ...parts].join(" · ");
    }
    default: {
      const _exhaustive: never = point;
      return _exhaustive;
    }
  }
}

function batteryPointFor(point: MixPoint): BatteryPoint {
  switch (point.kind) {
    case "gap":
      return { start: point.start, megawatts: null };
    case "complete":
    case "incomplete":
      return { start: point.start, megawatts: point.megawatts.battery };
    default: {
      const _exhaustive: never = point;
      return _exhaustive;
    }
  }
}

function mixAreaFor(
  layer: MixLayer,
  point: MixPoint,
  below: readonly StackFuel[],
): MixArea {
  switch (point.kind) {
    case "gap":
      return { fuel: layer.fuel, start: point.start, base: null, top: null };
    case "complete":
    case "incomplete": {
      const base = below.reduce((sum, fuel) => sum + point.megawatts[fuel], 0);
      return {
        fuel: layer.fuel,
        start: point.start,
        base,
        top: base + point.megawatts[layer.fuel],
      };
    }
    default: {
      const _exhaustive: never = point;
      return _exhaustive;
    }
  }
}

function tableRow(
  point: MixPoint,
  layers: MixLayer[],
  headers: string[],
): string[] {
  switch (point.kind) {
    case "gap":
      return [point.time, ...headers.slice(1).map(() => "No data")];
    case "complete":
    case "incomplete": {
      const cells = layers.map((layer) => {
        const value = point.megawatts[layer.fuel];
        return `${megawatts1.format(value)} MW${shareText(value, point.primary)}`;
      });
      return [
        point.kind === "incomplete" ? `${point.time} (incomplete)` : point.time,
        ...cells,
        `${megawatts1.format(point.primary)} MW`,
        `${megawatts1.format(point.megawatts.battery)} MW`,
      ];
    }
    default: {
      const _exhaustive: never = point;
      return _exhaustive;
    }
  }
}

type ValuedMixPoint = Extract<MixPoint, { kind: "complete" | "incomplete" }>;

function valuedPoints(points: MixPoint[]): ValuedMixPoint[] {
  const valued: ValuedMixPoint[] = [];
  for (const point of points) {
    switch (point.kind) {
      case "gap":
        break;
      case "complete":
      case "incomplete":
        valued.push(point);
        break;
      default: {
        const _exhaustive: never = point;
        return _exhaustive;
      }
    }
  }
  return valued;
}

function valuedMegawatts(
  series: Record<FuelCategory, Array<number | null>>,
  index: number,
): Record<FuelCategory, number> {
  return {
    hydro: series.hydro[index] ?? 0,
    geothermal: series.geothermal[index] ?? 0,
    wind: series.wind[index] ?? 0,
    solar: series.solar[index] ?? 0,
    gas: series.gas[index] ?? 0,
    coal_gas: series.coal_gas[index] ?? 0,
    other: series.other[index] ?? 0,
    unmapped: series.unmapped[index] ?? 0,
    battery: series.battery[index] ?? 0,
  };
}

function fuelSeries(
  section: GenerationSection,
  fuel: FuelCategory,
  count: number,
): Array<number | null> {
  const rows = section.series.filter((row) => row.fuel === fuel);
  return Array.from({ length: count }, (_, index) => {
    let total: number | null = null;
    for (const row of rows) {
      const mwh = row.megawatt_hours[index];
      if (mwh === null || mwh === undefined) continue;
      total = (total ?? 0) + mwh * 2;
    }
    return total;
  });
}

function shareText(value: number, total: number): string {
  if (total <= 0) return "";
  return ` (${percent1.format(value / total)})`;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

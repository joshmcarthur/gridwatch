import type {
  FuelCategory,
  GenerationSection,
  SiteDay,
} from "@gridwatch/publisher/site-contract";

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

const FUEL_LABELS: Record<StackFuel, string> = {
  hydro: "Hydro",
  geothermal: "Geothermal",
  wind: "Wind",
  solar: "Solar",
  gas: "Gas",
  coal_gas: "Coal/gas",
  other: "Other",
  unmapped: "Not yet matched to a plant",
};

const ZONE = "Pacific/Auckland";

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

export interface MixPoint {
  period: number;
  start: Date;
  /** Local clock time, for example `03:00`. On a DST-change day it ends with `NZDT` or `NZST`. */
  time: string;
  /** The period is listed in `missing_periods`. Every value is null. */
  gap: boolean;
  /** A null cell in a period that is not a gap. The cell counts as 0. */
  incomplete: boolean;
  /** Average megawatts for each stacked fuel. Null in a gap. */
  megawatts: Record<StackFuel, number | null>;
  /** Sum of the stacked fuels. Excludes battery. Null in a gap. */
  primary: number | null;
  /** Average megawatts of battery, shown in the table only. Null in a gap. */
  battery: number | null;
  /** Text for the native hover tooltip. */
  title: string;
}

/** One stacked band for one period. `base` and `top` are null in a gap. */
export interface MixArea {
  fuel: StackFuel;
  start: Date;
  base: number | null;
  top: number | null;
}

export interface GenerationMix {
  /** The generation section is `incomplete`. */
  incomplete: boolean;
  /** Fuels with at least one value above zero, in stack order. */
  layers: MixLayer[];
  points: MixPoint[];
  areas: MixArea[];
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

  const gaps = new Set(section.missing_periods);
  const clockOf = clockLabeller(day);
  const fuels = [...STACK_ORDER, "battery" as const];
  const megawattsByFuel = new Map<FuelCategory, Array<number | null>>();
  const hasRows = new Set<FuelCategory>();
  for (const fuel of fuels) {
    megawattsByFuel.set(fuel, fuelSeries(section, fuel, day.periods.length));
    if (section.series.some((row) => row.fuel === fuel)) hasRows.add(fuel);
  }

  const layers: MixLayer[] = STACK_ORDER.filter((fuel) =>
    (megawattsByFuel.get(fuel) ?? []).some(
      (value) => value !== null && value > 0,
    ),
  ).map((fuel) => ({ fuel, label: FUEL_LABELS[fuel] }));

  const points: MixPoint[] = day.periods.map((period, index) => {
    const gap = gaps.has(period.period);
    const zoned = zonedAt(period.start_utc);
    let incomplete = false;
    const read = (fuel: FuelCategory): number | null => {
      if (gap) return null;
      const value = megawattsByFuel.get(fuel)?.[index] ?? null;
      if (value !== null) return value;
      if (hasRows.has(fuel)) incomplete = true;
      return 0;
    };
    const megawatts = Object.fromEntries(
      STACK_ORDER.map((fuel) => [fuel, read(fuel)]),
    ) as Record<StackFuel, number | null>;
    const battery = read("battery");
    const primary = gap
      ? null
      : STACK_ORDER.reduce((sum, fuel) => sum + (megawatts[fuel] ?? 0), 0);
    const time = clockOf(zoned);
    return {
      period: period.period,
      start: new Date(period.start_utc),
      time,
      gap,
      incomplete,
      megawatts,
      primary,
      battery,
      title: tooltipText(time, layers, megawatts, primary, gap, incomplete),
    };
  });

  const areas: MixArea[] = [];
  for (const layer of layers) {
    const below = STACK_ORDER.slice(0, STACK_ORDER.indexOf(layer.fuel));
    for (const point of points) {
      const base = point.gap
        ? null
        : below.reduce((sum, fuel) => sum + (point.megawatts[fuel] ?? 0), 0);
      const value = point.megawatts[layer.fuel];
      areas.push({
        fuel: layer.fuel,
        start: point.start,
        base,
        top: base === null || value === null ? null : base + value,
      });
    }
  }

  return {
    incomplete: section.state === "incomplete",
    layers,
    points,
    areas,
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
  const rows = mix.points.map((point) => {
    if (point.gap) {
      return [point.time, ...headers.slice(1).map(() => "No data")];
    }
    const primary = point.primary ?? 0;
    const cells = mix.layers.map((layer) => {
      const value = point.megawatts[layer.fuel] ?? 0;
      return `${megawatts1.format(value)} MW${shareText(value, primary)}`;
    });
    return [
      point.incomplete ? `${point.time} (incomplete)` : point.time,
      ...cells,
      `${megawatts1.format(primary)} MW`,
      point.battery === null ? "" : `${megawatts1.format(point.battery)} MW`,
    ];
  });
  return { headers, rows };
}

/** One sentence for the chart text alternative. Uses the periods that have data. */
export function generationMixSummary(mix: GenerationMix): string {
  const data = mix.points.filter((point) => !point.gap);
  if (mix.layers.length === 0 || data.length === 0) {
    return "No fuel made power in the periods we have.";
  }
  const averages = mix.layers.map((layer) => ({
    layer,
    average: mean(data.map((point) => point.megawatts[layer.fuel] ?? 0)),
  }));
  const top = averages.reduce((best, next) =>
    next.average > best.average ? next : best,
  );
  const primary = mean(data.map((point) => point.primary ?? 0));
  const share = primary > 0 ? top.average / primary : 0;
  return `${top.layer.label} made the most, about ${megawattsWhole.format(top.average)} megawatts on average, ${percentWhole.format(share)} of the day's primary generation.`;
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

function zonedAt(startUtc: string): Temporal.ZonedDateTime {
  return Temporal.Instant.from(startUtc).toZonedDateTimeISO(ZONE);
}

/**
 * Clock labels for one day. A clock time that occurs twice (the repeated hour on the day
 * daylight saving ends) gets NZDT or NZST, so the two rows have different labels.
 */
function clockLabeller(
  day: SiteDay,
): (zoned: Temporal.ZonedDateTime) => string {
  const counts = new Map<string, number>();
  for (const period of day.periods) {
    const clock = clockText(zonedAt(period.start_utc));
    counts.set(clock, (counts.get(clock) ?? 0) + 1);
  }
  return (zoned) => {
    const clock = clockText(zoned);
    if ((counts.get(clock) ?? 0) < 2) return clock;
    return `${clock} ${zoned.offset === "+13:00" ? "NZDT" : "NZST"}`;
  };
}

function clockText(zoned: Temporal.ZonedDateTime): string {
  return `${String(zoned.hour).padStart(2, "0")}:${String(zoned.minute).padStart(2, "0")}`;
}

function timeTicks(day: SiteDay): Array<{ at: Date; label: string }> {
  const ticks: Array<{ at: Date; label: string }> = [];
  for (const period of day.periods) {
    const zoned = zonedAt(period.start_utc);
    if (zoned.minute !== 0 || zoned.hour % 3 !== 0) continue;
    ticks.push({
      at: new Date(period.start_utc),
      label: String(zoned.hour).padStart(2, "0"),
    });
  }
  return ticks;
}

function tooltipText(
  time: string,
  layers: MixLayer[],
  megawatts: Record<StackFuel, number | null>,
  primary: number | null,
  gap: boolean,
  incomplete: boolean,
): string {
  if (gap || primary === null) {
    return `${time} · No generation numbers for this period`;
  }
  const parts = layers.map(
    (layer) =>
      `${layer.label} ${megawatts1.format(megawatts[layer.fuel] ?? 0)} MW${shareText(megawatts[layer.fuel] ?? 0, primary)}`,
  );
  parts.push(`Total ${megawatts1.format(primary)} MW`);
  if (incomplete) parts.push("Some plant data missing, counted as 0");
  return [time, ...parts].join(" · ");
}

function shareText(value: number, total: number): string {
  if (total <= 0) return "";
  return ` (${percent1.format(value / total)})`;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

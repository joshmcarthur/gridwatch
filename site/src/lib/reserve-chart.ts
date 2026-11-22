import type {
  Island,
  ReserveClass,
  SiteDay,
} from "@gridwatch/publisher/site-contract";
import * as Plot from "@observablehq/plot";
import { renderPlot } from "./chart-svg.ts";

export const RESERVE_MISSING = "Reserve prices are not ready for this day yet.";

export const RESERVE_NOTICE =
  "Some 30-minute periods have no reserve price, so these figures cover part of the day.";

const money = new Intl.NumberFormat("en-NZ", {
  style: "currency",
  currency: "NZD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const KIND: Record<ReserveClass, string> = {
  FIR: "Fast reserve",
  SIR: "Slow reserve",
};

const ISLAND_NAME: Record<Island, string> = {
  NI: "North Island",
  SI: "South Island",
};

export interface ReserveRow {
  label: string;
  island: Island | null;
  min: number | null;
  mean: number | null;
  max: number | null;
  /** Some 30-minute periods have no price. */
  partial: boolean;
}

export interface ReserveChart {
  /** At least one row covers only part of the day. */
  partial: boolean;
  rows: ReserveRow[];
  /** X domain in $/MWh, with zero included. */
  domain: [number, number];
}

type ReserveDay = Pick<SiteDay, "reserves">;

/** Null when the day has no reserve prices, so the page never draws zeros for a missing day. */
export function reserveChart(day: ReserveDay): ReserveChart | null {
  const section = day.reserves;
  if (section === undefined || section.state === "missing") return null;
  const rows = [...section.classes]
    .sort(
      (a, b) =>
        islandOrder(a.island) - islandOrder(b.island) ||
        a.reserve_class.localeCompare(b.reserve_class),
    )
    .map((row) => ({
      label: rowLabel(row.reserve_class, row.island),
      island: row.island,
      min: row.min_price,
      mean: row.mean_price,
      max: row.max_price,
      partial:
        !row.inputs_complete || row.periods_present < row.periods_expected,
    }));
  const values = rows.flatMap((row) => [row.min, row.mean, row.max]);
  const numbers = values.filter((value): value is number => value !== null);
  if (numbers.length === 0) return null;
  return {
    partial: section.state === "incomplete" || rows.some((row) => row.partial),
    rows,
    domain: [Math.min(0, ...numbers), Math.max(...numbers)],
  };
}

function islandOrder(island: Island | null): number {
  return island === "NI" ? 0 : island === "SI" ? 1 : 2;
}

function rowLabel(kind: ReserveClass, island: Island | null): string {
  return island === null ? KIND[kind] : `${KIND[kind]}, ${ISLAND_NAME[island]}`;
}

function cell(value: number | null): string {
  return value === null ? "No data" : money.format(value);
}

export function reserveChartTable(chart: ReserveChart): {
  headers: string[];
  rows: string[][];
} {
  return {
    headers: [
      "Kind of reserve",
      "Lowest $/MWh",
      "Average $/MWh",
      "Highest $/MWh",
    ],
    rows: chart.rows.map((row) => [
      row.partial ? `${row.label} (part of the day)` : row.label,
      cell(row.min),
      cell(row.mean),
      cell(row.max),
    ]),
  };
}

/** One sentence for the text alternative. Fast and slow reserve are named in words. */
export function reserveChartSummary(chart: ReserveChart): string {
  const parts = chart.rows
    .filter((row) => row.min !== null && row.max !== null)
    .map(
      (row) =>
        `${row.label} from ${money.format(row.min as number)} to ${money.format(row.max as number)}${row.mean === null ? "" : `, average ${money.format(row.mean)}`}`,
    );
  return `Reserve prices for the day in dollars per megawatt-hour: ${parts.join("; ")}.`;
}

/** Each row is a bar from the day's lowest to its highest price, with a dot at the average. */
export function reserveChartSvg(chart: ReserveChart): string {
  const bars = chart.rows.filter((row) => row.min !== null && row.max !== null);
  const colour = (island: Island | null) =>
    island === "SI" ? "var(--color-island-south)" : "var(--color-island-north)";
  const title = (row: ReserveRow) =>
    `${row.label}: lowest ${cell(row.min)}, average ${cell(row.mean)}, highest ${cell(row.max)} per megawatt-hour`;
  return renderPlot(
    {
      width: 480,
      height: 60 + chart.rows.length * 36,
      marginLeft: 190,
      marginRight: 16,
      x: {
        label: "Price ($ per megawatt-hour)",
        domain: chart.domain,
        grid: true,
        nice: true,
      },
      y: {
        label: null,
        domain: chart.rows.map((row) => row.label),
      },
      marks: [
        Plot.ruleX([0], { stroke: "var(--color-ink-muted)" }),
        Plot.ruleY(bars, {
          y: "label",
          x1: "min",
          x2: "max",
          stroke: (row: ReserveRow) => colour(row.island),
          strokeWidth: 6,
          strokeLinecap: "round",
          title,
        }),
        Plot.dot(
          bars.filter((row) => row.mean !== null),
          {
            y: "label",
            x: "mean",
            fill: "var(--color-card)",
            stroke: "var(--color-ink)",
            strokeWidth: 1.5,
            r: 4,
            title,
          },
        ),
      ],
    },
    {
      id: "reserve-chart",
      title: "Reserve prices, lowest to highest, by island",
      summary: reserveChartSummary(chart),
    },
  );
}

import type {
  Island,
  ReserveClass,
  SiteDay,
} from "@gridwatch/publisher/site-contract";
import * as Plot from "@observablehq/plot";
import { renderPlot } from "./chart-svg.ts";
import { episodeClockRange } from "./episode-copy.ts";
import { type LinePlot, type PlotLine, renderLinePlot } from "./line-plot.ts";
import { clockLabeller, timeTicks, zonedAt } from "./period-clock.ts";

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
          stroke: (row: ReserveRow) => islandColour(row.island),
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

type ReservePlotDay = Pick<SiteDay, "periods" | "episodes" | "reserves">;

const PLOT_META: Record<ReserveClass, { id: string; title: string }> = {
  FIR: { id: "reserve-fast", title: "Fast reserve prices through the day" },
  SIR: { id: "reserve-slow", title: "Slow reserve prices through the day" },
};

/** True when at least one class has a per-period series (ADR-0014 optional `price`). */
export function usesReserveLinePlots(day: ReservePlotDay): boolean {
  return (day.reserves?.classes ?? []).some((row) => row.price !== undefined);
}

export function reserveHasEpisodeBand(day: ReservePlotDay): boolean {
  return (day.episodes?.items ?? []).some(isReserveEpisode);
}

function isReserveEpisode(episode: { observation_types: string[] }): boolean {
  return episode.observation_types.some((type) =>
    type.startsWith("reserve_price_"),
  );
}

/**
 * Line plots when `price` is present. Otherwise the day's lowest-to-highest bars,
 * so older JSON without the series still draws.
 */
export function reservePlots(
  day: ReservePlotDay,
  chart: ReserveChart,
): string[] {
  if (!usesReserveLinePlots(day)) return [reserveChartSvg(chart)];
  const plots = reserveClassPlots(day);
  return plots.length > 0 ? plots : [reserveChartSvg(chart)];
}

function reserveClassPlots(day: ReservePlotDay): string[] {
  const classes = day.reserves?.classes ?? [];
  const clockOf = clockLabeller(day);
  const ticks = timeTicks(day);
  const bands = reserveBands(day);
  return (Object.keys(PLOT_META) as ReserveClass[]).flatMap((kind) => {
    const rows = classes.filter((row) => row.reserve_class === kind);
    const lines: PlotLine[] = rows.map((row) => ({
      id: row.island ?? "both",
      values:
        row.price ?? Array.from({ length: day.periods.length }, () => null),
      colour: islandColour(row.island),
      dashed: false,
    }));
    const numbers = lines.flatMap((line) =>
      line.values.filter((value): value is number => value !== null),
    );
    if (numbers.length === 0) return [];
    const labels = rows.map((row) => islandLineLabel(row.island));
    const periods = day.periods.map((period, index) => {
      const time = clockOf(zonedAt(period.start_utc));
      return {
        start: new Date(period.start_utc),
        title: hoverTitle(time, index, labels, lines),
      };
    });
    const meta = PLOT_META[kind];
    const plot: LinePlot = {
      id: meta.id,
      title: meta.title,
      yLabel: "Price ($ per megawatt-hour)",
      domain: plotDomain(numbers),
      lines,
      bands,
    };
    return [
      renderLinePlot(
        plot,
        { periods, ticks },
        lineSummary(kind, labels, lines),
      ),
    ];
  });
}

function reserveBands(day: ReservePlotDay): NonNullable<LinePlot["bands"]> {
  return (day.episodes?.items ?? [])
    .filter(isReserveEpisode)
    .map((episode) => ({
      start: new Date(episode.start_utc),
      end: new Date(episode.end_utc),
      title: `Backup prices, ${episodeClockRange(episode, day)}`,
    }));
}

function islandColour(island: Island | null): string {
  switch (island) {
    case "SI":
      return "var(--color-island-south)";
    case "NI":
    case null:
      return "var(--color-island-north)";
    default: {
      const unreachable: never = island;
      return unreachable;
    }
  }
}

function islandLineLabel(island: Island | null): string {
  return island === null ? "Both islands" : ISLAND_NAME[island];
}

function hoverTitle(
  time: string,
  index: number,
  labels: string[],
  lines: PlotLine[],
): string {
  const parts = [time];
  for (let i = 0; i < lines.length; i++) {
    const value = lines[i]?.values[index] ?? null;
    const label = labels[i] ?? "Island";
    parts.push(
      value === null ? `${label} no data` : `${label} ${money.format(value)}`,
    );
  }
  return parts.join(" · ");
}

function lineSummary(
  kind: ReserveClass,
  labels: string[],
  lines: PlotLine[],
): string {
  const parts = lines.flatMap((line, i) => {
    const plotted = line.values.filter(
      (value): value is number => value !== null,
    );
    if (plotted.length === 0) return [];
    const label = labels[i] ?? "Island";
    return [
      `${label} from ${money.format(Math.min(...plotted))} to ${money.format(Math.max(...plotted))}`,
    ];
  });
  return `${KIND[kind]} prices through the day: ${parts.join("; ")}.`;
}

function plotDomain(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  return [Math.min(0, ...values), Math.max(0, ...values)];
}

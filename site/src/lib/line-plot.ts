import * as Plot from "@observablehq/plot";
import { renderPlot } from "./chart-svg.ts";

export interface PlotLine {
  id: string;
  values: Array<number | null>;
  colour: string;
  dashed: boolean;
  /** Periods that are proxy prices; drawn as open circles. */
  proxy?: boolean[];
}

export interface LinePlot {
  id: string;
  title: string;
  yLabel: string;
  domain: [number, number];
  lines: PlotLine[];
  zeroLine?: boolean;
}

export function renderLinePlot(
  plot: LinePlot,
  data: {
    periods: Array<{ start: Date; title: string }>;
    ticks: Array<{ at: Date; label: string }>;
  },
  summary: string,
): string {
  const labelAt = new Map(
    data.ticks.map((tick) => [tick.at.getTime(), tick.label]),
  );
  // Dashed lines are drawn last, so a dashed line that shares values with a solid one stays visible.
  const lines = [...plot.lines].sort(
    (a, b) => Number(a.dashed) - Number(b.dashed),
  );
  return renderPlot(
    {
      marginTop: 28,
      x: {
        label: "Hour (New Zealand time)",
        domain: [data.periods[0]?.start, data.periods.at(-1)?.start],
        nice: false,
        ticks: data.ticks.map((tick) => tick.at),
        tickFormat: (value: Date) => labelAt.get(value.getTime()) ?? "",
      },
      y: {
        label: plot.yLabel,
        domain: plot.domain,
        grid: true,
        nice: true,
      },
      marks: [
        ...(plot.zeroLine
          ? [Plot.ruleY([0], { stroke: "var(--color-ink-muted)" })]
          : []),
        ...lines.flatMap((line) => lineMarks(line, data.periods)),
        Plot.ruleX(data.periods, {
          x: "start",
          stroke: "transparent",
          strokeWidth: 8,
          title: "title",
        }),
      ],
    },
    {
      id: plot.id,
      title: plot.title,
      summary,
    },
  );
}

/** One row per period. Null values break the line. Lone points get a dot. */
function lineMarks(
  line: PlotLine,
  periods: Array<{ start: Date; title: string }>,
) {
  const rows = periods.map((period, index) => ({
    start: period.start,
    title: period.title,
    value: line.values[index] ?? null,
  }));
  const marks = [
    Plot.line(rows, {
      x: "start",
      y: "value",
      stroke: line.colour,
      strokeWidth: 2,
      strokeDasharray: line.dashed ? "4 3" : "none",
    }),
    Plot.dot(
      rows.filter((_, index) => isLonePoint(line.values, index)),
      { x: "start", y: "value", fill: line.colour, r: 2.5 },
    ),
  ];
  const proxy = line.proxy;
  if (proxy === undefined) return marks;
  marks.push(
    Plot.dot(
      rows.filter(
        (row, index) => (proxy[index] ?? false) && row.value !== null,
      ),
      {
        x: "start",
        y: "value",
        fill: "var(--color-card)",
        stroke: line.colour,
        strokeWidth: 1.5,
        r: 3.5,
      },
    ),
  );
  return marks;
}

/** A valid period whose neighbours are both null (or outside the day). A line draws nothing for it. */
function isLonePoint(values: Array<number | null>, index: number): boolean {
  return (
    (values[index] ?? null) !== null &&
    (values[index - 1] ?? null) === null &&
    (values[index + 1] ?? null) === null
  );
}

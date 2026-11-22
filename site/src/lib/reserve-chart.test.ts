import type { ReservesClassDay } from "@gridwatch/publisher/site-contract";
import { expect, test } from "vitest";
import {
  type ReserveChart,
  reserveChart,
  reserveChartSummary,
  reserveChartSvg,
  reserveChartTable,
} from "./reserve-chart.ts";

type Row = Partial<ReservesClassDay> &
  Pick<ReservesClassDay, "reserve_class" | "island">;

const row = (overrides: Row): ReservesClassDay => ({
  mean_price: 1,
  min_price: 0.5,
  max_price: 2,
  periods_present: 48,
  periods_expected: 48,
  rows_present: 48,
  inputs_complete: true,
  ...overrides,
});

const dayWith = (
  state: "complete" | "incomplete" | "missing",
  classes: ReservesClassDay[],
) =>
  ({
    reserves: {
      state,
      classes,
    },
  }) as unknown as Parameters<typeof reserveChart>[0];

const complete = (): ReserveChart => {
  const chart = reserveChart(
    dayWith("complete", [
      row({ reserve_class: "SIR", island: "SI", max_price: 4 }),
      row({ reserve_class: "FIR", island: "NI", max_price: 9 }),
      row({ reserve_class: "SIR", island: "NI" }),
      row({ reserve_class: "FIR", island: "SI" }),
    ]),
  );
  if (chart === null) throw new Error("expected a chart");
  return chart;
};

// Catches: a missing day drawing a chart of zeros.
test("no chart for an absent or missing reserves section", () => {
  expect(reserveChart({ reserves: undefined })).toBeNull();
  expect(reserveChart(dayWith("missing", []))).toBeNull();
  expect(
    reserveChart(
      dayWith("complete", [
        row({
          reserve_class: "FIR",
          island: "NI",
          min_price: null,
          mean_price: null,
          max_price: null,
        }),
      ]),
    ),
  ).toBeNull();
});

// Catches: unstable row order between days, which would move the bars around.
test("rows are North Island first, then fast before slow", () => {
  expect(complete().rows.map((r) => r.label)).toEqual([
    "Fast reserve, North Island",
    "Slow reserve, North Island",
    "Fast reserve, South Island",
    "Slow reserve, South Island",
  ]);
  expect(complete().domain).toEqual([0, 9]);
});

// Catches: a null price plotted as zero.
test("a null price is skipped in the chart and says No data in the table", () => {
  const chart = reserveChart(
    dayWith("complete", [
      row({
        reserve_class: "FIR",
        island: "NI",
        min_price: null,
        mean_price: null,
        max_price: null,
      }),
      row({ reserve_class: "SIR", island: "NI" }),
    ]),
  ) as ReserveChart;
  expect(reserveChartTable(chart).rows[0]).toEqual([
    "Fast reserve, North Island",
    "No data",
    "No data",
    "No data",
  ]);
  expect(reserveChartSummary(chart)).not.toMatch(/Fast reserve/);
});

// Catches: a part-day figure shown as if it covered the whole day.
test("a row with missing periods marks the chart partial", () => {
  expect(complete().partial).toBe(false);
  const chart = reserveChart(
    dayWith("complete", [
      row({ reserve_class: "FIR", island: "NI", periods_present: 40 }),
    ]),
  ) as ReserveChart;
  expect(chart.partial).toBe(true);
  expect(reserveChartTable(chart).rows[0]?.[0]).toBe(
    "Fast reserve, North Island (part of the day)",
  );
});

// Catches: table numbers that differ from the plotted ones, and unexplained FIR or SIR.
test("the table and summary carry the same numbers and no FIR or SIR", () => {
  const chart = complete();
  const table = reserveChartTable(chart);
  expect(table.rows[0]).toEqual([
    "Fast reserve, North Island",
    "$0.50",
    "$1.00",
    "$9.00",
  ]);
  const summary = reserveChartSummary(chart);
  expect(summary).toContain("Fast reserve, North Island from $0.50 to $9.00");
  expect(summary).not.toMatch(/\bFIR\b|\bSIR\b/);
  const svg = reserveChartSvg(chart);
  expect(svg).toContain('role="img"');
  expect(svg).toContain("reserve-chart-title");
  expect(svg).not.toMatch(/\bFIR\b|\bSIR\b/);
});

import type {
  ReservesClassDay,
  SiteEpisode,
} from "@gridwatch/publisher/site-contract";
import { expect, test } from "vitest";
import {
  type ReserveChart,
  reserveChart,
  reserveChartSummary,
  reserveChartSvg,
  reserveChartTable,
  reservePlots,
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

const threePeriods = [
  { period: 1, start_utc: "2026-09-26T12:00:00Z" },
  { period: 2, start_utc: "2026-09-26T12:30:00Z" },
  { period: 3, start_utc: "2026-09-26T13:00:00Z" },
];

const backupEpisode = (): SiteEpisode => ({
  episode_id: "ep-1",
  seed_observation_id: "obs-1",
  start_utc: "2026-09-26T12:00:00Z",
  end_utc: "2026-09-26T13:00:00Z",
  start_trading_period: 1,
  end_trading_period: 3,
  member_count: 1,
  observation_types: ["reserve_price_high"],
  islands: ["NI"],
  severity: 2,
});

function plotDay(
  classes: ReservesClassDay[],
  episode?: SiteEpisode,
): Parameters<typeof reservePlots>[0] {
  return {
    periods: threePeriods,
    reserves: {
      state: "complete",
      classes,
    },
    episodes:
      episode === undefined
        ? undefined
        : {
            state: "complete",
            items: [episode],
          },
  } as Parameters<typeof reservePlots>[0];
}

// Catches: still drawing the range bars once a day has a price series.
test("classes with a price series draw fast and slow line plots, not FIR or SIR", () => {
  const classes = [
    row({ reserve_class: "FIR", island: "NI", price: [1.5, 2, 0.5] }),
    row({ reserve_class: "SIR", island: "SI", price: [0.2, 0.2, 0.2] }),
  ];
  const chart = reserveChart(dayWith("complete", classes)) as ReserveChart;
  const plots = reservePlots(plotDay(classes), chart);
  expect(plots).toHaveLength(2);
  expect(plots[0]).toContain("reserve-fast-title");
  expect(plots[1]).toContain("reserve-slow-title");
  expect(plots.join("")).not.toMatch(/\bFIR\b|\bSIR\b/);
  expect(plots.join("")).toContain("Fast reserve prices through the day");
});

test("a reserve episode shades its clock window on both plots", () => {
  const classes = [
    row({ reserve_class: "FIR", island: "NI", price: [1.5, 2, 0.5] }),
    row({ reserve_class: "SIR", island: "SI", price: [0.2, 0.3, 0.1] }),
  ];
  const chart = reserveChart(dayWith("complete", classes)) as ReserveChart;
  const plots = reservePlots(plotDay(classes, backupEpisode()), chart);
  expect(plots.join("")).toContain("Backup prices, 12:00am–1:00am");
  expect(plots.join("")).toMatch(/<rect/i);
});

test("without a price series the range bars still draw", () => {
  const classes = [row({ reserve_class: "FIR", island: "NI", max_price: 9 })];
  const chart = reserveChart(dayWith("complete", classes)) as ReserveChart;
  expect(reservePlots(plotDay(classes), chart)).toEqual([
    reserveChartSvg(chart),
  ]);
});

test("an all-null slow series omits that plot", () => {
  const classes = [
    row({ reserve_class: "FIR", island: "NI", price: [1, 2, 3] }),
    row({
      reserve_class: "SIR",
      island: "NI",
      price: [null, null, null],
    }),
  ];
  const chart = reserveChart(dayWith("complete", classes)) as ReserveChart;
  const plots = reservePlots(plotDay(classes), chart);
  expect(plots).toHaveLength(1);
  expect(plots[0]).toContain("reserve-fast-title");
});

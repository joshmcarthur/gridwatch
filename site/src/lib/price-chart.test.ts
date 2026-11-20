import {
  assertSiteDay,
  type SiteDay,
} from "@gridwatch/publisher/site-contract";
import { expect, test } from "vitest";
import fixtureJson from "../../fixtures/days/2026-09-27.json";
import {
  PRICE_MISSING,
  type PriceChart,
  priceChart,
  priceChartDaily,
  priceChartSummary,
  priceChartTable,
  priceSpreadSummary,
} from "./price-chart.ts";

const fixtureUnknown: unknown = fixtureJson;
assertSiteDay(fixtureUnknown);
const fixture: SiteDay = fixtureUnknown;

const HALF_HOUR_MS = 30 * 60 * 1000;

/** Local midnight on the DST-start day (NZST, +12) is 12:00 UTC the day before. */
const DST_START_DAY = "2026-09-26T12:00:00Z";

/** Fixture day with a copy you can change. The fixture is never edited. */
function copy(): SiteDay {
  return structuredClone(fixture);
}

function chartOf(day: SiteDay): PriceChart {
  const chart = priceChart(day);
  if (!chart) throw new Error("expected a price chart");
  return chart;
}

/** A day with `count` periods and every node at `price`. Spreads are zero. */
function flatDay(count: number, price: number): SiteDay {
  const day = copy();
  const start = Date.parse(DST_START_DAY);
  day.periods = Array.from({ length: count }, (_, index) => ({
    period: index + 1,
    start_utc: new Date(start + index * HALF_HOUR_MS)
      .toISOString()
      .replace(".000Z", "Z"),
  }));
  for (const node of day.prices.nodes) {
    node.price = Array.from({ length: count }, () => price);
    node.daily = {
      ...node.daily,
      mean_price: price,
      min_price: price,
      max_price: price,
    };
  }
  for (const spread of day.prices.spreads) {
    spread.spread = Array.from({ length: count }, () => 0);
  }
  return day;
}

test("period 1 has the three node prices, the spreads and the 00:00 time", () => {
  const chart = chartOf(fixture);
  const first = chart.periods[0];
  if (!first) throw new Error("expected a first period");
  expect(first.time).toBe("00:00");
  expect(first.title).toContain("OTA2201 $81.00");
  expect(chart.nodes.map((node) => node.values[0])).toEqual([81, 71, 61]);
  expect(chart.spreads.map((spread) => spread.values[0])).toEqual([10, 10, 20]);
});

test("period 5 on the DST-start day is 03:00, with no NZDT suffix", () => {
  const chart = chartOf(fixture);
  const fifth = chart.periods[4];
  if (!fifth) throw new Error("expected period 5");
  expect(fifth.time).toBe("03:00");
  expect(chart.nodes.map((node) => node.values[4])).toEqual([85, 75, 65]);
});

test("period 46 is the last period, with the highest prices", () => {
  const chart = chartOf(fixture);
  expect(chart.periods.length).toBe(46);
  expect(chart.nodes.map((node) => node.values[45])).toEqual([126, 116, 106]);
});

test("the time axis has eight ticks from 00 to 21", () => {
  const chart = chartOf(fixture);
  expect(chart.ticks.map((tick) => tick.label)).toEqual([
    "00",
    "03",
    "06",
    "09",
    "12",
    "15",
    "18",
    "21",
  ]);
});

test("daily figures come from the contract summary", () => {
  const chart = chartOf(fixture);
  expect(chart.nodes.map((node) => node.daily.mean)).toEqual([
    103.5, 93.5, 83.5,
  ]);
  expect(chart.nodes.map((node) => node.daily.min)).toEqual([81, 71, 61]);
  expect(chart.nodes.map((node) => node.daily.max)).toEqual([126, 116, 106]);
});

test("the price summary is one exact sentence", () => {
  expect(priceChartSummary(chartOf(fixture))).toBe(
    "Period prices per megawatt-hour: OTA2201 from $81.00 to $126.00, HAY2201 from $71.00 to $116.00, BEN2201 from $61.00 to $106.00.",
  );
});

test("the spread summary names the drawn spreads and points to the table for OTA-BEN", () => {
  expect(priceSpreadSummary(chartOf(fixture))).toBe(
    "Spreads in $/MWh, first node minus second: OTA-HAY from $10.00 to $10.00, HAY-BEN from $10.00 to $10.00. OTA-BEN is in the table.",
  );
});

test("the daily lines label the highest and lowest prices as single prices", () => {
  expect(priceChartDaily(chartOf(fixture))).toEqual([
    "Average of the period prices for the day: OTA2201 $103.50, HAY2201 $93.50, BEN2201 $83.50, per megawatt-hour.",
    "Lowest single price published (not a period average): OTA2201 $81.00, HAY2201 $71.00, BEN2201 $61.00, per megawatt-hour.",
    "Highest single price published (not a period average): OTA2201 $126.00, HAY2201 $116.00, BEN2201 $106.00, per megawatt-hour.",
  ]);
});

test("the table has a time column, one column per node and one per spread", () => {
  const { headers, rows } = priceChartTable(chartOf(fixture));
  expect(headers).toEqual([
    "Time",
    "OTA2201 $/MWh",
    "HAY2201 $/MWh",
    "BEN2201 $/MWh",
    "Spread OTA-HAY ($/MWh)",
    "Spread HAY-BEN ($/MWh)",
    "Spread OTA-BEN ($/MWh)",
  ]);
  expect(rows.length).toBe(46);
  expect(rows[0]).toEqual([
    "00:00",
    "$81.00",
    "$71.00",
    "$61.00",
    "$10.00",
    "$10.00",
    "$20.00",
  ]);
});

test("the hover text includes OTA-BEN from the contract, not a sum", () => {
  const chart = chartOf(fixture);
  expect(chart.periods[4]?.title).toBe(
    "03:00 · OTA2201 $85.00/MWh · HAY2201 $75.00/MWh · BEN2201 $65.00/MWh · Spread OTA-HAY $10.00 · Spread HAY-BEN $10.00 · Spread OTA-BEN $20.00",
  );
});

test("a 50-period day uses its own period list", () => {
  const chart = chartOf(flatDay(50, 60));
  expect(chart.periods.length).toBe(50);
  expect(chart.nodes[0]?.values.length).toBe(50);
});

test("a null price breaks only that node's line, and the table says No data", () => {
  const day = copy();
  const ota = day.prices.nodes[0];
  if (!ota) throw new Error("expected OTA");
  ota.price[9] = null;
  day.prices.missing_periods = [10];
  day.prices.state = "incomplete";
  const chart = chartOf(day);
  expect(chart.incomplete).toBe(true);
  expect(chart.periods[9]?.gap).toBe(false);
  const row = priceChartTable(chart).rows[9];
  expect(row).toEqual([
    "05:30 (incomplete)",
    "No data",
    "$80.00",
    "$70.00",
    "$10.00",
    "$10.00",
    "$20.00",
  ]);
  expect(chart.nodes[1]?.lone.some(Boolean)).toBe(false);
});

test("a single valid period between two gaps is marked for a dot", () => {
  const day = copy();
  const ben = day.prices.nodes[2];
  if (!ben) throw new Error("expected BEN");
  ben.price[2] = null;
  ben.price[4] = null;
  const chart = chartOf(day);
  expect(chart.nodes[2]?.lone[3]).toBe(true);
  expect(chart.nodes[2]?.lone[2]).toBe(false);
  expect(chart.nodes[2]?.lone[4]).toBe(false);
});

test("a spike inside a period is plotted as the period price, not the daily maximum", () => {
  const day = flatDay(46, 50);
  const hay = day.prices.nodes[1];
  if (!hay) throw new Error("expected HAY");
  hay.price[9] = 50.75;
  hay.daily.max_price = 71.24;
  const chart = chartOf(day);
  expect(chart.nodes[1]?.values[9]).toBe(50.75);
  expect(chart.priceDomain[1]).toBe(50.75);
  expect(chart.priceDomain[1]).toBeLessThan(71.24);
  expect(priceChartDaily(chart).join(" ")).toContain(
    "Highest single price published (not a period average): OTA2201 $50.00, HAY2201 $71.24, BEN2201 $50.00",
  );
});

test("a proxy period gets a proxy marker in the hover text and the table", () => {
  const day = copy();
  const ota = day.prices.nodes[0];
  if (!ota) throw new Error("expected OTA");
  ota.proxy_periods = [5];
  const chart = chartOf(day);
  expect(chart.nodes[0]?.proxy[4]).toBe(true);
  expect(chart.nodes[0]?.proxy[3]).toBe(false);
  expect(chart.periods[4]?.title).toContain("OTA2201 $85.00/MWh (proxy price)");
  expect(priceChartTable(chart).rows[4]?.[1]).toBe("$85.00 (proxy price)");
});

test("a negative spread shows a minus sign and the spread axis includes zero", () => {
  const day = copy();
  const spread = day.prices.spreads[0];
  if (!spread) throw new Error("expected a spread");
  spread.spread[4] = -5;
  const chart = chartOf(day);
  expect(priceChartTable(chart).rows[4]?.[4]).toBe("-$5.00");
  expect(chart.periods[4]?.title).toContain("Spread OTA-HAY -$5.00");
  expect(chart.spreadDomain[0]).toBe(-5);
  expect(chart.spreadDomain[1]).toBeGreaterThanOrEqual(0);
});

test("OTA-BEN is not drawn, so it does not set the spread axis", () => {
  const day = copy();
  const otaBen = day.prices.spreads[2];
  if (!otaBen) throw new Error("expected OTA-BEN");
  otaBen.spread = otaBen.spread.map(() => 1000);
  const chart = chartOf(day);
  expect(chart.spreads.map((spread) => spread.drawn)).toEqual([
    true,
    true,
    false,
  ]);
  expect(chart.spreadDomain).toEqual([0, 10]);
});

test("a period with no price at any node is a gap with a plain hover text", () => {
  const day = copy();
  for (const node of day.prices.nodes) node.price[0] = null;
  day.prices.missing_periods = [1];
  const chart = chartOf(day);
  expect(chart.periods[0]?.gap).toBe(true);
  expect(chart.periods[0]?.title).toBe(
    "00:00 · No price numbers for this period",
  );
  expect(priceChartTable(chart).rows[0]?.slice(1, 4)).toEqual([
    "No data",
    "No data",
    "No data",
  ]);
});

test("a missing prices section gives no chart", () => {
  const day = copy();
  day.prices = { ...day.prices, state: "missing" };
  expect(priceChart(day)).toBeNull();
  expect(PRICE_MISSING).toMatch(/no chart/);
});

test("a complete day is not flagged as incomplete", () => {
  expect(chartOf(fixture).incomplete).toBe(false);
});

test("a day with no period prices says so in the summary", () => {
  const day = copy();
  for (const node of day.prices.nodes) {
    node.price = node.price.map(() => null);
  }
  expect(priceChartSummary(chartOf(day))).toBe(
    "We have no period prices for this day.",
  );
});

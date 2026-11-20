import { expect, test } from "vitest";
import {
  assertSiteDay,
  assertSiteIndex,
  SITE_CONTRACT_VERSION,
  type SiteDay,
} from "./contract.ts";

/** A valid day on a 46-period date. Generation is incomplete, prices are missing. */
function sampleDay(): SiteDay {
  const periods = Array.from({ length: 46 }, (_, i) => ({
    period: i + 1,
    start_utc: "2026-09-26T12:00:00Z",
  }));
  return {
    contract_version: SITE_CONTRACT_VERSION,
    trading_date: "2026-09-27",
    periods,
    complete: false,
    datasets: {
      generation_md: {
        status: "partial",
        expected_period_count: 46,
        actual_period_count: 45,
        missing_periods: [46],
        bronze_sha256s: ["abc"],
        errors: [],
      },
    },
    generation: {
      state: "incomplete",
      missing_periods: [],
      analysis_version: 1,
      inputs_sha256: "abc",
      silver_tables: ["generation_md"],
      gold_tables: ["generation_by_fuel_period"],
      datasets: ["generation_md"],
      series: [
        {
          fuel: "hydro",
          island: "NI",
          megawatt_hours: periods.map((_, i) => (i === 0 ? 10.5 : null)),
        },
      ],
      daily: [
        {
          fuel: "hydro",
          island: "NI",
          megawatt_hours: 10.5,
          average_megawatts: 0.1,
        },
      ],
      totals: { primary_megawatt_hours: 10.5, battery_megawatt_hours: 0 },
    },
    prices: {
      state: "missing",
      missing_periods: [],
      analysis_version: null,
      inputs_sha256: null,
      silver_tables: ["dispatch_energy_prices"],
      gold_tables: ["price_periods"],
      datasets: [],
      nodes: [],
      spreads: [],
      distribution: {
        poc_count: [],
        min: [],
        p05: [],
        p25: [],
        median: [],
        p75: [],
        p95: [],
        max: [],
      },
    },
  };
}

test("a valid day passes, with and without the optional extensions", () => {
  const day = sampleDay();
  expect(() => assertSiteDay(day)).not.toThrow();
  expect(() =>
    assertSiteDay({
      ...day,
      reserves: { state: "missing" },
      sankey: { state: "complete" },
    }),
  ).not.toThrow();
});

test("the validator rejects a truncated array, a missing state, a bad state and an unknown dataset", () => {
  const day = sampleDay();
  const [first] = day.generation.series;
  const short = {
    ...day,
    generation: {
      ...day.generation,
      series: [{ ...first, megawatt_hours: [1] }],
    },
  };
  expect(() => assertSiteDay(short)).toThrow(
    "generation.series[0].megawatt_hours: expected 46 entries",
  );

  const { state: _state, ...noState } = day.prices;
  expect(() => assertSiteDay({ ...day, prices: noState })).toThrow(
    "prices.state",
  );
  expect(() =>
    assertSiteDay({ ...day, prices: { ...day.prices, state: "ok" } }),
  ).toThrow("prices.state: expected one of");

  expect(() =>
    assertSiteDay({
      ...day,
      generation: { ...day.generation, datasets: ["generation_md", "nope"] },
    }),
  ).toThrow("nope is read by a section but is not a key");
});

test("the validator rejects a day length that is not 46, 48 or 50", () => {
  const day = sampleDay();
  expect(() =>
    assertSiteDay({ ...day, periods: day.periods.slice(1) }),
  ).toThrow("periods: expected 46, 48 or 50 entries");
});

const validIndex = {
  contract_version: SITE_CONTRACT_VERSION,
  days: [
    {
      date: "2026-09-26",
      path: "days/2026-09-26.json",
      complete: true,
      sections: { generation: "complete", prices: "complete" },
      export_sha256: "a",
    },
    {
      date: "2026-09-27",
      path: "days/2026-09-27.json",
      complete: false,
      sections: { generation: "incomplete", prices: "missing" },
      export_sha256: "b",
    },
  ],
  latest_complete: { generation_md: "2026-09-26", cleared_offers: null },
  latest_complete_sections: { generation: "2026-09-26", prices: null },
};

test("the index validator accepts a valid index and rejects dates out of order", () => {
  expect(() => assertSiteIndex(validIndex)).not.toThrow();
  expect(() =>
    assertSiteIndex({ ...validIndex, days: [...validIndex.days].reverse() }),
  ).toThrow("expected ascending, unique dates");
  expect(() =>
    assertSiteIndex({
      ...validIndex,
      days: [
        {
          ...validIndex.days[0],
          sections: { generation: "ok", prices: "complete" },
        },
      ],
    }),
  ).toThrow("expected one of");
});

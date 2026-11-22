import type { SiteDay, SiteIndex } from "@gridwatch/publisher/site-contract";
import { expect, test } from "vitest";
import {
  conditionCards,
  latestUpdate,
  recentDays,
} from "./homepage-conditions.ts";

const indexDay = (
  date: string,
  sections: Partial<SiteIndex["days"][number]["sections"]> & {
    generation: "complete" | "incomplete" | "missing";
    prices: "complete" | "incomplete" | "missing";
  },
  complete = sections.generation === "complete" &&
    sections.prices === "complete",
): SiteIndex["days"][number] => ({
  date,
  path: `days/${date}.json`,
  complete,
  sections,
  export_sha256: "x",
});

const indexOf = (days: SiteIndex["days"]): SiteIndex => ({
  contract_version: 1,
  days,
  latest_complete: {},
  latest_complete_sections: {
    generation:
      days.filter((d) => d.sections.generation === "complete").at(-1)?.date ??
      null,
    prices:
      days.filter((d) => d.sections.prices === "complete").at(-1)?.date ?? null,
    reserves:
      days.filter((d) => d.sections.reserves === "complete").at(-1)?.date ??
      null,
  },
});

const emptyDay = (date: string): SiteDay => ({
  contract_version: 1,
  trading_date: date,
  periods: Array.from({ length: 48 }, (_, i) => ({
    period: i + 1,
    start_utc: "2026-01-01T11:00:00Z",
  })),
  complete: true,
  datasets: {},
  generation: {
    state: "complete",
    missing_periods: [],
    analysis_version: 1,
    inputs_sha256: "g",
    silver_tables: ["generation_md"],
    gold_tables: [],
    datasets: ["generation_md"],
    series: [],
    daily: [
      { fuel: "hydro", island: "NI", megawatt_hours: 80, average_megawatts: 1 },
      { fuel: "gas", island: "NI", megawatt_hours: 20, average_megawatts: 1 },
    ],
    totals: { primary_megawatt_hours: 100, battery_megawatt_hours: 0 },
  },
  prices: {
    state: "complete",
    missing_periods: [],
    analysis_version: 1,
    inputs_sha256: "p",
    silver_tables: ["dispatch_energy_prices"],
    gold_tables: [],
    datasets: ["dispatch_energy_prices"],
    nodes: [
      {
        point_of_connection: "OTA2201",
        price_region: "upper_north_island",
        price: [],
        proxy_periods: [],
        daily: {
          mean_price: 40,
          min_price: 40,
          max_price: 40,
          periods_present: 48,
          periods_expected: 48,
          rows_present: 48,
          inputs_complete: true,
        },
      },
      {
        point_of_connection: "HAY2201",
        price_region: "lower_north_island",
        price: [],
        proxy_periods: [],
        daily: {
          mean_price: 50,
          min_price: 50,
          max_price: 50,
          periods_present: 48,
          periods_expected: 48,
          rows_present: 48,
          inputs_complete: true,
        },
      },
      {
        point_of_connection: "BEN2201",
        price_region: "south_island",
        price: [],
        proxy_periods: [],
        daily: {
          mean_price: 60,
          min_price: 60,
          max_price: 60,
          periods_present: 48,
          periods_expected: 48,
          rows_present: 48,
          inputs_complete: true,
        },
      },
    ],
    spreads: [
      {
        from: "HAY2201",
        to: "BEN2201",
        from_price_region: "lower_north_island",
        to_price_region: "south_island",
        spread: [10],
      },
    ],
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
  reserves: {
    state: "complete",
    missing_periods: [],
    analysis_version: 1,
    inputs_sha256: "r",
    silver_tables: ["dispatch_reserve_prices"],
    gold_tables: [],
    datasets: ["dispatch_reserve_prices"],
    daily: [
      {
        reserve_class: "FIR",
        island: "NI",
        mean_price: 2,
        min_price: 0,
        max_price: 4,
        periods_present: 48,
        periods_expected: 48,
        rows_present: 48,
        inputs_complete: true,
      },
    ],
  },
});

test("latest update is the newest prices-complete day, not the newest generation day", () => {
  const index = indexOf([
    indexDay("2026-10-31", { generation: "complete", prices: "complete" }),
    indexDay("2026-11-20", { generation: "missing", prices: "complete" }),
  ]);
  const days: Record<string, SiteDay> = {
    "2026-10-31": emptyDay("2026-10-31"),
    "2026-11-20": {
      ...emptyDay("2026-11-20"),
      generation: {
        ...emptyDay("2026-11-20").generation,
        state: "missing",
        totals: null,
        daily: [],
      },
    },
  };
  const update = latestUpdate(index, (date) => {
    const day = days[date];
    if (!day) throw new Error(`missing ${date}`);
    return day;
  });
  expect(update?.date).toBe("2026-11-20");
  expect(update?.spark.length).toBeGreaterThan(0);
  expect(update?.paragraphs.join(" ")).toMatch(/not in yet/i);
  expect(update?.paragraphs.join(" ")).not.toMatch(/\bobservatory\b/i);
});

test("latest update omits the generation-lag note when that day has generation", () => {
  const index = indexOf([
    indexDay("2026-10-31", { generation: "complete", prices: "complete" }),
  ]);
  const update = latestUpdate(index, () => emptyDay("2026-10-31"));
  expect(update?.paragraphs.join(" ")).not.toMatch(/not in yet/i);
});

test("latest update keeps incomplete generation copy from the daily headline", () => {
  const index = indexOf([
    indexDay("2026-10-31", { generation: "incomplete", prices: "complete" }),
  ]);
  const day = emptyDay("2026-10-31");
  const update = latestUpdate(index, () => ({
    ...day,
    generation: { ...day.generation, state: "incomplete" },
  }));
  expect(update?.paragraphs.join(" ")).toMatch(
    /incomplete generation numbers/i,
  );
  expect(update?.paragraphs.join(" ")).not.toMatch(/not in yet/i);
});

test("recent days are the last 14, newest first, with an incomplete note", () => {
  const days = Array.from({ length: 16 }, (_, i) => {
    const date = `2026-11-${String(i + 1).padStart(2, "0")}`;
    const complete = i !== 15;
    return indexDay(
      date,
      {
        generation: complete ? "complete" : "incomplete",
        prices: "complete",
      },
      complete,
    );
  });
  const recent = recentDays(indexOf(days));
  expect(recent).toHaveLength(14);
  expect(recent[0]?.date).toBe("2026-11-16");
  expect(recent[0]?.complete).toBe(false);
  expect(recent[1]?.date).toBe("2026-11-15");
  expect(recent.at(-1)?.date).toBe("2026-11-03");
});

test("each condition card uses its own complete day and past-tense band copy", () => {
  const history = Array.from({ length: 40 }, (_, i) => {
    const date = Temporal.PlainDate.from("2026-09-01")
      .add({ days: i })
      .toString();
    return indexDay(date, {
      generation: "complete",
      prices: "complete",
      reserves: "complete",
    });
  });
  const latestPrices = indexDay("2026-11-20", {
    generation: "missing",
    prices: "complete",
    reserves: "complete",
  });
  const latestGen = indexDay("2026-10-31", {
    generation: "complete",
    prices: "complete",
    reserves: "complete",
  });
  const index = indexOf([...history, latestGen, latestPrices]);
  const load = (date: string): SiteDay => {
    const day = emptyDay(date);
    if (date === "2026-10-31") {
      return {
        ...day,
        generation: {
          ...day.generation,
          daily: [
            {
              fuel: "gas",
              island: "NI",
              megawatt_hours: 90,
              average_megawatts: 1,
            },
            {
              fuel: "hydro",
              island: "NI",
              megawatt_hours: 10,
              average_megawatts: 1,
            },
          ],
          totals: { primary_megawatt_hours: 100, battery_megawatt_hours: 0 },
        },
      };
    }
    return day;
  };
  const cards = conditionCards(index, load);
  expect(cards.map((card) => card.id)).toEqual([
    "prices",
    "supply",
    "reserves",
    "regional",
  ]);
  expect(cards.find((c) => c.id === "prices")?.date).toBe("2026-11-20");
  expect(cards.find((c) => c.id === "supply")?.date).toBe("2026-10-31");
  expect(cards.find((c) => c.id === "reserves")?.date).toBe("2026-11-20");
  expect(cards.find((c) => c.id === "regional")?.date).toBe("2026-11-20");
  const supply = cards.find((c) => c.id === "supply");
  expect(supply?.percentile).toBeGreaterThanOrEqual(0.95);
  expect(supply?.headline).toMatch(
    /was one of the highest days in the past year/,
  );
  expect(supply?.share).toBeCloseTo(0.9);
  const joined = cards.map((c) => c.headline).join(" ");
  expect(joined).not.toMatch(/\bNI\b/);
  expect(joined).not.toMatch(/\bSI\b/);
  expect(joined).not.toMatch(/\bobservatory\b/i);
  expect(joined).not.toMatch(/\bI\b/);
  expect(joined.toLowerCase()).not.toMatch(/\bwe\b/);
});

test("a card with fewer than 30 earlier complete days does not claim a band", () => {
  const index = indexOf([
    indexDay("2026-11-20", {
      generation: "complete",
      prices: "complete",
      reserves: "complete",
    }),
  ]);
  const cards = conditionCards(index, () => emptyDay("2026-11-20"));
  expect(cards.every((card) => card.percentile === null)).toBe(true);
  expect(cards[0]?.headline).toMatch(/not yet enough complete days/i);
});

test("a missing section says it is unpublished, not that history is short", () => {
  const index = indexOf([
    indexDay("2026-11-20", { generation: "complete", prices: "complete" }),
  ]);
  const cards = conditionCards(index, () => emptyDay("2026-11-20"));
  const reserves = cards.find((card) => card.id === "reserves");
  expect(reserves?.date).toBeNull();
  expect(reserves?.headline).toMatch(/have not been published/i);
  expect(reserves?.headline).not.toMatch(/not yet enough complete days/i);
});

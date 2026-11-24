import type { SiteDay, SiteIndex } from "@gridwatch/publisher/site-contract";
import { expect, test } from "vitest";
import { pageLead } from "./daily-page.ts";
import {
  dayContext,
  gasCoalShare,
  groupRecentDays,
  latestMarketUpdate,
  leadFact,
  leadFinding,
  marketConditionCards,
  meanIslandSpread,
  meanReferencePrice,
  meanReservePrice,
  rankAgainstEarlier,
  recentDays,
  shortDayLabel,
} from "./market-conditions.ts";
import { loadSiteDay, loadSiteIndex } from "./site-data.ts";

const CLOCK_PERIODS = [
  { period: 1, start_utc: "2026-05-31T12:00:00Z" },
  { period: 2, start_utc: "2026-05-31T12:30:00Z" },
  { period: 33, start_utc: "2026-06-01T04:00:00Z" },
  { period: 38, start_utc: "2026-06-01T06:30:00Z" },
  { period: 41, start_utc: "2026-06-02T20:00:00Z" },
  { period: 45, start_utc: "2026-06-02T22:00:00Z" },
];

const previousDataRoot = process.env.DATA_ROOT;

test("rankAgainstEarlier needs 30 earlier days and uses the 25 / 75 / 95 bands", () => {
  expect(
    rankAgainstEarlier(
      10,
      Array.from({ length: 29 }, (_, i) => i),
    ),
  ).toBeNull();
  const earlier = Array.from({ length: 100 }, (_, i) => i);
  expect(rankAgainstEarlier(10, earlier)).toBe(
    "lower than most days in the past year",
  );
  expect(rankAgainstEarlier(50, earlier)).toBe("about usual");
  expect(rankAgainstEarlier(80, earlier)).toBe("higher than most");
  expect(rankAgainstEarlier(96, earlier)).toBe("one of the highest");
  expect(rankAgainstEarlier(0, earlier)).toBe(
    "lower than most days in the past year",
  );
});

test("rankAgainstEarlier ranks a value that ties with most earlier days as usual", () => {
  const earlier = Array.from({ length: 40 }, () => 0.01);
  expect(rankAgainstEarlier(0.01, earlier)).toBe("about usual");
  expect(rankAgainstEarlier(0.02, earlier)).toBe("one of the highest");
});

test("rankAgainstEarlier looks at the latest 365 earlier values", () => {
  const earlier = [
    ...Array.from({ length: 365 }, () => 1),
    ...Array.from({ length: 10 }, () => 100),
  ];
  expect(rankAgainstEarlier(50, earlier)).toBe("one of the highest");
});

function stubDay(overrides: {
  date?: string;
  generationState?: SiteDay["generation"]["state"];
  pricesState?: SiteDay["prices"]["state"];
  reservesState?: NonNullable<SiteDay["reserves"]>["state"];
  primary?: number;
  gas?: number;
  coalGas?: number;
  meanPrices?: Array<number | null>;
  hayBen?: Array<number | null>;
  reserveMeans?: Array<number | null>;
}): SiteDay {
  const periods = Array.from({ length: 46 }, (_, i) => ({
    period: i + 1,
    start_utc: "2026-09-26T12:00:00Z",
  }));
  const means = overrides.meanPrices ?? [80, 70, 60];
  const hayBen = overrides.hayBen ?? means.map(() => 10);
  const reserveMeans = overrides.reserveMeans ?? [1, 0.5];
  return {
    contract_version: 1,
    trading_date: overrides.date ?? "2026-09-27",
    periods,
    complete:
      (overrides.generationState ?? "complete") === "complete" &&
      (overrides.pricesState ?? "complete") === "complete",
    datasets: {},
    generation: {
      state: overrides.generationState ?? "complete",
      missing_periods: [],
      analysis_version: 1,
      inputs_sha256: "a",
      silver_tables: [],
      gold_tables: [],
      datasets: [],
      series: [],
      daily: [
        {
          fuel: "hydro",
          island: "NI",
          megawatt_hours:
            (overrides.primary ?? 100) -
            (overrides.gas ?? 10) -
            (overrides.coalGas ?? 5),
          average_megawatts: 1,
        },
        {
          fuel: "gas",
          island: "NI",
          megawatt_hours: overrides.gas ?? 10,
          average_megawatts: 1,
        },
        {
          fuel: "coal_gas",
          island: "NI",
          megawatt_hours: overrides.coalGas ?? 5,
          average_megawatts: 1,
        },
      ],
      totals: {
        primary_megawatt_hours: overrides.primary ?? 100,
        battery_megawatt_hours: 0,
      },
    },
    prices: {
      state: overrides.pricesState ?? "complete",
      missing_periods: [],
      analysis_version: 1,
      inputs_sha256: "a",
      silver_tables: [],
      gold_tables: [],
      datasets: [],
      nodes: ["upper_north_island", "lower_north_island", "south_island"].map(
        (region, i) => ({
          point_of_connection:
            ["OTA2201", "HAY2201", "BEN2201"][i] ?? "OTA2201",
          price_region: region,
          price: periods.map(() => means[i] ?? null),
          proxy_periods: [],
          daily: {
            mean_price: means[i] ?? null,
            min_price: means[i] ?? null,
            max_price: means[i] ?? null,
            periods_present: 46,
            periods_expected: 46,
            rows_present: 46,
            inputs_complete: true,
          },
        }),
      ),
      spreads: [
        {
          from: "OTA2201",
          to: "HAY2201",
          from_price_region: "upper_north_island",
          to_price_region: "lower_north_island",
          spread: periods.map(() => 10),
        },
        {
          from: "HAY2201",
          to: "BEN2201",
          from_price_region: "lower_north_island",
          to_price_region: "south_island",
          spread: hayBen,
        },
        {
          from: "OTA2201",
          to: "BEN2201",
          from_price_region: "upper_north_island",
          to_price_region: "south_island",
          spread: periods.map(() => 20),
        },
      ],
      distribution: {
        poc_count: periods.map(() => 3),
        min: periods.map(() => 1),
        p05: periods.map(() => 1),
        p25: periods.map(() => 1),
        median: periods.map(() => 1),
        p75: periods.map(() => 1),
        p95: periods.map(() => 1),
        max: periods.map(() => 1),
      },
    },
    reserves: {
      state: overrides.reservesState ?? "complete",
      missing_periods: [],
      analysis_version: 1,
      inputs_sha256: "a",
      silver_tables: [],
      gold_tables: [],
      datasets: [],
      classes: reserveMeans.map((mean, i) => ({
        reserve_class: i % 2 === 0 ? "FIR" : "SIR",
        island: i < 2 ? "NI" : "SI",
        mean_price: mean,
        min_price: mean,
        max_price: mean,
        periods_present: 46,
        periods_expected: 46,
        rows_present: 46,
        inputs_complete: true,
      })),
    },
  } as SiteDay;
}

function indexOf(
  days: Array<{
    date: string;
    complete?: boolean;
    generation?: "complete" | "incomplete" | "missing";
    prices?: "complete" | "incomplete" | "missing";
    reserves?: "complete" | "incomplete" | "missing";
  }>,
): SiteIndex {
  return {
    contract_version: 1,
    days: days.map((day) => ({
      date: day.date,
      path: `days/${day.date}.json`,
      complete: day.complete ?? true,
      sections: {
        generation: day.generation ?? "complete",
        prices: day.prices ?? "complete",
        reserves: day.reserves ?? "complete",
      },
      export_sha256: "a",
    })),
    latest_complete: {},
    latest_complete_sections: {
      generation:
        [...days]
          .reverse()
          .find((day) => (day.generation ?? "complete") === "complete")?.date ??
        null,
      prices:
        [...days]
          .reverse()
          .find((day) => (day.prices ?? "complete") === "complete")?.date ??
        null,
      reserves:
        [...days]
          .reverse()
          .find((day) => (day.reserves ?? "complete") === "complete")?.date ??
        null,
    },
  };
}

test("fixture day mean price, gas-coal share and island spread", () => {
  process.env.DATA_ROOT = "/tmp/gw-no-gold";
  try {
    const day = loadSiteDay("2026-09-27");
    expect(meanReferencePrice(day)).toBeCloseTo(52.30333, 4);
    expect(gasCoalShare(day)).toBeCloseTo(0.0070794, 6);
    expect(meanIslandSpread(day)).toBeCloseTo(42.72543, 4);
    expect(meanReservePrice(day)).toBeCloseTo(10.5775, 4);
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
  }
});

test("latest market update uses the newest complete prices day and notes missing generation", () => {
  const prices = stubDay({
    date: "2026-11-18",
    generationState: "missing",
    primary: 0,
  });
  prices.generation.totals = null;
  prices.generation.daily = [];
  const generation = stubDay({ date: "2026-10-31" });
  const update = latestMarketUpdate(
    indexOf([
      {
        date: "2026-10-31",
        prices: "incomplete",
        generation: "complete",
        complete: false,
      },
      {
        date: "2026-11-18",
        prices: "complete",
        generation: "missing",
        complete: false,
      },
    ]),
    (date) => (date === "2026-11-18" ? prices : generation),
  );
  expect(update.date).toBe("2026-11-18");
  expect(update.href).toBe("/2026/11/18/");
  expect(update.summary).toMatch(/wholesale prices/i);
  expect(update.summary).not.toMatch(/megawatt-hour|household bill/);
  expect(update.generationLag?.text).toMatch(/not in yet/i);
  expect(update.generationLag?.latest?.label).toMatch(/31 October 2026/);
  expect(update.generationLag?.latest?.href).toBe("/2026/10/31/");
});

test("latest market update has no generation lag when the prices day has a dispatch mix", () => {
  const prices = stubDay({
    date: "2026-11-18",
    generationState: "complete",
  });
  prices.generation.source = "dispatch";
  const update = latestMarketUpdate(
    indexOf([
      {
        date: "2026-11-18",
        prices: "complete",
        generation: "complete",
        complete: true,
      },
    ]),
    () => prices,
  );
  expect(update.generationLag).toBeNull();
});

test("recent days are the last 14, newest first, with an incomplete note flag", () => {
  const days = Array.from({ length: 16 }, (_, i) => {
    const date = Temporal.PlainDate.from("2026-09-01")
      .add({ days: i })
      .toString();
    return {
      date,
      complete: i !== 15,
      prices: i === 15 ? ("incomplete" as const) : ("complete" as const),
    };
  });
  const recent = recentDays(indexOf(days));
  expect(recent).toHaveLength(14);
  expect(recent[0]?.date).toBe("2026-09-16");
  expect(recent[0]?.complete).toBe(false);
  expect(recent[1]?.date).toBe("2026-09-15");
  expect(recent[1]?.complete).toBe(true);
  expect(recent.at(-1)?.date).toBe("2026-09-03");
});

test("each condition card uses its own latest complete date and has no composite score", () => {
  const byDate: Record<string, SiteDay> = {
    "2026-10-01": stubDay({
      date: "2026-10-01",
      meanPrices: [40, 40, 40],
      gas: 10,
      coalGas: 5,
      primary: 100,
      reserveMeans: [0.2, 0.2],
    }),
    "2026-10-20": stubDay({
      date: "2026-10-20",
      meanPrices: [80, 80, 80],
      gas: 40,
      coalGas: 10,
      primary: 100,
      reserveMeans: [2, 2],
    }),
    "2026-11-18": stubDay({
      date: "2026-11-18",
      meanPrices: [200, 200, 200],
      generationState: "missing",
      reserveMeans: [8, 8],
    }),
  };
  const cards = marketConditionCards(
    {
      contract_version: 1,
      days: [
        {
          date: "2026-10-01",
          path: "days/2026-10-01.json",
          complete: true,
          sections: {
            generation: "complete",
            prices: "complete",
            reserves: "complete",
          },
          export_sha256: "a",
        },
        {
          date: "2026-10-20",
          path: "days/2026-10-20.json",
          complete: true,
          sections: {
            generation: "complete",
            prices: "complete",
            reserves: "complete",
          },
          export_sha256: "b",
        },
        {
          date: "2026-11-18",
          path: "days/2026-11-18.json",
          complete: false,
          sections: {
            generation: "missing",
            prices: "complete",
            reserves: "complete",
          },
          export_sha256: "c",
        },
      ],
      latest_complete: {},
      latest_complete_sections: {
        generation: "2026-10-20",
        prices: "2026-11-18",
        reserves: "2026-11-18",
      },
    },
    (date) => byDate[date] as SiteDay,
  );
  expect(cards.map((card) => card.id)).toEqual([
    "prices",
    "supply",
    "reserves",
    "regional",
  ]);
  expect(cards.find((card) => card.id === "prices")?.date).toBe("2026-11-18");
  expect(cards.find((card) => card.id === "supply")?.date).toBe("2026-10-20");
  expect(cards.find((card) => card.id === "reserves")?.date).toBe("2026-11-18");
  expect(cards.find((card) => card.id === "regional")?.date).toBe("2026-11-18");
  expect(cards.find((card) => card.id === "prices")?.figure).toMatch(
    /20c per kWh/,
  );
  expect(cards.find((card) => card.id === "prices")?.figure).toMatch(
    /Ōtāhuhu, Haywards and Benmore/,
  );
  expect(cards.find((card) => card.id === "supply")?.figure).toMatch(/50%/);
  expect(cards.find((card) => card.id === "reserves")?.figure).toMatch(
    /backup generation/,
  );
  expect(cards.find((card) => card.id === "regional")?.figure).toMatch(
    /Haywards/,
  );
  expect(cards.every((card) => card.band === null)).toBe(true);
  expect(
    cards.every((card) => card.bandNote?.includes("Not enough complete days")),
  ).toBe(true);
});

test("thirty earlier complete days produce a rank band in past tense", () => {
  const dates = Array.from({ length: 31 }, (_, i) =>
    Temporal.PlainDate.from("2026-01-01").add({ days: i }).toString(),
  );
  const byDate: Record<string, SiteDay> = {};
  for (const [i, date] of dates.entries()) {
    const price = i === 30 ? 200 : i;
    byDate[date] = stubDay({
      date,
      meanPrices: [price, price, price],
      hayBen: Array.from({ length: 46 }, () => (i === 30 ? 80 : i)),
      gas: i === 30 ? 90 : i,
      coalGas: 0,
      primary: 100,
      reserveMeans: [i === 30 ? 20 : i / 10, i === 30 ? 20 : i / 10],
    });
  }
  const cards = marketConditionCards(
    {
      contract_version: 1,
      days: dates.map((date) => ({
        date,
        path: `days/${date}.json`,
        complete: true,
        sections: {
          generation: "complete",
          prices: "complete",
          reserves: "complete",
        },
        export_sha256: "a",
      })),
      latest_complete: {},
      latest_complete_sections: {
        generation: dates[30] ?? null,
        prices: dates[30] ?? null,
        reserves: dates[30] ?? null,
      },
    },
    (date) => byDate[date] as SiteDay,
  );
  expect(cards.every((card) => card.band === "one of the highest")).toBe(true);
  expect(
    cards.every((card) =>
      card.bandNote?.startsWith("That was one of the highest"),
    ),
  ).toBe(true);
  expect(
    cards.every((card) =>
      card.bandNote?.includes("30 earlier days on this site"),
    ),
  ).toBe(true);
  expect(cards.every((card) => card.date === dates[30])).toBe(true);
});

test("a missing reserves section is its own empty card, not a score", () => {
  const [reserves] = marketConditionCards(
    {
      contract_version: 1,
      days: [
        {
          date: "2026-09-27",
          path: "days/2026-09-27.json",
          complete: true,
          sections: { generation: "complete", prices: "complete" },
          export_sha256: "a",
        },
      ],
      latest_complete: {},
      latest_complete_sections: {
        generation: "2026-09-27",
        prices: "2026-09-27",
      },
    },
    () => stubDay({ reservesState: "missing", reserveMeans: [] }),
  ).filter((card) => card.id === "reserves");
  expect(reserves?.date).toBeNull();
  expect(reserves?.figure).toMatch(/not been published yet/i);
  expect(reserves?.figure).toMatch(/backup generation/);
});

test("homepage figures stay past tense and skip good, bad, safe, next", () => {
  process.env.DATA_ROOT = "/tmp/gw-no-gold";
  try {
    const index = loadSiteIndex();
    const update = latestMarketUpdate(index, (date) =>
      loadSiteDay(date, index),
    );
    const cards = marketConditionCards(index, (date) =>
      loadSiteDay(date, index),
    );
    const text = [
      update.summary,
      update.generationLag?.text ?? "",
      ...cards.flatMap((card) => [card.figure, card.bandNote ?? ""]),
    ].join(" ");
    expect(text).not.toMatch(/\b(good|bad|safe|safer|worse)\b/i);
    expect(text).not.toMatch(/will happen/i);
    expect(text).not.toMatch(/\bI\b/);
    expect(text).not.toMatch(/\bwe\b/i);
    expect(text).not.toMatch(/observatory/i);
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
  }
});

function daySeries(
  count: number,
  last: Parameters<typeof stubDay>[0],
): { index: SiteIndex; byDate: Record<string, SiteDay>; lastDate: string } {
  const dates = Array.from({ length: count }, (_, i) =>
    Temporal.PlainDate.from("2026-08-01").add({ days: i }).toString(),
  );
  const byDate: Record<string, SiteDay> = {};
  for (const [i, date] of dates.entries()) {
    byDate[date] =
      i === count - 1
        ? stubDay({ ...last, date })
        : stubDay({ date, primary: 1000 + i, meanPrices: [50, 50, 50] });
  }
  return {
    index: indexOf(dates.map((date) => ({ date }))),
    byDate,
    lastDate: dates.at(-1) as string,
  };
}

test("dayContext ranks a day against earlier days and says the change from the day before", () => {
  const { index, byDate, lastDate } = daySeries(41, {
    primary: 1000,
    meanPrices: [200, 200, 200],
  });
  const context = dayContext(
    index,
    lastDate,
    (date) => byDate[date] as SiteDay,
  );
  const price = context.find((entry) => entry.id === "price");
  const power = context.find((entry) => entry.id === "power");
  expect(price?.line).toBe(
    "Wholesale prices were one of the highest of the 40 earlier days on this site.",
  );
  expect(price?.change).toBe("Up 15c per kWh from the day before.");
  expect(power?.line).toMatch(/^Generation was lower than most of the 40/);
  expect(power?.change).toBe("Down 39 MWh from the day before.");
});

test("two days with different price levels get different comparison lines", () => {
  const ordinary = daySeries(41, { primary: 1020, meanPrices: [50, 50, 50] });
  const dear = daySeries(41, { primary: 1020, meanPrices: [200, 200, 200] });
  const line = (series: ReturnType<typeof daySeries>) =>
    dayContext(
      series.index,
      series.lastDate,
      (date) => series.byDate[date] as SiteDay,
    ).find((entry) => entry.id === "price")?.line;
  expect(line(ordinary)).toMatch(/about usual/);
  expect(line(dear)).toMatch(/one of the highest/);
});

test("dayContext says so when there are too few earlier days", () => {
  const { index, byDate, lastDate } = daySeries(10, { primary: 1000 });
  const context = dayContext(
    index,
    lastDate,
    (date) => byDate[date] as SiteDay,
  );
  expect(context.every((entry) => entry.line !== null)).toBe(true);
  expect(context.map((entry) => entry.line)).toEqual([
    "Not enough earlier days yet to compare.",
    "Not enough earlier days yet to compare.",
    "Not enough earlier days yet to compare.",
  ]);
});

test("leadFact picks the figure furthest from usual and says nothing about cause", () => {
  const { index, byDate, lastDate } = daySeries(41, {
    primary: 1020,
    meanPrices: [200, 200, 200],
  });
  const sentence = leadFact(index, lastDate, (date) => byDate[date] as SiteDay);
  expect(sentence).toBe(
    "Wholesale prices were one of the highest of the 40 earlier days on this site.",
  );
  expect(sentence).not.toMatch(/because|caused|due to/i);
});

test("leadFact says a day was ordinary when no figure is far from normal", () => {
  const { index, byDate, lastDate } = daySeries(41, {
    primary: 1020,
    meanPrices: [50, 50, 50],
  });
  expect(leadFact(index, lastDate, (date) => byDate[date] as SiteDay)).toBe(
    "None of the day's main figures was far from usual for the 40 earlier days on this site.",
  );
});

test("leadFact is null when there are too few earlier days", () => {
  const { index, byDate, lastDate } = daySeries(10, { primary: 1000 });
  expect(
    leadFact(index, lastDate, (date) => byDate[date] as SiteDay),
  ).toBeNull();
});

test("the latest update leads with the same fact as the daily page, and falls back to the kind of day", () => {
  const long = daySeries(41, { primary: 1020, meanPrices: [200, 200, 200] });
  const update = latestMarketUpdate(
    long.index,
    (date) => long.byDate[date] as SiteDay,
  );
  expect(update.summary).toBe(
    leadFact(long.index, long.lastDate, (date) => long.byDate[date] as SiteDay),
  );
  const short = daySeries(10, { primary: 1000 });
  const fallback = latestMarketUpdate(
    short.index,
    (date) => short.byDate[date] as SiteDay,
  );
  expect(fallback.summary).toMatch(/made most of the power/);
});

test("the latest update leads with the episode line when that day has one", () => {
  const long = daySeries(41, { primary: 1020, meanPrices: [200, 200, 200] });
  const last = long.byDate[long.lastDate] as SiteDay;
  last.periods = CLOCK_PERIODS;
  last.episodes = {
    state: "complete",
    missing_periods: [],
    analysis_version: 1,
    inputs_sha256: "a",
    silver_tables: [],
    gold_tables: [],
    datasets: [],
    items: [
      {
        episode_id: "e1",
        seed_observation_id: "o1",
        start_utc: "2026-06-01T04:00:00Z",
        end_utc: "2026-06-01T06:30:00Z",
        start_trading_period: 33,
        end_trading_period: 38,
        member_count: 1,
        observation_types: ["price_high"],
        islands: ["NI"],
        severity: 1,
        highlights: [
          {
            observation_type: "price_high",
            point_of_connection: "OTA2201",
            pair_from: null,
            pair_to: null,
            island: "NI",
            measured_value: 410,
            baseline_value: 80,
          },
        ],
      },
    ],
  };
  const quietLead = leadFact(
    long.index,
    long.lastDate,
    (date) => long.byDate[date] as SiteDay,
  );
  const update = latestMarketUpdate(
    long.index,
    (date) => long.byDate[date] as SiteDay,
  );
  expect(update.summary).toBe(pageLead(last, quietLead));
  expect(update.summary).toMatch(/Ōtāhuhu reached 41c/);
  expect(update.summary).not.toMatch(/because|caused|due to/i);
});

test("a finding has a short form built from the same ranking", () => {
  const dear = daySeries(41, { primary: 1020, meanPrices: [200, 200, 200] });
  const finding = leadFinding(
    dear.index,
    dear.lastDate,
    (date) => dear.byDate[date] as SiteDay,
  );
  expect(finding?.short).toBe("Prices: one of the highest");
  const usual = daySeries(41, { primary: 1020, meanPrices: [50, 50, 50] });
  expect(
    leadFinding(
      usual.index,
      usual.lastDate,
      (date) => usual.byDate[date] as SiteDay,
    )?.short,
  ).toBe("Main figures about usual");
  const young = daySeries(10, { primary: 1000 });
  expect(
    leadFinding(
      young.index,
      young.lastDate,
      (date) => young.byDate[date] as SiteDay,
    ),
  ).toBeNull();
});

test("only the latest seven recent days carry a short finding, and none without a loader", () => {
  const series = daySeries(41, { primary: 1020, meanPrices: [200, 200, 200] });
  const days = recentDays(
    series.index,
    14,
    (date) => series.byDate[date] as SiteDay,
  );
  expect(days).toHaveLength(14);
  expect(days.slice(0, 7).every((day) => day.lead !== null)).toBe(true);
  expect(days.slice(7).every((day) => day.lead === null)).toBe(true);
  expect(days[0]?.lead).toBe("Prices: one of the highest");
  expect(recentDays(series.index).every((day) => day.lead === null)).toBe(true);
});

test("groupRecentDays joins runs of the same finding and keeps breaks", () => {
  const day = (date: string, lead: string | null) => ({
    date,
    href: `/${date}/`,
    label: date,
    complete: true,
    lead,
  });
  const groups = groupRecentDays([
    day("2026-11-21", "Reserve prices: one of the highest"),
    day("2026-11-20", "Reserve prices: one of the highest"),
    day("2026-11-19", "Reserve prices: one of the highest"),
    day("2026-11-18", "Price gap: lower than most"),
    day("2026-11-17", null),
    day("2026-11-16", null),
  ]);
  expect(groups.map((g) => [g.lead, g.days.length])).toEqual([
    ["Reserve prices: one of the highest", 3],
    ["Price gap: lower than most", 1],
    [null, 1],
    [null, 1],
  ]);
});

test("shortDayLabel is a compact weekday and date", () => {
  expect(shortDayLabel("2026-11-21")).toMatch(/Sat.*21.*Nov/);
});

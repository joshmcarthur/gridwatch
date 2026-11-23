import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SiteEpisode,
  SiteIndex,
} from "@gridwatch/publisher/site-contract";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  completenessNotice,
  dailyPath,
  dailyStaticPaths,
  dateFromParams,
  dayHeadline,
  type HeadlineSource,
  mapPath,
  monthGroups,
  neighbouringDays,
  pageLead,
} from "./daily-page.ts";
import { loadSiteDay, loadSiteIndex } from "./site-data.ts";

const previousDataRoot = process.env.DATA_ROOT;
let dataRoot: string;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gw-daily-page-"));
  process.env.DATA_ROOT = dataRoot;
});

afterEach(async () => {
  if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
  else process.env.DATA_ROOT = previousDataRoot;
  await rm(dataRoot, { recursive: true, force: true });
});

const threeDayIndex: SiteIndex = {
  contract_version: 1,
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
      sections: { generation: "complete", prices: "incomplete" },
      export_sha256: "b",
    },
    {
      date: "2026-10-01",
      path: "days/2026-10-01.json",
      complete: true,
      sections: { generation: "complete", prices: "complete" },
      export_sha256: "c",
    },
  ],
  latest_complete: {},
  latest_complete_sections: { generation: "2026-10-01", prices: "2026-10-01" },
};

test("dailyPath is a trailing-slash YYYY/MM/DD route", () => {
  expect(dailyPath("2026-09-27")).toBe("/2026/09/27/");
});

test("mapPath is the daily path plus map/", () => {
  expect(mapPath("2026-09-27")).toBe("/2026/09/27/map/");
});

test("dateFromParams round-trips a padded calendar date", () => {
  expect(dateFromParams("2026", "09", "27")).toBe("2026-09-27");
});

test("dateFromParams throws when the date is not a calendar date", () => {
  expect(() => dateFromParams("2026", "13", "40")).toThrow();
});

test("dailyStaticPaths emits one params object per index day", () => {
  expect(dailyStaticPaths(threeDayIndex)).toEqual([
    { params: { year: "2026", month: "09", day: "26" } },
    { params: { year: "2026", month: "09", day: "27" } },
    { params: { year: "2026", month: "10", day: "01" } },
  ]);
});

test("neighbouringDays returns the previous and next index days", () => {
  expect(neighbouringDays(threeDayIndex, "2026-09-27")).toEqual({
    previous: threeDayIndex.days[0],
    next: threeDayIndex.days[2],
  });
});

test("neighbouringDays is empty at each end of the index", () => {
  expect(neighbouringDays(threeDayIndex, "2026-09-26").previous).toBeNull();
  expect(neighbouringDays(threeDayIndex, "2026-10-01").next).toBeNull();
});

test("monthGroups lists days under en-NZ month headings", () => {
  const groups = monthGroups(threeDayIndex);
  expect(groups.map((group) => group.key)).toEqual(["2026-09", "2026-10"]);
  expect(groups.map((group) => group.label)).toEqual([
    "September 2026",
    "October 2026",
  ]);
  expect(groups[0]?.days.map((day) => day.date)).toEqual([
    "2026-09-26",
    "2026-09-27",
  ]);
});

test("fixture days build a path for each committed sample", () => {
  const index = loadSiteIndex();
  expect(dailyStaticPaths(index)).toEqual([
    { params: { year: "2026", month: "09", day: "26" } },
    { params: { year: "2026", month: "09", day: "27" } },
    { params: { year: "2026", month: "10", day: "29" } },
  ]);
  const day = loadSiteDay("2026-09-27");
  expect(day.trading_date).toBe("2026-09-27");
  expect(day.complete).toBe(true);
});

test("headline names the kind of day without a unit lecture", () => {
  const headline = dayHeadline(loadSiteDay("2026-09-27"));
  expect(headline.sentence).toBe(
    "Hydro made most of the power, and wholesale prices were far apart across Ōtāhuhu, Haywards and Benmore.",
  );
  expect(headline.sentence).not.toMatch(/kilowatt/);
  expect(headline.sentence).not.toMatch(/household bill/);
  expect(headline.sentence).not.toMatch(/cable/);
  expect(headline.sentence).not.toMatch(/\bEMI\b/);
  expect(headline.sentence).not.toMatch(/\bOTA2201\b/);
  expect(headline.stats).toEqual([
    {
      id: "power",
      label: "Electricity generated",
      href: "#word-megawatt-hour",
      value: "108,910 MWh",
    },
    {
      id: "price",
      label: "Wholesale price",
      href: "#word-wholesale-price",
      value: "$20 to $73 / MWh",
    },
    {
      id: "islands",
      label: "The three places",
      href: "#word-places",
      value: "Far apart",
    },
  ]);
});

test("completenessNotice is omitted for a complete day", () => {
  expect(completenessNotice(loadSiteDay("2026-09-27"))).toBeNull();
});

test("completenessNotice names incomplete datasets in plain language", () => {
  const day = {
    complete: false,
    datasets: {
      dispatch_energy_prices: { status: "partial" as const },
      generation_md: { status: "complete" as const },
      entity_mappings: { status: "missing" as const },
    },
    generation: { state: "incomplete" as const },
    prices: { state: "incomplete" as const },
  };
  const notice = completenessNotice(day);
  expect(notice?.tone).toBe("warn");
  const text = notice?.paragraphs.join(" ") ?? "";
  expect(text).toMatch(/incomplete/i);
  expect(text).toMatch(/wholesale energy prices/i);
  expect(text).toMatch(/only partial/i);
  expect(text).toMatch(/plant names and locations/i);
  expect(text).toMatch(/missing/i);
  expect(text).not.toMatch(/dispatch_energy_prices/);
  expect(text).not.toMatch(/household bill/);
});

test("completenessNotice labels missing reserve prices", () => {
  const day = {
    complete: false,
    datasets: {
      dispatch_reserve_prices: { status: "missing" as const },
      dispatch_energy_prices: { status: "complete" as const },
      generation_md: { status: "partial" as const },
    },
    generation: { state: "incomplete" as const },
    prices: { state: "complete" as const },
  };
  const text = completenessNotice(day)?.paragraphs.join(" ");
  expect(text).toMatch(/reserve prices/i);
  expect(text).toMatch(/standing ready/i);
  expect(text).not.toMatch(/dispatch_reserve_prices/);
});

test("headline falls back when generation or prices are missing", () => {
  const day: HeadlineSource = {
    generation: { state: "missing", totals: null, daily: [] },
    prices: { state: "missing", nodes: [] },
  };
  const headline = dayHeadline(day);
  expect(headline.sentence).toMatch(
    /generation and wholesale prices for this day are missing/i,
  );
  expect(headline.stats.map((stat) => stat.value)).toEqual([
    "No numbers yet",
    "No numbers yet",
    "No numbers yet",
  ]);
});

test("close sample prices use one typical figure", () => {
  const day: HeadlineSource = {
    generation: {
      state: "complete",
      totals: { primary_megawatt_hours: 1000, battery_megawatt_hours: 0 },
      daily: [
        { fuel: "hydro", megawatt_hours: 800 },
        { fuel: "wind", megawatt_hours: 200 },
      ],
    },
    prices: {
      state: "complete",
      nodes: [
        { price_region: "upper_north_island", daily: { mean_price: 51 } },
        { price_region: "lower_north_island", daily: { mean_price: 50 } },
        { price_region: "south_island", daily: { mean_price: 49 } },
      ],
    },
  };
  const headline = dayHeadline(day);
  expect(headline.sentence).toBe(
    "Hydro made most of the power, and wholesale prices stayed close across Ōtāhuhu, Haywards and Benmore.",
  );
  expect(headline.stats[1]?.value).toBe("$50 / MWh");
  expect(headline.stats[2]?.value).toBe("Stayed close");
});

test("a wide gap between places is far apart, not differed", () => {
  const day: HeadlineSource = {
    generation: {
      state: "complete",
      totals: { primary_megawatt_hours: 1000, battery_megawatt_hours: 0 },
      daily: [{ fuel: "gas", megawatt_hours: 1000 }],
    },
    prices: {
      state: "complete",
      nodes: [
        { price_region: "upper_north_island", daily: { mean_price: 200 } },
        { price_region: "south_island", daily: { mean_price: 40 } },
      ],
    },
  };
  const headline = dayHeadline(day);
  expect(headline.sentence).toMatch(/far apart/);
  expect(headline.stats[2]?.value).toBe("Far apart");
  expect(headline.sentence).not.toMatch(/islands/);
});

const CLOCK_PERIODS = [
  { period: 1, start_utc: "2026-05-31T12:00:00Z" },
  { period: 2, start_utc: "2026-05-31T12:30:00Z" },
  { period: 33, start_utc: "2026-06-01T04:00:00Z" },
  { period: 38, start_utc: "2026-06-01T06:30:00Z" },
  { period: 41, start_utc: "2026-06-02T20:00:00Z" },
  { period: 45, start_utc: "2026-06-02T22:00:00Z" },
];

const hydroClose: HeadlineSource = {
  generation: {
    state: "complete",
    totals: { primary_megawatt_hours: 1000, battery_megawatt_hours: 0 },
    daily: [
      { fuel: "hydro", megawatt_hours: 800 },
      { fuel: "wind", megawatt_hours: 200 },
    ],
  },
  prices: {
    state: "complete",
    nodes: [
      { price_region: "upper_north_island", daily: { mean_price: 51 } },
      { price_region: "lower_north_island", daily: { mean_price: 50 } },
      { price_region: "south_island", daily: { mean_price: 49 } },
    ],
  },
};

const otahuhuHigh: SiteEpisode = {
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
};

test("pageLead uses the first episode line when the day has episodes", () => {
  expect(
    pageLead(
      {
        ...hydroClose,
        periods: CLOCK_PERIODS,
        episodes: { items: [otahuhuHigh] },
      },
      "Wholesale prices were one of the highest.",
    ),
  ).toBe(
    "From 4:00pm to 6:30pm, wholesale prices at Ōtāhuhu reached $410 per megawatt-hour, above the recent typical level of about $80.",
  );
});

test("two consecutive days with different episodes get different ledes", () => {
  const saturday = pageLead(
    {
      ...hydroClose,
      periods: CLOCK_PERIODS,
      episodes: { items: [otahuhuHigh] },
    },
    null,
  );
  const sunday = pageLead(
    {
      ...hydroClose,
      periods: CLOCK_PERIODS,
      episodes: {
        items: [
          {
            ...otahuhuHigh,
            episode_id: "e2",
            start_utc: "2026-06-02T20:00:00Z",
            end_utc: "2026-06-02T22:00:00Z",
            observation_types: ["price_low"],
            islands: ["SI"],
            highlights: [
              {
                observation_type: "price_low",
                point_of_connection: "BEN2201",
                pair_from: null,
                pair_to: null,
                island: "SI",
                measured_value: 5,
                baseline_value: 40,
              },
            ],
          },
        ],
      },
    },
    null,
  );
  expect(saturday).not.toBe(sunday);
  expect(saturday).toMatch(/Ōtāhuhu reached \$410/);
  expect(sunday).toMatch(/Benmore fell to \$5/);
});

test("a quiet day uses the history lead, then the kind of day", () => {
  const quiet = {
    ...hydroClose,
    periods: CLOCK_PERIODS,
    episodes: { items: [] },
  };
  expect(pageLead(quiet, "Wholesale prices were one of the highest.")).toBe(
    "Wholesale prices were one of the highest.",
  );
  expect(pageLead(quiet, null)).toBe(
    "Hydro made most of the power, and wholesale prices stayed close across Ōtāhuhu, Haywards and Benmore.",
  );
});

test("a missing episode list does not invent a stretch", () => {
  const missing = { ...hydroClose, periods: CLOCK_PERIODS };
  expect(
    pageLead(missing, "None of the day's main figures was far from normal."),
  ).toBe("None of the day's main figures was far from normal.");
});

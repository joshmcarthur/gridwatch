import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SiteIndex } from "@gridwatch/publisher/site-contract";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  CHART_SLOTS,
  completenessNotice,
  dailyPath,
  dailyStaticPaths,
  dateFromParams,
  type HeadlineSource,
  headlineParagraphs,
  monthGroups,
  neighbouringDays,
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

test("fixture day builds a /2026/09/27/ path", () => {
  const index = loadSiteIndex();
  expect(dailyStaticPaths(index)).toEqual([
    { params: { year: "2026", month: "09", day: "27" } },
  ]);
  const day = loadSiteDay("2026-09-27");
  expect(day.trading_date).toBe("2026-09-27");
  expect(day.complete).toBe(true);
});

test("headline explains wholesale prices and megawatt-hours in plain language", () => {
  const paragraphs = headlineParagraphs(loadSiteDay("2026-09-27"));
  const text = paragraphs.join(" ");
  expect(text).toMatch(/3,433 megawatt-hours/);
  expect(text).toMatch(/1,000 kilowatt-hours/);
  expect(text).toMatch(/kWh/);
  expect(text).toMatch(/wholesale prices/i);
  expect(text).toMatch(/household bill/);
  expect(text).toMatch(/\$104 per megawatt-hour/);
  expect(text).toMatch(/Upper North Island/);
  expect(text).toMatch(/Otahuhu/);
  expect(text).not.toMatch(/\bEMI\b/);
  expect(text).not.toMatch(/\bEA\b/);
  expect(text).not.toMatch(/\bNI\b/);
  expect(text).not.toMatch(/\bSI\b/);
});

test("completenessNotice says a complete day is complete", () => {
  const notice = completenessNotice(loadSiteDay("2026-09-27"));
  expect(notice.tone).toBe("ok");
  expect(notice.paragraphs.join(" ")).toMatch(/look complete/);
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
  expect(notice.tone).toBe("warn");
  const text = notice.paragraphs.join(" ");
  expect(text).toMatch(/incomplete/i);
  expect(text).toMatch(/wholesale energy prices/i);
  expect(text).toMatch(/household bill/);
  expect(text).toMatch(/only partial/i);
  expect(text).toMatch(/plant names and locations/i);
  expect(text).toMatch(/missing/i);
  expect(text).not.toMatch(/dispatch_energy_prices/);
});

test("headline falls back when generation or prices are missing", () => {
  const day: HeadlineSource = {
    generation: { state: "missing", totals: null },
    prices: { state: "missing", nodes: [] },
  };
  const text = headlineParagraphs(day).join(" ");
  expect(text).toMatch(/generation numbers for this day are missing/i);
  expect(text).toMatch(/wholesale prices for this day are missing/i);
});

test("chart slots leave empty homes for later issues", () => {
  expect(CHART_SLOTS.map((slot) => slot.id)).toEqual([
    "wholesale-prices",
    "energy-flow",
  ]);
  for (const slot of CHART_SLOTS) {
    expect(slot.body).toMatch(/not drawn yet/i);
  }
});

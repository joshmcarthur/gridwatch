import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { goldPartitionPath } from "../gold/common.ts";
import { completenessView } from "../gold/fixtures/completeness.ts";
import { writeParquet } from "../gold/fixtures/parquet.ts";
import type { NarrativeRecord } from "../gold/narrative.ts";
import {
  assertSiteDay,
  SITE_CONTRACT_VERSION,
  type SiteDay,
} from "./contract.ts";
import { buildSiteDay } from "./export.ts";
import { eventFromCandidate } from "./export-events.ts";

const DATE = "2026-07-27";
const EPISODE_ID = "abc123";

const narrative = (over: Partial<NarrativeRecord> = {}): NarrativeRecord => ({
  schema_version: 1,
  prompt_version: 1,
  package_id: "pkg-1",
  episode_id: EPISODE_ID,
  trading_date: DATE,
  model: "test",
  generated_at: "2026-11-23T00:00:00Z",
  what_happened:
    "On 27 July 2026, Otahuhu period 36 reached $3,296.04/MWh. See /2026/07/27/.",
  why: "Confirmed: the reserve price was $2,154.45/MWh.",
  what_it_means: "The islands pulled apart.",
  ...over,
});

const evidence = {
  episode: {
    episode_id: EPISODE_ID,
    event_start_utc: "2026-07-27T05:30:00Z",
    event_end_utc: "2026-07-27T07:30:00Z",
    start_trading_period: 36,
    end_trading_period: 39,
    observation_types: ["price_high", "reserve_price_high"],
    islands: ["NI"],
  },
  window: { trading_date: DATE, periods: [34, 35, 36] },
  context: {
    prices: {
      OTA2201: { price: [156.25, 141.04, 3296.04] },
      HAY2201: { price: [130.14, 119.64, 2853.43] },
      BEN2201: { price: [22.36, 54.09, 571.46] },
    },
    reserves: { SIR: { NI: { price: [1, 2, 2154.45] } } },
  },
  claims: [
    {
      id: "price.OTA2201.p36",
      label: "Otahuhu period price",
      value: 3296.04,
      unit: "$/MWh",
      confidence: "confirmed",
      source: {
        kind: "gold",
        table: "price_periods",
        query_id: "priceClaims",
        path: "gold/price_periods/trading_date=2026-07-27/data.parquet",
      },
    },
    {
      id: "reserve.SIR.NI.p36",
      label: "North Island 60-second reserve",
      value: 2154.45,
      unit: "$/MWh",
      confidence: "confirmed",
      source: {
        kind: "gold",
        table: "reserve_by_class_island_period",
        query_id: "reserveClaims",
        path: "gold/reserve_by_class_island_period/trading_date=2026-07-27/data.parquet",
      },
    },
  ],
  links: { daily_page: "/2026/07/27/" },
};

test("eventFromCandidate accepts a 27 July fixture that only uses package facts", () => {
  const event = eventFromCandidate(narrative(), evidence);
  expect(event?.episode_id).toBe(EPISODE_ID);
  expect(event?.review_status).toBe("unreviewed");
  expect(event?.claims).toHaveLength(2);
  expect(event?.window.prices[0]?.price[2]).toBe(3296.04);
  expect(event?.window.reserves[0]?.price[2]).toBe(2154.45);
  expect(event?.daily_page).toBe("/2026/07/27/");
});

test("eventFromCandidate still returns an event when a number is invented", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const event = eventFromCandidate(
    narrative({ what_happened: "Otahuhu hit $9,999/MWh." }),
    evidence,
  );
  expect(event?.episode_id).toBe(EPISODE_ID);
  expect(event?.what_happened).toContain("$9,999");
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

let root: string;
let goldDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-events-"));
  goldDir = join(root, "gold");
});
afterEach(() => rm(root, { recursive: true, force: true }));

const stamp = {
  analysis_version: 2,
  inputs_sha256: "rank",
  inputs_complete: true,
};

async function writeRanking(candidate: boolean) {
  await writeParquet(
    goldPartitionPath(goldDir, "episode_ranking_days", DATE),
    {
      analysis_version: "INTEGER",
      inputs_sha256: "VARCHAR",
      inputs_complete: "BOOLEAN",
    },
    [stamp],
  );
  await writeParquet(
    goldPartitionPath(goldDir, "episode_scores", DATE),
    {
      episode_id: "VARCHAR",
      is_candidate: "BOOLEAN",
      day_rank: "INTEGER",
    },
    [{ episode_id: EPISODE_ID, is_candidate: candidate, day_rank: 1 }],
  );
}

test("a day with no ranking gold exports events as missing", async () => {
  const day = await buildSiteDay({
    goldDir,
    date: DATE,
    completeness: completenessView(),
  });
  expect(day.events?.state).toBe("missing");
  expect(day.events?.items).toEqual([]);
  expect(() => assertSiteDay(day)).not.toThrow();
});

test("a candidate without a narrative is omitted, not invented", async () => {
  await writeRanking(true);
  const day = await buildSiteDay({
    goldDir,
    date: DATE,
    completeness: completenessView(),
  });
  expect(day.events?.state).toBe("complete");
  expect(day.events?.items).toEqual([]);
});

test("a candidate whose narrative fails checkNarrative is still published", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await writeRanking(true);
  await mkdir(join(goldDir, "narratives", DATE), { recursive: true });
  await mkdir(join(goldDir, "evidence", DATE), { recursive: true });
  await writeFile(
    join(goldDir, "narratives", DATE, `${EPISODE_ID}.json`),
    `${JSON.stringify(narrative({ what_happened: "Otahuhu hit $9,999/MWh." }))}\n`,
  );
  await writeFile(
    join(goldDir, "evidence", DATE, `${EPISODE_ID}.json`),
    `${JSON.stringify(evidence)}\n`,
  );
  const day = await buildSiteDay({
    goldDir,
    date: DATE,
    completeness: completenessView(),
  });
  expect(day.events?.items).toHaveLength(1);
  expect(day.events?.items[0]?.what_happened).toContain("$9,999");
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

test("a candidate with a passing narrative becomes an unreviewed event", async () => {
  await writeRanking(true);
  await mkdir(join(goldDir, "narratives", DATE), { recursive: true });
  await mkdir(join(goldDir, "evidence", DATE), { recursive: true });
  await writeFile(
    join(goldDir, "narratives", DATE, `${EPISODE_ID}.json`),
    `${JSON.stringify(narrative())}\n`,
  );
  await writeFile(
    join(goldDir, "evidence", DATE, `${EPISODE_ID}.json`),
    `${JSON.stringify(evidence)}\n`,
  );
  const day = await buildSiteDay({
    goldDir,
    date: DATE,
    completeness: completenessView(),
  });
  expect(day.events?.state).toBe("complete");
  expect(day.events?.items).toHaveLength(1);
  expect(day.events?.items[0]?.review_status).toBe("unreviewed");
  expect(day.events?.items[0]?.what_happened).toContain("3,296.04");
  expect(() => assertSiteDay(day)).not.toThrow();
});

test("assertSiteDay accepts a missing events section", () => {
  const periods = Array.from({ length: 46 }, (_, i) => ({
    period: i + 1,
    start_utc: "2026-09-26T12:00:00Z",
  }));
  const day: SiteDay = {
    contract_version: SITE_CONTRACT_VERSION,
    trading_date: "2026-09-27",
    periods,
    complete: false,
    datasets: {},
    generation: {
      state: "missing",
      missing_periods: [],
      analysis_version: null,
      inputs_sha256: null,
      silver_tables: [],
      gold_tables: [],
      datasets: [],
      series: [],
      daily: [],
      totals: null,
    },
    prices: {
      state: "missing",
      missing_periods: [],
      analysis_version: null,
      inputs_sha256: null,
      silver_tables: [],
      gold_tables: [],
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
    events: {
      state: "missing",
      missing_periods: [],
      analysis_version: null,
      inputs_sha256: null,
      silver_tables: [],
      gold_tables: ["episode_ranking_days", "episode_scores"],
      datasets: [],
      items: [],
    },
  };
  expect(() => assertSiteDay(day)).not.toThrow();
});

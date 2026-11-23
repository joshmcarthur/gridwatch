import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  formatTradingDate,
  loadSiteDay,
  loadSiteDayIfPresent,
  loadSiteIndex,
  recentEpisodes,
} from "./site-data.ts";

const validIndex = {
  contract_version: 1,
  days: [
    {
      date: "2026-09-26",
      path: "days/2026-09-26.json",
      complete: true,
      sections: { generation: "complete", prices: "complete" },
      export_sha256: "a",
    },
  ],
  latest_complete: { generation_md: "2026-09-26" },
  latest_complete_sections: { generation: "2026-09-26", prices: null },
};

let dataRoot: string;
const previousDataRoot = process.env.DATA_ROOT;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gw-site-data-"));
  delete process.env.DATA_ROOT;
});

afterEach(async () => {
  if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
  else process.env.DATA_ROOT = previousDataRoot;
  delete process.env.SITE_REQUIRE_GOLD;
  await rm(dataRoot, { recursive: true, force: true });
});

test("loadSiteIndex throws when SITE_REQUIRE_GOLD is set and gold is absent", () => {
  process.env.DATA_ROOT = dataRoot;
  process.env.SITE_REQUIRE_GOLD = "1";
  expect(() => loadSiteIndex()).toThrow(/SITE_REQUIRE_GOLD=1/);
});

test("formatTradingDate throws when the date is not a calendar date", () => {
  expect(() => formatTradingDate("not-a-date")).toThrow();
  expect(() => formatTradingDate("2026-13-40")).toThrow();
});

test("formatTradingDate formats a trading date in en-NZ", () => {
  expect(formatTradingDate("2026-09-27")).toBe("Sunday, 27 September 2026");
});

test("loadSiteIndex uses the fixture when gold is absent", () => {
  process.env.DATA_ROOT = dataRoot;
  const index = loadSiteIndex();
  expect(index.days.map((day) => day.date)).toEqual([
    "2026-07-27",
    "2026-09-26",
    "2026-09-27",
    "2026-10-29",
  ]);
});

test("loadSiteIndex returns gold when DATA_ROOT points at a valid index", async () => {
  await mkdir(join(dataRoot, "gold/site"), { recursive: true });
  await writeFile(
    join(dataRoot, "gold/site/index.json"),
    JSON.stringify(validIndex),
  );
  process.env.DATA_ROOT = dataRoot;
  expect(loadSiteIndex()).toEqual(validIndex);
});

test("loadSiteIndex throws when gold is not a SiteIndex", async () => {
  await mkdir(join(dataRoot, "gold/site"), { recursive: true });
  await writeFile(
    join(dataRoot, "gold/site/index.json"),
    JSON.stringify({ contract_version: 1 }),
  );
  process.env.DATA_ROOT = dataRoot;
  expect(() => loadSiteIndex()).toThrow();
});

test("loadSiteDay reads the fixture day when gold is absent", () => {
  process.env.DATA_ROOT = dataRoot;
  const day = loadSiteDay("2026-09-27");
  expect(day.trading_date).toBe("2026-09-27");
  expect(day.complete).toBe(true);
});

test("loadSiteDay throws when the date is not in the index", () => {
  process.env.DATA_ROOT = dataRoot;
  expect(() => loadSiteDay("1999-01-01")).toThrow(/1999-01-01/);
});

test("loadSiteDayIfPresent returns null for a date that is not in the index", () => {
  process.env.DATA_ROOT = dataRoot;
  expect(loadSiteDayIfPresent("1999-01-01")).toBeNull();
});

test("loadSiteDayIfPresent loads 2026-07-27 from the fixture, not 2026-09-27", () => {
  process.env.DATA_ROOT = dataRoot;
  expect(loadSiteDayIfPresent("2026-07-27")?.trading_date).toBe("2026-07-27");
  expect(loadSiteDayIfPresent("2026-09-27")?.trading_date).toBe("2026-09-27");
});

test("fixture 2026-07-27 is a complete generation and prices day", () => {
  process.env.DATA_ROOT = dataRoot;
  const day = loadSiteDay("2026-07-27");
  expect(day.complete).toBe(true);
  expect(day.generation.state).toBe("complete");
  expect(day.prices.state).toBe("complete");
  expect(day.periods).toHaveLength(48);
  const otahuhu = day.prices.nodes.find(
    (node) => node.point_of_connection === "OTA2201",
  );
  expect(otahuhu?.price[35]).toBe(3296.04);
});

test("loadSiteDay reads a gold day when DATA_ROOT has a matching file", async () => {
  const fixture = await readFile(
    new URL("../../fixtures/days/2026-09-27.json", import.meta.url),
    "utf8",
  );
  await mkdir(join(dataRoot, "gold/site/days"), { recursive: true });
  await writeFile(
    join(dataRoot, "gold/site/index.json"),
    JSON.stringify({
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
    }),
  );
  await writeFile(join(dataRoot, "gold/site/days/2026-09-27.json"), fixture);
  process.env.DATA_ROOT = dataRoot;
  expect(loadSiteDay("2026-09-27").trading_date).toBe("2026-09-27");
});

test("recentEpisodes walks newest days first and stops at the limit", () => {
  const older = {
    episode_id: "old",
    seed_observation_id: "s1",
    start_utc: "2026-09-25T12:00:00Z",
    end_utc: "2026-09-25T13:00:00Z",
    start_trading_period: 1,
    end_trading_period: 2,
    member_count: 1,
    observation_types: ["price_high"],
    islands: ["NI" as const],
    severity: 9,
  };
  const newer = {
    ...older,
    episode_id: "new",
    seed_observation_id: "s2",
    severity: 1,
  };
  const found = recentEpisodes(
    {
      contract_version: 1,
      days: [
        {
          date: "2026-09-25",
          path: "days/2026-09-25.json",
          complete: true,
          sections: { generation: "complete", prices: "complete" },
          export_sha256: "a",
        },
        {
          date: "2026-09-26",
          path: "days/2026-09-26.json",
          complete: true,
          sections: { generation: "complete", prices: "complete" },
          export_sha256: "a",
        },
      ],
      latest_complete: { generation_md: "2026-09-26" },
      latest_complete_sections: { generation: "2026-09-26", prices: null },
    },
    (date) =>
      ({
        contract_version: 1,
        trading_date: date,
        periods: [],
        complete: true,
        datasets: {},
        generation: { state: "complete" },
        prices: { state: "complete" },
        episodes: {
          state: "complete",
          items: date === "2026-09-26" ? [newer] : [older],
        },
      }) as never,
    1,
  );
  expect(found).toEqual([{ date: "2026-09-26", episode: newer }]);
});

test("loadSiteIndex does not load gold from a cwd-relative data path", async () => {
  await mkdir(join(dataRoot, "data/gold/site"), { recursive: true });
  await writeFile(
    join(dataRoot, "data/gold/site/index.json"),
    JSON.stringify(validIndex),
  );
  const nested = join(dataRoot, "nested");
  await mkdir(nested);
  const previousCwd = process.cwd();
  process.chdir(nested);
  try {
    expect(loadSiteIndex()).not.toEqual(validIndex);
  } finally {
    process.chdir(previousCwd);
  }
});

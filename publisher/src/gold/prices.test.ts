import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { PublisherDataset } from "../datasets.ts";
import { runPublish } from "../runner.ts";
import { lit } from "../silver/common.ts";
import { completenessKey, saveCompleteness } from "../silver/completeness.ts";
import {
  DATASET,
  publishDispatchEnergyPrices,
} from "../silver/dispatch-energy-prices.ts";
import { fingerprint, goldPartitionPath } from "./common.ts";
import { completenessView } from "./fixtures/completeness.ts";
import {
  ANALYSIS_VERSION,
  prices,
  publishGoldPrices,
  TABLES,
} from "./prices.ts";

const DATE = "2026-11-18";
// Trading period 1 of 2026-11-18 starts at 00:00 NZDT, which is 11:00 UTC the day before.
const DAY_START = Date.parse("2026-11-17T11:00:00Z");
const fixtures = join(
  import.meta.dirname,
  "fixtures",
  "dispatch-energy-prices",
);

let root: string;
let silverDir: string;
let goldDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-gold-"));
  silverDir = join(root, "silver");
  goldDir = join(root, "gold");
});
afterEach(() => rm(root, { recursive: true, force: true }));

interface SilverRow {
  poc: string;
  /** 1-based trading period, as silver holds it. */
  period: number;
  /** Seconds after the period start that the price was published. */
  at: number;
  price: number;
  proxy?: boolean;
}

/** Write a silver dispatch energy prices partition with only the columns gold reads. */
async function writeSilver(
  rows: SilverRow[],
  sha = "sha-a",
  date = DATE,
  dayStart = DAY_START,
) {
  const values = rows
    .map((r) => {
      const start = dayStart + (r.period - 1) * 30 * 60_000;
      const iso = (ms: number) => lit(new Date(ms).toISOString());
      return `(${r.period}, ${iso(start)}::TIMESTAMPTZ, ${iso(start + 1_800_000)}::TIMESTAMPTZ,
        ${iso(start + r.at * 1000)}::TIMESTAMPTZ, ${lit(r.poc)}, ${r.proxy ?? false}, ${r.price}::DOUBLE, ${lit(sha)})`;
    })
    .join(",");
  const path = join(silverDir, DATASET, `trading_date=${date}`, "data.parquet");
  await mkdir(join(path, ".."), { recursive: true });
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run(
      `COPY (SELECT * FROM (VALUES ${values}) t(trading_period, event_start_utc, event_end_utc,
         source_published_at, point_of_connection, is_proxy_price, dollars_per_megawatt_hour, bronze_sha256))
       TO ${lit(path)} (FORMAT parquet)`,
    );
  } finally {
    connection.closeSync();
  }
}

async function readGold(table: string, date = DATE) {
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    return (
      await connection.runAndReadAll(
        `SELECT * FROM read_parquet(${lit(join(goldDir, table, `trading_date=${date}`, "data.parquet"))})`,
      )
    ).getRowObjectsJson() as Array<Record<string, unknown>>;
  } finally {
    connection.closeSync();
  }
}

/** Rows of one POC and period: `[at, price]` pairs. */
const rowsOf = (
  poc: string,
  period: number,
  ...pairs: Array<[at: number, price: number]>
): SilverRow[] => pairs.map(([at, price]) => ({ poc, period, at, price }));

/**
 * Hand-calculated day under rule B. A period is 1800 s. Only periods 1 and 2 have rows.
 * OTA P1: 10 from 0 s, 20 from 600 s, 60 from 1200 s: (10 + 20 + 60) / 3 = 30.
 * OTA P2: one row at 300 s. It applies from the period start: 100.
 * HAY P1: 5. HAY P2: 10 from 0 s, 30 from 900 s: 20.
 * BEN P1: 3 published at 60 s (applies from 0), 9 from 1500 s: (3 * 1500 + 9 * 300) / 1800 = 4.
 * BEN P2: 20.
 * Two other POCs in P1 only: Z1 at 0 and Z2 at 100.
 */
const synthetic: SilverRow[] = [
  ...rowsOf("OTA2201", 1, [0, 10], [600, 20], [1200, 60]),
  ...rowsOf("OTA2201", 2, [300, 100]),
  ...rowsOf("HAY2201", 1, [0, 5]),
  ...rowsOf("HAY2201", 2, [0, 10], [900, 30]),
  ...rowsOf("BEN2201", 1, [60, 3], [1500, 9]),
  ...rowsOf("BEN2201", 2, [0, 20]),
  ...rowsOf("Z1", 1, [0, 0]),
  ...rowsOf("Z2", 1, [0, 100]),
];

test("price per reference node per period: each price applies until the next publish", async () => {
  await writeSilver(synthetic);
  const result = await publishGoldPrices({
    silverDir,
    goldDir,
    completeness: completenessView(),
    date: DATE,
  });
  expect(result.status).toBe("partial");
  if (result.status !== "partial") throw new Error("expected partial");
  expect(result.missingPeriods).toEqual(
    Array.from({ length: 46 }, (_, i) => i + 3),
  );
  expect(result.rows).toBe(3 * 48);

  const rows = await readGold("price_periods");
  expect(rows).toHaveLength(3 * 48);
  const at = (poc: string, period: number) =>
    rows.find(
      (r) => r.point_of_connection === poc && r.trading_period === period,
    );
  expect(at("OTA2201", 1)).toMatchObject({
    price: 30,
    min_price: 10,
    max_price: 60,
    rows_present: 3,
    inputs_complete: true,
    price_region: "upper_north_island",
    analysis_version: ANALYSIS_VERSION,
  });
  expect(at("OTA2201", 2)).toMatchObject({ price: 100, rows_present: 1 });
  expect(at("HAY2201", 2)?.price).toBe(20);
  expect(at("BEN2201", 1)?.price).toBe(4);
  expect(at("HAY2201", 3)).toMatchObject({
    price: null,
    rows_present: 0,
    inputs_complete: false,
  });
  expect(Date.parse(String(at("OTA2201", 1)?.event_start_utc))).toBe(DAY_START);
});

test("daily summary: mean of periods, min and max of published prices", async () => {
  await writeSilver(synthetic);
  await publishGoldPrices({
    silverDir,
    goldDir,
    completeness: completenessView(),
    date: DATE,
  });
  const rows = await readGold("price_daily_summary");
  const ota = rows.find((r) => r.point_of_connection === "OTA2201");
  // Period prices 30 and 100, each covered for 1800 s.
  expect(ota?.mean_price).toBe(65);
  expect(ota).not.toHaveProperty("time_weighted_mean_price");
  expect(ota).toMatchObject({
    min_price: 10,
    max_price: 100,
    periods_present: 2,
    periods_expected: 48,
    rows_present: 4,
    inputs_complete: false,
  });
  const ben = rows.find((r) => r.point_of_connection === "BEN2201");
  expect(ben?.mean_price).toBe(12); // (4 + 20) / 2
  expect(ben?.min_price).toBe(3);
  expect(ben?.max_price).toBe(20);
});

test("publish times are clamped into the period", async () => {
  await writeSilver([
    // Two rows before the period start: the first has no length, the second applies all period.
    ...rowsOf("OTA2201", 1, [-30, 10], [-20, 20]),
    // One row before the start, then one in the period (the shape of a 06:29:40 publish).
    ...rowsOf("HAY2201", 1, [-16, 10], [900, 30]),
    // A row after the period end has no weight but still counts.
    ...rowsOf("BEN2201", 1, [0, 4], [1900, 99]),
  ]);
  await publishGoldPrices({
    silverDir,
    goldDir,
    completeness: completenessView(),
    date: DATE,
  });
  const rows = await readGold("price_periods");
  const at = (poc: string) =>
    rows.find((r) => r.point_of_connection === poc && r.trading_period === 1);
  expect(at("OTA2201")?.price).toBe(20);
  expect(at("HAY2201")?.price).toBe(20); // (10 * 900 + 30 * 900) / 1800
  expect(at("BEN2201")).toMatchObject({
    price: 4,
    rows_present: 2,
    max_price: 99,
  });
});

test("spreads are from minus to, by period, flagged when either side has no row", async () => {
  await writeSilver(synthetic);
  await publishGoldPrices({
    silverDir,
    goldDir,
    completeness: completenessView(),
    date: DATE,
  });
  const rows = await readGold("price_spreads");
  expect(rows).toHaveLength(3 * 48);
  const at = (from: string, to: string, period: number) =>
    rows.find(
      (r) =>
        r.from_point_of_connection === from &&
        r.to_point_of_connection === to &&
        r.trading_period === period,
    );
  expect(at("OTA2201", "HAY2201", 1)).toMatchObject({
    spread: 25,
    from_price_region: "upper_north_island",
    to_price_region: "lower_north_island",
    inputs_complete: true,
  });
  expect(at("HAY2201", "BEN2201", 1)).toMatchObject({
    spread: 1,
    inputs_complete: true,
  });
  expect(at("OTA2201", "BEN2201", 1)).toMatchObject({
    spread: 26,
    inputs_complete: true,
  });
  expect(at("OTA2201", "HAY2201", 2)?.spread).toBe(80);
  expect(at("HAY2201", "BEN2201", 2)?.spread).toBe(0);
  expect(at("OTA2201", "BEN2201", 2)?.spread).toBe(80);
  expect(at("OTA2201", "HAY2201", 3)).toMatchObject({
    spread: null,
    inputs_complete: false,
  });
});

test("national distribution of period prices over the POCs that have a row", async () => {
  await writeSilver(synthetic);
  await publishGoldPrices({
    silverDir,
    goldDir,
    completeness: completenessView(),
    date: DATE,
  });
  const rows = await readGold("price_distribution");
  expect(rows).toHaveLength(48);
  // P1 prices: 0, 4, 5, 30, 100.
  expect(rows[0]).toMatchObject({
    trading_period: 1,
    poc_count: 5,
    min_price: 0,
    median_price: 5,
    max_price: 100,
    inputs_complete: true,
  });
  expect(rows[0]?.p05_price).toBeCloseTo(0.8, 9);
  expect(rows[0]?.p25_price).toBeCloseTo(4, 9);
  expect(rows[0]?.p75_price).toBeCloseTo(30, 9);
  expect(rows[0]?.p95_price).toBeCloseTo(86, 9);
  expect(rows[1]).toMatchObject({ poc_count: 3, median_price: 20 });
  expect(rows[2]).toMatchObject({
    poc_count: 0,
    min_price: null,
    inputs_complete: false,
  });
});

test("inputs_sha256 follows the bronze version and the analysis version", async () => {
  const shaOf = async () => {
    const [row] = await readGold("price_periods");
    return row?.inputs_sha256;
  };
  await writeSilver(synthetic, "sha-a");
  expect(
    await publishGoldPrices({
      silverDir,
      goldDir,
      completeness: completenessView(),
      date: DATE,
    }),
  ).toMatchObject({ status: "partial" });
  const first = await shaOf();
  expect(
    await publishGoldPrices({
      silverDir,
      goldDir,
      completeness: completenessView(),
      date: DATE,
    }),
  ).toMatchObject({ status: "partial" });
  expect(await shaOf()).toBe(first);
  await writeSilver(synthetic, "sha-b");
  expect(
    await publishGoldPrices({
      silverDir,
      goldDir,
      completeness: completenessView(),
      date: DATE,
    }),
  ).toMatchObject({ status: "partial" });
  const expected = fingerprint(ANALYSIS_VERSION, [
    ["dispatch_energy_prices", "sha-b complete"],
  ]);
  expect(await shaOf()).toBe(expected);
  expect(expected).not.toBe(first);
  expect(
    (await prices.wantedVersions?.(silverDir, completenessView()))?.get(DATE),
  ).toBe(expected);
  for (const table of TABLES)
    for (const row of await readGold(table))
      expect(row.inputs_sha256).toBe(expected);
}, 20_000);

test("two runs on the same input write identical bytes", async () => {
  await writeSilver(synthetic);
  const bytes = async () =>
    Promise.all(
      TABLES.map((t) =>
        readFile(join(goldDir, t, `trading_date=${DATE}`, "data.parquet")),
      ),
    );
  await publishGoldPrices({
    silverDir,
    goldDir,
    completeness: completenessView(),
    date: DATE,
  });
  const first = await bytes();
  await publishGoldPrices({
    silverDir,
    goldDir,
    completeness: completenessView(),
    date: DATE,
  });
  expect(await bytes()).toEqual(first);
});

test("a DST-start day has 46 periods in every table, and a proxy price is flagged", async () => {
  const date = "2026-09-27";
  // Period 1 starts at 00:00 NZST (UTC+12), 2026-09-26T12:00Z.
  const dayStart = Date.parse("2026-09-26T12:00:00Z");
  const rows: SilverRow[] = [
    ...rowsOf("OTA2201", 1, [0, 10]),
    ...rowsOf("HAY2201", 1, [0, 4]),
    ...rowsOf("BEN2201", 1, [0, 1]),
    // The last period of a 46-period day, with a proxy price at BEN2201.
    ...rowsOf("OTA2201", 46, [0, 7]),
    ...rowsOf("HAY2201", 46, [0, 5]),
    { poc: "BEN2201", period: 46, at: 0, price: 3, proxy: true },
  ];
  await writeSilver(rows, "sha-a", date, dayStart);
  const result = await publishGoldPrices({
    silverDir,
    goldDir,
    completeness: completenessView(),
    date,
  });
  expect(result.status).toBe("partial");
  if (result.status !== "partial") throw new Error("expected partial");
  expect(result.rows).toBe(3 * 46);
  expect(result.path).toBe(goldPartitionPath(goldDir, TABLES[0], date));
  const periods = await readGold("price_periods", date);
  expect(periods).toHaveLength(3 * 46);
  expect(Math.max(...periods.map((r) => Number(r.trading_period)))).toBe(46);
  const at = (poc: string, period: number) =>
    periods.find(
      (r) => r.point_of_connection === poc && r.trading_period === period,
    );
  expect(at("BEN2201", 46)).toMatchObject({
    price: 3,
    has_proxy_price: true,
    rows_present: 1,
    inputs_complete: true,
  });
  expect(at("HAY2201", 46)).toMatchObject({
    has_proxy_price: false,
    inputs_complete: true,
  });
  expect(
    (await readGold("price_distribution", date)).map((r) => r.trading_period),
  ).toEqual(Array.from({ length: 46 }, (_, i) => i + 1));
  const summary = await readGold("price_daily_summary", date);
  expect(summary[0]).toMatchObject({
    periods_expected: 46,
    periods_present: 2,
  });
});

test("a date with no silver is missing and writes nothing", async () => {
  expect(
    await publishGoldPrices({
      silverDir,
      goldDir,
      completeness: completenessView(),
      date: DATE,
    }),
  ).toEqual({
    date: DATE,
    status: "missing",
  });
  expect(existsSync(goldDir)).toBe(false);
});

test("real data: HAY2201 period prices match hand sums (periods 1 and 45), and spreads equal from minus to", async () => {
  const csv = await readFile(
    join(fixtures, "20261118_DispatchEnergyPrices.csv"),
    "utf8",
  );
  const sha256 = createHash("sha256").update(csv).digest("hex");
  const bronzeDir = join(root, "bronze");
  const path = `${DATASET}/${sha256}/20261118_DispatchEnergyPrices.csv`;
  await mkdir(join(bronzeDir, DATASET, sha256), { recursive: true });
  await writeFile(join(bronzeDir, path), csv);
  await appendFile(
    join(bronzeDir, "manifest.jsonl"),
    `${JSON.stringify({ dataset: DATASET, status: "new", checked_at: "2026-11-20T00:00:00.000Z", retrieved_at: "2026-11-20T00:00:01.000Z", sha256, path, trading_dates: [DATE] })}\n`,
  );
  await publishDispatchEnergyPrices({ bronzeDir, silverDir, date: DATE });

  const result = await publishGoldPrices({
    silverDir,
    goldDir,
    completeness: completenessView(),
    date: DATE,
  });
  // The extract has rows in every period, so the day is complete.
  expect(result).toMatchObject({ status: "complete", rows: 3 * 48 });

  const periods = await readGold("price_periods");
  const hay = (period: number) =>
    periods.find(
      (r) => r.point_of_connection === "HAY2201" && r.trading_period === period,
    );
  // Hand sums. Each price applies until the next publish; the first applies from the period
  // start. Period 1 rows (seconds after 00:00 NZDT): 13 28.83, 280 28.69, 590 27.91, 1213 5.40,
  // 1486 5.39. Weights: 280, 310, 623, 273, 314 s.
  expect(hay(1)?.price).toBeCloseTo(
    (280 * 28.83 + 310 * 28.69 + 623 * 27.91 + 273 * 5.4 + 314 * 5.39) / 1800,
    9,
  );
  expect(hay(1)).toMatchObject({ rows_present: 5, inputs_complete: true });
  // Period 45 (22:00 to 22:30). Publishes at 49, 483, 591, 952, 1187 and 1480 s:
  // 71.04, 71.24, 51.69, 40.52, 36.63, 32.59. Weights: 483, 108, 361, 235, 293, 320 s.
  // Sum of weight * price = 91349.92.
  expect(hay(45)?.price).toBeCloseTo(91349.92 / 1800, 9);
  expect(hay(45)).toMatchObject({
    rows_present: 6,
    min_price: 32.59,
    max_price: 71.24,
  });

  const byKey = new Map(
    periods.map((r) => [
      `${r.point_of_connection}/${r.trading_period}`,
      r.price,
    ]),
  );
  const spreads = await readGold("price_spreads");
  for (const s of spreads.filter((r) => r.spread !== null)) {
    const from = byKey.get(`${s.from_point_of_connection}/${s.trading_period}`);
    const to = byKey.get(`${s.to_point_of_connection}/${s.trading_period}`);
    expect(s.spread).toBeCloseTo(Number(from) - Number(to), 9);
  }

  // The distribution covers the 4 POCs of the extract.
  const dist = await readGold("price_distribution");
  expect(dist[0]?.poc_count).toBe(4);
});

test("the runner builds gold_prices, skips it when silver is unchanged and rebuilds it when the dispatch fingerprint changes", async () => {
  const other = "2026-09-27";
  await writeSilver(synthetic);
  await writeSilver(
    synthetic,
    "sha-a",
    other,
    Date.parse("2026-09-26T12:00:00Z"),
  );
  const run = () =>
    runPublish({
      bronzeDir: join(root, "bronze"),
      silverDir,
      goldDir,
      only: ["gold_prices"],
    }).then((s) => s[0]);
  expect(await run()).toMatchObject({ published: 2, upToDate: 0, failed: [] });
  expect(await run()).toMatchObject({ published: 0, upToDate: 2 });
  const file = join(silverDir, DATASET, `trading_date=${DATE}`, "data.parquet");
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run(
      `COPY (SELECT * REPLACE ('new-sha' AS bronze_sha256) FROM read_parquet(${lit(file)}))
       TO ${lit(`${file}.new`)} (FORMAT parquet)`,
    );
  } finally {
    connection.closeSync();
  }
  await rename(`${file}.new`, file);
  expect(await run()).toMatchObject({ published: 1, upToDate: 1 });
}, 20_000);

/** A silver stand-in that writes nothing: the old partition stays, as for an invalid file. */
const silverStub = (
  status: () => "complete" | "invalid",
): PublisherDataset => ({
  id: DATASET,
  partitionKey: "trading_date",
  countsTradingPeriods: true,
  wantedVersions: async () => new Map([[DATE, "sha-new"]]),
  publish: async ({ date }) =>
    status() === "complete"
      ? { date, status: "complete", rows: 1, path: "p" }
      : { date, status: "invalid", errors: ["bad file"] },
});

test("an invalid input day gives incomplete rows in the same run, and a status change alone rebuilds gold", async () => {
  await writeSilver(
    ["OTA2201", "HAY2201", "BEN2201"].flatMap((poc) =>
      Array.from({ length: 48 }, (_, i) => ({
        poc,
        period: i + 1,
        at: 0,
        price: 10,
      })),
    ),
  );
  let status: "complete" | "invalid" = "complete";
  const run = () =>
    runPublish({
      bronzeDir: join(root, "bronze"),
      silverDir,
      goldDir,
      registry: [silverStub(() => status), prices],
    });
  const flags = async () => [
    ...new Set(
      (await readGold("price_daily_summary")).map((r) => r.inputs_complete),
    ),
  ];

  const first = (await run()).find((s) => s.id === "gold_prices");
  expect(first).toMatchObject({ published: 1, partial: [] });
  expect(await flags()).toEqual([true]);
  const shaComplete = (await readGold("price_periods"))[0]?.inputs_sha256;

  // Silver keeps its old partition, so only the `_completeness` status changes.
  status = "invalid";
  const second = (await run()).find((s) => s.id === "gold_prices");
  expect(second).toMatchObject({ published: 1 });
  expect(second?.partial).toHaveLength(1);
  expect(await flags()).toEqual([false]);
  for (const table of TABLES)
    for (const r of await readGold(table))
      expect(r.inputs_complete).toBe(false);
  expect((await readGold("price_periods"))[0]?.inputs_sha256).not.toBe(
    shaComplete,
  );

  // The same status again: gold is up to date.
  expect((await run()).find((s) => s.id === "gold_prices")).toMatchObject({
    published: 0,
    upToDate: 1,
  });
}, 30_000);

test("a date with no completeness row is not complete", async () => {
  await writeSilver(
    ["OTA2201", "HAY2201", "BEN2201"].flatMap((poc) =>
      Array.from({ length: 48 }, (_, i) => ({
        poc,
        period: i + 1,
        at: 0,
        price: 10,
      })),
    ),
  );
  const result = await publishGoldPrices({
    silverDir,
    goldDir,
    completeness: new Map(),
    date: DATE,
  });
  expect(result).toMatchObject({ status: "partial", missingPeriods: [] });
});

test("a gold-only run reads the held completeness from disk", async () => {
  await writeSilver(
    ["OTA2201", "HAY2201", "BEN2201"].flatMap((poc) =>
      Array.from({ length: 48 }, (_, i) => ({
        poc,
        period: i + 1,
        at: 0,
        price: 10,
      })),
    ),
  );
  const held = completenessView().get(completenessKey(DATASET, DATE));
  if (!held) throw new Error("no row");
  await saveCompleteness(
    silverDir,
    new Map([[completenessKey(DATASET, DATE), held]]),
  );
  await runPublish({
    bronzeDir: join(root, "bronze"),
    silverDir,
    goldDir,
    only: ["gold_prices"],
  });
  expect(
    (await readGold("price_daily_summary")).map((r) => r.inputs_complete),
  ).toEqual([true, true, true]);
});

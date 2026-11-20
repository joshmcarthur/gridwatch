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
import { runPublish } from "../runner.ts";
import { lit } from "../silver/common.ts";
import {
  DATASET,
  publishDispatchEnergyPrices,
} from "../silver/dispatch-energy-prices.ts";
import { fingerprint, goldPartitionPath } from "./common.ts";
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
  /** 0-based index of the 5-minute interval of the day. */
  interval: number;
  price: number;
  /** Seconds after the interval start. Default 10. */
  publishOffset?: number;
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
      const period = Math.floor(r.interval / 6) + 1;
      const start = dayStart + (period - 1) * 30 * 60_000;
      const publish =
        dayStart + r.interval * 300_000 + (r.publishOffset ?? 10) * 1000;
      const iso = (ms: number) => lit(new Date(ms).toISOString());
      return `(${period}, ${iso(start)}::TIMESTAMPTZ, ${iso(start + 1_800_000)}::TIMESTAMPTZ,
        ${iso(publish)}::TIMESTAMPTZ, ${lit(r.poc)}, ${r.proxy ?? false}, ${r.price}::DOUBLE, ${lit(sha)})`;
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

const each = (poc: string, prices: number[], from = 0): SilverRow[] =>
  prices.map((price, i) => ({ poc, interval: from + i, price }));

/**
 * Hand-calculated day. Period 1 (intervals 0-5) and period 2 (intervals 6-11) only.
 * OTA P1: 10..60 step 10, mean 35. OTA P2: 3 intervals of 100.
 * HAY: 5 all of P1, 10 all of P2.
 * BEN P1: 1,2,3,4,5,6 but interval 2 has a re-run (publish +130 s) at 9, so 1,2,9,4,5,6 = 27/6 = 4.5.
 * BEN P2: 20.
 * Two other POCs in P1 only: Z1 at 0 and Z2 at 100.
 */
const synthetic: SilverRow[] = [
  ...each("OTA2201", [10, 20, 30, 40, 50, 60]),
  ...each("OTA2201", [100, 100, 100], 6),
  ...each("HAY2201", [5, 5, 5, 5, 5, 5]),
  ...each("HAY2201", [10, 10, 10, 10, 10, 10], 6),
  ...each("BEN2201", [1, 2, 3, 4, 5, 6]),
  { poc: "BEN2201", interval: 2, price: 9, publishOffset: 130 },
  ...each("BEN2201", [20, 20, 20, 20, 20, 20], 6),
  ...each("Z1", [0, 0, 0, 0, 0, 0]),
  ...each("Z2", [100, 100, 100, 100, 100, 100]),
];

test("price per reference node per period keeps the latest case and flags gaps", async () => {
  await writeSilver(synthetic);
  const result = await publishGoldPrices({ silverDir, goldDir, date: DATE });
  expect(result.status).toBe("partial");
  if (result.status !== "partial") throw new Error("expected partial");
  expect(result.missingPeriods).toContain(2);
  expect(result.rows).toBe(3 * 48);

  const rows = await readGold("price_periods");
  expect(rows).toHaveLength(3 * 48);
  const at = (poc: string, period: number) =>
    rows.find(
      (r) => r.point_of_connection === poc && r.trading_period === period,
    );
  expect(at("OTA2201", 1)).toMatchObject({
    price: 35,
    min_interval_price: 10,
    max_interval_price: 60,
    intervals_present: 6,
    inputs_complete: true,
    price_region: "upper_north_island",
    analysis_version: ANALYSIS_VERSION,
  });
  expect(at("BEN2201", 1)?.price).toBe(4.5);
  expect(at("BEN2201", 1)?.intervals_present).toBe(6);
  expect(at("OTA2201", 2)).toMatchObject({
    price: 100,
    intervals_present: 3,
    inputs_complete: false,
  });
  expect(at("HAY2201", 3)).toMatchObject({
    price: null,
    intervals_present: 0,
    inputs_complete: false,
  });
  expect(Date.parse(String(at("OTA2201", 1)?.event_start_utc))).toBe(DAY_START);
});

test("daily summary: mean of periods, time-weighted mean of intervals, min, max", async () => {
  await writeSilver(synthetic);
  await publishGoldPrices({ silverDir, goldDir, date: DATE });
  const rows = await readGold("price_daily_summary");
  const ota = rows.find((r) => r.point_of_connection === "OTA2201");
  // mean of period prices (35 + 100) / 2. Intervals (35*6 + 100*3) / 9.
  expect(ota?.mean_price).toBe(67.5);
  expect(ota?.time_weighted_mean_price).toBeCloseTo(510 / 9, 9);
  expect(ota).toMatchObject({
    min_price: 10,
    max_price: 100,
    periods_present: 2,
    periods_expected: 48,
    intervals_present: 9,
    intervals_expected: 288,
    inputs_complete: false,
  });
  const ben = rows.find((r) => r.point_of_connection === "BEN2201");
  expect(ben?.mean_price).toBe(12.25); // (4.5 + 20) / 2
  expect(ben?.min_price).toBe(1);
  expect(ben?.max_price).toBe(20);
});

test("spreads are from minus to, by period, flagged when either side is incomplete", async () => {
  await writeSilver(synthetic);
  await publishGoldPrices({ silverDir, goldDir, date: DATE });
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
    spread: 30,
    inputs_complete: true,
  });
  expect(at("HAY2201", "BEN2201", 1)).toMatchObject({
    spread: 0.5,
    inputs_complete: true,
  });
  expect(at("OTA2201", "BEN2201", 1)).toMatchObject({
    spread: 30.5,
    inputs_complete: true,
  });
  expect(at("OTA2201", "HAY2201", 2)).toMatchObject({
    spread: 90,
    inputs_complete: false,
  });
  expect(at("HAY2201", "BEN2201", 2)).toMatchObject({
    spread: -10,
    inputs_complete: true,
  });
  expect(at("OTA2201", "BEN2201", 2)).toMatchObject({
    spread: 80,
    inputs_complete: false,
  });
  expect(at("OTA2201", "HAY2201", 3)).toMatchObject({
    spread: null,
    inputs_complete: false,
  });
});

test("national distribution of period prices across all nodes", async () => {
  await writeSilver(synthetic);
  await publishGoldPrices({ silverDir, goldDir, date: DATE });
  const rows = await readGold("price_distribution");
  expect(rows).toHaveLength(48);
  // P1 prices: 0, 4.5, 5, 35, 100.
  expect(rows[0]).toMatchObject({
    trading_period: 1,
    poc_count: 5,
    min_price: 0,
    median_price: 5,
    max_price: 100,
    inputs_complete: true,
  });
  expect(rows[0]?.p05_price).toBeCloseTo(0.9, 9);
  expect(rows[0]?.p25_price).toBeCloseTo(4.5, 9);
  expect(rows[0]?.p75_price).toBeCloseTo(35, 9);
  expect(rows[0]?.p95_price).toBeCloseTo(87, 9);
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
    await publishGoldPrices({ silverDir, goldDir, date: DATE }),
  ).toMatchObject({ status: "partial" });
  const first = await shaOf();
  expect(
    await publishGoldPrices({ silverDir, goldDir, date: DATE }),
  ).toMatchObject({ status: "partial" });
  expect(await shaOf()).toBe(first);
  await writeSilver(synthetic, "sha-b");
  expect(
    await publishGoldPrices({ silverDir, goldDir, date: DATE }),
  ).toMatchObject({ status: "partial" });
  const expected = fingerprint(ANALYSIS_VERSION, [
    ["dispatch_energy_prices", "sha-b"],
  ]);
  expect(await shaOf()).toBe(expected);
  expect(expected).not.toBe(first);
  expect((await prices.wantedVersions?.(silverDir))?.get(DATE)).toBe(expected);
  for (const table of TABLES)
    for (const row of await readGold(table))
      expect(row.inputs_sha256).toBe(expected);
});

test("two runs on the same input write identical bytes", async () => {
  await writeSilver(synthetic);
  const bytes = async () =>
    Promise.all(
      TABLES.map((t) =>
        readFile(join(goldDir, t, `trading_date=${DATE}`, "data.parquet")),
      ),
    );
  await publishGoldPrices({ silverDir, goldDir, date: DATE });
  const first = await bytes();
  await publishGoldPrices({ silverDir, goldDir, date: DATE });
  expect(await bytes()).toEqual(first);
});

test("a DST-start day has 46 periods in every table, and a proxy price is flagged", async () => {
  const date = "2026-09-27";
  // Period 1 starts at 00:00 NZST (UTC+12), 2026-09-26T12:00Z.
  const dayStart = Date.parse("2026-09-26T12:00:00Z");
  const rows: SilverRow[] = [
    ...each("OTA2201", [10, 10, 10, 10, 10, 10]),
    ...each("HAY2201", [4, 4, 4, 4, 4, 4]),
    ...each("BEN2201", [1, 1, 1, 1, 1, 1]),
    // The last period of a 46-period day, with one proxy price at HAY2201.
    ...each("OTA2201", [7, 7, 7, 7, 7, 7], 45 * 6),
    ...each("HAY2201", [5, 5, 5, 5, 5, 5], 45 * 6),
    { poc: "BEN2201", interval: 45 * 6, price: 3, proxy: true },
  ];
  await writeSilver(rows, "sha-a", date, dayStart);
  const result = await publishGoldPrices({ silverDir, goldDir, date });
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
    intervals_present: 1,
    inputs_complete: false,
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
    intervals_expected: 276,
  });
});

test("a date with no silver is missing and writes nothing", async () => {
  expect(await publishGoldPrices({ silverDir, goldDir, date: DATE })).toEqual({
    date: DATE,
    status: "missing",
  });
  expect(existsSync(goldDir)).toBe(false);
});

test("real data: HAY2201 period prices match hand sums, and spreads equal from minus to", async () => {
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

  const result = await publishGoldPrices({ silverDir, goldDir, date: DATE });
  expect(result.status).toBe("partial");
  if (result.status !== "partial") throw new Error("expected partial");

  const periods = await readGold("price_periods");
  const hay = (period: number) =>
    periods.find(
      (r) => r.point_of_connection === "HAY2201" && r.trading_period === period,
    );
  // Hand sum of the file: period 1 has 5 intervals (00:00, 00:05, 00:10, 00:20, 00:25).
  expect(hay(1)?.price).toBeCloseTo(
    (28.83 + 28.69 + 27.91 + 5.4 + 5.39) / 5,
    9,
  );
  expect(hay(1)).toMatchObject({
    intervals_present: 5,
    inputs_complete: false,
  });
  expect(hay(2)?.price).toBeCloseTo(
    (16.9 + 15.86 + 5.67 + 16.92 + 4.4 + 16.58) / 6,
    9,
  );
  expect(hay(2)?.inputs_complete).toBe(true);

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

  // The distribution covers the 4 POCs of the extract and agrees with the node rows.
  const dist = await readGold("price_distribution");
  expect(dist[0]?.poc_count).toBe(4);
  expect(dist[1]?.max_price).toBeGreaterThanOrEqual(Number(hay(2)?.price));
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
});

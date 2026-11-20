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
  publishDispatchReservePrices,
} from "../silver/dispatch-reserve-prices.ts";
import { fingerprint, goldPartitionPath } from "./common.ts";
import { completenessView } from "./fixtures/completeness.ts";
import {
  ANALYSIS_VERSION,
  publishReserves,
  reserves,
  TABLES,
} from "./reserves.ts";

const DATE = "2026-11-18";
// Trading period 1 of 2026-11-18 starts at 00:00 NZDT, 11:00 UTC the day before.
const DAY_START = Date.parse("2026-11-17T11:00:00Z");
const FIXTURES = join(
  import.meta.dirname,
  "..",
  "silver",
  "fixtures",
  "dispatch-reserve-prices",
);

let root: string;
let bronzeDir: string;
let silverDir: string;
let goldDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-gold-reserves-"));
  bronzeDir = join(root, "bronze");
  silverDir = join(root, "silver");
  goldDir = join(root, "gold");
});
afterEach(() => rm(root, { recursive: true, force: true }));

interface SilverRow {
  reserveClass: "FIR" | "SIR";
  island: "NI" | "SI" | null;
  poc: string;
  /** Publish time, in seconds after the start of the day. Can be before 0. */
  at: number;
  price: number;
  /** The trading period the source gave the row. Default: the period that holds `at`. */
  period?: number;
}

/** Write a silver dispatch reserve prices partition with the columns gold reads. */
async function writeSilver(rows: SilverRow[], sha = "sha-a", date = DATE) {
  const values = rows
    .map((r) => {
      const period = r.period ?? Math.floor(r.at / 1800) + 1;
      const start = DAY_START + (period - 1) * 30 * 60_000;
      const iso = (ms: number) => lit(new Date(ms).toISOString());
      const island = r.island === null ? "NULL" : lit(r.island);
      return `(${period}, ${iso(start)}::TIMESTAMPTZ, ${iso(start + 1_800_000)}::TIMESTAMPTZ,
        ${iso(DAY_START + r.at * 1000)}::TIMESTAMPTZ, ${lit(r.poc)}, ${island}, ${lit(r.reserveClass)},
        ${r.price}::DOUBLE, ${lit(sha)})`;
    })
    .join(",");
  const path = join(silverDir, DATASET, `trading_date=${date}`, "data.parquet");
  await mkdir(join(path, ".."), { recursive: true });
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run(
      `COPY (SELECT * FROM (VALUES ${values}) t(trading_period, event_start_utc, event_end_utc,
         source_published_at, point_of_connection, island, reserve_class,
         dollars_per_megawatt_hour, bronze_sha256))
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

const row = (
  reserveClass: SilverRow["reserveClass"],
  island: SilverRow["island"],
  poc: string,
  at: number,
  price: number,
  period?: number,
): SilverRow => ({ reserveClass, island, poc, at, price, period });

const HAY = "HAY2201";
const BEN = "BEN2201";

/**
 * Hand-calculated day under rule B. Period 1 is 0 to 1800 s, period 2 is 1800 to 3600 s.
 *
 * FIR NI P1: 10 at 5 s (applies from 0 to 900: 900 s), 20 at 900 s (450 s), 40 at 1350 s (450 s).
 *   (10*900 + 20*450 + 40*450) / 1800 = 36000 / 1800 = 20.
 * FIR NI P2: 7 at 2000 s. The first row applies from the period start, so all 1800 s: 7.
 * FIR SI P1: 4 at 0 s (300 s). Two rows at 300 s sort by price: 2 (0 s), then 6 (1500 s).
 *   (4*300 + 2*0 + 6*1500) / 1800 = 10200 / 1800 = 5.666...
 * FIR SI P2: 20 at 3500 s, all 1800 s: 20.
 * SIR NI P1: 5. SIR SI P1: 8.
 */
const synthetic: SilverRow[] = [
  row("FIR", "NI", HAY, 5, 10),
  row("FIR", "NI", HAY, 900, 20),
  row("FIR", "NI", HAY, 1350, 40),
  row("FIR", "NI", HAY, 2000, 7),
  row("FIR", "SI", BEN, 0, 4),
  row("FIR", "SI", BEN, 300, 6),
  row("FIR", "SI", BEN, 300, 2),
  row("FIR", "SI", BEN, 3500, 20),
  row("SIR", "NI", HAY, 0, 5),
  row("SIR", "SI", BEN, 0, 8),
];

const at = (
  rows: Array<Record<string, unknown>>,
  reserveClass: string,
  island: string | null,
  period?: number,
) =>
  rows.find(
    (r) =>
      r.reserve_class === reserveClass &&
      r.island === island &&
      (period === undefined || r.trading_period === period),
  );

test("period price is the time-weighted mean, and ties sort by price", async () => {
  await writeSilver(synthetic);
  const result = await publishReserves({
    silverDir,
    goldDir,
    completeness: completenessView(),
    date: DATE,
  });
  expect(result.status).toBe("partial");
  if (result.status !== "partial") throw new Error("expected partial");
  expect(result.missingPeriods.slice(0, 3)).toEqual([2, 3, 4]); // SIR has no period 2

  const rows = await readGold("reserve_by_class_island_period");
  expect(rows).toHaveLength(4 * 48); // 4 class-island pairs on every period
  expect(at(rows, "SIR", "NI", 2)).toMatchObject({
    dollars_per_megawatt_hour: null,
    min_price: null,
    max_price: null,
    rows_present: 0,
    inputs_complete: false,
  });
  expect(at(rows, "FIR", "NI", 1)).toMatchObject({
    dollars_per_megawatt_hour: 20,
    min_price: 10,
    max_price: 40,
    rows_present: 3,
    inputs_complete: true,
    analysis_version: ANALYSIS_VERSION,
  });
  expect(at(rows, "FIR", "NI", 2)).toMatchObject({
    dollars_per_megawatt_hour: 7, // nothing carries over from period 1
    rows_present: 1,
  });
  expect(
    Number(at(rows, "FIR", "SI", 1)?.dollars_per_megawatt_hour),
  ).toBeCloseTo(10200 / 1800, 12);
  expect(at(rows, "FIR", "SI", 1)).toMatchObject({
    min_price: 2,
    max_price: 6,
    rows_present: 3,
  });
  expect(at(rows, "FIR", "SI", 2)?.dollars_per_megawatt_hour).toBe(20);
  expect(at(rows, "SIR", "NI", 1)?.dollars_per_megawatt_hour).toBe(5);
  expect(at(rows, "SIR", "SI", 1)?.dollars_per_megawatt_hour).toBe(8);
  expect(Date.parse(String(at(rows, "FIR", "NI", 1)?.event_start_utc))).toBe(
    DAY_START,
  );
});

test("daily summary: mean of period prices, min and max of published prices", async () => {
  await writeSilver(synthetic);
  await publishReserves({
    silverDir,
    goldDir,
    completeness: completenessView(),
    date: DATE,
  });
  const rows = await readGold("reserve_by_class_island_day");
  expect(rows[0]).not.toHaveProperty("time_weighted_mean_price");
  // (20*1800 + 7*1800) / 3600
  expect(at(rows, "FIR", "NI")).toMatchObject({
    mean_price: 13.5,
    min_price: 7,
    max_price: 40,
    periods_present: 2,
    periods_expected: 48,
    rows_present: 4,
    inputs_complete: false,
  });
  const firSi = at(rows, "FIR", "SI");
  // (10200/1800 + 20) / 2
  expect(Number(firSi?.mean_price)).toBeCloseTo((10200 / 1800 + 20) / 2, 12);
  expect(firSi).toMatchObject({ min_price: 2, max_price: 20, rows_present: 4 });
  expect(at(rows, "SIR", "NI")?.mean_price).toBe(5);
});

test("segment ends are clamped into the period", async () => {
  await writeSilver([
    // Two rows before the period start apply from the start. The first has zero length.
    // (100*0 + 50*900 + 10*900) / 1800 = 30. Zero-length rows still count in min, max and rows.
    row("FIR", "NI", HAY, -600, 100, 1),
    row("FIR", "NI", HAY, -300, 50, 1),
    row("FIR", "NI", HAY, 900, 10, 1),
    // A row after the period end gets zero length: 4 holds all 1800 s.
    row("FIR", "SI", BEN, 600, 4, 1),
    row("FIR", "SI", BEN, 2100, 999, 1),
  ]);
  await publishReserves({
    silverDir,
    goldDir,
    completeness: completenessView(),
    date: DATE,
  });
  const rows = await readGold("reserve_by_class_island_period");
  expect(at(rows, "FIR", "NI", 1)).toMatchObject({
    dollars_per_megawatt_hour: 30,
    min_price: 10,
    max_price: 100,
    rows_present: 3,
  });
  expect(at(rows, "FIR", "SI", 1)).toMatchObject({
    dollars_per_megawatt_hour: 4,
    min_price: 4,
    max_price: 999,
    rows_present: 2,
  });
});

test("two points of connection on one island and class make the date invalid", async () => {
  await writeSilver([
    row("FIR", "NI", HAY, 0, 1),
    row("FIR", "NI", "OTA2201", 20, 9),
    row("SIR", "NI", HAY, 0, 2),
  ]);
  const result = await publishReserves({
    silverDir,
    goldDir,
    completeness: completenessView(),
    date: DATE,
  });
  expect(result).toEqual({
    date: DATE,
    status: "invalid",
    errors: [
      "FIR on island NI has more than one point of connection: HAY2201, OTA2201",
    ],
  });
  for (const table of TABLES)
    expect(existsSync(goldPartitionPath(goldDir, table, DATE))).toBe(false);
});

test("one island missing a period gets a null-price row, a false day flag and a partial result", async () => {
  // NI has every period. SI has every period except 7.
  await writeSilver(
    Array.from({ length: 48 }, (_, i) => i).flatMap((i) => [
      row("FIR", "NI", HAY, i * 1800, 1),
      ...(i === 6 ? [] : [row("FIR", "SI", BEN, i * 1800, 2)]),
    ]),
  );
  const result = await publishReserves({
    silverDir,
    goldDir,
    completeness: completenessView(),
    date: DATE,
  });
  expect(result).toMatchObject({ status: "partial", missingPeriods: [7] });
  const periods = await readGold("reserve_by_class_island_period");
  expect(at(periods, "FIR", "SI", 7)).toMatchObject({
    dollars_per_megawatt_hour: null,
    rows_present: 0,
    inputs_complete: false,
  });
  expect(at(periods, "FIR", "NI", 7)).toMatchObject({
    dollars_per_megawatt_hour: 1,
    inputs_complete: true,
  });
  const days = await readGold("reserve_by_class_island_day");
  expect(at(days, "FIR", "SI")).toMatchObject({
    periods_present: 47,
    mean_price: 2,
    inputs_complete: false,
  });
  expect(at(days, "FIR", "NI")).toMatchObject({
    periods_present: 48,
    inputs_complete: true,
  });
});

test("a null island is kept and flagged, not dropped", async () => {
  await writeSilver([row("FIR", null, "ZZZ2201", 0, 3)]);
  const result = await publishReserves({
    silverDir,
    goldDir,
    completeness: completenessView(),
    date: DATE,
  });
  expect(result.status).toBe("partial");
  expect(
    at(await readGold("reserve_by_class_island_day"), "FIR", null),
  ).toMatchObject({
    mean_price: 3,
    min_price: 3,
    max_price: 3,
    inputs_complete: false,
  });
});

test("a date with no reserve silver is missing", async () => {
  expect(
    await publishReserves({
      silverDir,
      goldDir,
      completeness: completenessView(),
      date: DATE,
    }),
  ).toEqual({
    date: DATE,
    status: "missing",
  });
});

test("the same inputs and analysis version give identical bytes", async () => {
  await writeSilver(synthetic);
  const bytes = async () =>
    Promise.all(
      TABLES.map((t) =>
        readFile(goldPartitionPath(goldDir, t, DATE)).then((b) =>
          createHash("sha256").update(b).digest("hex"),
        ),
      ),
    );
  await publishReserves({
    silverDir,
    goldDir,
    completeness: completenessView(),
    date: DATE,
  });
  const first = await bytes();
  await publishReserves({
    silverDir,
    goldDir,
    completeness: completenessView(),
    date: DATE,
  });
  expect(await bytes()).toEqual(first);
});

test("rows carry the analysis version, the fingerprint and the completeness flag", async () => {
  await writeSilver(
    Array.from({ length: 48 }, (_, i) => row("FIR", "NI", HAY, i * 1800, 1)),
  );
  const result = await publishReserves({
    silverDir,
    goldDir,
    completeness: completenessView(),
    date: DATE,
  });
  expect(result.status).toBe("complete");
  const wanted = (
    await reserves.wantedVersions?.(silverDir, completenessView(), goldDir)
  )?.get(DATE);
  for (const table of TABLES) {
    const rows = await readGold(table);
    const flags = [
      ...new Set(
        rows.map((r) =>
          JSON.stringify({
            analysis_version: r.analysis_version,
            inputs_sha256: r.inputs_sha256,
            inputs_complete: r.inputs_complete,
          }),
        ),
      ),
    ];
    expect(flags).toEqual([
      JSON.stringify({
        analysis_version: ANALYSIS_VERSION,
        inputs_sha256: wanted,
        inputs_complete: true,
      }),
    ]);
  }
});

test("the fingerprint changes with the analysis version and with an input", () => {
  const inputs = [["dispatch_reserve_prices", "a"]] as const;
  expect(fingerprint(1, inputs)).toBe(fingerprint(1, inputs));
  expect(fingerprint(2, inputs)).not.toBe(fingerprint(1, inputs));
  expect(fingerprint(1, [["dispatch_reserve_prices", "b"]])).not.toBe(
    fingerprint(1, inputs),
  );
});

test("the runner builds gold, skips it when silver is unchanged and rebuilds it when an input changes", async () => {
  await writeSilver(synthetic);
  const run = () =>
    runPublish({
      bronzeDir,
      silverDir,
      goldDir,
      only: ["gold_reserves"],
    }).then((s) => s[0]);
  expect(await run()).toMatchObject({ published: 1, upToDate: 0, failed: [] });
  expect(await run()).toMatchObject({ published: 0, upToDate: 1 });
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
  expect(await run()).toMatchObject({ published: 1, upToDate: 0 });
});

async function archive(date: string, csv: string) {
  const sha256 = createHash("sha256").update(csv).digest("hex");
  const name = `${date.replaceAll("-", "")}_DispatchReservePrices.csv`;
  const path = `${DATASET}/${sha256}/${name}`;
  await mkdir(join(bronzeDir, DATASET, sha256), { recursive: true });
  await writeFile(join(bronzeDir, path), csv);
  await appendFile(
    join(bronzeDir, "manifest.jsonl"),
    `${JSON.stringify({ dataset: DATASET, status: "new", retrieved_at: "2026-11-20T00:00:01.000Z", sha256, path, trading_dates: [date] })}\n`,
  );
}

async function archiveFixture(date: string) {
  await archive(
    date,
    await readFile(
      join(FIXTURES, `${date.replaceAll("-", "")}_DispatchReservePrices.csv`),
      "utf8",
    ),
  );
  expect(
    await publishDispatchReservePrices({ bronzeDir, silverDir, date }),
  ).toMatchObject({ status: "complete" });
}

test("real fixture period 1 FIR NI matches the hand-calculated rule B mean", {
  timeout: 60_000,
}, async () => {
  await archiveFixture(DATE);
  expect(
    await publishReserves({
      silverDir,
      goldDir,
      completeness: completenessView(),
      date: DATE,
    }),
  ).toMatchObject({ status: "complete" });
  // HAY2201 FIR, period 1. Published 00:00:13 1.00, 00:04:40 1.00, 00:09:50 0.50,
  // 00:20:13 0.15, 00:24:46 0.15. Weights 280, 310, 623, 273, 314 s (the last runs to 00:30:00).
  // (1.00*280 + 1.00*310 + 0.50*623 + 0.15*273 + 0.15*314) / 1800 = 989.55 / 1800 = 0.54975.
  const period = at(
    await readGold("reserve_by_class_island_period"),
    "FIR",
    "NI",
    1,
  );
  expect(Number(period?.dollars_per_megawatt_hour)).toBeCloseTo(0.54975, 12);
  expect(period).toMatchObject({
    min_price: 0.15,
    max_price: 1,
    rows_present: 5,
    inputs_complete: true,
  });
  const day = at(await readGold("reserve_by_class_island_day"), "FIR", "NI");
  expect(day).toMatchObject({
    periods_present: 48,
    periods_expected: 48,
    inputs_complete: true,
  });
});

test("a DST-start day has 46 periods, and a row before a period starts is clamped", {
  timeout: 60_000,
}, async () => {
  const date = "2026-09-27";
  await archiveFixture(date);
  expect(
    await publishReserves({
      silverDir,
      goldDir,
      completeness: completenessView(),
      date,
    }),
  ).toMatchObject({
    status: "complete",
  });
  const periods = await readGold("reserve_by_class_island_period", date);
  expect(periods).toHaveLength(4 * 46); // 2 classes, 2 islands
  expect(Math.max(...periods.map((r) => Number(r.trading_period)))).toBe(46);
  expect(periods.some((r) => r.trading_period === 49)).toBe(false);

  // HAY2201, period 5 (03:00 to 03:30 NZDT, 14:00 to 14:30 UTC). The first row was published
  // at 01:59:23 NZST, 37 s before the period starts, so it applies from the start.
  // SIR prices in publish order: 0.17, 0.16, 0.17, 0.17, 0.16, 0.17.
  // Weights 263, 302, 305, 295, 305, 330 s (the next publishes are at 14:04:23, 14:09:25,
  // 14:14:30, 14:19:25 and 14:24:30 UTC). 0.16 holds 607 s and 0.17 holds 1193 s:
  // (0.16*607 + 0.17*1193) / 1800 = 299.93 / 1800.
  const sir = at(periods, "SIR", "NI", 5);
  expect(Number(sir?.dollars_per_megawatt_hour)).toBeCloseTo(299.93 / 1800, 12);
  expect(sir).toMatchObject({
    min_price: 0.16,
    max_price: 0.17,
    rows_present: 6,
  });
  expect(at(periods, "FIR", "NI", 5)?.dollars_per_megawatt_hour).toBeCloseTo(
    0.11,
    12,
  );

  const day = at(
    await readGold("reserve_by_class_island_day", date),
    "SIR",
    "NI",
  );
  const prices = periods
    .filter((r) => r.reserve_class === "SIR" && r.island === "NI")
    .map((r) => Number(r.dollars_per_megawatt_hour));
  expect(Number(day?.mean_price)).toBeCloseTo(
    prices.reduce((a, b) => a + b, 0) / 46,
    12,
  );
  expect(day).toMatchObject({
    periods_present: 46,
    periods_expected: 46,
    inputs_complete: true,
  });
});

test("an invalid input day gives incomplete rows", async () => {
  await writeSilver(
    Array.from({ length: 48 }, (_, i) => row("FIR", "NI", HAY, i * 1800, 1)),
  );
  const result = await publishReserves({
    silverDir,
    goldDir,
    completeness: completenessView([
      ["dispatch_reserve_prices", DATE, "invalid"],
    ]),
    date: DATE,
  });
  expect(result).toMatchObject({ status: "partial", missingPeriods: [] });
  for (const table of TABLES)
    for (const r of await readGold(table))
      expect(r.inputs_complete).toBe(false);
});

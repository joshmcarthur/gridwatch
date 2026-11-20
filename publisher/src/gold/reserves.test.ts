import { createHash } from "node:crypto";
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
  /** 0-based index of the 5-minute interval of the day. */
  interval: number;
  price: number;
  /** Seconds after the interval start. Default 10. */
  publishOffset?: number;
}

/** Write a silver dispatch reserve prices partition with the columns gold reads. */
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
      const island = r.island === null ? "NULL" : lit(r.island);
      return `(${period}, ${iso(start)}::TIMESTAMPTZ, ${iso(start + 1_800_000)}::TIMESTAMPTZ,
        ${iso(publish)}::TIMESTAMPTZ, ${lit(r.poc)}, ${island}, ${lit(r.reserveClass)},
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

const each = (
  reserveClass: SilverRow["reserveClass"],
  island: SilverRow["island"],
  poc: string,
  prices: number[],
  from = 0,
): SilverRow[] =>
  prices.map((price, i) => ({
    reserveClass,
    island,
    poc,
    interval: from + i,
    price,
  }));

/**
 * Hand-calculated day. Period 1 (intervals 0-5) and period 2 (intervals 6-11) only.
 * FIR NI P1: 10..60 step 10, mean 35. FIR NI P2: 3 intervals of 100.
 * FIR SI P1: 1,2,3,4,5,6 but interval 2 has a re-run (publish +130 s) at 9, so 1,2,9,4,5,6 = 4.5.
 * FIR SI P2: 20.
 * SIR NI P1: 5. SIR SI P1: 8.
 */
const synthetic: SilverRow[] = [
  ...each("FIR", "NI", "HAY2201", [10, 20, 30, 40, 50, 60]),
  ...each("FIR", "NI", "HAY2201", [100, 100, 100], 6),
  ...each("FIR", "SI", "BEN2201", [1, 2, 3, 4, 5, 6]),
  {
    reserveClass: "FIR",
    island: "SI",
    poc: "BEN2201",
    interval: 2,
    price: 9,
    publishOffset: 130,
  },
  ...each("FIR", "SI", "BEN2201", [20, 20, 20, 20, 20, 20], 6),
  ...each("SIR", "NI", "HAY2201", [5, 5, 5, 5, 5, 5]),
  ...each("SIR", "SI", "BEN2201", [8, 8, 8, 8, 8, 8]),
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

test("period price is the mean of latest-case interval prices", async () => {
  await writeSilver(synthetic);
  const result = await publishReserves({ silverDir, goldDir, date: DATE });
  expect(result.status).toBe("partial");
  if (result.status !== "partial") throw new Error("expected partial");
  expect(result.missingPeriods.slice(0, 3)).toEqual([3, 4, 5]);

  const rows = await readGold("reserve_by_class_island_period");
  expect(at(rows, "FIR", "NI", 1)).toMatchObject({
    dollars_per_megawatt_hour: 35,
    min_interval_price: 10,
    max_interval_price: 60,
    intervals_present: 6,
    inputs_complete: false,
    analysis_version: ANALYSIS_VERSION,
  });
  expect(at(rows, "FIR", "SI", 1)?.dollars_per_megawatt_hour).toBe(4.5);
  expect(at(rows, "FIR", "NI", 2)).toMatchObject({
    dollars_per_megawatt_hour: 100,
    intervals_present: 3,
    inputs_complete: false,
  });
  expect(at(rows, "SIR", "NI", 1)?.dollars_per_megawatt_hour).toBe(5);
  expect(Date.parse(String(at(rows, "FIR", "NI", 1)?.event_start_utc))).toBe(
    DAY_START,
  );
});

test("daily summaries are the hand-calculated mean, min, max and time-weighted mean", async () => {
  await writeSilver(synthetic);
  await publishReserves({ silverDir, goldDir, date: DATE });
  const rows = await readGold("reserve_by_class_island_day");
  const firNi = at(rows, "FIR", "NI");
  // mean of period prices (35 + 100) / 2. Intervals (35*6 + 100*3) / 9.
  expect(firNi?.mean_price).toBe(67.5);
  expect(Number(firNi?.time_weighted_mean_price)).toBeCloseTo(510 / 9, 9);
  expect(firNi).toMatchObject({
    min_price: 10,
    max_price: 100,
    inputs_complete: false,
  });
  const firSi = at(rows, "FIR", "SI");
  expect(firSi?.mean_price).toBe(12.25); // (4.5 + 20) / 2
  expect(firSi?.min_price).toBe(1);
  expect(firSi?.max_price).toBe(20);
  expect(at(rows, "SIR", "NI")?.mean_price).toBe(5);
});

test("two points of connection on one island keep the later publish", async () => {
  await writeSilver([
    {
      reserveClass: "FIR",
      island: "NI",
      poc: "HAY2201",
      interval: 0,
      price: 1,
    },
    {
      reserveClass: "FIR",
      island: "NI",
      poc: "OTA2201",
      interval: 0,
      price: 9,
      publishOffset: 20,
    },
  ]);
  await publishReserves({ silverDir, goldDir, date: DATE });
  expect(
    at(await readGold("reserve_by_class_island_period"), "FIR", "NI", 1),
  ).toMatchObject({
    dollars_per_megawatt_hour: 9,
    intervals_present: 1,
  });
});

test("a null island is kept and flagged, not dropped", async () => {
  await writeSilver([
    {
      reserveClass: "FIR",
      island: null,
      poc: "ZZZ2201",
      interval: 0,
      price: 3,
    },
  ]);
  const result = await publishReserves({ silverDir, goldDir, date: DATE });
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
  expect(await publishReserves({ silverDir, goldDir, date: DATE })).toEqual({
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
  await publishReserves({ silverDir, goldDir, date: DATE });
  const first = await bytes();
  await publishReserves({ silverDir, goldDir, date: DATE });
  expect(await bytes()).toEqual(first);
});

test("rows carry the analysis version, the fingerprint and the completeness flag", async () => {
  await writeSilver(
    each(
      "FIR",
      "NI",
      "HAY2201",
      Array.from({ length: 48 * 6 }, () => 1),
    ),
  );
  await publishReserves({ silverDir, goldDir, date: DATE });
  const wanted = (await reserves.wantedVersions?.(silverDir))?.get(DATE);
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

test("real fixture period 1 FIR NI matches the hand-calculated interval mean", {
  timeout: 60_000,
}, async () => {
  await archive(
    DATE,
    await readFile(
      join(FIXTURES, "20261118_DispatchReservePrices.csv"),
      "utf8",
    ),
  );
  expect(
    await publishDispatchReservePrices({ bronzeDir, silverDir, date: DATE }),
  ).toMatchObject({ status: "complete" });
  expect(
    await publishReserves({ silverDir, goldDir, date: DATE }),
  ).toMatchObject({ status: "complete" });
  // Period 1 HAY FIR publishes snap to 00:00, 00:05, 00:10, 00:20, 00:25:
  // 1.00, 1.00, 0.50, 0.15, 0.15. Mean 2.80 / 5 = 0.56. No 00:15 interval.
  const row = at(
    await readGold("reserve_by_class_island_period"),
    "FIR",
    "NI",
    1,
  );
  expect(Number(row?.dollars_per_megawatt_hour)).toBeCloseTo(0.56, 9);
  expect(row).toMatchObject({
    min_interval_price: 0.15,
    max_interval_price: 1,
    intervals_present: 5,
    inputs_complete: true,
  });
});

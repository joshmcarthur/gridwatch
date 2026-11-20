import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runPublish } from "../runner.ts";
import { publishEntityMappings } from "../silver/entity-mappings.ts";
import { publishNetworkSupplyPoints } from "../silver/network-supply-points.ts";
import { publishNodalPricesAndVolumes } from "../silver/nodal-prices-and-volumes.ts";
import { goldPartitionPath } from "./common.ts";
import { completenessView } from "./fixtures/completeness.ts";
import { writeParquet } from "./fixtures/parquet.ts";
import {
  ANALYSIS_VERSION,
  gridLoad,
  publishGridLoad,
  TABLES,
} from "./grid-load.ts";

const FIXTURES = join(import.meta.dirname, "..", "silver", "fixtures");
const DATE = "2026-10-31"; // 48 periods, NZDT (UTC+13): period 1 starts at 2026-10-30T11:00Z
let root: string;
let bronzeDir: string;
let silverDir: string;
let goldDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-gold-load-"));
  bronzeDir = join(root, "bronze");
  silverDir = join(root, "silver");
  goldDir = join(root, "gold");
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function query(sql: string) {
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    return (
      await connection.runAndReadAll(
        sql.replaceAll("$S", silverDir).replaceAll("$G", goldDir),
      )
    ).getRowObjectsJson() as Array<Record<string, string | null>>;
  } finally {
    connection.closeSync();
  }
}

const gold = (table: string, date = DATE) =>
  `'$G/${table}/trading_date=${date}/data.parquet'`;
const num = (value: string | null | undefined) => Number(value);

interface Nodal {
  period: number;
  interval: number; // 0..5 within the period
  poc: string;
  unit: string | null;
  island: string | null;
  load: number;
  runAt?: string | null;
  caseId?: string;
  caseType?: string;
}
interface Scenario {
  nodal: Nodal[];
  poc: Array<{ id: string; island: string }>;
}

const start = (period: number, interval: number) =>
  new Date(
    Date.UTC(2026, 9, 30, 11, 0) + ((period - 1) * 30 + interval * 5) * 60_000,
  ).toISOString();

/**
 * The base case: every period has 6 intervals. `AAA0331` (NI) loads 10 MW and `BBB0331` (SI) loads
 * 5 MW in every interval. By hand, for every period: NI load 5 MWh, SI load 2.5 MWh.
 */
function base(periods = 48): Scenario {
  const range = Array.from({ length: periods }, (_, i) => i + 1);
  return {
    poc: [
      { id: "AAA0331", island: "NI" },
      { id: "HLY0331", island: "NI" },
      { id: "BBB0331", island: "SI" },
    ],
    nodal: range.flatMap((period) =>
      Array.from({ length: 6 }, (_, interval) => [
        {
          period,
          interval,
          poc: "AAA0331",
          unit: null,
          island: "North Island",
          load: 10,
        },
        {
          period,
          interval,
          poc: "BBB0331",
          unit: null,
          island: "South Island",
          load: 5,
        },
      ]).flat(),
    ),
  };
}

const REFERENCE_RUN = "2026-10-30T10:59:00.000Z";

async function writeScenario(s: Scenario, date = DATE) {
  await writeParquet(
    join(
      silverDir,
      "nodal_prices_and_volumes",
      `trading_date=${date}`,
      "data.parquet",
    ),
    {
      trading_date: "DATE",
      trading_period: "INTEGER",
      event_start_utc: "TIMESTAMPTZ",
      source_run_at: "TIMESTAMPTZ",
      case_type: "VARCHAR",
      case_id: "VARCHAR",
      point_of_connection: "VARCHAR",
      unit_code: "VARCHAR",
      island: "VARCHAR",
      load_megawatts: "DOUBLE",
      bronze_sha256: "VARCHAR",
    },
    s.nodal.map((n) => ({
      trading_date: date,
      trading_period: n.period,
      event_start_utc: start(n.period, n.interval),
      source_run_at: n.runAt === undefined ? REFERENCE_RUN : n.runAt,
      case_type: n.caseType ?? "RTD",
      case_id: n.caseId ?? `case-${n.period}-${n.interval}`,
      point_of_connection: n.poc,
      unit_code: n.unit,
      island: n.island,
      load_megawatts: n.load,
      bronze_sha256: "nodal-sha",
    })),
  );
  await writeParquet(
    join(
      silverDir,
      "entity_points_of_connection",
      `trading_date=${date}`,
      "data.parquet",
    ),
    {
      trading_date: "DATE",
      poc_id: "VARCHAR",
      island: "VARCHAR",
      inputs_sha256: "VARCHAR",
    },
    s.poc.map((p) => ({
      trading_date: date,
      poc_id: p.id,
      island: p.island,
      inputs_sha256: "poc-sha",
    })),
  );
}

const publish = (date = DATE, view = completenessView()) =>
  publishGridLoad({ silverDir, goldDir, completeness: view, date });

const period = (island: string, tp: number, date = DATE) =>
  query(
    `SELECT * FROM ${gold("grid_load_period", date)}
     WHERE island = '${island}' AND trading_period = ${tp}`,
  ).then((rows) => rows[0]);
const day = (island: string, date = DATE) =>
  query(
    `SELECT * FROM ${gold("grid_load_day", date)} WHERE island = '${island}'`,
  ).then((rows) => rows[0]);

test("the base case is the mean of interval MW times 0.5 hours, unit rows included", async () => {
  await writeScenario(base());
  expect(await publish()).toMatchObject({ status: "complete", rows: 96 });
  const ni = await period("NI", 7);
  expect(num(ni?.load_mwh)).toBe(5);
  expect(num(ni?.load_intervals)).toBe(6);
  expect(ni?.inputs_complete).toBe(true);
  expect(num((await period("SI", 7))?.load_mwh)).toBe(2.5);
  const d = await day("NI");
  expect(num(d?.load_mwh)).toBe(240);
  expect(d?.inputs_complete).toBe(true);
});

test("a nodal unit row counts as load, like a battery or a dispatchable unit", async () => {
  const s = base();
  // HLY91 loads 8 MW in all six intervals of period 1: NI load = (10 + 8) x 0.5.
  for (let interval = 0; interval < 6; interval++)
    s.nodal.push({
      period: 1,
      interval,
      poc: "HLY0331",
      unit: "HLY91",
      island: "North Island",
      load: 8,
    });
  await writeScenario(s);
  await publish();
  expect(num((await period("NI", 1))?.load_mwh)).toBe(9);
  expect(num((await period("NI", 2))?.load_mwh)).toBe(5);
});

test("the latest RTD case wins for an interval, and the case id breaks a tie on run time", async () => {
  const s = base();
  // Period 2, interval 0: an older case (10 MW, case id "z-old") and a newer case (40 MW, case id
  // "a-new"). The older case has the larger id, so only the run time picks the newer one:
  // (40 + 5 x 10) / 6 x 0.5.
  s.nodal = s.nodal.map((n) =>
    n.period === 2 && n.interval === 0 ? { ...n, caseId: "z-old" } : n,
  );
  s.nodal.push({
    period: 2,
    interval: 0,
    poc: "AAA0331",
    unit: null,
    island: "North Island",
    load: 40,
    runAt: "2026-10-30T11:31:00.000Z",
    caseId: "a-new",
  });
  // Period 3, interval 0: same run time, case ids "case-3-0" and "case-3-0-b" -> the larger id (70 MW) wins.
  s.nodal.push({
    period: 3,
    interval: 0,
    poc: "AAA0331",
    unit: null,
    island: "North Island",
    load: 70,
    caseId: "case-3-0-b",
  });
  // A case of another type is ignored.
  s.nodal.push({
    period: 4,
    interval: 0,
    poc: "AAA0331",
    unit: null,
    island: "North Island",
    load: 900,
    caseType: "PRSS",
    runAt: "2026-10-30T12:31:00.000Z",
    caseId: "z",
  });
  await writeScenario(s);
  await publish();
  expect(num((await period("NI", 2))?.load_mwh)).toBeCloseTo(
    ((40 + 5 * 10) / 6) * 0.5,
    12,
  );
  expect(num((await period("NI", 3))?.load_mwh)).toBeCloseTo(
    ((70 + 5 * 10) / 6) * 0.5,
    12,
  );
  expect(num((await period("NI", 4))?.load_mwh)).toBe(5);
});

test("a case with no run time loses to a case that has one", async () => {
  const s = base();
  // Period 10, interval 0: the base case has no run time (id "z-null", 10 MW); the other has one
  // (id "a-set", 40 MW) and wins: (40 + 5 x 10) / 6 x 0.5.
  s.nodal = s.nodal.map((n) =>
    n.period === 10 && n.interval === 0
      ? { ...n, runAt: null, caseId: "z-null" }
      : n,
  );
  s.nodal.push({
    period: 10,
    interval: 0,
    poc: "AAA0331",
    unit: null,
    island: "North Island",
    load: 40,
    caseId: "a-set",
  });
  await writeScenario(s);
  await publish();
  expect(num((await period("NI", 10))?.load_mwh)).toBeCloseTo(
    ((40 + 5 * 10) / 6) * 0.5,
    12,
  );
});

test("a period with 3 intervals uses the mean of the intervals times 0.5 hours", async () => {
  const s = base();
  s.nodal = s.nodal.filter((n) => !(n.period === 4 && n.interval >= 3));
  s.nodal = s.nodal.map((n) =>
    n.period === 4 && n.interval === 0 && n.poc === "AAA0331"
      ? { ...n, load: 4 }
      : n,
  );
  await writeScenario(s);
  await publish();
  const row = await period("NI", 4);
  expect(num(row?.load_intervals)).toBe(3);
  expect(num(row?.load_mwh)).toBeCloseTo(((4 + 10 + 10) / 3) * 0.5, 12);
  expect(row?.inputs_complete).toBe(true);
});

test("a period with no interval has null load, and null day terms and flag", async () => {
  const s = base();
  s.nodal = s.nodal.filter((n) => n.period !== 5);
  await writeScenario(s);
  expect(await publish()).toMatchObject({
    status: "partial",
    missingPeriods: [5],
  });
  const row = await period("NI", 5);
  expect(row?.load_mwh).toBeNull();
  expect(num(row?.load_intervals)).toBe(0);
  expect(row?.inputs_complete).toBe(false);
  const d = await day("NI");
  expect(d?.load_mwh).toBeNull();
  expect(d?.inputs_complete).toBe(false);
});

test("an island with no load row has null load, not 0", async () => {
  const s = base();
  s.nodal = s.nodal.filter((n) => !(n.period === 6 && n.poc === "BBB0331"));
  await writeScenario(s);
  await publish();
  const si = await period("SI", 6);
  expect(si?.load_mwh).toBeNull();
  expect(si?.inputs_complete).toBe(false);
  expect(num((await period("NI", 6))?.load_mwh)).toBe(5);
  expect((await period("NI", 6))?.inputs_complete).toBe(true);
});

test("energy with no island goes to neither row and flags every row of the date", async () => {
  const s = base();
  s.nodal.push({
    period: 9,
    interval: 0,
    poc: "ZZZ0331",
    unit: null,
    island: null,
    load: 3,
  });
  await writeScenario(s);
  expect(await publish()).toMatchObject({ status: "partial" });
  expect(num((await period("NI", 9))?.load_mwh)).toBe(5);
  expect(num((await period("SI", 9))?.load_mwh)).toBe(2.5);
  const flags = await query(
    `SELECT DISTINCT inputs_complete FROM ${gold("grid_load_period")}
     UNION SELECT DISTINCT inputs_complete FROM ${gold("grid_load_day")}`,
  );
  expect(flags).toEqual([{ inputs_complete: false }]);
});

test("a point of connection that the entity table lacks does not take the nodal Island string", async () => {
  const s = base();
  s.nodal.push({
    period: 9,
    interval: 0,
    poc: "ZZZ0331",
    unit: null,
    island: "South Island",
    load: 6,
  });
  await writeScenario(s);
  expect(await publish()).toMatchObject({ status: "partial" });
  // The 6 MW is in neither island: the loads are as in the base case.
  expect(num((await period("SI", 9))?.load_mwh)).toBe(2.5);
  expect(num((await period("NI", 9))?.load_mwh)).toBe(5);
});

test("with no nodal partition the date is not wanted and nothing is written", async () => {
  await writeScenario(base());
  await rm(join(silverDir, "nodal_prices_and_volumes"), { recursive: true });
  expect(await publish()).toEqual({ date: DATE, status: "missing" });
  expect(existsSync(join(goldDir, "grid_load_period"))).toBe(false);
  expect(
    (
      await gridLoad.wantedVersions?.(silverDir, completenessView(), goldDir)
    )?.has(DATE),
  ).toBe(false);
});

test("the rows carry the analysis version and the wanted fingerprint, and a rerun gives identical bytes", async () => {
  await writeScenario(base());
  await publish();
  const wanted = (
    await gridLoad.wantedVersions?.(silverDir, completenessView(), goldDir)
  )?.get(DATE);
  for (const table of TABLES)
    expect(
      await query(
        `SELECT DISTINCT analysis_version, inputs_sha256 FROM ${gold(table)}`,
      ),
    ).toEqual([{ analysis_version: ANALYSIS_VERSION, inputs_sha256: wanted }]);
  const bytes = () =>
    Promise.all(
      TABLES.map((t) =>
        readFile(goldPartitionPath(goldDir, t, DATE)).then((b) =>
          createHash("sha256").update(b).digest("hex"),
        ),
      ),
    );
  const first = await bytes();
  await publish();
  expect(await bytes()).toEqual(first);
});

test("the runner skips an up-to-date date, and rebuilds it when a silver fingerprint changes", async () => {
  const s = base();
  await writeScenario(s);
  const run = () =>
    runPublish({
      bronzeDir,
      silverDir,
      goldDir,
      only: ["gold_grid_load"],
    }).then((x) => x[0]);
  expect(await run()).toMatchObject({ published: 1, upToDate: 0, failed: [] });
  expect(await run()).toMatchObject({ published: 0, upToDate: 1 });
  await writeParquet(
    join(
      silverDir,
      "nodal_prices_and_volumes",
      `trading_date=${DATE}`,
      "data.parquet",
    ),
    {
      trading_date: "DATE",
      trading_period: "INTEGER",
      event_start_utc: "TIMESTAMPTZ",
      source_run_at: "TIMESTAMPTZ",
      case_type: "VARCHAR",
      case_id: "VARCHAR",
      point_of_connection: "VARCHAR",
      unit_code: "VARCHAR",
      island: "VARCHAR",
      load_megawatts: "DOUBLE",
      bronze_sha256: "VARCHAR",
    },
    s.nodal.map((n) => ({
      trading_date: DATE,
      trading_period: n.period,
      event_start_utc: start(n.period, n.interval),
      source_run_at: n.runAt === undefined ? REFERENCE_RUN : n.runAt,
      case_type: n.caseType ?? "RTD",
      case_id: n.caseId ?? `case-${n.period}-${n.interval}`,
      point_of_connection: n.poc,
      unit_code: n.unit,
      island: n.island,
      load_megawatts: n.load,
      bronze_sha256: "nodal-sha-2",
    })),
  );
  expect(await run()).toMatchObject({ published: 1, upToDate: 0 });
});

test("an incomplete nodal day flags every row", async () => {
  await writeScenario(base());
  expect(
    await publish(
      DATE,
      completenessView([["nodal_prices_and_volumes", DATE, "partial"]]),
    ),
  ).toMatchObject({ status: "partial", missingPeriods: [] });
  const flags = await query(
    `SELECT DISTINCT inputs_complete FROM ${gold("grid_load_period")}`,
  );
  expect(flags).toEqual([{ inputs_complete: false }]);
});

async function archive(
  dataset: string,
  folder: string,
  fileName: string,
  dates: string[],
) {
  const csv = await readFile(join(FIXTURES, folder, fileName), "utf8");
  const sha256 = createHash("sha256").update(csv).digest("hex");
  const path = `${dataset}/${sha256}/${fileName}`;
  await mkdir(join(bronzeDir, dataset, sha256), { recursive: true });
  await writeFile(join(bronzeDir, path), csv);
  await appendFile(
    join(bronzeDir, "manifest.jsonl"),
    `${JSON.stringify({ dataset, status: "new", retrieved_at: "2026-11-21T00:00:01.000Z", sha256, path, trading_dates: dates })}\n`,
  );
}

async function buildFixtureDay(date: string) {
  await archive(
    "network_supply_points",
    "network-supply-points",
    "20260106_NetworkSupplyPointsTable.csv",
    ["2026-01-06"],
  );
  await archive(
    "nodal_prices_and_volumes",
    "nodal-prices-and-volumes",
    `${date.replaceAll("-", "")}_DispatchNodalPricesAndVolumes.csv`,
    [date],
  );
  const args = { bronzeDir, silverDir, date };
  await publishNetworkSupplyPoints({ ...args, date: "2026-01-06" });
  await publishNodalPricesAndVolumes(args);
  await publishEntityMappings({ silverDir, date });
}

for (const [date, periods] of [
  ["2026-04-05", 50],
  ["2026-09-27", 46],
] as const) {
  test(`${date} has ${periods} periods, and each period counts the intervals that its UTC span holds`, {
    timeout: 60_000,
  }, async () => {
    await buildFixtureDay(date);
    expect(await publish(date)).toMatchObject({ rows: periods * 2 });
    const [count] = await query(
      `SELECT count(DISTINCT trading_period) AS n FROM ${gold("grid_load_period", date)}`,
    );
    expect(num(count?.n)).toBe(periods);
    // The same 5-minute intervals, counted from silver by UTC start, for each period.
    const mismatches = await query(
      `SELECT p.trading_period, p.load_intervals, s.n
       FROM ${gold("grid_load_period", date)} p
       LEFT JOIN (
         SELECT trading_period, count(DISTINCT event_start_utc) AS n
         FROM '$S/nodal_prices_and_volumes/trading_date=${date}/data.parquet'
         WHERE case_type = 'RTD'
         GROUP BY trading_period) s USING (trading_period)
       WHERE p.island = 'NI' AND p.load_intervals <> coalesce(s.n, 0)`,
    );
    expect(mismatches).toEqual([]);
    const [dayRow] = await query(
      `SELECT count(*) FILTER (WHERE load_mwh IS NULL) AS nulls
       FROM ${gold("grid_load_period", date)} WHERE island = 'NI'`,
    );
    const d = await day("NI", date);
    expect(d?.load_mwh === null).toBe(num(dayRow?.nulls) > 0);
    // A period of the repeated hour (5 April, local 02:00 to 03:00) has its own UTC span.
    if (periods === 50) {
      const repeated = await query(
        `SELECT trading_period, load_intervals FROM ${gold("grid_load_period", date)}
         WHERE island = 'NI' AND trading_period BETWEEN 5 AND 8 ORDER BY 1`,
      );
      expect(repeated).toHaveLength(4);
      for (const row of repeated)
        expect(num(row.load_intervals)).toBeGreaterThan(0);
    }
  });
}

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
import { dirname, join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runPublish } from "../runner.ts";
import { publishEntityMappings } from "../silver/entity-mappings.ts";
import { publishGenerationMd } from "../silver/generation-md.ts";
import { publishHvdcFlows } from "../silver/hvdc-flows.ts";
import { publishNetworkSupplyPoints } from "../silver/network-supply-points.ts";
import { publishNodalPricesAndVolumes } from "../silver/nodal-prices-and-volumes.ts";
import { goldPartitionPath } from "./common.ts";
import {
  ANALYSIS_VERSION,
  energyBalance,
  publishEnergyBalance,
  TABLES,
} from "./energy-balance.ts";
import { completenessView } from "./fixtures/completeness.ts";
import { publishGeneration } from "./generation.ts";
import { publishHvdc } from "./hvdc.ts";

const FIXTURES = join(import.meta.dirname, "..", "silver", "fixtures");
const DATE = "2026-10-31"; // 48 periods, NZDT (UTC+13): period 1 starts at 2026-10-30T11:00Z
let root: string;
let bronzeDir: string;
let silverDir: string;
let goldDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-gold-balance-"));
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

// ---------------------------------------------------------------------------------------------
// Hand-built inputs. Each scenario writes the four input partitions with a few rows, so that a
// test controls every term. Silver and gold inputs hold only the columns that the SQL reads, plus
// the version column.
// ---------------------------------------------------------------------------------------------

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
interface Fuel {
  period: number;
  island: string | null;
  mwh: number;
  complete?: boolean;
}
interface Hvdc {
  period: number;
  northReceived: number;
  southSent: number;
}
interface Scenario {
  nodal: Nodal[];
  fuel: Fuel[];
  hvdc: Hvdc[];
  poc: Array<{ id: string; island: string }>;
}

const start = (period: number, interval: number) =>
  new Date(
    Date.UTC(2026, 9, 30, 11, 0) + ((period - 1) * 30 + interval * 5) * 60_000,
  ).toISOString();

/** Write rows as Parquet through a JSON file. `columns` is the DuckDB type of each column. */
async function writeParquet(
  path: string,
  columns: Record<string, string>,
  rows: object[],
) {
  await mkdir(dirname(path), { recursive: true });
  const json = `${path}.json`;
  await writeFile(json, rows.map((row) => JSON.stringify(row)).join("\n"));
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    const columnSql = Object.entries(columns)
      .map(([name, type]) => `'${name}': '${type}'`)
      .join(", ");
    await connection.run(
      `COPY (SELECT * FROM read_json('${json}', format = 'newline_delimited', columns = {${columnSql}}))
       TO '${path}' (FORMAT parquet)`,
    );
  } finally {
    connection.closeSync();
  }
  await rm(json);
}

/**
 * The base case: every period has 6 intervals. `AAA0331` (NI) loads 10 MW and `BBB0331` (SI) loads
 * 5 MW in every interval. Each island generates 6 MWh (NI) and 4 MWh (SI) in a period. The link
 * receives 1.0 MWh in the north and sends 1.2 MWh from the south. By hand, for every period:
 * NI load 5 MWh, SI load 2.5 MWh, NI import 1.0, SI import -1.2, NI residual 6 + 1 - 5 = 2.0,
 * SI residual 4 - 1.2 - 2.5 = 0.3, link losses 0.2.
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
    fuel: range.flatMap((period) => [
      { period, island: "NI", mwh: 6 },
      { period, island: "SI", mwh: 4 },
    ]),
    hvdc: range.map((period) => ({
      period,
      northReceived: 1.0,
      southSent: 1.2,
    })),
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
  await writeUpstream(s, date);
}

/** The two gold inputs, with a version that the caller can change. */
async function writeUpstream(s: Scenario, date = DATE, sha = "upstream-1") {
  await writeParquet(
    goldPartitionPath(goldDir, "generation_by_fuel_period", date),
    {
      trading_date: "DATE",
      trading_period: "INTEGER",
      fuel_category: "VARCHAR",
      island: "VARCHAR",
      megawatt_hours: "DOUBLE",
      inputs_complete: "BOOLEAN",
      inputs_sha256: "VARCHAR",
    },
    s.fuel.map((f) => ({
      trading_date: date,
      trading_period: f.period,
      fuel_category: "hydro",
      island: f.island,
      megawatt_hours: f.mwh,
      inputs_complete: f.complete ?? true,
      inputs_sha256: `${sha}-generation`,
    })),
  );
  await writeParquet(
    goldPartitionPath(goldDir, "hvdc_transfer_period", date),
    {
      trading_date: "DATE",
      trading_period: "INTEGER",
      north_island_received_mwh: "DOUBLE",
      south_island_sent_mwh: "DOUBLE",
      losses_mwh: "DOUBLE",
      inputs_complete: "BOOLEAN",
      inputs_sha256: "VARCHAR",
    },
    s.hvdc.map((h) => ({
      trading_date: date,
      trading_period: h.period,
      north_island_received_mwh: h.northReceived,
      south_island_sent_mwh: h.southSent,
      // Losses are what enters the link minus what leaves it. Positive flow is north.
      losses_mwh: h.southSent - h.northReceived,
      inputs_complete: true,
      inputs_sha256: `${sha}-hvdc`,
    })),
  );
}

const publish = (date = DATE, view = completenessView()) =>
  publishEnergyBalance({ silverDir, goldDir, completeness: view, date });

const period = (island: string, tp: number, date = DATE) =>
  query(
    `SELECT * FROM ${gold("energy_balance_period", date)}
     WHERE island = '${island}' AND trading_period = ${tp}`,
  ).then((rows) => rows[0]);
const day = (island: string, date = DATE) =>
  query(
    `SELECT * FROM ${gold("energy_balance_day", date)} WHERE island = '${island}'`,
  ).then((rows) => rows[0]);

test("the base case balances by hand: generation + HVDC import - load", async () => {
  await writeScenario(base());
  expect(await publish()).toMatchObject({ status: "complete", rows: 96 });
  const ni = await period("NI", 7);
  expect(num(ni?.generation_mwh)).toBe(6);
  expect(num(ni?.hvdc_import_mwh)).toBe(1);
  expect(num(ni?.load_mwh)).toBe(5);
  expect(num(ni?.load_intervals)).toBe(6);
  expect(num(ni?.residual_mwh)).toBe(2);
  expect(num(ni?.residual_pct_of_load)).toBeCloseTo(40, 9);
  expect(ni?.inputs_complete).toBe(true);
  const si = await period("SI", 7);
  expect(num(si?.hvdc_import_mwh)).toBeCloseTo(-1.2, 12);
  expect(num(si?.load_mwh)).toBe(2.5);
  expect(num(si?.residual_mwh)).toBeCloseTo(0.3, 12);
  // The day sums 48 periods.
  const d = await day("NI");
  expect(num(d?.generation_mwh)).toBe(288);
  expect(num(d?.load_mwh)).toBe(240);
  expect(num(d?.residual_mwh)).toBe(96);
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

test("a period with no interval has null load and residual, and null day terms and flag", async () => {
  const s = base();
  s.nodal = s.nodal.filter((n) => n.period !== 5);
  await writeScenario(s);
  expect(await publish()).toMatchObject({
    status: "partial",
    missingPeriods: [5],
  });
  const row = await period("NI", 5);
  expect(row?.load_mwh).toBeNull();
  expect(row?.residual_mwh).toBeNull();
  expect(row?.residual_pct_of_load).toBeNull();
  expect(num(row?.load_intervals)).toBe(0);
  expect(row?.inputs_complete).toBe(false);
  // Generation is still known, and the day sums only when every period has the term.
  expect(num(row?.generation_mwh)).toBe(6);
  const d = await day("NI");
  expect(d?.load_mwh).toBeNull();
  expect(d?.residual_mwh).toBeNull();
  expect(num(d?.generation_mwh)).toBe(288);
  expect(d?.inputs_complete).toBe(false);
});

test("an island with no generation row has null generation, not 0", async () => {
  const s = base();
  s.fuel = s.fuel.filter((f) => !(f.period === 6 && f.island === "SI"));
  await writeScenario(s);
  await publish();
  const row = await period("SI", 6);
  expect(row?.generation_mwh).toBeNull();
  expect(row?.residual_mwh).toBeNull();
  expect(row?.inputs_complete).toBe(false);
  expect(num((await period("NI", 6))?.residual_mwh)).toBe(2);
});

test("a southward period gives the South Island a positive import", async () => {
  const s = base();
  const link = s.hvdc.find((h) => h.period === 8);
  if (link) Object.assign(link, { northReceived: -2.0, southSent: -2.2 });
  await writeScenario(s);
  await publish();
  expect(num((await period("NI", 8))?.hvdc_import_mwh)).toBe(-2);
  expect(num((await period("SI", 8))?.hvdc_import_mwh)).toBe(2.2);
  expect(num((await period("SI", 8))?.residual_mwh)).toBeCloseTo(
    4 + 2.2 - 2.5,
    12,
  );
});

test("the two island residuals add up to generation - load - link losses", async () => {
  const s = base();
  const link = s.hvdc.find((h) => h.period === 8);
  if (link) Object.assign(link, { northReceived: -2.0, southSent: -2.2 });
  await writeScenario(s);
  await publish();
  const rows = await query(
    `SELECT p.trading_period,
       sum(p.residual_mwh) AS residuals,
       sum(p.generation_mwh) - sum(p.load_mwh) + sum(p.hvdc_import_mwh) AS by_import,
       sum(p.generation_mwh) - sum(p.load_mwh) - any_value(h.losses_mwh) AS by_losses
     FROM ${gold("energy_balance_period")} p
     JOIN ${gold("hvdc_transfer_period")} h USING (trading_period)
     GROUP BY p.trading_period`,
  );
  expect(rows).toHaveLength(48);
  for (const row of rows) {
    expect(num(row.residuals)).toBeCloseTo(num(row.by_import), 9);
    expect(num(row.residuals)).toBeCloseTo(num(row.by_losses), 9);
  }
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
  // The 3 MW is in neither island: the loads are as in the base case.
  expect(num((await period("NI", 9))?.load_mwh)).toBe(5);
  expect(num((await period("SI", 9))?.load_mwh)).toBe(2.5);
  const flags = await query(
    `SELECT DISTINCT inputs_complete FROM ${gold("energy_balance_period")}
     UNION SELECT DISTINCT inputs_complete FROM ${gold("energy_balance_day")}`,
  );
  expect(flags).toEqual([{ inputs_complete: false }]);
});

test("generation with a null island goes to neither row and flags every row of the date", async () => {
  const s = base();
  s.fuel.push({ period: 9, island: null, mwh: 3 });
  await writeScenario(s);
  expect(await publish()).toMatchObject({ status: "partial" });
  expect(num((await period("NI", 9))?.generation_mwh)).toBe(6);
  expect(num((await period("SI", 9))?.generation_mwh)).toBe(4);
  const flags = await query(
    `SELECT DISTINCT inputs_complete FROM ${gold("energy_balance_period")}
     UNION SELECT DISTINCT inputs_complete FROM ${gold("energy_balance_day")}`,
  );
  expect(flags).toEqual([{ inputs_complete: false }]);
});

test("a point of connection that the entity table lacks takes the island of the nodal row", async () => {
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
  expect(await publish()).toMatchObject({ status: "complete" });
  expect(num((await period("SI", 9))?.load_mwh)).toBeCloseTo(
    ((5 * 5 + 11) / 6) * 0.5,
    12,
  );
});

test("with no HVDC partition the date is not wanted and nothing is written", async () => {
  await writeScenario(base());
  await rm(join(goldDir, "hvdc_transfer_period"), { recursive: true });
  expect(await publish()).toEqual({ date: DATE, status: "missing" });
  expect(existsSync(join(goldDir, "energy_balance_period"))).toBe(false);
  expect(
    (
      await energyBalance.wantedVersions?.(
        silverDir,
        completenessView(),
        goldDir,
      )
    )?.has(DATE),
  ).toBe(false);
});

test("the rows carry the analysis version and the wanted fingerprint, and a rerun gives identical bytes", async () => {
  await writeScenario(base());
  await publish();
  const wanted = (
    await energyBalance.wantedVersions?.(silverDir, completenessView(), goldDir)
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

test("the runner skips an up-to-date date, and rebuilds it when an upstream gold fingerprint changes", async () => {
  const s = base();
  await writeScenario(s);
  const run = () =>
    runPublish({
      bronzeDir,
      silverDir,
      goldDir,
      only: ["gold_energy_balance"],
    }).then((x) => x[0]);
  expect(await run()).toMatchObject({ published: 1, upToDate: 0, failed: [] });
  expect(await run()).toMatchObject({ published: 0, upToDate: 1 });
  // Upstream gold is rebuilt: a new fingerprint on the generation and HVDC tables.
  await writeUpstream(s, DATE, "upstream-2");
  expect(await run()).toMatchObject({ published: 1, upToDate: 0 });
});

// ---------------------------------------------------------------------------------------------
// DST days, from the real silver fixtures: the repeated hour of 5 April has to be keyed by UTC.
// ---------------------------------------------------------------------------------------------

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

async function buildFixtureDay(date: string, month: string) {
  await archive(
    "network_supply_points",
    "network-supply-points",
    "20260106_NetworkSupplyPointsTable.csv",
    ["2026-01-06"],
  );
  await archive(
    "generation_md",
    "generation-md",
    `${month}_Generation_MD.csv`,
    [date],
  );
  await archive("hvdc_flows", "hvdc-flows", `${month}_HVDC_flows.csv`, [date]);
  await archive(
    "nodal_prices_and_volumes",
    "nodal-prices-and-volumes",
    `${date.replaceAll("-", "")}_DispatchNodalPricesAndVolumes.csv`,
    [date],
  );
  const args = { bronzeDir, silverDir, date };
  await publishNetworkSupplyPoints({ ...args, date: "2026-01-06" });
  await publishGenerationMd(args);
  await publishHvdcFlows(args);
  await publishNodalPricesAndVolumes(args);
  await publishEntityMappings({ silverDir, date });
  const view = completenessView();
  await publishGeneration({ silverDir, goldDir, completeness: view, date });
  await publishHvdc({ silverDir, goldDir, completeness: view, date });
}

for (const [date, month, periods] of [
  ["2026-04-05", "202604", 50],
  ["2026-09-27", "202609", 46],
] as const) {
  test(`${date} has ${periods} periods, and each period counts the intervals that its UTC span holds`, {
    timeout: 60_000,
  }, async () => {
    await buildFixtureDay(date, month);
    expect(await publish(date)).toMatchObject({ rows: periods * 2 });
    const [count] = await query(
      `SELECT count(DISTINCT trading_period) AS n FROM ${gold("energy_balance_period", date)}`,
    );
    expect(num(count?.n)).toBe(periods);
    // The same 5-minute intervals, counted from silver by UTC start, for each period.
    const mismatches = await query(
      `SELECT p.trading_period, p.load_intervals, s.n
       FROM ${gold("energy_balance_period", date)} p
       LEFT JOIN (
         SELECT trading_period, count(DISTINCT event_start_utc) AS n
         FROM '$S/nodal_prices_and_volumes/trading_date=${date}/data.parquet'
         GROUP BY trading_period) s USING (trading_period)
       WHERE p.island = 'NI' AND p.load_intervals <> coalesce(s.n, 0)`,
    );
    expect(mismatches).toEqual([]);
    // The day sums every period, so it has a term when all of them have load.
    const [dayRow] = await query(
      `SELECT count(*) FILTER (WHERE load_mwh IS NULL) AS nulls
       FROM ${gold("energy_balance_period", date)} WHERE island = 'NI'`,
    );
    const d = await day("NI", date);
    expect(d?.load_mwh === null).toBe(num(dayRow?.nulls) > 0);
    // A period of the repeated hour (5 April, local 02:00 to 03:00) has its own UTC span.
    if (periods === 50) {
      const repeated = await query(
        `SELECT trading_period, load_intervals FROM ${gold("energy_balance_period", date)}
         WHERE island = 'NI' AND trading_period BETWEEN 5 AND 8 ORDER BY 1`,
      );
      expect(repeated).toHaveLength(4);
      for (const row of repeated)
        expect(num(row.load_intervals)).toBeGreaterThan(0);
    }
  });
}

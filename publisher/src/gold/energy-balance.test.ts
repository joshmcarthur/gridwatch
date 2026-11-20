import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runPublish } from "../runner.ts";
import { goldPartitionPath } from "./common.ts";
import {
  ANALYSIS_VERSION,
  energyBalance,
  publishEnergyBalance,
  TABLES,
} from "./energy-balance.ts";
import { completenessView } from "./fixtures/completeness.ts";
import { writeParquet } from "./fixtures/parquet.ts";

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
  complete?: boolean;
}
interface Load {
  period: number;
  island: string;
  mwh: number | null;
  intervals?: number;
  complete?: boolean;
}
interface Scenario {
  fuel: Fuel[];
  hvdc: Hvdc[];
  load: Load[];
}

/**
 * The base case: each island generates 6 MWh (NI) and 4 MWh (SI) in a period. NI load is 5 MWh
 * and SI load is 2.5 MWh. The link receives 1.0 MWh in the north and sends 1.2 MWh from the
 * south. By hand, for every period: NI import 1.0, SI import -1.2, NI residual 6 + 1 - 5 = 2.0,
 * SI residual 4 - 1.2 - 2.5 = 0.3, link losses 0.2.
 */
function base(periods = 48): Scenario {
  const range = Array.from({ length: periods }, (_, i) => i + 1);
  return {
    fuel: range.flatMap((period) => [
      { period, island: "NI", mwh: 6 },
      { period, island: "SI", mwh: 4 },
    ]),
    hvdc: range.map((period) => ({
      period,
      northReceived: 1.0,
      southSent: 1.2,
    })),
    load: range.flatMap((period) => [
      { period, island: "NI", mwh: 5, intervals: 6 },
      { period, island: "SI", mwh: 2.5, intervals: 6 },
    ]),
  };
}

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
      losses_mwh: h.southSent - h.northReceived,
      inputs_complete: h.complete ?? true,
      inputs_sha256: `${sha}-hvdc`,
    })),
  );
  await writeParquet(
    goldPartitionPath(goldDir, "grid_load_period", date),
    {
      trading_date: "DATE",
      trading_period: "INTEGER",
      island: "VARCHAR",
      load_mwh: "DOUBLE",
      load_intervals: "INTEGER",
      inputs_complete: "BOOLEAN",
      inputs_sha256: "VARCHAR",
    },
    s.load.map((l) => ({
      trading_date: date,
      trading_period: l.period,
      island: l.island,
      load_mwh: l.mwh,
      load_intervals: l.intervals ?? 6,
      inputs_complete: l.complete ?? true,
      inputs_sha256: `${sha}-load`,
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
  await writeUpstream(base());
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
  const d = await day("NI");
  expect(num(d?.generation_mwh)).toBe(288);
  expect(num(d?.load_mwh)).toBe(240);
  expect(num(d?.residual_mwh)).toBe(96);
  expect(d?.inputs_complete).toBe(true);
});

test("an island with no generation row has null generation, not 0", async () => {
  const s = base();
  s.fuel = s.fuel.filter((f) => !(f.period === 6 && f.island === "SI"));
  await writeUpstream(s);
  await publish();
  const row = await period("SI", 6);
  expect(row?.generation_mwh).toBeNull();
  expect(row?.residual_mwh).toBeNull();
  expect(row?.inputs_complete).toBe(false);
  expect(num((await period("NI", 6))?.residual_mwh)).toBe(2);
});

test("an island with no load row has null load, not 0", async () => {
  const s = base();
  s.load = s.load.filter((l) => !(l.period === 6 && l.island === "SI"));
  await writeUpstream(s);
  await publish();
  const row = await period("SI", 6);
  expect(row?.load_mwh).toBeNull();
  expect(row?.residual_mwh).toBeNull();
  expect(row?.inputs_complete).toBe(false);
  expect(num((await period("NI", 6))?.residual_mwh)).toBe(2);
});

test("a southward period gives the South Island a positive import", async () => {
  const s = base();
  const link = s.hvdc.find((h) => h.period === 8);
  if (link) Object.assign(link, { northReceived: -2.0, southSent: -2.2 });
  await writeUpstream(s);
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
  await writeUpstream(s);
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

test("generation with a null island goes to neither row and flags every row of the date", async () => {
  const s = base();
  s.fuel.push({ period: 9, island: null, mwh: 3 });
  await writeUpstream(s);
  expect(await publish()).toMatchObject({ status: "partial" });
  expect(num((await period("NI", 9))?.generation_mwh)).toBe(6);
  expect(num((await period("SI", 9))?.generation_mwh)).toBe(4);
  const flags = await query(
    `SELECT DISTINCT inputs_complete FROM ${gold("energy_balance_period")}
     UNION SELECT DISTINCT inputs_complete FROM ${gold("energy_balance_day")}`,
  );
  expect(flags).toEqual([{ inputs_complete: false }]);
});

test("an incomplete grid-load row flags the energy-balance row", async () => {
  const s = base();
  const load = s.load.find((l) => l.period === 9 && l.island === "NI");
  if (load) load.complete = false;
  await writeUpstream(s);
  expect(await publish()).toMatchObject({ status: "partial" });
  expect((await period("NI", 9))?.inputs_complete).toBe(false);
  expect((await period("SI", 9))?.inputs_complete).toBe(true);
});

test("with no HVDC partition the date is not wanted and nothing is written", async () => {
  await writeUpstream(base());
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

test("with no grid_load partition the date is not wanted", async () => {
  await writeUpstream(base());
  await rm(join(goldDir, "grid_load_period"), { recursive: true });
  expect(await publish()).toEqual({ date: DATE, status: "missing" });
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
  await writeUpstream(base());
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
  await writeUpstream(s);
  const run = () =>
    runPublish({
      bronzeDir,
      silverDir,
      goldDir,
      only: ["gold_energy_balance"],
    }).then((x) => x[0]);
  expect(await run()).toMatchObject({ published: 1, upToDate: 0, failed: [] });
  expect(await run()).toMatchObject({ published: 0, upToDate: 1 });
  await writeUpstream(s, DATE, "upstream-2");
  expect(await run()).toMatchObject({ published: 1, upToDate: 0 });
});

test("a period with null load has null residual, and null day terms and flag", async () => {
  const s = base();
  const load = s.load.find((l) => l.period === 5 && l.island === "NI");
  if (load) Object.assign(load, { mwh: null, intervals: 0, complete: false });
  await writeUpstream(s);
  expect(await publish()).toMatchObject({
    status: "partial",
    missingPeriods: [5],
  });
  const row = await period("NI", 5);
  expect(row?.load_mwh).toBeNull();
  expect(row?.residual_mwh).toBeNull();
  expect(row?.residual_pct_of_load).toBeNull();
  expect(row?.inputs_complete).toBe(false);
  expect(num(row?.generation_mwh)).toBe(6);
  const d = await day("NI");
  expect(d?.load_mwh).toBeNull();
  expect(d?.residual_mwh).toBeNull();
  expect(num(d?.generation_mwh)).toBe(288);
  expect(d?.inputs_complete).toBe(false);
});

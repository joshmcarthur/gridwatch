import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, expect, test } from "vitest";
import { lit } from "../silver/common.ts";
import { periodsInTradingDate, periodToUtc } from "../trading-time.ts";
import { goldPartitionPath } from "./common.ts";
import { completenessView } from "./fixtures/completeness.ts";
import {
  ANALYSIS_VERSION,
  FUEL_GENERATION_CHANGE_CONFIG,
  FUEL_TABLES,
  type FuelGenerationChangeConfig,
  fuelGenerationChange,
  PLANT_GENERATION_CHANGE_CONFIG,
  PLANT_TABLES,
  type PlantGenerationChangeConfig,
  plantGenerationChange,
  plantGenerationChangeDataset,
  publishFuelGenerationChange,
  publishPlantGenerationChange,
} from "./generation-change.ts";
import { OBSERVATION_COLUMNS } from "./observation.ts";

const HYDRO = "ARI/arapuni";
const SOLAR = "KPO/kapuni_solar";
const SMALL = "TINY/creek";
const BATTERY_PLANT = "HLY/battery";
const BASE = "2026-11-10";
const DAY = "2026-11-11";

const plantTestConfig: PlantGenerationChangeConfig = {
  baselineWindowDays: 1,
  minBaselinePeriods: 1,
  highPercentile: 0.75,
  lowPercentile: 0.25,
  minDeviationFromMedian: 30,
  minPeriods: 2,
  baselineByTradingPeriod: true,
  minPlantAverageMw: 30,
};

const fuelTestConfig: FuelGenerationChangeConfig = {
  baselineWindowDays: 1,
  minBaselinePeriods: 1,
  highPercentile: 0.75,
  lowPercentile: 0.25,
  minDeviationFromMedian: 100,
  minPeriods: 2,
  baselineByTradingPeriod: true,
};

let root: string;
let silverDir: string;
let goldDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-generation-change-"));
  silverDir = join(root, "silver");
  goldDir = join(root, "gold");
});
afterEach(() => rm(root, { recursive: true, force: true }));

interface PlantSpec {
  plantId: string;
  plantName: string;
  fuelCategory: string;
  island: "NI" | "SI" | null;
  mw: (period: number) => number | null;
}

interface FuelSpec {
  fuelCategory: string;
  island: "NI" | "SI" | null;
  mw: (period: number) => number | null;
}

interface DayOptions {
  complete?: boolean;
  sha?: string;
}

async function withConnection<T>(
  use: (
    connection: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  ) => Promise<T>,
): Promise<T> {
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    return await use(connection);
  } finally {
    connection.closeSync();
  }
}

const stamp = (options: DayOptions) =>
  `${ANALYSIS_VERSION}::INTEGER, ${lit(options.sha ?? "sha-a")}, ${options.complete ?? true}`;

async function writePlantDay(
  date: string,
  plants: PlantSpec[],
  options: DayOptions = {},
) {
  const rows: string[] = [];
  for (const plant of plants) {
    for (let period = 1; period <= periodsInTradingDate(date); period++) {
      const mw = plant.mw(period);
      const mwSql = mw === null ? "NULL::DOUBLE" : `${mw}::DOUBLE`;
      const mwhSql = mw === null ? "NULL::DOUBLE" : `${mw / 2}::DOUBLE`;
      const islandSql =
        plant.island === null ? "NULL::VARCHAR" : lit(plant.island);
      const span = periodToUtc(date, period);
      rows.push(
        `(${lit(date)}::DATE, ${period}::INTEGER,
          ${lit(span.eventStartUtc.toString())}::TIMESTAMPTZ, ${lit(span.eventEndUtc.toString())}::TIMESTAMPTZ,
          ${lit(plant.plantId)}, ${lit(plant.plantName)}, ${lit(plant.fuelCategory)}, ${islandSql},
          ${mwhSql}, ${mwSql}, ${stamp(options)})`,
      );
    }
  }
  const path = goldPartitionPath(goldDir, "generation_by_plant_period", date);
  await mkdir(join(path, ".."), { recursive: true });
  await withConnection((c) =>
    c.run(
      `COPY (SELECT * FROM (VALUES ${rows.join(",")}) t(trading_date, trading_period,
         event_start_utc, event_end_utc, plant_id, plant_name, fuel_category, island,
         megawatt_hours, average_megawatts, analysis_version, inputs_sha256, inputs_complete))
       TO ${lit(path)} (FORMAT parquet)`,
    ),
  );
}

async function writeFuelDay(
  date: string,
  fuels: FuelSpec[],
  options: DayOptions = {},
) {
  const rows: string[] = [];
  for (const fuel of fuels) {
    for (let period = 1; period <= periodsInTradingDate(date); period++) {
      const mw = fuel.mw(period);
      const mwSql = mw === null ? "NULL::DOUBLE" : `${mw}::DOUBLE`;
      const mwhSql = mw === null ? "NULL::DOUBLE" : `${mw / 2}::DOUBLE`;
      const islandSql =
        fuel.island === null ? "NULL::VARCHAR" : lit(fuel.island);
      const span = periodToUtc(date, period);
      rows.push(
        `(${lit(date)}::DATE, ${period}::INTEGER,
          ${lit(span.eventStartUtc.toString())}::TIMESTAMPTZ, ${lit(span.eventEndUtc.toString())}::TIMESTAMPTZ,
          ${lit(fuel.fuelCategory)}, ${islandSql},
          ${mwhSql}, ${mwSql}, ${stamp(options)})`,
      );
    }
  }
  const path = goldPartitionPath(goldDir, "generation_by_fuel_period", date);
  await mkdir(join(path, ".."), { recursive: true });
  await withConnection((c) =>
    c.run(
      `COPY (SELECT * FROM (VALUES ${rows.join(",")}) t(trading_date, trading_period,
         event_start_utc, event_end_utc, fuel_category, island,
         megawatt_hours, average_megawatts, analysis_version, inputs_sha256, inputs_complete))
       TO ${lit(path)} (FORMAT parquet)`,
    ),
  );
}

const rowsOf = (table: string, date: string) =>
  withConnection(
    async (c) =>
      (
        await c.runAndReadAll(
          `SELECT * FROM read_parquet(${lit(join(goldDir, table, `trading_date=${date}`, "data.parquet"))})`,
        )
      ).getRowObjectsJson() as Array<Record<string, unknown>>,
  );

const observationsOf = (tables: readonly [string, string], date: string) =>
  withConnection(
    async (c) =>
      (
        await c.runAndReadAll(
          `SELECT * REPLACE (
           strftime(event_start_utc, '%Y-%m-%dT%H:%M:%SZ') AS event_start_utc,
           strftime(event_end_utc, '%Y-%m-%dT%H:%M:%SZ') AS event_end_utc)
         FROM read_parquet(${lit(join(goldDir, tables[1], `trading_date=${date}`, "data.parquet"))})
         ORDER BY observation_type, subject_id, start_trading_period`,
        )
      ).getRowObjectsJson() as Array<Record<string, unknown>>,
  );

const publishPlant = (
  date: string,
  config: PlantGenerationChangeConfig = plantTestConfig,
) =>
  publishPlantGenerationChange(
    { silverDir, goldDir, completeness: completenessView(), date },
    config,
  );

const publishFuel = (
  date: string,
  config: FuelGenerationChangeConfig = fuelTestConfig,
) =>
  publishFuelGenerationChange(
    { silverDir, goldDir, completeness: completenessView(), date },
    config,
  );

const hydro = (mw: number | ((period: number) => number)): PlantSpec => ({
  plantId: HYDRO,
  plantName: "Arapuni",
  fuelCategory: "hydro",
  island: "NI",
  mw: typeof mw === "number" ? () => mw : mw,
});

const solar = (mw: (period: number) => number): PlantSpec => ({
  plantId: SOLAR,
  plantName: "Kapuni solar",
  fuelCategory: "solar",
  island: "NI",
  mw,
});

const small = (mw: number | ((period: number) => number)): PlantSpec => ({
  plantId: SMALL,
  plantName: "Tiny creek",
  fuelCategory: "hydro",
  island: "SI",
  mw: typeof mw === "number" ? () => mw : mw,
});

const battery = (mw: number): PlantSpec => ({
  plantId: BATTERY_PLANT,
  plantName: "Huntly battery",
  fuelCategory: "battery",
  island: "NI",
  mw: () => mw,
});

/** Night (1–16) at 0 MW, day (17–36) at `dayMw`, evening (37–48) at 0. */
const solarShape = (dayMw: number) => (period: number) =>
  period >= 17 && period <= 36 ? dayMw : 0;

test("a plant drop versus its own same-period history is a generation_low run", async () => {
  await writePlantDay(BASE, [hydro(200)]);
  await writePlantDay(DAY, [
    hydro((period) => (period === 20 || period === 21 ? 50 : 200)),
  ]);
  expect(await publishPlant(DAY)).toMatchObject({ status: "complete" });
  const observations = await observationsOf(PLANT_TABLES, DAY);
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({
    detector_id: "plant_generation_change",
    observation_type: "generation_low",
    trading_date: DAY,
    start_trading_period: 20,
    end_trading_period: 21,
    period_count: 2,
    subject_type: "plant",
    subject_id: HYDRO,
    plant_id: HYDRO,
    island: "NI",
    fuel_category: "hydro",
    point_of_connection: null,
    price_region: null,
    measured_value: 50,
    measured_unit: "MW",
    baseline_value: 200,
    threshold_value: 170,
    baseline_sample_count: 1,
    baseline_window_start: BASE,
    baseline_window_end: BASE,
    analysis_version: ANALYSIS_VERSION,
    inputs_complete: true,
    input_tables: ["gold/generation_by_plant_period"],
  });
  expect(observations[0]?.severity).toBeCloseTo(150 / 30, 12);
  expect(observations[0]?.observation_id).toMatch(/^[0-9a-f]{16}$/);
});

test("a plant whose baseline mean is below the size cutoff is not a subject", async () => {
  await writePlantDay(BASE, [hydro(200), small(5), battery(80)]);
  await writePlantDay(DAY, [
    hydro((period) => (period === 20 || period === 21 ? 50 : 200)),
    small(0),
    battery(0),
  ]);
  await publishPlant(DAY);
  const observations = await observationsOf(PLANT_TABLES, DAY);
  expect(observations.map((o) => o.subject_id)).toEqual([HYDRO]);
  const subjects = [
    ...new Set((await rowsOf(PLANT_TABLES[0], DAY)).map((r) => r.subject_id)),
  ];
  expect(subjects).toEqual([HYDRO]);
});

test("a solar-style night zero does not fire when the baseline is period-matched", async () => {
  await writePlantDay(BASE, [solar(solarShape(200))]);
  await writePlantDay(DAY, [
    solar((period) => {
      if (period === 20 || period === 21) return 40;
      return solarShape(200)(period);
    }),
  ]);
  await publishPlant(DAY);
  const observations = await observationsOf(PLANT_TABLES, DAY);
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({
    observation_type: "generation_low",
    subject_id: SOLAR,
    start_trading_period: 20,
    end_trading_period: 21,
    measured_value: 40,
  });
  expect(
    observations.some(
      (o) =>
        Number(o.start_trading_period) <= 16 ||
        Number(o.start_trading_period) >= 37,
    ),
  ).toBe(false);
});

test("an incomplete input is flagged on the observation; a missing partition writes nothing", async () => {
  await writePlantDay(BASE, [hydro(200)]);
  await writePlantDay(
    DAY,
    [hydro((period) => (period === 20 || period === 21 ? 50 : 200))],
    { complete: false },
  );
  expect(await publishPlant(DAY)).toMatchObject({
    status: "partial",
    missingPeriods: [],
  });
  const [observation] = await observationsOf(PLANT_TABLES, DAY);
  expect(observation).toMatchObject({
    subject_id: HYDRO,
    inputs_complete: false,
  });

  expect(await publishPlant("2026-11-18")).toEqual({
    date: "2026-11-18",
    status: "missing",
  });
  expect(
    existsSync(join(goldDir, PLANT_TABLES[0], "trading_date=2026-11-18")),
  ).toBe(false);
});

test("fuel: an island-fuel drop is a run; battery and a null island are not subjects", async () => {
  await writeFuelDay(BASE, [
    { fuelCategory: "hydro", island: "NI", mw: () => 500 },
    { fuelCategory: "battery", island: "NI", mw: () => 200 },
    { fuelCategory: "hydro", island: null, mw: () => 400 },
  ]);
  await writeFuelDay(DAY, [
    {
      fuelCategory: "hydro",
      island: "NI",
      mw: (period) => (period === 10 || period === 11 ? 200 : 500),
    },
    { fuelCategory: "battery", island: "NI", mw: () => 0 },
    { fuelCategory: "hydro", island: null, mw: () => 0 },
  ]);
  expect(await publishFuel(DAY)).toMatchObject({ status: "complete" });
  const observations = await observationsOf(FUEL_TABLES, DAY);
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({
    detector_id: "fuel_generation_change",
    observation_type: "generation_low",
    subject_type: "fuel_category",
    subject_id: "hydro|NI",
    fuel_category: "hydro",
    island: "NI",
    plant_id: null,
    point_of_connection: null,
    price_region: null,
    measured_value: 200,
    measured_unit: "MW",
    baseline_value: 500,
    threshold_value: 400,
    input_tables: ["gold/generation_by_fuel_period"],
  });
  const subjects = [
    ...new Set((await rowsOf(FUEL_TABLES[0], DAY)).map((r) => r.subject_id)),
  ];
  expect(subjects).toEqual(["hydro|NI"]);
});

test("wanted and written fingerprints are the same function", async () => {
  await writePlantDay(BASE, [hydro(200)], { sha: "sha-a" });
  await writePlantDay(
    DAY,
    [hydro((period) => (period === 20 || period === 21 ? 50 : 200))],
    { sha: "sha-b" },
  );
  await publishPlant(DAY);
  const written = (await rowsOf(PLANT_TABLES[0], DAY))[0]?.inputs_sha256;
  const wanted = await plantGenerationChangeDataset(
    plantTestConfig,
  ).wantedVersions?.(silverDir, completenessView(), goldDir);
  expect(written).toEqual(expect.any(String));
  expect(wanted?.get(DAY)).toBe(written);
});

test("every observation records the parameters, and the table has the columns of OBSERVATION_COLUMNS", async () => {
  await writePlantDay(BASE, [hydro(200)]);
  await writePlantDay(DAY, [
    hydro((period) => (period === 20 || period === 21 ? 50 : 200)),
  ]);
  await publishPlant(DAY);
  const observations = await observationsOf(PLANT_TABLES, DAY);
  expect(observations.length).toBeGreaterThan(0);
  for (const o of observations)
    expect(o.parameters).toBe(JSON.stringify(plantTestConfig));
  const columns = await withConnection(
    async (c) =>
      (
        await c.runAndReadAll(
          `DESCRIBE SELECT * FROM read_parquet(${lit(join(goldDir, PLANT_TABLES[1], `trading_date=${DAY}`, "data.parquet"))})`,
        )
      ).getRowObjectsJson() as Array<{ column_name: string }>,
  );
  expect(columns.map((c) => c.column_name)).toEqual([...OBSERVATION_COLUMNS]);
});

test("the default configs are pinned: a changed value without an ANALYSIS_VERSION bump fails here", () => {
  expect(ANALYSIS_VERSION).toBe(1);
  expect(
    createHash("sha256")
      .update(JSON.stringify(PLANT_GENERATION_CHANGE_CONFIG))
      .digest("hex"),
  ).toBe("54ac98ca4511c6135962545392d03139e9d20baf0895437ad6b1823257560b17");
  expect(
    createHash("sha256")
      .update(JSON.stringify(FUEL_GENERATION_CHANGE_CONFIG))
      .digest("hex"),
  ).toBe("92d52785dab47a150f27a19f3a41a9747f9611cfff6f30b10be805d6f91c0429");
});

test("the registry entries and the TABLES order: the runner reads the first table, the sentinel", () => {
  expect(plantGenerationChange).toMatchObject({
    id: "gold_plant_generation_change",
    table: PLANT_TABLES[0],
    partitionKey: "trading_date",
    versionColumn: "inputs_sha256",
  });
  expect(fuelGenerationChange).toMatchObject({
    id: "gold_fuel_generation_change",
    table: FUEL_TABLES[0],
    partitionKey: "trading_date",
    versionColumn: "inputs_sha256",
  });
  expect(PLANT_TABLES).toEqual([
    "plant_generation_change_baselines",
    "observations_plant_generation_change",
  ]);
  expect(FUEL_TABLES).toEqual([
    "fuel_generation_change_baselines",
    "observations_fuel_generation_change",
  ]);
});

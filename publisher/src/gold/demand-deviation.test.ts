import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, expect, test } from "vitest";
import { lit } from "../silver/common.ts";
import { periodsInTradingDate, periodToUtc } from "../trading-time.ts";
import { goldPartitionPath, ISLANDS, type Island } from "./common.ts";
import {
  ANALYSIS_VERSION,
  DEMAND_DEVIATION_CONFIG,
  type DemandDeviationConfig,
  demandDeviation,
  demandDeviationDataset,
  publishDemandDeviation,
  TABLES,
} from "./demand-deviation.ts";
import { completenessView } from "./fixtures/completeness.ts";
import { OBSERVATION_COLUMNS } from "./observation.ts";

const PREV_WEDNESDAY = "2026-11-04";
const TUESDAY = "2026-11-10";
const WEDNESDAY = "2026-11-11";
const DST_SUNDAY = "2026-09-27";
const PREV_DST_SUNDAY = "2026-09-20";
const DST_END = "2026-04-05";
const PREV_DST_END_SUNDAY = "2026-03-29";

/** One prior same weekday is enough. The 50 MWh floor is the production floor. */
const testConfig: DemandDeviationConfig = {
  baselineWindowDays: 7,
  minBaselinePeriods: 1,
  highPercentile: 0.99,
  lowPercentile: 0.01,
  minDeviationFromMedian: 50,
  minPeriods: 2,
  baselineByTradingPeriod: true,
  baselineSameWeekday: true,
};

let root: string;
let silverDir: string;
let goldDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-demand-deviation-"));
  silverDir = join(root, "silver");
  goldDir = join(root, "gold");
});
afterEach(() => rm(root, { recursive: true, force: true }));

interface DayOptions {
  complete?: (island: Island, period: number) => boolean;
  sha?: string;
}

interface IslandLoad {
  island: Island;
  load: (period: number) => number | null;
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

async function writeLoadDay(
  date: string,
  islands: IslandLoad[],
  options: DayOptions = {},
) {
  const byIsland = new Map(islands.map((row) => [row.island, row]));
  const rows: string[] = [];
  for (const island of ISLANDS) {
    const spec = byIsland.get(island);
    for (let period = 1; period <= periodsInTradingDate(date); period++) {
      const load = spec?.load(period) ?? null;
      const loadSql = load === null ? "NULL::DOUBLE" : `${load}::DOUBLE`;
      const complete = options.complete?.(island, period) ?? true;
      const span = periodToUtc(date, period);
      rows.push(
        `(${lit(date)}::DATE, ${period}::INTEGER,
          ${lit(span.eventStartUtc.toString())}::TIMESTAMPTZ, ${lit(span.eventEndUtc.toString())}::TIMESTAMPTZ,
          ${lit(island)}, ${loadSql}, 6::INTEGER, 1::INTEGER, ${lit(options.sha ?? "sha-a")}, ${complete})`,
      );
    }
  }
  const path = goldPartitionPath(goldDir, "grid_load_period", date);
  await mkdir(join(path, ".."), { recursive: true });
  await withConnection((c) =>
    c.run(
      `COPY (SELECT * FROM (VALUES ${rows.join(",")}) t(trading_date, trading_period,
         event_start_utc, event_end_utc, island, load_mwh, load_intervals,
         analysis_version, inputs_sha256, inputs_complete))
       TO ${lit(path)} (FORMAT parquet)`,
    ),
  );
}

const both = (
  load: number | ((period: number) => number | null),
): IslandLoad[] =>
  ISLANDS.map((island) => ({
    island,
    load: typeof load === "number" ? () => load : load,
  }));

const niSi = (
  ni: number | ((period: number) => number | null),
  si: number | ((period: number) => number | null),
): IslandLoad[] => [
  { island: "NI", load: typeof ni === "number" ? () => ni : ni },
  { island: "SI", load: typeof si === "number" ? () => si : si },
];

const spike =
  (base: number, high: number, periods: Set<number>) => (period: number) =>
    periods.has(period) ? high : base;

const rowsOf = (table: string, date: string) =>
  withConnection(
    async (c) =>
      (
        await c.runAndReadAll(
          `SELECT * FROM read_parquet(${lit(join(goldDir, table, `trading_date=${date}`, "data.parquet"))})`,
        )
      ).getRowObjectsJson() as Array<Record<string, unknown>>,
  );

const observationsOf = (date: string) =>
  withConnection(
    async (c) =>
      (
        await c.runAndReadAll(
          `SELECT * REPLACE (
           strftime(event_start_utc, '%Y-%m-%dT%H:%M:%SZ') AS event_start_utc,
           strftime(event_end_utc, '%Y-%m-%dT%H:%M:%SZ') AS event_end_utc)
         FROM read_parquet(${lit(join(goldDir, TABLES[1], `trading_date=${date}`, "data.parquet"))})
         ORDER BY observation_type, subject_id, start_trading_period`,
        )
      ).getRowObjectsJson() as Array<Record<string, unknown>>,
  );

const publish = (date: string, config: DemandDeviationConfig = testConfig) =>
  publishDemandDeviation(
    { silverDir, goldDir, completeness: completenessView(), date },
    config,
  );

test("a high run versus the same weekday and period is a demand_high observation", async () => {
  await writeLoadDay(PREV_WEDNESDAY, both(1000));
  await writeLoadDay(TUESDAY, both(5000));
  await writeLoadDay(WEDNESDAY, both(spike(1000, 2000, new Set([20, 21]))));
  expect(await publish(WEDNESDAY)).toMatchObject({ status: "complete" });
  const observations = await observationsOf(WEDNESDAY);
  expect(observations).toHaveLength(3);
  expect(observations.map((o) => o.subject_id)).toEqual(["NI", "NZ", "SI"]);
  expect(observations[0]).toMatchObject({
    detector_id: "demand_deviation",
    observation_type: "demand_high",
    trading_date: WEDNESDAY,
    start_trading_period: 20,
    end_trading_period: 21,
    period_count: 2,
    subject_type: "island",
    subject_id: "NI",
    island: "NI",
    point_of_connection: null,
    price_region: null,
    plant_id: null,
    fuel_category: null,
    reserve_class: null,
    measured_value: 2000,
    measured_unit: "MWh",
    baseline_value: 1000,
    threshold_value: 1050,
    baseline_sample_count: 1,
    baseline_window_start: "2026-11-04",
    baseline_window_end: "2026-11-10",
    analysis_version: ANALYSIS_VERSION,
    inputs_complete: true,
    input_tables: ["gold/grid_load_period"],
  });
  expect(observations[0]?.severity).toBeCloseTo(1000 / 50, 12);
  expect(observations[0]?.observation_id).toMatch(/^[0-9a-f]{16}$/);
  expect(observations.find((o) => o.subject_id === "NZ")).toMatchObject({
    island: null,
    measured_value: 4000,
    baseline_value: 2000,
    threshold_value: 2050,
  });
});

test("a low run is a demand_low observation with a mirrored threshold", async () => {
  await writeLoadDay(PREV_WEDNESDAY, both(1000));
  await writeLoadDay(WEDNESDAY, both(spike(1000, 100, new Set([30, 31]))));
  await publish(WEDNESDAY);
  const observations = await observationsOf(WEDNESDAY);
  expect(observations).toHaveLength(3);
  expect(observations[0]).toMatchObject({
    observation_type: "demand_low",
    subject_id: "NI",
    start_trading_period: 30,
    end_trading_period: 31,
    measured_value: 100,
    baseline_value: 1000,
    threshold_value: 950,
  });
  expect(observations[0]?.severity).toBeCloseTo(900 / 50, 12);
});

test("a Tuesday of the same period is not in a Wednesday baseline", async () => {
  await writeLoadDay(PREV_WEDNESDAY, both(1000));
  await writeLoadDay(TUESDAY, both(5000));
  await writeLoadDay(WEDNESDAY, both(spike(1000, 2000, new Set([20, 21]))));
  await publish(WEDNESDAY, { ...testConfig, baselineSameWeekday: undefined });
  const observations = await observationsOf(WEDNESDAY);
  expect(
    observations.filter((o) => o.observation_type === "demand_high"),
  ).toEqual([]);
});

test("NZ is the sum of the islands and is null when either island load is null", async () => {
  await writeLoadDay(PREV_WEDNESDAY, niSi(1000, 400));
  await writeLoadDay(
    WEDNESDAY,
    niSi(spike(1000, 1200, new Set([20, 21])), (period) =>
      period === 20 || period === 21 ? null : 400,
    ),
  );
  await publish(WEDNESDAY);
  const observations = await observationsOf(WEDNESDAY);
  expect(observations.map((o) => o.subject_id)).toEqual(["NI"]);
  expect(observations[0]).toMatchObject({
    observation_type: "demand_high",
    measured_value: 1200,
  });
});

test("an incomplete island-day is dropped from the baseline, not only its incomplete periods", async () => {
  await writeLoadDay("2026-10-28", both(2000), {
    complete: (_island, period) => period !== 1,
  });
  await writeLoadDay(PREV_WEDNESDAY, both(1000));
  await writeLoadDay(WEDNESDAY, both(spike(1000, 2000, new Set([20, 21]))));
  await publish(WEDNESDAY, { ...testConfig, baselineWindowDays: 14 });
  const observations = await observationsOf(WEDNESDAY);
  expect(observations).toHaveLength(3);
  expect(observations[0]).toMatchObject({
    observation_type: "demand_high",
    baseline_value: 1000,
    baseline_sample_count: 1,
  });
});

test("a move inside the 50 MWh floor is not a hit; a run below minPeriods is not an observation", async () => {
  await writeLoadDay(PREV_WEDNESDAY, both(1000));
  await writeLoadDay(
    WEDNESDAY,
    both((period) => {
      if (period === 10 || period === 11) return 1020;
      if (period === 20) return 2000;
      if (period === 22) return 2000;
      return 1000;
    }),
  );
  await publish(WEDNESDAY);
  expect(await observationsOf(WEDNESDAY)).toEqual([]);
});

test("fewer than four same-weekday samples leaves the cell not ready", async () => {
  await writeLoadDay("2026-10-21", both(1000));
  await writeLoadDay("2026-10-28", both(1000));
  await writeLoadDay(PREV_WEDNESDAY, both(1000));
  await writeLoadDay(WEDNESDAY, both(spike(1000, 2000, new Set([20, 21]))));
  const result = await publish(WEDNESDAY, {
    ...testConfig,
    baselineWindowDays: 28,
    minBaselinePeriods: 4,
  });
  expect(result).toMatchObject({ status: "partial" });
  expect(await observationsOf(WEDNESDAY)).toEqual([]);
});

test("an incomplete input is flagged on the observation; a missing partition writes nothing", async () => {
  await writeLoadDay(PREV_WEDNESDAY, both(1000));
  await writeLoadDay(WEDNESDAY, both(spike(1000, 2000, new Set([20, 21]))), {
    complete: () => false,
  });
  expect(await publish(WEDNESDAY)).toMatchObject({
    status: "partial",
    missingPeriods: [],
  });
  const [observation] = await observationsOf(WEDNESDAY);
  expect(observation).toMatchObject({
    subject_id: "NI",
    inputs_complete: false,
  });

  expect(await publish("2026-11-18")).toEqual({
    date: "2026-11-18",
    status: "missing",
  });
  expect(existsSync(join(goldDir, TABLES[0], "trading_date=2026-11-18"))).toBe(
    false,
  );
});

test("DST uses the same period number; extra periods on a DST-end day cannot fire", async () => {
  await writeLoadDay(PREV_DST_SUNDAY, both(1000));
  await writeLoadDay(DST_SUNDAY, both(spike(1000, 2000, new Set([20, 21]))));
  await publish(DST_SUNDAY);
  const spring = await observationsOf(DST_SUNDAY);
  expect(spring).toHaveLength(3);
  expect(spring[0]).toMatchObject({
    start_trading_period: 20,
    end_trading_period: 21,
  });

  await writeLoadDay(PREV_DST_END_SUNDAY, both(1000));
  await writeLoadDay(
    DST_END,
    both((period) => (period >= 49 ? 2000 : 1000)),
  );
  expect(await publish(DST_END)).toMatchObject({ status: "complete" });
  expect(await observationsOf(DST_END)).toEqual([]);
});

test("wanted and written fingerprints are the same function", async () => {
  await writeLoadDay(PREV_WEDNESDAY, both(1000), { sha: "sha-a" });
  await writeLoadDay(WEDNESDAY, both(spike(1000, 2000, new Set([20, 21]))), {
    sha: "sha-b",
  });
  await publish(WEDNESDAY);
  const written = (await rowsOf(TABLES[0], WEDNESDAY))[0]?.inputs_sha256;
  const wanted = await demandDeviationDataset(testConfig).wantedVersions?.(
    silverDir,
    completenessView(),
    goldDir,
  );
  expect(written).toEqual(expect.any(String));
  expect(wanted?.get(WEDNESDAY)).toBe(written);
});

test("every observation records the parameters, and the table has the columns of OBSERVATION_COLUMNS", async () => {
  await writeLoadDay(PREV_WEDNESDAY, both(1000));
  await writeLoadDay(WEDNESDAY, both(spike(1000, 2000, new Set([20, 21]))));
  await publish(WEDNESDAY);
  const observations = await observationsOf(WEDNESDAY);
  expect(observations.length).toBeGreaterThan(0);
  for (const o of observations)
    expect(o.parameters).toBe(JSON.stringify(testConfig));
  const columns = await withConnection(
    async (c) =>
      (
        await c.runAndReadAll(
          `DESCRIBE SELECT * FROM read_parquet(${lit(join(goldDir, TABLES[1], `trading_date=${WEDNESDAY}`, "data.parquet"))})`,
        )
      ).getRowObjectsJson() as Array<{ column_name: string }>,
  );
  expect(columns.map((c) => c.column_name)).toEqual([...OBSERVATION_COLUMNS]);
});

test("the default config is pinned: a changed value without an ANALYSIS_VERSION bump fails here", () => {
  expect(ANALYSIS_VERSION).toBe(1);
  expect(
    createHash("sha256")
      .update(JSON.stringify(DEMAND_DEVIATION_CONFIG))
      .digest("hex"),
  ).toBe("3b6cbc740d93c6a642b66392e2892d275eec9bc765b0fbaece36c5a6c5dcd28a");
});

test("the registry entry and the TABLES order: the runner reads the first table, the sentinel", () => {
  expect(demandDeviation).toMatchObject({
    id: "gold_demand_deviation",
    table: TABLES[0],
    partitionKey: "trading_date",
    versionColumn: "inputs_sha256",
  });
  expect(TABLES).toEqual([
    "demand_deviation_baselines",
    "observations_demand_deviation",
  ]);
});

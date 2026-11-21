import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runPublish } from "../runner.ts";
import { lit } from "../silver/common.ts";
import { periodsInTradingDate, periodToUtc } from "../trading-time.ts";
import { goldPartitionPath } from "./common.ts";
import { completenessView } from "./fixtures/completeness.ts";
import { OBSERVATION_COLUMNS } from "./observation.ts";
import {
  ANALYSIS_VERSION,
  RESERVE_PRICE_ANOMALY_CONFIG,
  RESERVE_SUBJECTS,
  type ReservePriceAnomalyConfig,
  reservePriceAnomaly,
  reservePriceAnomalyDataset,
  TABLES,
} from "./reserve-price-anomaly.ts";

const FIR_NI = "FIR|NI";
const SIR_SI = "SIR|SI";
const BASE = "2026-11-10";
const DAY = "2026-11-11";
const DST_BASE = "2026-09-26";
const DST_DAY = "2026-09-27";

/** Baseline is the day before, so one day of 48 periods gives 48 samples. */
const testConfig: ReservePriceAnomalyConfig = {
  baselineWindowDays: 1,
  minBaselinePeriods: 48,
  highPercentile: 0.75,
  lowPercentile: 0.25,
  minDeviationFromMedian: 5,
  minPeriods: 2,
};

let root: string;
let silverDir: string;
let goldDir: string;
let bronzeDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-reserve-anomaly-"));
  silverDir = join(root, "silver");
  goldDir = join(root, "gold");
  bronzeDir = join(root, "bronze");
});
afterEach(() => rm(root, { recursive: true, force: true }));

interface DayOptions {
  /** Overrides by `FIR|NI:period`. A null price is a missing price. */
  overrides?: Record<string, number | null>;
  /** False for a period of a subject: the input is not complete. */
  complete?: (subjectId: string, period: number) => boolean;
  /** False for a period of a subject that has no price row (rows_present = 0). */
  rowsPresent?: (subjectId: string, period: number) => boolean;
  /** A class-island with no rows at all on the date. */
  skipSubject?: string;
  sha?: string;
}

/** Write the gold `reserve_by_class_island_period` partition of a date for the four subjects. */
async function writeDay(
  date: string,
  base: (subjectId: string, period: number) => number | null,
  options: DayOptions = {},
) {
  const rows: string[] = [];
  for (const subject of RESERVE_SUBJECTS) {
    if (subject.subjectId === options.skipSubject) continue;
    for (let period = 1; period <= periodsInTradingDate(date); period++) {
      const key = `${subject.subjectId}:${period}`;
      const price =
        options.overrides && key in options.overrides
          ? options.overrides[key]
          : base(subject.subjectId, period);
      const priceSql =
        price === null || price === undefined
          ? "NULL::DOUBLE"
          : `${price}::DOUBLE`;
      const complete = options.complete?.(subject.subjectId, period) ?? true;
      const present = options.rowsPresent?.(subject.subjectId, period) ?? true;
      const span = periodToUtc(date, period);
      rows.push(
        `(${lit(date)}::DATE, ${period}::INTEGER,
          ${lit(span.eventStartUtc.toString())}::TIMESTAMPTZ, ${lit(span.eventEndUtc.toString())}::TIMESTAMPTZ,
          ${lit(subject.reserveClass)}, ${lit(subject.island)}, ${priceSql}, ${priceSql}, ${priceSql},
          ${present ? 1 : 0}::INTEGER, ${ANALYSIS_VERSION}::INTEGER, ${lit(options.sha ?? "sha-a")}, ${complete})`,
      );
    }
  }
  const path = goldPartitionPath(
    goldDir,
    "reserve_by_class_island_period",
    date,
  );
  await mkdir(join(path, ".."), { recursive: true });
  await withConnection((c) =>
    c.run(
      `COPY (SELECT * FROM (VALUES ${rows.join(",")}) t(trading_date, trading_period,
         event_start_utc, event_end_utc, reserve_class, island, dollars_per_megawatt_hour, min_price, max_price,
         rows_present, analysis_version, inputs_sha256, inputs_complete))
       TO ${lit(path)} (FORMAT parquet)`,
    ),
  );
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

const rowsOf = (table: string, date: string) =>
  withConnection(
    async (c) =>
      (
        await c.runAndReadAll(
          `SELECT * FROM read_parquet(${lit(join(goldDir, table, `trading_date=${date}`, "data.parquet"))})`,
        )
      ).getRowObjectsJson() as Array<Record<string, unknown>>,
  );

/** Observations of a date, with the UTC instants as text. */
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

const publish = (
  date: string,
  config: ReservePriceAnomalyConfig = testConfig,
  force = true,
) =>
  runPublish({
    bronzeDir,
    silverDir,
    goldDir,
    registry: [reservePriceAnomalyDataset(config)],
    only: ["gold_reserve_price_anomaly"],
    range: { from: date, to: date },
    force,
  }).then((summaries) => {
    const summary = summaries[0];
    if (!summary) throw new Error("expected gold_reserve_price_anomaly");
    return summary;
  });

/** Baseline day: the price of period k is k, for every class and island. */
const ramp = (_subjectId: string, period: number) => period;
const flat = (_subjectId: string, _period: number) => 24.5;

test("a high run is one observation: the run, the thresholds and the severity, and a price at the threshold is not a hit", async () => {
  await writeDay(BASE, ramp);
  await writeDay(DAY, flat, {
    overrides: {
      [`${FIR_NI}:10`]: 40,
      [`${FIR_NI}:11`]: 50,
      [`${FIR_NI}:12`]: 45,
      [`${FIR_NI}:44`]: 36.25,
      [`${FIR_NI}:45`]: 36.25,
    },
  });
  expect(await publish(DAY)).toMatchObject({
    published: 1,
    failed: [],
    partial: [],
  });
  const [observation, ...rest] = await observationsOf(DAY);
  expect(rest).toEqual([]);
  expect(observation).toMatchObject({
    detector_id: "reserve_price_anomaly",
    observation_type: "reserve_price_high",
    trading_date: DAY,
    start_trading_period: 10,
    end_trading_period: 12,
    period_count: 3,
    event_start_utc: "2026-11-10T15:30:00Z",
    event_end_utc: "2026-11-10T17:00:00Z",
    subject_type: "reserve_class",
    subject_id: FIR_NI,
    point_of_connection: null,
    island: "NI",
    reserve_class: "FIR",
    price_region: null,
    measured_value: 50,
    measured_unit: "$/MWh",
    baseline_value: 24.5,
    baseline_sample_count: 48,
    baseline_window_start: BASE,
    baseline_window_end: BASE,
    analysis_version: ANALYSIS_VERSION,
    inputs_complete: true,
  });
  expect(observation?.threshold_value).toBeCloseTo(36.25, 10);
  expect(observation?.severity).toBeCloseTo(25.5 / 11.75, 12);
  expect(observation?.observation_id).toMatch(/^[0-9a-f]{16}$/);
});

test("a low run is one observation with a mirrored threshold and severity", async () => {
  await writeDay(BASE, ramp);
  await writeDay(DAY, flat, {
    overrides: { [`${FIR_NI}:30`]: 10, [`${FIR_NI}:31`]: 5 },
  });
  expect(await publish(DAY)).toMatchObject({ published: 1, partial: [] });
  const observations = await observationsOf(DAY);
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({
    observation_type: "reserve_price_low",
    start_trading_period: 30,
    end_trading_period: 31,
    period_count: 2,
    measured_value: 5,
    baseline_value: 24.5,
    subject_id: FIR_NI,
    reserve_class: "FIR",
    island: "NI",
    event_start_utc: periodToUtc(DAY, 30).eventStartUtc.toString(),
    event_end_utc: periodToUtc(DAY, 31).eventEndUtc.toString(),
  });
  expect(observations[0]?.threshold_value).toBeCloseTo(12.75, 10);
  expect(observations[0]?.severity).toBeCloseTo(19.5 / 11.75, 12);
});

test("a run below minPeriods, and a single period beside a gap, are not observations", async () => {
  await writeDay(BASE, ramp);
  await writeDay(DAY, flat, {
    overrides: {
      [`${FIR_NI}:10`]: 40,
      [`${FIR_NI}:11`]: 50,
      [`${FIR_NI}:12`]: 45,
      [`${FIR_NI}:20`]: 60,
      [`${FIR_NI}:30`]: 10,
      [`${FIR_NI}:31`]: 5,
      [`${FIR_NI}:40`]: 50,
      [`${FIR_NI}:41`]: 24.5,
    },
  });
  await publish(DAY);
  const types = (await observationsOf(DAY)).map((o) => [
    o.observation_type,
    o.start_trading_period,
  ]);
  expect(types).toEqual([
    ["reserve_price_high", 10],
    ["reserve_price_low", 30],
  ]);
});

test("a flat baseline has a deviation guard: a price 4 above the median is not a hit", async () => {
  await writeDay(BASE, () => 10);
  await writeDay(DAY, () => 10, {
    overrides: {
      [`${FIR_NI}:1`]: 14,
      [`${FIR_NI}:2`]: 14,
      [`${FIR_NI}:5`]: 16,
      [`${FIR_NI}:6`]: 20,
    },
  });
  await publish(DAY);
  const observations = await observationsOf(DAY);
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({
    observation_type: "reserve_price_high",
    start_trading_period: 5,
    end_trading_period: 6,
    measured_value: 20,
    baseline_value: 10,
  });
  expect(observations[0]?.threshold_value).toBe(15);
  expect(observations[0]?.severity).toBe(2);
});

test("a DST-start day (46 periods): a run over the clock jump is one run, and the last period ends at 11:00 UTC", async () => {
  expect(periodsInTradingDate(DST_DAY)).toBe(46);
  await writeDay(DST_BASE, ramp);
  await writeDay(DST_DAY, flat, {
    overrides: {
      [`${FIR_NI}:4`]: 40,
      [`${FIR_NI}:5`]: 45,
      [`${FIR_NI}:45`]: 50,
      [`${FIR_NI}:46`]: 60,
    },
  });
  await publish(DST_DAY);
  const observations = await observationsOf(DST_DAY);
  expect(observations).toHaveLength(2);
  expect(observations[0]).toMatchObject({
    observation_type: "reserve_price_high",
    start_trading_period: 4,
    end_trading_period: 5,
    event_start_utc: "2026-09-26T13:30:00Z",
    event_end_utc: "2026-09-26T14:30:00Z",
    measured_value: 45,
  });
  expect(observations[0]?.severity).toBeCloseTo(20.5 / 11.75, 12);
  expect(observations[1]).toMatchObject({
    observation_type: "reserve_price_high",
    start_trading_period: 45,
    end_trading_period: 46,
    event_start_utc: "2026-09-27T10:00:00Z",
    event_end_utc: "2026-09-27T11:00:00Z",
    measured_value: 60,
  });
  expect(observations[1]?.severity).toBeCloseTo(35.5 / 11.75, 12);
});

test("two runs on the same inputs write identical bytes, and the observation IDs match", async () => {
  await writeDay(BASE, ramp);
  await writeDay(DAY, flat, {
    overrides: {
      [`${FIR_NI}:10`]: 40,
      [`${FIR_NI}:11`]: 50,
      [`${FIR_NI}:12`]: 45,
    },
  });
  const bytes = () =>
    Promise.all(
      TABLES.map((table) =>
        readFile(join(goldDir, table, `trading_date=${DAY}`, "data.parquet")),
      ),
    );
  await publish(DAY);
  const first = await bytes();
  const firstIds = (await observationsOf(DAY)).map((o) => o.observation_id);
  await publish(DAY);
  expect(await bytes()).toEqual(first);
  expect(firstIds).toHaveLength(1);
  expect((await observationsOf(DAY)).map((o) => o.observation_id)).toEqual(
    firstIds,
  );
});

test("too little history: no baseline, null thresholds, no observations, and a partial result", async () => {
  await writeDay(BASE, ramp, { complete: (_subject, period) => period <= 24 });
  await writeDay(DAY, flat, {
    overrides: {
      [`${FIR_NI}:10`]: 40,
      [`${FIR_NI}:11`]: 50,
      [`${FIR_NI}:12`]: 45,
    },
  });
  const summary = await publish(DAY);
  expect(summary).toMatchObject({ published: 1, failed: [] });
  expect(summary.partial).toEqual([
    `${DAY}: PARTIAL 4 rows, an input is not complete`,
  ]);
  const baselines = await rowsOf(TABLES[0], DAY);
  expect(baselines).toHaveLength(4);
  for (const row of baselines) {
    expect(row).toMatchObject({
      baseline_sample_count: 24,
      baseline_ready: false,
      high_threshold: null,
      low_threshold: null,
      observation_count: 0,
      inputs_complete: true,
    });
  }
  expect(await observationsOf(DAY)).toEqual([]);

  await writeDay("2026-11-18", flat);
  expect(await publish("2026-11-18")).toMatchObject({ published: 1 });
  expect(await rowsOf(TABLES[0], "2026-11-18")).toHaveLength(4);
  expect(
    (await rowsOf(TABLES[0], "2026-11-18")).every(
      (row) => row.baseline_ready === false,
    ),
  ).toBe(true);
});

test("an incomplete input is flagged on the observation; a null price ends a run", async () => {
  await writeDay(BASE, ramp);
  await writeDay(DAY, flat, {
    overrides: {
      [`${FIR_NI}:10`]: 40,
      [`${FIR_NI}:11`]: 50,
      [`${FIR_NI}:12`]: 45,
    },
    complete: (subjectId) => subjectId !== FIR_NI,
  });
  expect(await publish(DAY)).toMatchObject({
    published: 1,
    partial: [`${DAY}: PARTIAL 4 rows, an input is not complete`],
  });
  const [observation] = await observationsOf(DAY);
  expect(observation).toMatchObject({
    subject_id: FIR_NI,
    inputs_complete: false,
  });

  await writeDay(DAY, flat, {
    overrides: {
      [`${FIR_NI}:10`]: 40,
      [`${FIR_NI}:11`]: null,
      [`${FIR_NI}:12`]: 45,
    },
  });
  await publish(DAY);
  expect(await observationsOf(DAY)).toEqual([]);
});

test("a period with no price row lists the missing period, and a skipped subject still has a sentinel row", async () => {
  await writeDay(BASE, ramp);
  await writeDay(DAY, flat, {
    rowsPresent: (subjectId, period) => !(subjectId === FIR_NI && period === 7),
    complete: (subjectId, period) => !(subjectId === FIR_NI && period === 7),
  });
  expect(await publish(DAY)).toMatchObject({
    published: 1,
    partial: [`${DAY}: PARTIAL 4 rows, missing periods 7`],
  });
  await writeDay(DAY, flat, { complete: (subjectId) => subjectId !== SIR_SI });
  expect(await publish(DAY)).toMatchObject({
    published: 1,
    partial: [`${DAY}: PARTIAL 4 rows, an input is not complete`],
  });
  await writeDay(DAY, flat, { skipSubject: SIR_SI });
  expect(await publish(DAY)).toMatchObject({
    published: 1,
    partial: [`${DAY}: PARTIAL 4 rows, an input is not complete`],
  });
  const sentinel = await rowsOf(TABLES[0], DAY);
  expect(sentinel).toHaveLength(4);
  expect(sentinel.find((r) => r.subject_id === SIR_SI)).toMatchObject({
    inputs_complete: false,
  });
});

test("wanted and written fingerprints are the same function", async () => {
  await writeDay(BASE, ramp, { sha: "sha-a" });
  await writeDay(DAY, flat, {
    sha: "sha-b",
    overrides: {
      [`${FIR_NI}:10`]: 40,
      [`${FIR_NI}:11`]: 50,
      [`${FIR_NI}:12`]: 45,
    },
  });
  await publish(DAY);
  const written = (await rowsOf(TABLES[0], DAY))[0]?.inputs_sha256;
  const wanted = await reservePriceAnomalyDataset(testConfig).wantedVersions?.(
    silverDir,
    completenessView(),
    goldDir,
  );
  expect(written).toEqual(expect.any(String));
  expect(wanted?.get(DAY)).toBe(written);
});

test("a date with no reserve partition is not wanted and writes nothing", async () => {
  expect(await publish(DAY, testConfig, false)).toMatchObject({
    published: 0,
    upToDate: 0,
    missing: 0,
    failed: [],
  });
  expect(existsSync(join(goldDir, TABLES[0]))).toBe(false);
});

test("every observation records the parameters, and the table has the columns of OBSERVATION_COLUMNS", async () => {
  await writeDay(BASE, ramp);
  await writeDay(DAY, flat, {
    overrides: {
      [`${FIR_NI}:10`]: 40,
      [`${FIR_NI}:11`]: 50,
      [`${FIR_NI}:12`]: 45,
    },
  });
  await publish(DAY);
  const observations = await observationsOf(DAY);
  expect(observations.length).toBeGreaterThan(0);
  for (const o of observations)
    expect(o.parameters).toBe(JSON.stringify(testConfig));
  const columns = await withConnection(
    async (c) =>
      (
        await c.runAndReadAll(
          `DESCRIBE SELECT * FROM read_parquet(${lit(join(goldDir, TABLES[1], `trading_date=${DAY}`, "data.parquet"))})`,
        )
      ).getRowObjectsJson() as Array<{ column_name: string }>,
  );
  expect(columns.map((c) => c.column_name)).toEqual([...OBSERVATION_COLUMNS]);
});

test("the default config is pinned: a changed value without an ANALYSIS_VERSION bump fails here", () => {
  expect(ANALYSIS_VERSION).toBe(1);
  expect(
    createHash("sha256")
      .update(JSON.stringify(RESERVE_PRICE_ANOMALY_CONFIG))
      .digest("hex"),
  ).toBe("c9a6dbb958751e995e99d1b369f23799236b04b65bc990597be8dce74ef523f2");
});

test("the runner: a day is rebuilt when a reserve day in its window changes, and not after", async () => {
  const dates = [
    "2026-11-10",
    "2026-11-11",
    "2026-11-12",
    "2026-11-13",
    "2026-11-14",
  ];
  const config: ReservePriceAnomalyConfig = {
    ...testConfig,
    baselineWindowDays: 2,
  };
  for (const date of dates) await writeDay(date, ramp, { sha: "sha-a" });
  const run = () =>
    runPublish({
      bronzeDir,
      silverDir,
      goldDir,
      registry: [reservePriceAnomalyDataset(config)],
      only: ["gold_reserve_price_anomaly"],
    }).then((summaries) => summaries[0]);

  expect(await run()).toMatchObject({
    published: 5,
    upToDate: 0,
    failed: [],
  });
  expect(await run()).toMatchObject({ published: 0, upToDate: 5 });
  await writeDay(dates[2] as string, ramp, { sha: "sha-b" });
  expect(await run()).toMatchObject({ published: 3, upToDate: 2 });
  expect(await run()).toMatchObject({ published: 0, upToDate: 5 });
}, 60_000);

test("the registry entry fields and the TABLES order: the runner reads the first table, the sentinel", () => {
  expect(reservePriceAnomaly).toMatchObject({
    id: "gold_reserve_price_anomaly",
    table: TABLES[0],
    partitionKey: "trading_date",
    versionColumn: "inputs_sha256",
  });
  expect(TABLES).toEqual([
    "reserve_price_anomaly_baselines",
    "observations_reserve_price_anomaly",
  ]);
  expect(RESERVE_SUBJECTS.map((s) => s.subjectId)).toEqual([
    "FIR|NI",
    "FIR|SI",
    "SIR|NI",
    "SIR|SI",
  ]);
});

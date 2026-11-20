import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, expect, test } from "vitest";
import { goldPartitionPath } from "../gold/common.ts";
import { completenessView } from "../gold/fixtures/completeness.ts";
import { prices, REFERENCE_NODES } from "../gold/prices.ts";
import { runPublish } from "../runner.ts";
import { lit } from "../silver/common.ts";
import { completenessKey, saveCompleteness } from "../silver/completeness.ts";
import { DATASET } from "../silver/dispatch-energy-prices.ts";
import { periodsInTradingDate, periodToUtc } from "../trading-time.ts";
import { OBSERVATION_COLUMNS } from "./observation.ts";
import {
  ANALYSIS_VERSION,
  PRICE_ANOMALY_CONFIG,
  type PriceAnomalyConfig,
  priceAnomaly,
  priceAnomalyDataset,
  publishPriceAnomalies,
  TABLES,
} from "./price-anomaly.ts";

const OTA = "OTA2201";
const HAY = "HAY2201";
const BASE = "2026-11-10";
const DAY = "2026-11-11";
const DST_BASE = "2026-09-26";
const DST_DAY = "2026-09-27";

/** Baseline is the day before, so one day of 48 periods gives 48 samples. */
const testConfig: PriceAnomalyConfig = {
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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-anomaly-"));
  silverDir = join(root, "silver");
  goldDir = join(root, "gold");
});
afterEach(() => rm(root, { recursive: true, force: true }));

interface DayOptions {
  /** Overrides by `POC:period`. A null price is a missing price. */
  overrides?: Record<string, number | null>;
  /** False for a period of a node: the input is not complete. */
  complete?: (poc: string, period: number) => boolean;
  /** False for a period of a node that has no price row (rows_present = 0). */
  rowsPresent?: (poc: string, period: number) => boolean;
  sha?: string;
}

/** Write the gold `price_periods` partition of a date for the three reference nodes. */
async function writeDay(
  date: string,
  base: (poc: string, period: number) => number | null,
  options: DayOptions = {},
) {
  const rows: string[] = [];
  for (const node of REFERENCE_NODES) {
    for (let period = 1; period <= periodsInTradingDate(date); period++) {
      const key = `${node.pointOfConnection}:${period}`;
      const price =
        options.overrides && key in options.overrides
          ? options.overrides[key]
          : base(node.pointOfConnection, period);
      const priceSql =
        price === null || price === undefined
          ? "NULL::DOUBLE"
          : `${price}::DOUBLE`;
      const complete =
        options.complete?.(node.pointOfConnection, period) ?? true;
      const present =
        options.rowsPresent?.(node.pointOfConnection, period) ?? true;
      const span = periodToUtc(date, period);
      rows.push(
        `(${lit(date)}::DATE, ${period}::INTEGER,
          ${lit(span.eventStartUtc.toString())}::TIMESTAMPTZ, ${lit(span.eventEndUtc.toString())}::TIMESTAMPTZ,
          ${lit(node.pointOfConnection)}, ${lit(node.priceRegion)}, ${priceSql}, ${priceSql}, ${priceSql},
          ${present ? 1 : 0}::INTEGER, false, ${ANALYSIS_VERSION}::INTEGER, ${lit(options.sha ?? "sha-a")}, ${complete})`,
      );
    }
  }
  const path = goldPartitionPath(goldDir, "price_periods", date);
  await mkdir(join(path, ".."), { recursive: true });
  await withConnection((c) =>
    c.run(
      `COPY (SELECT * FROM (VALUES ${rows.join(",")}) t(trading_date, trading_period,
         event_start_utc, event_end_utc, point_of_connection, price_region, price, min_price, max_price,
         rows_present, has_proxy_price, analysis_version, inputs_sha256, inputs_complete))
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

const publish = (date: string, config: PriceAnomalyConfig = testConfig) =>
  publishPriceAnomalies(
    { silverDir, goldDir, completeness: completenessView(), date },
    config,
  );

/** Baseline day: the price of period k is k, for every node. */
const ramp = (_poc: string, period: number) => period;
const flat = (_poc: string, _period: number) => 24.5;

test("a high run is one observation: the run, the thresholds and the severity, and a price at the threshold is not a hit", async () => {
  await writeDay(BASE, ramp);
  await writeDay(DAY, flat, {
    overrides: {
      [`${OTA}:10`]: 40,
      [`${OTA}:11`]: 50,
      [`${OTA}:12`]: 45,
      [`${OTA}:44`]: 36.25,
      [`${OTA}:45`]: 36.25,
    },
  });
  expect(await publish(DAY)).toMatchObject({ status: "complete", rows: 3 });
  const [observation, ...rest] = await observationsOf(DAY);
  expect(rest).toEqual([]);
  expect(observation).toMatchObject({
    detector_id: "price_anomaly",
    observation_type: "price_high",
    trading_date: DAY,
    start_trading_period: 10,
    end_trading_period: 12,
    period_count: 3,
    event_start_utc: "2026-11-10T15:30:00Z",
    event_end_utc: "2026-11-10T17:00:00Z",
    subject_type: "point_of_connection",
    subject_id: OTA,
    point_of_connection: OTA,
    island: "NI",
    price_region: "upper_north_island",
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
    overrides: { [`${OTA}:30`]: 10, [`${OTA}:31`]: 5 },
  });
  expect(await publish(DAY)).toMatchObject({ status: "complete" });
  const observations = await observationsOf(DAY);
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({
    observation_type: "price_low",
    start_trading_period: 30,
    end_trading_period: 31,
    period_count: 2,
    measured_value: 5,
    baseline_value: 24.5,
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
      [`${OTA}:10`]: 40,
      [`${OTA}:11`]: 50,
      [`${OTA}:12`]: 45,
      [`${OTA}:20`]: 60,
      [`${OTA}:30`]: 10,
      [`${OTA}:31`]: 5,
      [`${OTA}:40`]: 50,
      [`${OTA}:41`]: 24.5,
    },
  });
  await publish(DAY);
  const types = (await observationsOf(DAY)).map((o) => [
    o.observation_type,
    o.start_trading_period,
  ]);
  // The single periods 20 and 40 are dropped. Only the runs 10 to 12 and 30 to 31 stay.
  expect(types).toEqual([
    ["price_high", 10],
    ["price_low", 30],
  ]);
});

test("a flat baseline has a deviation guard: a price 4 above the median is not a hit", async () => {
  await writeDay(BASE, () => 10);
  await writeDay(DAY, () => 10, {
    overrides: {
      [`${OTA}:1`]: 14,
      [`${OTA}:2`]: 14,
      [`${OTA}:5`]: 16,
      [`${OTA}:6`]: 20,
    },
  });
  await publish(DAY);
  const observations = await observationsOf(DAY);
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({
    observation_type: "price_high",
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
      [`${OTA}:4`]: 40,
      [`${OTA}:5`]: 45,
      [`${OTA}:45`]: 50,
      [`${OTA}:46`]: 60,
    },
  });
  await publish(DST_DAY);
  const observations = await observationsOf(DST_DAY);
  expect(observations).toHaveLength(2);
  expect(observations[0]).toMatchObject({
    observation_type: "price_high",
    start_trading_period: 4,
    end_trading_period: 5,
    event_start_utc: "2026-09-26T13:30:00Z",
    event_end_utc: "2026-09-26T14:30:00Z",
    measured_value: 45,
  });
  expect(observations[0]?.severity).toBeCloseTo(20.5 / 11.75, 12);
  expect(observations[1]).toMatchObject({
    observation_type: "price_high",
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
    overrides: { [`${OTA}:10`]: 40, [`${OTA}:11`]: 50, [`${OTA}:12`]: 45 },
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

test("too little history: no baseline, null thresholds, no observations, and a partial result without missing periods", async () => {
  // 24 complete periods per node in the baseline, against a minimum of 48.
  await writeDay(BASE, ramp, { complete: (_poc, period) => period <= 24 });
  await writeDay(DAY, flat, {
    overrides: { [`${OTA}:10`]: 40, [`${OTA}:11`]: 50, [`${OTA}:12`]: 45 },
  });
  expect(await publish(DAY)).toEqual({
    date: DAY,
    status: "partial",
    rows: 3,
    path: join(goldDir, TABLES[0], `trading_date=${DAY}`, "data.parquet"),
    missingPeriods: [],
  });
  const baselines = await rowsOf(TABLES[0], DAY);
  expect(baselines).toHaveLength(3);
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

  // A date with no earlier partition has no baseline at all.
  await writeDay("2026-11-18", flat);
  expect(await publish("2026-11-18")).toMatchObject({ status: "partial" });
  expect(await rowsOf(TABLES[0], "2026-11-18")).toHaveLength(3);
});

test("an incomplete input is flagged on the observation; a null price ends a run", async () => {
  await writeDay(BASE, ramp);
  await writeDay(DAY, flat, {
    overrides: { [`${OTA}:10`]: 40, [`${OTA}:11`]: 50, [`${OTA}:12`]: 45 },
    complete: (poc) => poc !== OTA,
  });
  expect(await publish(DAY)).toMatchObject({
    status: "partial",
    missingPeriods: [],
  });
  const [observation] = await observationsOf(DAY);
  expect(observation).toMatchObject({
    subject_id: OTA,
    inputs_complete: false,
  });

  await writeDay(DAY, flat, {
    overrides: { [`${OTA}:10`]: 40, [`${OTA}:11`]: null, [`${OTA}:12`]: 45 },
  });
  await publish(DAY);
  expect(await observationsOf(DAY)).toEqual([]);
});

test("a period with no price row lists the missing period, and a status-only failure lists none", async () => {
  await writeDay(BASE, ramp);
  await writeDay(DAY, flat, {
    rowsPresent: (poc, period) => !(poc === OTA && period === 7),
    complete: (poc, period) => !(poc === OTA && period === 7),
  });
  expect(await publish(DAY)).toMatchObject({
    status: "partial",
    missingPeriods: [7],
  });
  await writeDay(DAY, flat, { complete: (poc) => poc !== HAY });
  expect(await publish(DAY)).toMatchObject({
    status: "partial",
    missingPeriods: [],
  });
});

test("a date with no price partition is missing and writes nothing", async () => {
  expect(await publish(DAY)).toEqual({ date: DAY, status: "missing" });
  expect(existsSync(join(goldDir, TABLES[0]))).toBe(false);
});

test("every observation records the parameters, and the table has the columns of OBSERVATION_COLUMNS", async () => {
  await writeDay(BASE, ramp);
  await writeDay(DAY, flat, {
    overrides: { [`${OTA}:10`]: 40, [`${OTA}:11`]: 50, [`${OTA}:12`]: 45 },
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
  // Change the config and ANALYSIS_VERSION together, then update this hash.
  expect(ANALYSIS_VERSION).toBe(1);
  expect(
    createHash("sha256")
      .update(JSON.stringify(PRICE_ANOMALY_CONFIG))
      .digest("hex"),
  ).toBe("88dcf182a89dc18ad7daa742c5be60a72f0d1919fd06085be652efda4b2088f6");
});

/** A silver dispatch partition: each node has one row per period, at period start, at `price`. */
async function writeSilverDay(date: string, sha: string) {
  const values = REFERENCE_NODES.flatMap((node) =>
    Array.from({ length: periodsInTradingDate(date) }, (_, i) => {
      const span = periodToUtc(date, i + 1);
      const start = lit(span.eventStartUtc.toString());
      return `(${i + 1}::INTEGER, ${start}::TIMESTAMPTZ, ${lit(span.eventEndUtc.toString())}::TIMESTAMPTZ,
        ${start}::TIMESTAMPTZ, ${lit(node.pointOfConnection)}, false, 10::DOUBLE, ${lit(sha)})`;
    }),
  );
  const path = join(silverDir, DATASET, `trading_date=${date}`, "data.parquet");
  await mkdir(join(path, ".."), { recursive: true });
  await withConnection((c) =>
    c.run(
      `COPY (SELECT * FROM (VALUES ${values.join(",")}) t(trading_period, event_start_utc, event_end_utc,
         source_published_at, point_of_connection, is_proxy_price, dollars_per_megawatt_hour, bronze_sha256))
       TO ${lit(path)} (FORMAT parquet)`,
    ),
  );
}

test("the runner: a day is rebuilt when a price day in its window changes, and not after", async () => {
  const dates = [
    "2026-11-10",
    "2026-11-11",
    "2026-11-12",
    "2026-11-13",
    "2026-11-14",
  ];
  // A window of two days, so day 3 is in the window of days 3 to 5.
  const config: PriceAnomalyConfig = { ...testConfig, baselineWindowDays: 2 };
  for (const date of dates) await writeSilverDay(date, "sha-a");
  await saveCompleteness(
    silverDir,
    new Map(
      dates.map((date) => {
        const row = completenessView().get(completenessKey(DATASET, date));
        if (!row) throw new Error(`no completeness row for ${date}`);
        return [completenessKey(DATASET, date), row];
      }),
    ),
  );
  const registry = [prices, priceAnomalyDataset(config)];
  const run = () =>
    runPublish({
      bronzeDir: join(root, "bronze"),
      silverDir,
      goldDir,
      registry,
    }).then(([pricesSummary, anomalySummary]) => ({
      prices: pricesSummary,
      anomaly: anomalySummary,
    }));

  // (a) the first run builds all five days of both datasets.
  expect(await run()).toMatchObject({
    prices: { published: 5, upToDate: 0, failed: [] },
    anomaly: { published: 5, upToDate: 0, failed: [] },
  });
  // (b) the second run builds nothing.
  expect(await run()).toMatchObject({
    prices: { published: 0, upToDate: 5 },
    anomaly: { published: 0, upToDate: 5 },
  });
  // (c) day 3 gets a new silver version. Its prices rebuild, and so do the days whose window holds it.
  await writeSilverDay(dates[2] as string, "sha-b");
  expect(await run()).toMatchObject({
    prices: { published: 1, upToDate: 4 },
    anomaly: { published: 3, upToDate: 2 },
  });
  // (d) the next run builds nothing.
  expect(await run()).toMatchObject({
    prices: { published: 0, upToDate: 5 },
    anomaly: { published: 0, upToDate: 5 },
  });
}, 60_000);

test("the default dataset is gold_price_anomaly and it writes the sentinel table first", () => {
  expect(priceAnomaly).toMatchObject({
    id: "gold_price_anomaly",
    table: TABLES[0],
    partitionKey: "trading_date",
    versionColumn: "inputs_sha256",
  });
  expect(TABLES).toEqual([
    "price_anomaly_baselines",
    "observations_price_anomaly",
  ]);
});

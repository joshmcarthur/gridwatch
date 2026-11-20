import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runPublish } from "../runner.ts";
import { lit } from "../silver/common.ts";
import { completenessKey, saveCompleteness } from "../silver/completeness.ts";
import { DATASET } from "../silver/dispatch-energy-prices.ts";
import { periodsInTradingDate, periodToUtc } from "../trading-time.ts";
import { goldPartitionPath } from "./common.ts";
import { completenessView } from "./fixtures/completeness.ts";
import { OBSERVATION_COLUMNS } from "./observation.ts";
import {
  ANALYSIS_VERSION,
  PRICE_SEPARATION_CONFIG,
  type PriceSeparationConfig,
  priceSeparation,
  priceSeparationDataset,
  publishPriceSeparations,
  TABLES,
} from "./price-separation.ts";
import { prices, REFERENCE_NODES, SPREAD_PAIRS } from "./prices.ts";

const OTA = "OTA2201";
const HAY = "HAY2201";
const BEN = "BEN2201";
const OTA_HAY = `${OTA}-${HAY}`;
const HAY_BEN = `${HAY}-${BEN}`;
const OTA_BEN = `${OTA}-${BEN}`;
const BASE_1 = "2026-11-09";
const BASE_2 = "2026-11-10";
const DAY = "2026-11-11";
const DST_BASE_1 = "2026-09-25";
const DST_BASE_2 = "2026-09-26";
const DST_DAY = "2026-09-27";

const nullNodeColumns = {
  point_of_connection: null,
  island: null,
  price_region: null,
};

/** Two baseline days with all spreads 0: median 0, p99 0, p01 0, thresholds +10 and -10. */
const testConfig: PriceSeparationConfig = {
  baselineWindowDays: 2,
  minBaselinePeriods: 48,
  highPercentile: 0.99,
  lowPercentile: 0.01,
  minDeviationFromMedian: 10,
  minPeriods: 2,
};

let root: string;
let silverDir: string;
let goldDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-separation-"));
  silverDir = join(root, "silver");
  goldDir = join(root, "gold");
});
afterEach(() => rm(root, { recursive: true, force: true }));

interface DayOptions {
  /** Node price overrides by `POC:period`. A null price gives a null spread. */
  overrides?: Record<string, number | null>;
  /** False for a spread row of a pair: the input is not complete. */
  complete?: (pair: string, period: number) => boolean;
  /** Base price of a node, 0 when absent. */
  base?: Record<string, number>;
  /** A pair with no row at all on the date. */
  skipPair?: string;
  sha?: string;
}

/**
 * Write the gold `price_spreads` partition of a date. Every node price is 0 unless overridden,
 * and a spread is the price of the from-node minus the price of the to-node.
 */
async function writeDay(date: string, options: DayOptions = {}) {
  const priceOf = (poc: string, period: number) => {
    const key = `${poc}:${period}`;
    return options.overrides && key in options.overrides
      ? options.overrides[key]
      : (options.base?.[poc] ?? 0);
  };
  const rows: string[] = [];
  for (const [from, to] of SPREAD_PAIRS) {
    if (`${from}-${to}` === options.skipPair) continue;
    const region = (poc: string) =>
      REFERENCE_NODES.find((n) => n.pointOfConnection === poc)?.priceRegion ??
      "";
    for (let period = 1; period <= periodsInTradingDate(date); period++) {
      const a = priceOf(from, period);
      const b = priceOf(to, period);
      const sql = (value: number | null | undefined) =>
        value === null || value === undefined
          ? "NULL::DOUBLE"
          : `${value}::DOUBLE`;
      const span = periodToUtc(date, period);
      rows.push(
        `(${lit(date)}::DATE, ${period}::INTEGER,
          ${lit(span.eventStartUtc.toString())}::TIMESTAMPTZ, ${lit(span.eventEndUtc.toString())}::TIMESTAMPTZ,
          ${lit(from)}, ${lit(to)}, ${lit(region(from))}, ${lit(region(to))},
          ${sql(a)}, ${sql(b)},
          ${a === null || b === null || a === undefined || b === undefined ? "NULL::DOUBLE" : `${a - b}::DOUBLE`},
          ${ANALYSIS_VERSION}::INTEGER, ${lit(options.sha ?? "sha-a")},
          ${options.complete?.(`${from}-${to}`, period) ?? true})`,
      );
    }
  }
  const path = goldPartitionPath(goldDir, "price_spreads", date);
  await mkdir(join(path, ".."), { recursive: true });
  await withConnection((c) =>
    c.run(
      `COPY (SELECT * FROM (VALUES ${rows.join(",")}) t(trading_date, trading_period,
         event_start_utc, event_end_utc, from_point_of_connection, to_point_of_connection,
         from_price_region, to_price_region, from_price, to_price, spread,
         analysis_version, inputs_sha256, inputs_complete))
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

const publish = (date: string, config: PriceSeparationConfig = testConfig) =>
  publishPriceSeparations(
    { silverDir, goldDir, completeness: completenessView(), date },
    config,
  );

const writeBaseline = async () => {
  await writeDay(BASE_1);
  await writeDay(BASE_2);
};

test("a high run: OTA-HAY and OTA-BEN each get an observation and HAY-BEN none; pair rows null the node columns", async () => {
  await writeBaseline();
  await writeDay(DAY, { overrides: { [`${OTA}:4`]: 30, [`${OTA}:5`]: 30 } });
  expect(await publish(DAY)).toMatchObject({ status: "complete", rows: 3 });
  const observations = await observationsOf(DAY);
  expect(observations.map((o) => o.subject_id)).toEqual([OTA_BEN, OTA_HAY]);
  for (const o of observations)
    expect(o).toMatchObject({
      detector_id: "price_separation",
      observation_type: "separation_high",
      trading_date: DAY,
      start_trading_period: 4,
      end_trading_period: 5,
      period_count: 2,
      subject_type: "point_of_connection_pair",
      ...nullNodeColumns,
      measured_value: 30,
      measured_unit: "$/MWh",
      baseline_value: 0,
      threshold_value: 10,
      severity: 3,
      baseline_sample_count: 96,
      baseline_window_start: BASE_1,
      baseline_window_end: BASE_2,
      input_tables: ["gold/price_spreads"],
      inputs_complete: true,
    });
  expect(observations[0]?.observation_id).toMatch(/^[0-9a-f]{16}$/);
});

test("a low run: a negative spread on HAY-BEN and OTA-BEN; pair rows still null the node columns", async () => {
  await writeBaseline();
  await writeDay(DAY, { overrides: { [`${BEN}:20`]: 25, [`${BEN}:21`]: 25 } });
  await publish(DAY);
  const observations = await observationsOf(DAY);
  expect(observations.map((o) => o.subject_id)).toEqual([HAY_BEN, OTA_BEN]);
  for (const o of observations)
    expect(o).toMatchObject({
      observation_type: "separation_low",
      start_trading_period: 20,
      end_trading_period: 21,
      measured_value: -25,
      baseline_value: 0,
      threshold_value: -10,
      severity: 2.5,
      subject_type: "point_of_connection_pair",
      ...nullNodeColumns,
    });
});

test("a single period, a run of one beside a gap, and a null spread that ends a run are not observations", async () => {
  await writeBaseline();
  await writeDay(DAY, {
    overrides: {
      [`${OTA}:10`]: 30,
      [`${OTA}:20`]: 30,
      [`${OTA}:22`]: 30,
      [`${OTA}:30`]: 30,
      [`${OTA}:31`]: null,
      [`${OTA}:32`]: 30,
    },
  });
  await publish(DAY);
  expect(await observationsOf(DAY)).toEqual([]);
});

test("a low run can have a positive measured spread, and a high run a negative one", async () => {
  // Median +200: a low run has a positive minimum.
  await writeDay(BASE_1, { base: { [OTA]: 200 } });
  await writeDay(BASE_2, { base: { [OTA]: 200 } });
  await writeDay(DAY, {
    base: { [OTA]: 200 },
    overrides: { [`${OTA}:4`]: 50, [`${OTA}:5`]: 50 },
  });
  await publish(DAY);
  const low = await observationsOf(DAY);
  expect(low.map((o) => o.subject_id)).toEqual([OTA_BEN, OTA_HAY]);
  for (const o of low)
    expect(o).toMatchObject({
      observation_type: "separation_low",
      measured_value: 50,
      baseline_value: 200,
      threshold_value: 190,
      severity: 15,
      ...nullNodeColumns,
    });

  // Median -200: a high run has a negative maximum.
  await writeDay(BASE_1, { base: { [OTA]: -200 } });
  await writeDay(BASE_2, { base: { [OTA]: -200 } });
  await writeDay(DAY, {
    base: { [OTA]: -200 },
    overrides: { [`${OTA}:4`]: -50, [`${OTA}:5`]: -50 },
  });
  await publish(DAY);
  const high = await observationsOf(DAY);
  expect(high.map((o) => o.subject_id)).toEqual([OTA_BEN, OTA_HAY]);
  for (const o of high)
    expect(o).toMatchObject({
      observation_type: "separation_high",
      measured_value: -50,
      ...nullNodeColumns,
    });
});

test("a pair with no row on the date is incomplete and has no run", async () => {
  await writeBaseline();
  await writeDay(DAY, {
    overrides: { [`${OTA}:4`]: 30, [`${OTA}:5`]: 30 },
    skipPair: OTA_HAY,
  });
  expect(await publish(DAY)).toMatchObject({ status: "partial", rows: 3 });
  expect((await observationsOf(DAY)).map((o) => o.subject_id)).toEqual([
    OTA_BEN,
  ]);
  const sentinel = await rowsOf(TABLES[0], DAY);
  expect(sentinel).toHaveLength(3);
  expect(sentinel.find((r) => r.subject_id === OTA_HAY)).toMatchObject({
    inputs_complete: false,
    observation_count: 0,
  });
});

test("a spread exactly at the threshold is not a hit", async () => {
  await writeBaseline();
  await writeDay(DAY, {
    overrides: {
      [`${OTA}:6`]: 10,
      [`${OTA}:7`]: 10,
      [`${BEN}:8`]: 10,
      [`${BEN}:9`]: 10,
    },
  });
  await publish(DAY);
  expect(await observationsOf(DAY)).toEqual([]);
});

test("a DST-start day (46 periods): the instants of a run and of a run that ends at period 46", async () => {
  expect(periodsInTradingDate(DST_DAY)).toBe(46);
  await writeDay(DST_BASE_1);
  await writeDay(DST_BASE_2);
  await writeDay(DST_DAY, {
    overrides: {
      [`${OTA}:4`]: 30,
      [`${OTA}:5`]: 30,
      [`${OTA}:45`]: 40,
      [`${OTA}:46`]: 40,
    },
  });
  await publish(DST_DAY);
  const observations = (await observationsOf(DST_DAY)).filter(
    (o) => o.subject_id === OTA_BEN,
  );
  expect(observations).toHaveLength(2);
  expect(observations[0]).toMatchObject({
    start_trading_period: 4,
    end_trading_period: 5,
    event_start_utc: "2026-09-26T13:30:00Z",
    event_end_utc: "2026-09-26T14:30:00Z",
  });
  expect(observations[1]).toMatchObject({
    start_trading_period: 45,
    end_trading_period: 46,
    event_start_utc: "2026-09-27T10:00:00Z",
    event_end_utc: "2026-09-27T11:00:00Z",
    measured_value: 40,
  });
});

test("too little history: no baseline, no observations, and a partial result", async () => {
  // One baseline day with 20 complete periods, against a minimum of 48.
  await writeDay(BASE_2, { complete: (_pair, period) => period <= 20 });
  await writeDay(DAY, { overrides: { [`${OTA}:4`]: 30, [`${OTA}:5`]: 30 } });
  expect(await publish(DAY)).toEqual({
    date: DAY,
    status: "partial",
    rows: 3,
    path: join(goldDir, TABLES[0], `trading_date=${DAY}`, "data.parquet"),
    missingPeriods: [],
  });
  for (const row of await rowsOf(TABLES[0], DAY))
    expect(row).toMatchObject({
      baseline_sample_count: 20,
      baseline_ready: false,
      high_threshold: null,
      low_threshold: null,
      observation_count: 0,
    });
  expect(await observationsOf(DAY)).toEqual([]);
});

test("an incomplete spread row flags only its pair; a null spread lists the period; a missing partition is missing", async () => {
  await writeBaseline();
  await writeDay(DAY, {
    overrides: { [`${OTA}:4`]: 30, [`${OTA}:5`]: 30 },
    complete: (pair, period) => !(pair === OTA_BEN && period === 40),
  });
  expect(await publish(DAY)).toMatchObject({
    status: "partial",
    missingPeriods: [],
  });
  const completeOf = Object.fromEntries(
    (await observationsOf(DAY)).map((o) => [o.subject_id, o.inputs_complete]),
  );
  expect(completeOf).toEqual({ [OTA_BEN]: false, [OTA_HAY]: true });

  await writeDay(DAY, {
    overrides: { [`${HAY}:7`]: null },
    complete: (pair, period) => !(pair.includes(HAY) && period === 7),
  });
  expect(await publish(DAY)).toMatchObject({
    status: "partial",
    missingPeriods: [7],
  });

  expect(await publish("2026-11-18")).toEqual({
    date: "2026-11-18",
    status: "missing",
  });
  expect(existsSync(join(goldDir, TABLES[0], "trading_date=2026-11-18"))).toBe(
    false,
  );
});

test("two runs on the same inputs write identical bytes, and the observation IDs match", async () => {
  await writeBaseline();
  await writeDay(DAY, { overrides: { [`${OTA}:4`]: 30, [`${OTA}:5`]: 30 } });
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
  expect(firstIds).toHaveLength(2);
  expect((await observationsOf(DAY)).map((o) => o.observation_id)).toEqual(
    firstIds,
  );
});

test("wanted and written fingerprints are the same function", async () => {
  await writeDay(BASE_1, { sha: "sha-a" });
  await writeDay(BASE_2, { sha: "sha-a" });
  await writeDay(DAY, {
    sha: "sha-b",
    overrides: { [`${OTA}:4`]: 30, [`${OTA}:5`]: 30 },
  });
  await publish(DAY);
  const written = (await rowsOf(TABLES[0], DAY))[0]?.inputs_sha256;
  const wanted = await priceSeparationDataset(testConfig).wantedVersions?.(
    silverDir,
    completenessView(),
    goldDir,
  );
  expect(written).toEqual(expect.any(String));
  expect(wanted?.get(DAY)).toBe(written);
});

test("every observation records the parameters, and the table has the columns of OBSERVATION_COLUMNS", async () => {
  await writeBaseline();
  await writeDay(DAY, { overrides: { [`${OTA}:4`]: 30, [`${OTA}:5`]: 30 } });
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
      .update(JSON.stringify(PRICE_SEPARATION_CONFIG))
      .digest("hex"),
  ).toBe("20ee6c508fe194021204f1ebf8c22ffc9c3f7fd0dde26cde39a94321d5a9969f");
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
  const config: PriceSeparationConfig = {
    ...testConfig,
    baselineWindowDays: 2,
  };
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
  const registry = [prices, priceSeparationDataset(config)];
  const run = () =>
    runPublish({
      bronzeDir: join(root, "bronze"),
      silverDir,
      goldDir,
      registry,
    }).then(([pricesSummary, separationSummary]) => ({
      prices: pricesSummary,
      separation: separationSummary,
    }));

  expect(await run()).toMatchObject({
    prices: { published: 5, upToDate: 0, failed: [] },
    separation: { published: 5, upToDate: 0, failed: [] },
  });
  expect(await run()).toMatchObject({
    prices: { published: 0, upToDate: 5 },
    separation: { published: 0, upToDate: 5 },
  });
  // Day 3 gets a new silver version. Its prices rebuild, and so do the days whose window holds it.
  await writeSilverDay(dates[2] as string, "sha-b");
  expect(await run()).toMatchObject({
    prices: { published: 1, upToDate: 4 },
    separation: { published: 3, upToDate: 2 },
  });
  expect(await run()).toMatchObject({
    prices: { published: 0, upToDate: 5 },
    separation: { published: 0, upToDate: 5 },
  });
}, 60_000);

test("the registry entry and the TABLES order: the runner reads the first table, the sentinel", () => {
  expect(priceSeparation).toMatchObject({
    id: "gold_price_separation",
    table: TABLES[0],
    partitionKey: "trading_date",
    versionColumn: "inputs_sha256",
  });
  expect(TABLES).toEqual([
    "price_separation_baselines",
    "observations_price_separation",
  ]);
});

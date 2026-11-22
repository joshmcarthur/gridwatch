import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, expect, test } from "vitest";
import { lit } from "../silver/common.ts";
import { periodToUtc } from "../trading-time.ts";
import { goldPartitionPath } from "./common.ts";
import { TABLES as DEMAND_DEVIATION_TABLES } from "./demand-deviation.ts";
import { INPUTS, publishEpisodes, TABLES } from "./episodes.ts";
import { episodeIdOf } from "./episodes-group.ts";
import { completenessView } from "./fixtures/completeness.ts";
import { FUEL_TABLES, PLANT_TABLES } from "./generation-change.ts";
import { TABLES as PRICE_ANOMALY_TABLES } from "./price-anomaly.ts";
import { TABLES as PRICE_SEPARATION_TABLES } from "./price-separation.ts";
import { TABLES as RESERVE_PRICE_ANOMALY_TABLES } from "./reserve-price-anomaly.ts";

const DAY = "2026-11-11";

let root: string;
let silverDir: string;
let goldDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-episodes-"));
  silverDir = join(root, "silver");
  goldDir = join(root, "gold");
});
afterEach(() => rm(root, { recursive: true, force: true }));

const SENTINELS = [
  PRICE_ANOMALY_TABLES[0],
  PRICE_SEPARATION_TABLES[0],
  RESERVE_PRICE_ANOMALY_TABLES[0],
] as const;
const OBSERVATION_TABLES = [
  PRICE_ANOMALY_TABLES[1],
  PRICE_SEPARATION_TABLES[1],
  RESERVE_PRICE_ANOMALY_TABLES[1],
] as const;

async function copySql(sql: string, path: string) {
  await mkdir(dirname(path), { recursive: true });
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    await connection.run(`COPY (${sql}) TO ${lit(path)} (FORMAT parquet)`);
  } finally {
    connection.closeSync();
  }
}

async function writeSentinels(date: string) {
  for (const table of SENTINELS) {
    await copySql(
      `SELECT DATE ${lit(date)} AS trading_date, 's' AS subject_id,
         'abc' AS inputs_sha256`,
      goldPartitionPath(goldDir, table, date),
    );
  }
}

interface ObservationSpec {
  table: (typeof OBSERVATION_TABLES)[number];
  observation_id: string;
  observation_type: string;
  start: number;
  end: number;
  subject_type?: string;
  subject_id?: string;
  island?: string | null;
  plant_id?: string | null;
  measured_value?: number;
  severity?: number;
  inputs_complete?: boolean;
}

async function writeObservations(date: string, rows: ObservationSpec[]) {
  const byTable = new Map<string, ObservationSpec[]>();
  for (const table of OBSERVATION_TABLES) byTable.set(table, []);
  for (const row of rows) {
    const list = byTable.get(row.table) ?? [];
    list.push(row);
    byTable.set(row.table, list);
  }
  for (const [table, list] of byTable) {
    const values =
      list.length === 0
        ? `SELECT NULL::VARCHAR AS observation_id, NULL::VARCHAR AS observation_type,
             NULL::DATE AS trading_date, NULL::INTEGER AS start_trading_period,
             NULL::INTEGER AS end_trading_period,
             NULL::TIMESTAMPTZ AS event_start_utc, NULL::TIMESTAMPTZ AS event_end_utc,
             NULL::VARCHAR AS subject_type, NULL::VARCHAR AS subject_id,
             NULL::VARCHAR AS island, NULL::VARCHAR AS plant_id,
             NULL::DOUBLE AS measured_value, NULL::DOUBLE AS severity,
             NULL::BOOLEAN AS inputs_complete
           WHERE false`
        : `SELECT * FROM (VALUES ${list
            .map((row) => {
              const start = periodToUtc(date, row.start);
              const end = periodToUtc(date, row.end);
              return `(${lit(row.observation_id)}, ${lit(row.observation_type)},
                DATE ${lit(date)}, ${row.start}::INTEGER, ${row.end}::INTEGER,
                ${lit(start.eventStartUtc.toString())}::TIMESTAMPTZ,
                ${lit(end.eventEndUtc.toString())}::TIMESTAMPTZ,
                ${lit(row.subject_type ?? "point_of_connection")},
                ${lit(row.subject_id ?? "OTA2201")},
                ${row.island === null ? "NULL::VARCHAR" : lit(row.island ?? "NI")},
                ${row.plant_id == null ? "NULL::VARCHAR" : lit(row.plant_id)},
                ${row.measured_value ?? 100}::DOUBLE,
                ${row.severity ?? 1.5}::DOUBLE,
                ${row.inputs_complete ?? true})`;
            })
            .join(", ")}) t(observation_id, observation_type, trading_date,
              start_trading_period, end_trading_period, event_start_utc, event_end_utc,
              subject_type, subject_id, island, plant_id, measured_value, severity,
              inputs_complete)`;
    await copySql(values, goldPartitionPath(goldDir, table, date));
  }
}

const publish = (date: string) =>
  publishEpisodes({
    silverDir,
    goldDir,
    completeness: completenessView(),
    date,
  });

test("a date with no detector sentinels is missing", async () => {
  expect(await publish(DAY)).toEqual({ date: DAY, status: "missing" });
});

test("quiet sentinels write a day row and an empty episodes partition", async () => {
  await writeSentinels(DAY);
  await writeObservations(DAY, []);
  expect(await publish(DAY)).toMatchObject({ status: "complete", rows: 1 });
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    const days = await connection.runAndReadAll(
      `SELECT episode_count, observation_count, inputs_complete
       FROM read_parquet(${lit(goldPartitionPath(goldDir, TABLES[0], DAY))})`,
    );
    expect(days.getRowObjectsJson()).toEqual([
      { episode_count: 0, observation_count: 0, inputs_complete: true },
    ]);
    const episodes = await connection.runAndReadAll(
      `SELECT count(*)::INTEGER AS n
       FROM read_parquet(${lit(goldPartitionPath(goldDir, TABLES[1], DAY))})`,
    );
    expect(episodes.getRowObjectsJson()).toEqual([{ n: 0 }]);
  } finally {
    connection.closeSync();
  }
});

test("overlapping NI price_high and reserve_price_high write one episode", async () => {
  await writeSentinels(DAY);
  await writeObservations(DAY, [
    {
      table: PRICE_ANOMALY_TABLES[1],
      observation_id: "price1",
      observation_type: "price_high",
      start: 35,
      end: 40,
      severity: 2,
    },
    {
      table: RESERVE_PRICE_ANOMALY_TABLES[1],
      observation_id: "res1",
      observation_type: "reserve_price_high",
      start: 35,
      end: 40,
      subject_type: "reserve_class",
      subject_id: "SIR|NI",
      severity: 10,
    },
  ]);
  expect(await publish(DAY)).toMatchObject({ status: "complete" });
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    const rows = (
      await connection.runAndReadAll(
        `SELECT episode_id, seed_observation_id, member_count, severity,
           member_observation_ids, observation_types, grouping_reason
         FROM read_parquet(${lit(goldPartitionPath(goldDir, TABLES[1], DAY))})`,
      )
    ).getRowObjectsJson() as Array<{
      episode_id: string;
      seed_observation_id: string;
      member_count: number;
      severity: number;
      member_observation_ids: string[];
      observation_types: string[];
      grouping_reason: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.member_count).toBe(2);
    expect(rows[0]?.severity).toBe(10);
    expect(rows[0]?.episode_id).toBe(episodeIdOf("price1"));
    expect(rows[0]?.grouping_reason).toContain(
      "price_high_reserve_price_high_adjacent_island",
    );
  } finally {
    connection.closeSync();
  }
});

test("INPUTS are the three detector sentinels", () => {
  expect(INPUTS.map((input) => input.table)).toEqual([...SENTINELS]);
});

test("generation-change and demand-deviation sentinels are not episode inputs (#180)", () => {
  const tables = INPUTS.map((input) => input.table);
  expect(tables).not.toContain(PLANT_TABLES[0]);
  expect(tables).not.toContain(FUEL_TABLES[0]);
  expect(tables).not.toContain(DEMAND_DEVIATION_TABLES[0]);
});

test("overlapping generation_low on disk does not join a price episode (#180)", async () => {
  await writeSentinels(DAY);
  await writeObservations(DAY, [
    {
      table: PRICE_ANOMALY_TABLES[1],
      observation_id: "price1",
      observation_type: "price_high",
      start: 35,
      end: 40,
    },
  ]);
  const start = periodToUtc(DAY, 36);
  const end = periodToUtc(DAY, 38);
  await copySql(
    `SELECT 'gen1' AS observation_id, 'generation_low' AS observation_type,
       DATE ${lit(DAY)} AS trading_date, 36::INTEGER AS start_trading_period,
       38::INTEGER AS end_trading_period,
       ${lit(start.eventStartUtc.toString())}::TIMESTAMPTZ AS event_start_utc,
       ${lit(end.eventEndUtc.toString())}::TIMESTAMPTZ AS event_end_utc,
       'plant' AS subject_type, 'MAN/manapouri' AS subject_id,
       'SI' AS island, 'MAN/manapouri' AS plant_id,
       0::DOUBLE AS measured_value, 7.33::DOUBLE AS severity, true AS inputs_complete`,
    goldPartitionPath(goldDir, PLANT_TABLES[1], DAY),
  );
  expect(await publish(DAY)).toMatchObject({ status: "complete" });
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    const rows = (
      await connection.runAndReadAll(
        `SELECT member_count, member_observation_ids, observation_types
         FROM read_parquet(${lit(goldPartitionPath(goldDir, TABLES[1], DAY))})`,
      )
    ).getRowObjectsJson() as Array<{
      member_count: number;
      member_observation_ids: string[];
      observation_types: string[];
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.member_count).toBe(1);
    expect(rows[0]?.member_observation_ids).toEqual(["price1"]);
    expect(rows[0]?.observation_types).toEqual(["price_high"]);
  } finally {
    connection.closeSync();
  }
});

test("the same inputs give identical bytes on a second run", async () => {
  await writeSentinels(DAY);
  await writeObservations(DAY, []);
  const bytes = async () =>
    Promise.all(
      TABLES.map((table) =>
        readFile(goldPartitionPath(goldDir, table, DAY)).then((buf) =>
          createHash("sha256").update(buf).digest("hex"),
        ),
      ),
    );
  await publish(DAY);
  const first = await bytes();
  await publish(DAY);
  expect(await bytes()).toEqual(first);
});

test("a changed sentinel fingerprint changes the episode_days inputs_sha256", async () => {
  await writeSentinels(DAY);
  await writeObservations(DAY, []);
  await publish(DAY);
  const sha = async () => {
    const connection = await (
      await DuckDBInstance.create(":memory:")
    ).connect();
    try {
      const rows = (
        await connection.runAndReadAll(
          `SELECT inputs_sha256 FROM read_parquet(${lit(goldPartitionPath(goldDir, TABLES[0], DAY))})`,
        )
      ).getRowObjectsJson() as Array<{ inputs_sha256: string }>;
      return rows[0]?.inputs_sha256;
    } finally {
      connection.closeSync();
    }
  };
  const first = await sha();
  await copySql(
    `SELECT DATE ${lit(DAY)} AS trading_date, 's' AS subject_id,
       'changed' AS inputs_sha256`,
    goldPartitionPath(goldDir, SENTINELS[0], DAY),
  );
  await publish(DAY);
  expect(await sha()).not.toBe(first);
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, expect, test } from "vitest";
import { goldPartitionPath } from "../gold/common.ts";
import { TABLES as EPISODE_TABLES } from "../gold/episodes.ts";
import { completenessView } from "../gold/fixtures/completeness.ts";
import { writeParquet } from "../gold/fixtures/parquet.ts";
import { TABLES as PRICE_ANOMALY_TABLES } from "../gold/price-anomaly.ts";
import { TABLES as PRICE_SEPARATION_TABLES } from "../gold/price-separation.ts";
import { TABLES as RESERVE_PRICE_ANOMALY_TABLES } from "../gold/reserve-price-anomaly.ts";
import { buildEpisodes } from "./export-episodes.ts";

const DATE = "2026-07-27";
const STAMP = {
  analysis_version: 1,
  inputs_sha256: "sha",
  inputs_complete: true,
};

const OBSERVATION_COLUMNS = {
  observation_id: "VARCHAR",
  observation_type: "VARCHAR",
  subject_id: "VARCHAR",
  subject_type: "VARCHAR",
  point_of_connection: "VARCHAR",
  island: "VARCHAR",
  reserve_class: "VARCHAR",
  measured_value: "DOUBLE",
  measured_unit: "VARCHAR",
  baseline_value: "DOUBLE",
  severity: "DOUBLE",
};

let goldDir = "";

afterEach(async () => {
  if (goldDir !== "") await rm(goldDir, { recursive: true, force: true });
  goldDir = "";
});

async function lake(): Promise<string> {
  goldDir = await mkdtemp(join(tmpdir(), "gw-ep-"));
  return goldDir;
}

async function writeDays(dir: string) {
  await writeParquet(
    goldPartitionPath(dir, EPISODE_TABLES[0], DATE),
    {
      trading_date: "DATE",
      episode_count: "INTEGER",
      observation_count: "INTEGER",
      analysis_version: "INTEGER",
      inputs_sha256: "VARCHAR",
      inputs_complete: "BOOLEAN",
    },
    [{ trading_date: DATE, episode_count: 1, observation_count: 2, ...STAMP }],
  );
}

async function writeEpisode(dir: string, members: string[], types: string[]) {
  await writeParquet(
    goldPartitionPath(dir, EPISODE_TABLES[1], DATE),
    {
      episode_id: "VARCHAR",
      seed_observation_id: "VARCHAR",
      event_start_utc: "TIMESTAMPTZ",
      event_end_utc: "TIMESTAMPTZ",
      start_trading_period: "INTEGER",
      end_trading_period: "INTEGER",
      member_count: "INTEGER",
      member_observation_ids: "VARCHAR[]",
      observation_types: "VARCHAR[]",
      islands: "VARCHAR[]",
      severity: "DOUBLE",
    },
    [
      {
        episode_id: "ep1",
        seed_observation_id: members[0],
        event_start_utc: "2026-07-27T04:00:00Z",
        event_end_utc: "2026-07-27T06:30:00Z",
        start_trading_period: 33,
        end_trading_period: 38,
        member_count: members.length,
        member_observation_ids: members,
        observation_types: types,
        islands: ["NI"],
        severity: 2,
      },
    ],
  );
}

const priceObs = (
  id: string,
  poc: string,
  measured: number,
  severity: number,
) => ({
  observation_id: id,
  observation_type: "price_high",
  subject_id: poc,
  subject_type: "point_of_connection",
  point_of_connection: poc,
  island: "NI",
  reserve_class: null,
  measured_value: measured,
  measured_unit: "$/MWh",
  baseline_value: 150.2,
  severity,
});

async function episodesOf(dir: string) {
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    return await buildEpisodes(connection, dir, DATE, completenessView());
  } finally {
    connection.closeSync();
  }
}

test("an episode highlight is the dearest member of each observation type", async () => {
  const dir = await lake();
  await writeDays(dir);
  await writeEpisode(
    dir,
    ["obs-price", "obs-reserve"],
    ["price_high", "reserve_price_high"],
  );
  await writeParquet(
    goldPartitionPath(dir, PRICE_ANOMALY_TABLES[1], DATE),
    OBSERVATION_COLUMNS,
    [priceObs("obs-price", "OTA2201", 3296.04, 2)],
  );
  await writeParquet(
    goldPartitionPath(dir, RESERVE_PRICE_ANOMALY_TABLES[1], DATE),
    OBSERVATION_COLUMNS,
    [
      {
        observation_id: "obs-reserve",
        observation_type: "reserve_price_high",
        subject_id: "SIR|NI",
        subject_type: "reserve_class",
        point_of_connection: null,
        island: "NI",
        reserve_class: "SIR",
        measured_value: 2154.45,
        measured_unit: "$/MWh",
        baseline_value: 12,
        severity: 1.5,
      },
    ],
  );
  const section = await episodesOf(dir);
  expect(section.items[0]?.highlights).toEqual([
    {
      observation_type: "price_high",
      point_of_connection: "OTA2201",
      pair_from: null,
      pair_to: null,
      island: "NI",
      measured_value: 3296.04,
      baseline_value: 150.2,
    },
    {
      observation_type: "reserve_price_high",
      point_of_connection: null,
      pair_from: null,
      pair_to: null,
      island: "NI",
      measured_value: 2154.45,
      baseline_value: 12,
    },
  ]);
});

test("two members of one type keep the more severe place", async () => {
  const dir = await lake();
  await writeDays(dir);
  await writeEpisode(dir, ["obs-ota", "obs-hay"], ["price_high"]);
  await writeParquet(
    goldPartitionPath(dir, PRICE_ANOMALY_TABLES[1], DATE),
    OBSERVATION_COLUMNS,
    [
      priceObs("obs-ota", "OTA2201", 3296, 2),
      priceObs("obs-hay", "HAY2201", 2853, 3),
    ],
  );
  const section = await episodesOf(dir);
  expect(section.items[0]?.highlights).toEqual([
    {
      observation_type: "price_high",
      point_of_connection: "HAY2201",
      pair_from: null,
      pair_to: null,
      island: "NI",
      measured_value: 2853,
      baseline_value: 150.2,
    },
  ]);
});

test("a pair observation exports the two places, not a joined subject id", async () => {
  const dir = await lake();
  await writeDays(dir);
  await writeEpisode(dir, ["obs-sep"], ["separation_high"]);
  await writeParquet(
    goldPartitionPath(dir, PRICE_SEPARATION_TABLES[1], DATE),
    OBSERVATION_COLUMNS,
    [
      {
        observation_id: "obs-sep",
        observation_type: "separation_high",
        subject_id: "OTA2201-BEN2201",
        subject_type: "point_of_connection_pair",
        point_of_connection: null,
        island: null,
        reserve_class: null,
        measured_value: 2724.58,
        measured_unit: "$/MWh",
        baseline_value: 80.1,
        severity: 4,
      },
    ],
  );
  const section = await episodesOf(dir);
  expect(section.items[0]?.highlights).toEqual([
    {
      observation_type: "separation_high",
      point_of_connection: null,
      pair_from: "OTA2201",
      pair_to: "BEN2201",
      island: null,
      measured_value: 2724.58,
      baseline_value: 80.1,
    },
  ]);
});

test("a dashed subject_id is not a pair unless gold says it is", async () => {
  const dir = await lake();
  await writeDays(dir);
  await writeEpisode(dir, ["obs-price"], ["price_high"]);
  await writeParquet(
    goldPartitionPath(dir, PRICE_ANOMALY_TABLES[1], DATE),
    OBSERVATION_COLUMNS,
    [priceObs("obs-price", "OTA2201-HAY2201", 200, 2)],
  );
  const section = await episodesOf(dir);
  expect(section.items[0]?.highlights).toEqual([
    {
      observation_type: "price_high",
      point_of_connection: "OTA2201-HAY2201",
      pair_from: null,
      pair_to: null,
      island: "NI",
      measured_value: 200,
      baseline_value: 150.2,
    },
  ]);
});

test("missing observation partitions yield empty highlights, not omitted", async () => {
  const dir = await lake();
  await writeDays(dir);
  await writeEpisode(dir, ["obs-price"], ["price_high"]);
  const section = await episodesOf(dir);
  expect(section.items[0]?.highlights).toEqual([]);
});

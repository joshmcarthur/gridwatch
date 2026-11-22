import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, expect, test } from "vitest";
import { goldPartitionPath } from "../gold/common.ts";
import { TABLES as RANKING_TABLES } from "../gold/episode-ranking.ts";
import { completenessView } from "../gold/fixtures/completeness.ts";
import {
  DAY,
  EPISODE_ID,
  writeEvidenceGold,
} from "../gold/fixtures/evidence-27-july.ts";
import { writeEvidenceSilver } from "../gold/fixtures/evidence-27-july-silver.ts";
import { writeParquet } from "../gold/fixtures/parquet.ts";
import { buildEvents } from "./export-events.ts";

let root: string;
let silverDir: string;
let goldDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-export-events-"));
  silverDir = join(root, "silver");
  goldDir = join(root, "gold");
});
afterEach(() => rm(root, { recursive: true, force: true }));

const lake = () => writeEvidenceGold({ goldDir });
const silver = () => writeEvidenceSilver({ silverDir });

async function writeRanking(isCandidate: boolean) {
  await writeParquet(
    goldPartitionPath(goldDir, RANKING_TABLES[0], DAY),
    {
      trading_date: "DATE",
      episode_count: "INTEGER",
      candidate_count: "INTEGER",
      history_days: "INTEGER",
      analysis_version: "INTEGER",
      inputs_sha256: "VARCHAR",
      inputs_complete: "BOOLEAN",
    },
    [
      {
        trading_date: DAY,
        episode_count: 1,
        candidate_count: isCandidate ? 1 : 0,
        history_days: 90,
        analysis_version: 3,
        inputs_sha256: "rank",
        inputs_complete: true,
      },
    ],
  );
  await writeParquet(
    goldPartitionPath(goldDir, RANKING_TABLES[1], DAY),
    {
      episode_id: "VARCHAR",
      trading_date: "DATE",
      is_candidate: "BOOLEAN",
      score: "DOUBLE",
      day_rank: "INTEGER",
    },
    [
      {
        episode_id: EPISODE_ID,
        trading_date: DAY,
        is_candidate: isCandidate,
        score: 0.8,
        day_rank: 1,
      },
    ],
  );
}

async function events() {
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    return await buildEvents({
      connection,
      goldDir,
      silverDir,
      date: DAY,
      completeness: completenessView(),
    });
  } finally {
    connection.closeSync();
  }
}

test("missing ranking is a missing events section", async () => {
  await lake();
  await silver();
  const section = await events();
  expect(section.state).toBe("missing");
  expect(section.items).toEqual([]);
});

test("a ranking day with no is_candidate row is complete and empty", async () => {
  await lake();
  await silver();
  await writeRanking(false);
  const section = await events();
  expect(section.state).toBe("complete");
  expect(section.items).toEqual([]);
});

test("the #21 candidate emits Unreviewed claims that match the evidence package", async () => {
  await lake();
  await silver();
  await writeRanking(true);
  const section = await events();
  expect(section.items).toHaveLength(1);
  const event = section.items[0];
  expect(event?.episode_id).toBe(EPISODE_ID);
  expect(event?.review_status).toBe("unreviewed");
  expect(event?.daily_page).toBe("/2026/07/27/");
  const ota = event?.claims.find((claim) => claim.id === "price.OTA2201.p36");
  expect(ota?.value).toBe(3296.04);
  expect(ota?.confidence).toBe("confirmed");
  expect(ota?.source_table).toBe("price_periods");
  expect(ota?.source_path).toContain("price_periods");
  expect(event?.window.prices.map((row) => row.point_of_connection)).toEqual([
    "OTA2201",
    "HAY2201",
    "BEN2201",
  ]);
  const sirNi = event?.window.reserves.find(
    (row) => row.reserve_class === "SIR" && row.island === "NI",
  );
  expect(sirNi?.price.some((value) => value === 2154.45)).toBe(true);
});

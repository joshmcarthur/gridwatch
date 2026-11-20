import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  type GoldInput,
  goldPartitionPath,
  inputFingerprint,
  silverPartitionPath,
  wantedFingerprints,
} from "./common.ts";
import { completenessView } from "./fixtures/completeness.ts";

let root: string;
let silverDir: string;
let goldDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-gold-common-"));
  silverDir = join(root, "silver");
  goldDir = join(root, "gold");
});
afterEach(() => rm(root, { recursive: true, force: true }));

/** A one-row gold partition that holds only the version column. */
async function writeGold(table: string, date: string, sha: string) {
  const path = goldPartitionPath(goldDir, table, date);
  await mkdir(dirname(path), { recursive: true });
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run(
      `COPY (SELECT '${sha}' AS inputs_sha256) TO '${path}' (FORMAT parquet)`,
    );
  } finally {
    connection.closeSync();
  }
}

const UPSTREAM: GoldInput = {
  table: "upstream_gold",
  layer: "gold",
  versionColumn: "inputs_sha256",
  completenessDataset: null,
};

const SILVER: GoldInput = {
  table: "some_silver",
  layer: "silver",
  versionColumn: "bronze_sha256",
  completenessDataset: "some_silver",
};

/** A one-row silver partition that holds only the version column. */
async function writeSilver(table: string, date: string, sha: string) {
  const path = silverPartitionPath(silverDir, table, date);
  await mkdir(dirname(path), { recursive: true });
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run(
      `COPY (SELECT '${sha}' AS bronze_sha256) TO '${path}' (FORMAT parquet)`,
    );
  } finally {
    connection.closeSync();
  }
}

// Catches: a gold input read from the silver directory, or a changed upstream gold
// fingerprint that does not change the wanted fingerprint (the date would never rebuild).
test("a gold input takes its version from goldDir, and a new upstream fingerprint changes the wanted one", async () => {
  const view = completenessView();
  const wanted = () =>
    wantedFingerprints(silverDir, goldDir, 1, [UPSTREAM], view);
  expect((await wanted()).size).toBe(0);

  await writeGold("upstream_gold", "2026-10-31", "aaa");
  const first = (await wanted()).get("2026-10-31");
  expect(first).toBeDefined();
  expect(
    await inputFingerprint(
      silverDir,
      goldDir,
      1,
      [UPSTREAM],
      view,
      "2026-10-31",
    ),
  ).toBe(first);

  await writeGold("upstream_gold", "2026-10-31", "bbb");
  expect((await wanted()).get("2026-10-31")).not.toBe(first);
});

test("a silver input takes its version from silverDir, not goldDir", async () => {
  const view = completenessView();
  await writeSilver("some_silver", "2026-10-31", "silver-aaa");
  await writeGold("some_silver", "2026-10-31", "gold-bbb");
  const wanted = await wantedFingerprints(
    silverDir,
    goldDir,
    1,
    [SILVER],
    view,
  );
  expect(wanted.get("2026-10-31")).toBe(
    await inputFingerprint(silverDir, goldDir, 1, [SILVER], view, "2026-10-31"),
  );
  const goldWanted = await wantedFingerprints(
    silverDir,
    goldDir,
    1,
    [
      {
        ...SILVER,
        layer: "gold",
        versionColumn: "inputs_sha256",
        completenessDataset: null,
      },
    ],
    view,
  );
  expect(goldWanted.get("2026-10-31")).not.toBe(wanted.get("2026-10-31"));
});

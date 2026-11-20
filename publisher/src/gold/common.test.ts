import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  type GoldInput,
  goldPartitionPath,
  inputFingerprint,
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

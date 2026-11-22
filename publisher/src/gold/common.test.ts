import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  asIso,
  byString,
  type GoldInput,
  goldPartitionPath,
  inputFingerprint,
  listSql,
  shiftDate,
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

const WINDOWED: GoldInput = {
  table: "price_periods",
  layer: "gold",
  versionColumn: "inputs_sha256",
  completenessDataset: null,
  windowDays: 2,
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

const fingerprintOf = (
  inputs: readonly GoldInput[],
  date: string,
  completeness = completenessView(),
) => inputFingerprint(silverDir, goldDir, 1, inputs, completeness, date);

const wantedOf = (
  inputs: readonly GoldInput[],
  completeness = completenessView(),
) => wantedFingerprints(silverDir, goldDir, 1, inputs, completeness);

// Catches: localeCompare putting "a" next to "A" or "é" next to "e".
test("byString is code-unit order: uppercase before lowercase, accents after ASCII", () => {
  expect(["é", "Z", "a", "A"].sort(byString)).toEqual(["A", "Z", "a", "é"]);
  expect(byString("a", "a")).toBe(0);
});

// Catches: a gold input read from the silver directory, or a changed upstream gold
// fingerprint that does not change the wanted fingerprint (the date would never rebuild).
test("a gold input takes its version from goldDir, and a new upstream fingerprint changes the wanted one", async () => {
  const view = completenessView();
  const wanted = () => wantedOf([UPSTREAM], view);
  expect((await wanted()).size).toBe(0);

  await writeGold("upstream_gold", "2026-10-31", "aaa");
  const first = (await wanted()).get("2026-10-31");
  expect(first).toBeDefined();
  expect(await fingerprintOf([UPSTREAM], "2026-10-31", view)).toBe(first);

  await writeGold("upstream_gold", "2026-10-31", "bbb");
  expect((await wanted()).get("2026-10-31")).not.toBe(first);
});

test("a silver input takes its version from silverDir, not goldDir", async () => {
  const view = completenessView();
  await writeSilver("some_silver", "2026-10-31", "silver-aaa");
  await writeGold("some_silver", "2026-10-31", "gold-bbb");
  const wanted = await wantedOf([SILVER], view);
  expect(wanted.get("2026-10-31")).toBe(
    await fingerprintOf([SILVER], "2026-10-31", view),
  );
  const goldWanted = await wantedOf(
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

test("windowDays folds in existing days and still wants a date that has only the subject partition", async () => {
  const d0 = "2026-11-10";
  const d1 = shiftDate(d0, 1);
  const d2 = shiftDate(d0, 2);
  await writeGold("price_periods", d2, "sha-subject");
  const wanted = await wantedOf([WINDOWED]);
  expect([...wanted.keys()]).toEqual([d2]);
  expect(wanted.get(d2)).toBe(await fingerprintOf([WINDOWED], d2));

  await writeGold("price_periods", d0, "sha-old");
  await writeGold("price_periods", d1, "sha-mid");
  const withWindow = await wantedOf([WINDOWED]);
  expect([...withWindow.keys()].sort()).toEqual([d0, d1, d2]);
  expect(withWindow.get(d2)).not.toBe(wanted.get(d2));
  expect(withWindow.get(d2)).toBe(await fingerprintOf([WINDOWED], d2));
});

test("a missing earlier window day is omitted, and a changed window day changes the fingerprint", async () => {
  const d0 = "2026-11-10";
  const d1 = shiftDate(d0, 1);
  const d2 = shiftDate(d0, 2);
  await writeGold("price_periods", d1, "sha-mid");
  await writeGold("price_periods", d2, "sha-subject");
  const before = await fingerprintOf([WINDOWED], d2);
  expect((await wantedOf([WINDOWED])).get(d2)).toBe(before);

  await writeGold("price_periods", d0, "sha-old");
  const withEarly = await fingerprintOf([WINDOWED], d2);
  expect(withEarly).not.toBe(before);
  expect((await wantedOf([WINDOWED])).get(d2)).toBe(withEarly);

  await writeGold("price_periods", d1, "sha-mid-b");
  expect(await fingerprintOf([WINDOWED], d2)).not.toBe(withEarly);
});

// Catches: an optional input that drops a date from the wanted list, or one whose late arrival
// does not change the fingerprint (the date would never rebuild).
test("an optional gold input does not decide which dates are wanted, and its arrival changes the fingerprint", async () => {
  const date = "2026-11-10";
  const optional: GoldInput = {
    ...UPSTREAM,
    table: "extra_gold",
    optional: true,
  };
  await writeGold("upstream_gold", date, "aaa");
  const without = (await wantedOf([UPSTREAM, optional])).get(date);
  expect(without).toBeDefined();
  expect(await fingerprintOf([UPSTREAM, optional], date)).toBe(without);

  await writeGold("extra_gold", date, "bbb");
  const withIt = (await wantedOf([UPSTREAM, optional])).get(date);
  expect(withIt).not.toBe(without);
  expect(await fingerprintOf([UPSTREAM, optional], date)).toBe(withIt);
});

test("asIso formats a Date and a string as an instant with Z", () => {
  expect(asIso(new Date("2026-07-27T05:50:26.000Z"))).toBe(
    "2026-07-27T05:50:26Z",
  );
  expect(asIso("2026-07-27T05:50:26Z")).toBe("2026-07-27T05:50:26Z");
});

test("listSql quotes values for a DuckDB VARCHAR array", () => {
  expect(listSql([])).toBe("[]::VARCHAR[]");
  expect(listSql(["OTA2201", "O'Hara"])).toBe(
    "['OTA2201', 'O''Hara']::VARCHAR[]",
  );
});

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DATASET, publishGenerationFleet } from "./generation-fleet.ts";

const NAME = "DispatchedGenerationPlant.csv";
let root: string;
let bronzeDir: string;
let silverDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-silver-"));
  bronzeDir = join(root, "bronze");
  silverDir = join(root, "silver");
});
afterEach(() => rm(root, { recursive: true, force: true }));

/** Store `csv` in bronze the way the collector does, and add its manifest record. */
async function archive(
  date: string,
  csv: string,
  checkedAt = "2026-11-20T00:00:00.000Z",
) {
  const sha256 = createHash("sha256").update(csv).digest("hex");
  const path = `${DATASET}/${sha256}/${NAME}`;
  await mkdir(join(bronzeDir, DATASET, sha256), { recursive: true });
  await writeFile(join(bronzeDir, path), csv);
  const record = {
    dataset: DATASET,
    status: "new",
    checked_at: checkedAt,
    retrieved_at: "2026-11-20T00:00:01.000Z",
    sha256,
    path,
    trading_dates: [date],
  };
  await appendFile(
    join(bronzeDir, "manifest.jsonl"),
    `${JSON.stringify(record)}\n`,
  );
  return { sha256 };
}

const fixture = () =>
  readFile(
    join(import.meta.dirname, "fixtures", "generation-fleet", NAME),
    "utf8",
  );

const publish = (date: string) =>
  publishGenerationFleet({ bronzeDir, silverDir, date });

async function query(file: string, sql: string) {
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    const reader = await connection.runAndReadAll(
      sql.replace("$FILE", `'${file}'`),
    );
    return reader.getRowObjectsJson();
  } finally {
    connection.closeSync();
  }
}

test("publishes a snapshot with fuel, operator periods and provenance", async () => {
  const { sha256 } = await archive("2026-11-19", await fixture());
  const result = await publish("2026-11-19");
  expect(result).toMatchObject({ status: "complete", rows: 7 });
  if (result.status !== "complete") return;
  expect(result.path).toBe(
    join(silverDir, DATASET, "snapshot_date=2026-11-19", "data.parquet"),
  );
  const rows = await query(
    result.path,
    `SELECT unit_code, point_of_connection AS poc, fuel_code, plant_operator_code AS operator,
            effective_start_date::VARCHAR AS start, effective_end_date::VARCHAR AS "end",
            nameplate_megawatts AS mw, is_peaking_plant AS peaking,
            any_value(bronze_sha256) OVER () AS sha,
            strftime(retrieved_at, '%Y-%m-%dT%H:%M:%SZ') AS retrieved
     FROM read_parquet($FILE) WHERE point_of_connection = 'ARG1101'
     ORDER BY effective_start_date`,
  );
  // Branch River changed operator on 2021-10-01. Both periods stay.
  expect(rows).toEqual([
    {
      unit_code: "BRR0",
      poc: "ARG1101",
      fuel_code: "HYD",
      operator: "TRUS",
      start: "1900-01-01",
      end: "2021-10-01",
      mw: 12,
      peaking: false,
      sha: sha256,
      retrieved: "2026-11-20T00:00:01Z",
    },
    {
      unit_code: "BRR0",
      poc: "ARG1101",
      fuel_code: "HYD",
      operator: "CNIR",
      start: "2021-10-01",
      end: "2099-12-31",
      mw: 12,
      peaking: false,
      sha: sha256,
      retrieved: "2026-11-20T00:00:01Z",
    },
  ]);
});

test("a day uses the newest snapshot on or before it and the half-open operator period", async () => {
  await archive("2026-11-19", await fixture());
  const result = await publish("2026-11-19");
  if (result.status !== "complete") throw new Error("expected ok");
  const operatorOn = async (day: string) => {
    const [row] = await query(
      result.path,
      `SELECT plant_operator_code AS operator
       FROM read_parquet($FILE)
       WHERE point_of_connection = 'ARG1101'
         AND effective_start_date <= DATE '${day}'
         AND DATE '${day}' < effective_end_date`,
    );
    return row?.operator;
  };
  // Branch River ends one operator period on 2021-10-01 and starts the next on the same date.
  expect(await operatorOn("2021-09-30")).toBe("TRUS");
  expect(await operatorOn("2021-10-01")).toBe("CNIR");
});

test("publishing the same snapshot again gives identical bytes", async () => {
  await archive("2026-11-19", await fixture());
  const first = await publish("2026-11-19");
  if (first.status !== "complete") throw new Error("expected ok");
  const before = await readFile(first.path);
  await publish("2026-11-19");
  expect(await readFile(first.path)).toEqual(before);
});

test("reports a date with no bronze file as missing", async () => {
  expect(await publish("2026-11-19")).toEqual({
    date: "2026-11-19",
    status: "missing",
  });
});

test.each([
  [
    "a duplicate key",
    (lines: string[]) => [...lines, lines[1] as string],
    "1 duplicate keys",
  ],
  [
    "a bad effective date",
    (lines: string[]) => [
      ...lines.slice(0, 1),
      (lines[1] as string).replace("1900-01-01", "never"),
      ...lines.slice(2),
    ],
    "1 rows have a missing or non-numeric value",
  ],
  [
    "a non-numeric capacity",
    (lines: string[]) => [
      ...lines.slice(0, 1),
      (lines[1] as string).replace(",78.0,", ",big,"),
      ...lines.slice(2),
    ],
    "1 rows have a missing or non-numeric value",
  ],
  [
    "an end before the start",
    (lines: string[]) => [
      ...lines.slice(0, 1),
      (lines[1] as string).replace(
        "1900-01-01,2099-12-31",
        "2099-12-31,1900-01-01",
      ),
      ...lines.slice(2),
    ],
    "1 rows end before they start",
  ],
  [
    "a bad peaking flag",
    (lines: string[]) => [
      ...lines.slice(0, 1),
      (lines[1] as string).replace(",N,", ",X,"),
      ...lines.slice(2),
    ],
    "1 rows have a peaking flag that is not Y or N",
  ],
  [
    "no fuel code",
    (lines: string[]) => [
      ...lines.slice(0, 1),
      (lines[1] as string).replace(",HYD,Hydro,N,", ",,Hydro,N,"),
      ...lines.slice(2),
    ],
    "1 rows lack a plant name, unit, point of connection, fuel or operator",
  ],
  [
    "overlapping ranges",
    (lines: string[]) => [
      ...lines.slice(0, 3),
      (lines[3] as string).replace(
        "2021-10-01,2099-12-31",
        "2021-09-01,2099-12-31",
      ),
      ...lines.slice(4),
    ],
    "1 overlapping ranges for the same unit",
  ],
  ["no rows", (lines: string[]) => lines.slice(0, 1), "no rows"],
  [
    "a missing column",
    (lines: string[]) => [
      (lines[0] as string).replace("FuelCode", "Fuel_Code"),
      ...lines.slice(1),
    ],
    expect.stringContaining("cannot read the file"),
  ],
])(
  "marks a snapshot with %s as invalid and writes nothing",
  async (_name, mutate, error) => {
    const lines = (await fixture()).trimEnd().split("\n");
    // Row 1 is Aratiatia: capacity 78.0, always in force, not a peaking plant.
    await archive("2026-11-19", `${mutate(lines).join("\n")}\n`);
    const result = await publish("2026-11-19");
    expect(result).toMatchObject({ status: "invalid" });
    if (result.status === "invalid")
      expect(result.errors).toContainEqual(error);
    expect(existsSync(join(silverDir, DATASET))).toBe(false);
  },
);

test("uses the version with the newer manifest record", async () => {
  const csv = await fixture();
  await archive("2026-11-19", csv, "2026-11-19T00:00:00.000Z");
  const newer = await archive(
    "2026-11-19",
    csv.replaceAll("Aratiatia", "Aratiatia New"),
    "2026-11-20T00:00:00.000Z",
  );
  const result = await publish("2026-11-19");
  if (result.status !== "complete") throw new Error("expected ok");
  const [row] = await query(
    result.path,
    "SELECT any_value(bronze_sha256) AS sha, count(*) FILTER (WHERE plant_name = 'Aratiatia New') AS n FROM read_parquet($FILE)",
  );
  expect(row).toMatchObject({ sha: newer.sha256, n: "1" });
});

test("an invalid snapshot leaves the older partition untouched", async () => {
  const csv = await fixture();
  await archive("2026-11-19", csv);
  const first = await publish("2026-11-19");
  if (first.status !== "complete") throw new Error("expected ok");
  const before = await readFile(first.path);
  await archive(
    "2026-11-19",
    `${csv}${csv.split("\n")[1]}\n`,
    "2026-11-21T00:00:00.000Z",
  );
  expect(await publish("2026-11-19")).toMatchObject({ status: "invalid" });
  expect(await readFile(first.path)).toEqual(before);
});

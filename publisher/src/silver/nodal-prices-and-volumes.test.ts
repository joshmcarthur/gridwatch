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
import {
  DATASET,
  publishNodalPricesAndVolumes,
} from "./nodal-prices-and-volumes.ts";

const fixtures = join(
  import.meta.dirname,
  "fixtures",
  "nodal-prices-and-volumes",
);
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
  const name = `${date.replaceAll("-", "")}_DispatchNodalPricesAndVolumes.csv`;
  const path = `${DATASET}/${sha256}/${name}`;
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
  return { sha256, name };
}

const fixture = (date: string) =>
  readFile(
    join(
      fixtures,
      `${date.replaceAll("-", "")}_DispatchNodalPricesAndVolumes.csv`,
    ),
    "utf8",
  );

/** Replace the comma-separated field at `index` of `line`. */
const setField = (line: string, index: number, value: string) =>
  line
    .split(",")
    .map((field, i) => (i === index ? value : field))
    .join(",");
const PRICE = 14;
const DEAD_FLAG = 15;

const publish = (date: string) =>
  publishNodalPricesAndVolumes({ bronzeDir, silverDir, date });

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

test("publishes a normal 48-period day with UTC times, null N/A fields and provenance", async () => {
  const { sha256, name } = await archive(
    "2026-11-18",
    await fixture("2026-11-18"),
  );
  const result = await publish("2026-11-18");
  expect(result).toMatchObject({ status: "complete", rows: 864 });
  if (result.status !== "complete") return;
  expect(result.path).toBe(
    join(silverDir, DATASET, "trading_date=2026-11-18", "data.parquet"),
  );
  const [row] = await query(
    result.path,
    `SELECT count(DISTINCT trading_period) AS periods,
            strftime(min(event_start_utc), '%Y-%m-%dT%H:%M:%SZ') AS first_start,
            strftime(max(event_end_utc), '%Y-%m-%dT%H:%M:%SZ') AS last_end,
            count(*) FILTER (WHERE unit_code IS NULL AND plant_name IS NULL) AS poc_rows,
            count(*) FILTER (WHERE unit_code = 'PPI0' AND is_dead AND is_disconnected) AS dead_rows,
            count(DISTINCT case_id) FILTER (WHERE event_start_utc = TIMESTAMPTZ '2026-11-17 14:10:00+00') AS cases_in_rerun_interval,
            any_value(bronze_file_name) AS file, any_value(bronze_sha256) AS sha,
            strftime(any_value(retrieved_at), '%Y-%m-%dT%H:%M:%SZ') AS retrieved
     FROM read_parquet($FILE)`,
  );
  expect(row).toEqual({
    periods: "48",
    first_start: "2026-11-17T11:00:00Z",
    last_end: "2026-11-18T11:00:00Z",
    poc_rows: "288",
    dead_rows: "288",
    cases_in_rerun_interval: "2",
    file: name,
    sha: sha256,
    retrieved: "2026-11-20T00:00:01Z",
  });
});

test("publishes a 46-period DST day", async () => {
  await archive("2026-09-27", await fixture("2026-09-27"));
  const result = await publish("2026-09-27");
  expect(result).toMatchObject({ status: "complete", rows: 816 });
  if (result.status !== "complete") return;
  const [row] = await query(
    result.path,
    `SELECT count(DISTINCT trading_period) AS periods,
            strftime(min(event_start_utc), '%Y-%m-%dT%H:%M:%SZ') AS first_start,
            strftime(max(event_end_utc), '%Y-%m-%dT%H:%M:%SZ') AS last_end
     FROM read_parquet($FILE)`,
  );
  expect(row).toEqual({
    periods: "46",
    first_start: "2026-09-26T12:00:00Z",
    last_end: "2026-09-27T11:00:00Z",
  });
});

test("publishing the same day again gives identical bytes", async () => {
  await archive("2026-11-18", await fixture("2026-11-18"));
  const first = await publish("2026-11-18");
  if (first.status !== "complete") throw new Error("expected ok");
  const before = await readFile(first.path);
  await publish("2026-11-18");
  expect(await readFile(first.path)).toEqual(before);
});

test("publishes a day with missing periods as partial, but not a day with missing intervals", async () => {
  const lines = (await fixture("2026-11-18")).trimEnd().split("\n");
  // Periods 24 and 25 are gone. Period 26 loses its first interval only.
  const kept = lines.filter(
    (l) =>
      !l.startsWith("2026-11-18,24,") &&
      !l.startsWith("2026-11-18,25,") &&
      !l.includes("2026-11-18T12:30:00.000"),
  );
  await archive("2026-11-18", `${kept.join("\n")}\n`);
  const result = await publish("2026-11-18");
  expect(result).toMatchObject({
    status: "partial",
    rows: kept.length - 1,
    missingPeriods: [24, 25],
  });
  if (result.status !== "partial") return;
  const [row] = await query(
    result.path,
    `SELECT count(*) AS n, count(DISTINCT trading_period) AS periods,
            count(*) FILTER (WHERE trading_period = 26) > 0 AS has_26
     FROM read_parquet($FILE)`,
  );
  expect(row).toEqual({
    n: String(kept.length - 1),
    periods: "46",
    has_26: true,
  });
});

test("reports a day with no bronze file as missing", async () => {
  expect(await publish("2026-11-18")).toEqual({
    date: "2026-11-18",
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
    "a non-numeric price",
    (lines: string[]) => [
      ...lines.slice(0, 1),
      setField(lines[1] as string, PRICE, "n/a"),
      ...lines.slice(2),
    ],
    "1 rows have a missing or non-numeric value",
  ],
  [
    "a trading period outside the day",
    (lines: string[]) => [
      ...lines,
      (lines[1] as string).replace("2026-11-18,1,", "2026-11-18,49,"),
    ],
    "1 rows have a trading period outside 1 to 48",
  ],
  [
    "an interval outside its trading period",
    (lines: string[]) => [
      ...lines.slice(0, 1),
      (lines[1] as string).replace("2026-11-18,1,", "2026-11-18,2,"),
      ...lines.slice(2),
    ],
    "1 rows have an interval that is not on a 5-minute boundary inside its trading period",
  ],
  [
    "an interval off the 5-minute boundary",
    (lines: string[]) => [
      ...lines.slice(0, 1),
      (lines[1] as string).replace("T00:00:00.000+", "T00:01:00.000+"),
      ...lines.slice(2),
    ],
    "1 rows have an interval that is not on a 5-minute boundary inside its trading period",
  ],
  [
    "a bad dead flag",
    (lines: string[]) => [
      ...lines.slice(0, 1),
      setField(lines[1] as string, DEAD_FLAG, "X"),
      ...lines.slice(2),
    ],
    "1 rows have a dead or disconnected flag that is not Y or N",
  ],
  [
    "a row for another day",
    (lines: string[]) => [
      ...lines,
      (lines[1] as string).replace("2026-11-18,", "2026-11-17,"),
    ],
    "1 rows are not for 2026-11-18",
  ],
])(
  "marks a day with %s as invalid and writes nothing",
  async (_name, mutate, error) => {
    const lines = (await fixture("2026-11-18")).trimEnd().split("\n");
    await archive("2026-11-18", `${mutate(lines).join("\n")}\n`);
    const result = await publish("2026-11-18");
    expect(result).toMatchObject({ status: "invalid" });
    if (result.status === "invalid") expect(result.errors).toContain(error);
    expect(existsSync(join(silverDir, DATASET))).toBe(false);
  },
);

test("uses the version with the newer manifest record", async () => {
  const lines = (await fixture("2026-11-18")).trimEnd().split("\n");
  await archive(
    "2026-11-18",
    `${lines.join("\n")}\n`,
    "2026-11-19T00:00:00.000Z",
  );
  const newer = await archive(
    "2026-11-18",
    `${[lines[0], setField(lines[1] as string, PRICE, "999.5"), ...lines.slice(2)].join("\n")}\n`,
    "2026-11-20T00:00:00.000Z",
  );
  const result = await publish("2026-11-18");
  if (result.status !== "complete") throw new Error("expected ok");
  const [row] = await query(
    result.path,
    "SELECT any_value(bronze_sha256) AS sha, max(dollars_per_megawatt_hour) AS top FROM read_parquet($FILE)",
  );
  expect(row).toMatchObject({ sha: newer.sha256, top: 999.5 });
});

test("an invalid day leaves the older partition untouched", async () => {
  const lines = (await fixture("2026-11-18")).trimEnd().split("\n");
  await archive("2026-11-18", `${lines.join("\n")}\n`);
  const first = await publish("2026-11-18");
  if (first.status !== "complete") throw new Error("expected ok");
  const before = await readFile(first.path);
  await archive(
    "2026-11-18",
    `${[...lines, lines[1]].join("\n")}\n`,
    "2026-11-21T00:00:00.000Z",
  );
  expect(await publish("2026-11-18")).toMatchObject({ status: "invalid" });
  expect(await readFile(first.path)).toEqual(before);
});

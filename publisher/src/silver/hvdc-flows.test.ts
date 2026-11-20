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
import { DATASET, publishHvdcFlows } from "./hvdc-flows.ts";

const fixtures = join(import.meta.dirname, "fixtures", "hvdc-flows");
let root: string;
let bronzeDir: string;
let silverDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-silver-"));
  bronzeDir = join(root, "bronze");
  silverDir = join(root, "silver");
});
afterEach(() => rm(root, { recursive: true, force: true }));

/**
 * Store a monthly file in bronze the way the collector does. The manifest record lists every
 * date of the month.
 */
async function archive(
  month: string,
  csv: string,
  checkedAt = "2026-11-21T00:00:00.000Z",
) {
  const sha256 = createHash("sha256").update(csv).digest("hex");
  const name = `${month}_HVDC_flows.csv`;
  const path = `${DATASET}/${sha256}/${name}`;
  await mkdir(join(bronzeDir, DATASET, sha256), { recursive: true });
  await writeFile(join(bronzeDir, path), csv);
  const first = Temporal.PlainDate.from(
    `${month.slice(0, 4)}-${month.slice(4)}-01`,
  );
  const record = {
    dataset: DATASET,
    status: "new",
    checked_at: checkedAt,
    retrieved_at: "2026-11-21T00:00:01.000Z",
    sha256,
    path,
    trading_dates: Array.from({ length: first.daysInMonth }, (_, i) =>
      first.add({ days: i }).toString(),
    ),
  };
  await appendFile(
    join(bronzeDir, "manifest.jsonl"),
    `${JSON.stringify(record)}\n`,
  );
  return { sha256, name };
}

const fixture = (month: string) =>
  readFile(join(fixtures, `${month}_HVDC_flows.csv`), "utf8");
const linesOf = async (month: string) =>
  (await fixture(month)).trimEnd().split("\n");
const toCsv = (lines: string[]) => `${lines.join("\n")}\n`;

/** Source columns: 8 identifier columns (Trading_Date is the 8th), then TP1. */
const DATE_COLUMN = 7;
const setCell = (line: string, period: number, value: string) => {
  const cells = line.split(",");
  cells[DATE_COLUMN + period] = value;
  return cells.join(",");
};
const rowsFor = (lines: string[], date: string) =>
  lines.filter((l) => l.split(",")[DATE_COLUMN] === date);
/** Sum of every TP value in the source rows for `date`. */
const sourceTotal = (lines: string[], date: string) =>
  rowsFor(lines, date)
    .flatMap((l) => l.split(",").slice(DATE_COLUMN + 1))
    .filter((v) => v !== "")
    .reduce((sum, v) => sum + Number(v), 0);
/** The first source row of a date. */
const firstRowIndex = (lines: string[], date: string) =>
  lines.findIndex((l) => l.split(",")[DATE_COLUMN] === date);

const publish = (date: string) =>
  publishHvdcFlows({ bronzeDir, silverDir, date });

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

const SPAN_SQL = `SELECT count(DISTINCT trading_period) AS periods,
            strftime(min(event_start_utc), '%Y-%m-%dT%H:%M:%SZ') AS first_start,
            strftime(max(event_end_utc), '%Y-%m-%dT%H:%M:%SZ') AS last_end,
            sum(kilowatt_hours) AS total
     FROM read_parquet($FILE)`;

test("publishes a normal 48-period northward day: four units, kWh, UTC times, provenance", async () => {
  const lines = await linesOf("202610");
  const { sha256, name } = await archive("202610", toCsv(lines));
  const result = await publish("2026-10-31");
  // 4 units x 48 periods. TP49 and TP50 are blank.
  expect(result).toMatchObject({ status: "complete", rows: 192 });
  if (result.status !== "complete") return;
  expect(result.path).toBe(
    join(silverDir, DATASET, "trading_date=2026-10-31", "data.parquet"),
  );
  const [row] = await query(result.path, SPAN_SQL);
  expect(row).toEqual({
    periods: "48",
    first_start: "2026-10-30T11:00:00Z",
    last_end: "2026-10-31T11:00:00Z",
    total: sourceTotal(lines, "2026-10-31"),
  });
  const [meta] = await query(
    result.path,
    `SELECT count(DISTINCT (point_of_connection, flow_direction)) AS units,
            any_value(bronze_file_name) AS file, any_value(bronze_sha256) AS sha,
            strftime(any_value(retrieved_at), '%Y-%m-%dT%H:%M:%SZ') AS retrieved,
            max(kilowatt_hours) FILTER (WHERE point_of_connection = 'BEN2201'
              AND flow_direction = 'X' AND trading_period = 1) AS ben_x_tp1
     FROM read_parquet($FILE)`,
  );
  expect(meta).toEqual({
    units: "4",
    file: name,
    sha: sha256,
    retrieved: "2026-11-21T00:00:01Z",
    ben_x_tp1: 204554,
  });
});

test("publishes the 50-period DST-end day with negative net flow kept", async () => {
  const lines = await linesOf("202604");
  await archive("202604", toCsv(lines));
  const result = await publish("2026-04-05");
  expect(result).toMatchObject({ status: "complete", rows: 200 });
  if (result.status !== "complete") return;
  const [row] = await query(result.path, SPAN_SQL);
  expect(row).toEqual({
    periods: "50",
    first_start: "2026-04-04T11:00:00Z",
    last_end: "2026-04-05T12:00:00Z",
    total: sourceTotal(lines, "2026-04-05"),
  });
});

test("publishes the 46-period DST-start day", async () => {
  const lines = await linesOf("202609");
  await archive("202609", toCsv(lines));
  const result = await publish("2026-09-27");
  expect(result).toMatchObject({ status: "complete", rows: 184 });
  if (result.status !== "complete") return;
  const [row] = await query(result.path, SPAN_SQL);
  expect(row).toEqual({
    periods: "46",
    first_start: "2026-09-26T12:00:00Z",
    last_end: "2026-09-27T11:00:00Z",
    total: sourceTotal(lines, "2026-09-27"),
  });
});

test("publishing the same day again gives identical bytes", async () => {
  await archive("202604", await fixture("202604"));
  const first = await publish("2026-04-05");
  if (first.status !== "complete") throw new Error("expected ok");
  const before = await readFile(first.path);
  await publish("2026-04-05");
  expect(await readFile(first.path)).toEqual(before);
});

test("publishes a day with a period blank for every unit as partial", async () => {
  const lines = await linesOf("202610");
  const day = rowsFor(lines, "2026-10-31");
  const blanked = lines.map((l) => (day.includes(l) ? setCell(l, 5, "") : l));
  await archive("202610", toCsv(blanked));
  const result = await publish("2026-10-31");
  expect(result).toMatchObject({
    status: "partial",
    rows: 192 - 4,
    missingPeriods: [5],
  });
});

test("marks a day with a blank cell for one unit as invalid and writes nothing", async () => {
  const lines = await linesOf("202610");
  const index = firstRowIndex(lines, "2026-10-31");
  const mutated = lines.map((l, i) => (i === index ? setCell(l, 5, "") : l));
  await archive("202610", toCsv(mutated));
  expect(await publish("2026-10-31")).toMatchObject({
    status: "invalid",
    errors: ["1 blank cells in trading periods that other units fill"],
  });
  expect(existsSync(join(silverDir, DATASET))).toBe(false);
});

test("reports a day with every cell blank as missing and writes nothing", async () => {
  const lines = await linesOf("202610");
  const day = rowsFor(lines, "2026-10-31");
  const blanked = lines.map((l) =>
    day.includes(l) ? l.split(",").slice(0, 8).join(",") + ",".repeat(50) : l,
  );
  await archive("202610", toCsv(blanked));
  expect(await publish("2026-10-31")).toEqual({
    date: "2026-10-31",
    status: "missing",
  });
  expect(existsSync(join(silverDir, DATASET))).toBe(false);
});

test("reports a day that the monthly file does not hold as missing", async () => {
  await archive("202610", await fixture("202610"));
  expect(await publish("2026-10-25")).toEqual({
    date: "2026-10-25",
    status: "missing",
  });
  expect(existsSync(join(silverDir, DATASET))).toBe(false);
});

test("reports a day with no bronze file as missing", async () => {
  expect(await publish("2026-10-31")).toEqual({
    date: "2026-10-31",
    status: "missing",
  });
});

test.each([
  [
    "a blank point of connection",
    (lines: string[], i: number) =>
      lines.map((l, j) => (j === i ? l.replace(/^[^,]*,/, ",") : l)),
    "1 rows have a blank point of connection or flow direction",
  ],
  [
    "a unit of measure other than kWh",
    (lines: string[], i: number) =>
      lines.map((l, j) => (j === i ? l.replace(",kWh,", ",MWh,") : l)),
    "1 rows have a unit of measure other than kWh",
  ],
  [
    "a flow direction other than X or I",
    (lines: string[], i: number) =>
      lines.map((l, j) => (j === i ? l.replace(/,[XI],/, ",Z,") : l)),
    "1 rows have a flow direction other than X or I",
  ],
  [
    "a duplicate unit",
    (lines: string[], i: number) => [...lines, lines[i] as string],
    "1 duplicate units",
  ],
  [
    "a non-numeric value",
    (lines: string[], i: number) =>
      lines.map((l, j) => (j === i ? setCell(l, 3, "n/a") : l)),
    "1 values are not finite numbers",
  ],
  [
    "a value in TP49 on a 48-period day",
    (lines: string[], i: number) =>
      lines.map((l, j) => (j === i ? setCell(l, 49, "5") : l)),
    "1 values are outside trading periods 1 to 48",
  ],
])(
  "marks a day with %s as invalid and writes nothing",
  async (_name, mutate, error) => {
    const lines = await linesOf("202610");
    const index = firstRowIndex(lines, "2026-10-31");
    await archive("202610", toCsv(mutate(lines, index)));
    const result = await publish("2026-10-31");
    expect(result).toMatchObject({ status: "invalid" });
    if (result.status === "invalid")
      expect(result.errors).toContainEqual(error);
    expect(existsSync(join(silverDir, DATASET))).toBe(false);
  },
);

test("marks a file with a missing column as invalid", async () => {
  const lines = await linesOf("202610");
  await archive(
    "202610",
    toCsv(
      lines.map((l, i) =>
        i === 0 ? l.replace("Unit_Measure", "UnitMeasure") : l,
      ),
    ),
  );
  expect(await publish("2026-10-31")).toMatchObject({
    status: "invalid",
    errors: [expect.stringContaining("cannot read the file")],
  });
});

test("marks a file with no rows, or a date that does not parse, as invalid", async () => {
  const lines = await linesOf("202610");
  await archive("202610", toCsv(lines.slice(0, 1)));
  expect(await publish("2026-10-31")).toMatchObject({
    status: "invalid",
    errors: ["no rows"],
  });
  await archive(
    "202610",
    toCsv([...lines, (lines[1] as string).replace("2026-10-24", "October 24")]),
    "2026-11-22T00:00:00.000Z",
  );
  expect(await publish("2026-10-31")).toMatchObject({
    status: "invalid",
    errors: ["1 rows have a trading date that does not parse"],
  });
});

test("a revised monthly file replaces the partition, and an invalid revision keeps the older one", async () => {
  const lines = await linesOf("202610");
  await archive("202610", toCsv(lines), "2026-11-21T00:00:00.000Z");
  const first = await publish("2026-10-31");
  if (first.status !== "complete") throw new Error("expected ok");

  const index = firstRowIndex(lines, "2026-10-31");
  const revised = lines.map((l, i) => (i === index ? setCell(l, 1, "999") : l));
  const newer = await archive(
    "202610",
    toCsv(revised),
    "2026-11-22T00:00:00.000Z",
  );
  const replaced = await publish("2026-10-31");
  if (replaced.status !== "complete") throw new Error("expected ok");
  const [row] = await query(
    replaced.path,
    "SELECT any_value(bronze_sha256) AS sha, count(*) FILTER (WHERE kilowatt_hours = 999) AS top FROM read_parquet($FILE)",
  );
  expect(row).toMatchObject({ sha: newer.sha256, top: "1" });

  const broken = lines.map((l, i) => (i === index ? setCell(l, 5, "") : l));
  const invalid = await archive(
    "202610",
    toCsv(broken),
    "2026-11-23T00:00:00.000Z",
  );
  expect(await publish("2026-10-31")).toMatchObject({ status: "invalid" });
  const [kept] = await query(
    replaced.path,
    "SELECT any_value(bronze_sha256) AS sha FROM read_parquet($FILE)",
  );
  expect(kept).toEqual({ sha: newer.sha256 });
  expect(invalid.sha256).not.toBe(newer.sha256);
});

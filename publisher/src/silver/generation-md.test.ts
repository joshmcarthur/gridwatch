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
import { DATASET, publishGenerationMd } from "./generation-md.ts";

const fixtures = join(import.meta.dirname, "fixtures", "generation-md");
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
  checkedAt = "2026-11-20T00:00:00.000Z",
) {
  const sha256 = createHash("sha256").update(csv).digest("hex");
  const name = `${month}_Generation_MD.csv`;
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
    retrieved_at: "2026-11-20T00:00:01.000Z",
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
  readFile(join(fixtures, `${month}_Generation_MD.csv`), "utf8");
const linesOf = async (month: string) =>
  (await fixture(month)).trimEnd().split("\n");
const toCsv = (lines: string[]) => `${lines.join("\n")}\n`;

/** Source columns: 7 identifier columns, then TP1. */
const setCell = (line: string, period: number, value: string) => {
  const cells = line.split(",");
  cells[6 + period] = value;
  return cells.join(",");
};
const rowsFor = (lines: string[], date: string) =>
  lines.filter((l) => l.split(",")[6] === date);
/** Sum of every TP value in the source rows for `date`. */
const sourceTotal = (lines: string[], date: string) =>
  rowsFor(lines, date)
    .flatMap((l) => l.split(",").slice(7))
    .filter((v) => v !== "")
    .reduce((sum, v) => sum + Number(v), 0);

const publish = (date: string) =>
  publishGenerationMd({ bronzeDir, silverDir, date });

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

test("publishes a normal 48-period day: long rows, UTC times, provenance, source codes, daily total", async () => {
  const lines = await linesOf("202604");
  const { sha256, name } = await archive("202604", toCsv(lines));
  const result = await publish("2026-04-01");
  // 7 units, 48 periods. TP49 and TP50 are blank.
  expect(result).toMatchObject({ status: "complete", rows: 336 });
  if (result.status !== "complete") return;
  expect(result.path).toBe(
    join(silverDir, DATASET, "trading_date=2026-04-01", "data.parquet"),
  );
  const [row] = await query(result.path, SPAN_SQL);
  expect(row).toEqual({
    periods: "48",
    first_start: "2026-03-31T11:00:00Z",
    last_end: "2026-04-01T11:00:00Z",
    total: sourceTotal(lines, "2026-04-01"),
  });
  const [meta] = await query(
    result.path,
    `SELECT count(DISTINCT trading_date) AS dates,
            any_value(bronze_file_name) AS file, any_value(bronze_sha256) AS sha,
            strftime(any_value(retrieved_at), '%Y-%m-%dT%H:%M:%SZ') AS retrieved,
            string_agg(DISTINCT fuel_code || '/' || tech_code, ' ' ORDER BY fuel_code || '/' || tech_code) AS codes
     FROM read_parquet($FILE)`,
  );
  expect(meta).toEqual({
    dates: "1",
    file: name,
    sha: sha256,
    retrieved: "2026-11-20T00:00:01Z",
    // Both code vocabularies stay as the source wrote them.
    codes: "Coal/Thrml ELE/BAT HYD/HYD Hydro/Hydro Solar/Solar WIN/ONW",
  });
});

test("publishes the 50-period DST-end day", async () => {
  const lines = await linesOf("202604");
  await archive("202604", toCsv(lines));
  const result = await publish("2026-04-05");
  expect(result).toMatchObject({ status: "complete", rows: 350 });
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
  expect(result).toMatchObject({ status: "complete", rows: 322 });
  if (result.status !== "complete") return;
  const [row] = await query(result.path, SPAN_SQL);
  expect(row).toEqual({
    periods: "46",
    first_start: "2026-09-26T12:00:00Z",
    last_end: "2026-09-27T11:00:00Z",
    total: sourceTotal(lines, "2026-09-27"),
  });
});

test("each day of one monthly file gets its own partition", async () => {
  await archive("202609", await fixture("202609"));
  const a = await publish("2026-09-26");
  const b = await publish("2026-09-27");
  if (a.status !== "complete" || b.status !== "complete")
    throw new Error("expected ok");
  expect(a.path).not.toBe(b.path);
  expect(a.rows).toBe(336);
});

test("publishing the same day again gives identical bytes", async () => {
  await archive("202604", await fixture("202604"));
  const first = await publish("2026-04-05");
  if (first.status !== "complete") throw new Error("expected ok");
  const before = await readFile(first.path);
  await publish("2026-04-05");
  expect(await readFile(first.path)).toEqual(before);
});

test("accepts the lower-case date header of older files", async () => {
  const csv = (await fixture("202604")).replace("Trading_Date", "Trading_date");
  await archive("202604", csv);
  expect(await publish("2026-04-01")).toMatchObject({
    status: "complete",
    rows: 336,
  });
});

test("publishes a day with a period blank for every unit as partial", async () => {
  const lines = await linesOf("202604");
  const day = rowsFor(lines, "2026-04-01");
  const blanked = lines.map((l) => (day.includes(l) ? setCell(l, 5, "") : l));
  await archive("202604", toCsv(blanked));
  const result = await publish("2026-04-01");
  expect(result).toMatchObject({
    status: "partial",
    rows: 336 - 7,
    missingPeriods: [5],
  });
  if (result.status !== "partial") return;
  const [row] = await query(
    result.path,
    `SELECT count(DISTINCT trading_period) AS periods,
            count(*) FILTER (WHERE trading_period = 5) AS gap
     FROM read_parquet($FILE)`,
  );
  expect(row).toEqual({ periods: "47", gap: "0" });
});

test("marks a day with a blank cell for one unit as invalid", async () => {
  const lines = await linesOf("202604");
  const index = lines.findIndex((l) => l.split(",")[6] === "2026-04-01");
  const mutated = lines.map((l, i) => (i === index ? setCell(l, 5, "") : l));
  await archive("202604", toCsv(mutated));
  const result = await publish("2026-04-01");
  expect(result).toMatchObject({
    status: "invalid",
    errors: ["1 blank cells in trading periods that other units fill"],
  });
  expect(existsSync(join(silverDir, DATASET))).toBe(false);
});

test("reports a day with every cell blank as missing and writes nothing", async () => {
  const lines = await linesOf("202604");
  const day = rowsFor(lines, "2026-04-01");
  const blanked = lines.map((l) =>
    day.includes(l) ? l.split(",").slice(0, 7).join(",") + ",".repeat(50) : l,
  );
  await archive("202604", toCsv(blanked));
  expect(await publish("2026-04-01")).toEqual({
    date: "2026-04-01",
    status: "missing",
  });
  expect(existsSync(join(silverDir, DATASET))).toBe(false);
});

test("marks a day with an unparseable period column as invalid", async () => {
  const lines = await linesOf("202604");
  const extra = lines.map((l, i) =>
    i === 0 ? `${l},TP99999999999` : `${l},${i === 1 ? "5" : ""}`,
  );
  await archive("202604", toCsv(extra));
  const result = await publish("2026-04-01");
  expect(result).toMatchObject({ status: "invalid" });
  if (result.status === "invalid")
    expect(result.errors).toContain(
      "1 values are outside trading periods 1 to 48",
    );
});

test("reports a day with no bronze file as missing", async () => {
  expect(await publish("2026-04-01")).toEqual({
    date: "2026-04-01",
    status: "missing",
  });
});

test("reports a day that the monthly file does not hold as missing and writes nothing", async () => {
  await archive("202604", await fixture("202604"));
  expect(await publish("2026-04-02")).toEqual({
    date: "2026-04-02",
    status: "missing",
  });
  expect(existsSync(join(silverDir, DATASET))).toBe(false);
});

test.each([
  [
    "a duplicate unit",
    (lines: string[]) => [...lines, lines[1] as string],
    "1 duplicate units",
  ],
  [
    "a non-numeric value",
    (lines: string[]) => [
      ...lines.slice(0, 1),
      setCell(lines[1] as string, 3, "n/a"),
      ...lines.slice(2),
    ],
    "1 values are not finite numbers",
  ],
  [
    "a non-finite value",
    (lines: string[]) => [
      ...lines.slice(0, 1),
      setCell(lines[1] as string, 3, "inf"),
      ...lines.slice(2),
    ],
    "1 values are not finite numbers",
  ],
  [
    "a value in TP49 on a 48-period day",
    (lines: string[]) => [
      ...lines.slice(0, 1),
      setCell(lines[1] as string, 49, "5"),
      ...lines.slice(2),
    ],
    "1 values are outside trading periods 1 to 48",
  ],
  [
    "a blank point of connection",
    (lines: string[]) => [
      ...lines.slice(0, 1),
      (lines[1] as string).replace(/^([^,]*),[^,]*,/, "$1,,"),
      ...lines.slice(2),
    ],
    "1 rows have a blank site, point of connection, network or generation code",
  ],
  [
    "a missing column",
    (lines: string[]) => [
      (lines[0] as string).replace("Trading_Date", "TradingDate"),
      ...lines.slice(1),
    ],
    expect.stringContaining("cannot read the file"),
  ],
  [
    "a missing site code column",
    (lines: string[]) => [
      (lines[0] as string).replace("Site_Code", "SiteCode"),
      ...lines.slice(1),
    ],
    expect.stringContaining("cannot read the file"),
  ],
])(
  "marks a day with %s as invalid and writes nothing",
  async (_name, mutate, error) => {
    const lines = await linesOf("202604");
    // Row 1 is a 2026-04-01 row.
    await archive("202604", toCsv(mutate(lines)));
    const result = await publish("2026-04-01");
    expect(result).toMatchObject({ status: "invalid" });
    if (result.status === "invalid")
      expect(result.errors).toContainEqual(error);
    expect(existsSync(join(silverDir, DATASET))).toBe(false);
  },
);

test("marks a value in TP47 on the 46-period day as invalid", async () => {
  const lines = await linesOf("202609");
  const index = lines.findIndex((l) => l.split(",")[6] === "2026-09-27");
  const mutated = lines.map((l, i) => (i === index ? setCell(l, 47, "5") : l));
  await archive("202609", toCsv(mutated));
  const result = await publish("2026-09-27");
  expect(result).toMatchObject({
    status: "invalid",
    errors: ["1 values are outside trading periods 1 to 46"],
  });
});

test("marks a file with no rows, or a date that does not parse, as invalid", async () => {
  const lines = await linesOf("202604");
  await archive("202604", toCsv(lines.slice(0, 1)));
  expect(await publish("2026-04-01")).toMatchObject({
    status: "invalid",
    errors: ["no rows"],
  });
  await archive(
    "202604",
    toCsv([...lines, (lines[1] as string).replace("2026-04-01", "April 1")]),
    "2026-11-21T00:00:00.000Z",
  );
  expect(await publish("2026-04-01")).toMatchObject({
    status: "invalid",
    errors: ["1 rows have a trading date that does not parse"],
  });
});

test("a revised monthly file replaces the partitions of the days it covers", async () => {
  const lines = await linesOf("202604");
  await archive("202604", toCsv(lines), "2026-11-19T00:00:00.000Z");
  const first = await publish("2026-04-01");
  if (first.status !== "complete") throw new Error("expected ok");
  const revised = lines.map((l, i) => (i === 1 ? setCell(l, 1, "999999") : l));
  const newer = await archive(
    "202604",
    toCsv(revised),
    "2026-11-20T00:00:00.000Z",
  );
  const result = await publish("2026-04-01");
  if (result.status !== "complete") throw new Error("expected ok");
  const [row] = await query(
    result.path,
    "SELECT any_value(bronze_sha256) AS sha, max(kilowatt_hours) AS top FROM read_parquet($FILE)",
  );
  expect(row).toMatchObject({ sha: newer.sha256, top: 999999 });
});

test("an invalid day leaves the older partition untouched", async () => {
  const lines = await linesOf("202604");
  await archive("202604", toCsv(lines));
  const first = await publish("2026-04-01");
  if (first.status !== "complete") throw new Error("expected ok");
  const before = await readFile(first.path);
  await archive(
    "202604",
    toCsv([...lines, lines[1] as string]),
    "2026-11-21T00:00:00.000Z",
  );
  expect(await publish("2026-04-01")).toMatchObject({ status: "invalid" });
  expect(await readFile(first.path)).toEqual(before);
});

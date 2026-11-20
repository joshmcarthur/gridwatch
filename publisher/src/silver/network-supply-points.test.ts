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
  publishNetworkSupplyPoints,
} from "./network-supply-points.ts";

const fixtures = join(import.meta.dirname, "fixtures");
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
  const name = `${date.replaceAll("-", "")}_NetworkSupplyPointsTable.csv`;
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
      "network-supply-points",
      `${date.replaceAll("-", "")}_NetworkSupplyPointsTable.csv`,
    ),
    "utf8",
  );

const publish = (date: string) =>
  publishNetworkSupplyPoints({ bronzeDir, silverDir, date });

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

test("publishes a snapshot with provenance, history rows and WGS84 coordinates", async () => {
  const { sha256, name } = await archive(
    "2026-11-19",
    await fixture("2026-11-19"),
  );
  const result = await publish("2026-11-19");
  expect(result).toMatchObject({ status: "complete", rows: 15 });
  if (result.status !== "complete") return;
  expect(result.path).toBe(
    join(silverDir, DATASET, "snapshot_date=2026-11-19", "data.parquet"),
  );
  const [row] = await query(
    result.path,
    `SELECT count(*) FILTER (WHERE is_current) AS current_rows,
            count(*) FILTER (WHERE end_date IS NOT NULL) AS closed_rows,
            count(*) FILTER (WHERE latitude IS NULL) AS no_coordinates,
            any_value(bronze_file_name) AS file, any_value(bronze_sha256) AS sha,
            strftime(any_value(retrieved_at), '%Y-%m-%dT%H:%M:%SZ') AS retrieved
     FROM read_parquet($FILE)`,
  );
  expect(row).toEqual({
    current_rows: "5",
    closed_rows: "10",
    no_coordinates: "2",
    file: name,
    sha: sha256,
    retrieved: "2026-11-20T00:00:01Z",
  });
  // Source IDs stay unchanged. An open row has a null end date.
  const [albany] = await query(
    result.path,
    `SELECT nsp, point_of_connection, island, easting_nztm, northing_nztm, latitude, longitude,
            start_date::VARCHAR AS start_date, end_date::VARCHAR AS end_date
     FROM read_parquet($FILE) WHERE is_current AND point_of_connection = 'ALB0331'`,
  );
  expect(albany).toMatchObject({
    nsp: "ALB0331UNETGN",
    island: "NI",
    easting_nztm: 1750900,
    northing_nztm: 5932739,
    start_date: "2020-08-14",
    end_date: null,
  });
});

test("converts NZTM to WGS84 within 0.000001 degrees of the PROJ result", async () => {
  await archive("2026-11-19", await fixture("2026-11-19"));
  const result = await publish("2026-11-19");
  if (result.status !== "complete") throw new Error("expected ok");
  const rows = await query(
    result.path,
    `SELECT point_of_connection AS poc, any_value(latitude) AS lat, any_value(longitude) AS lon
     FROM read_parquet($FILE)
     WHERE point_of_connection IN ('ABY0111', 'AKL0331', 'ALB0331') GROUP BY ALL ORDER BY poc`,
  );
  // Reference values from pyproj, EPSG:2193 to EPSG:4326.
  const expected = [
    { poc: "ABY0111", lat: -44.251511, lon: 170.800381 },
    { poc: "AKL0331", lat: -36.962752, lon: 174.827615 },
    { poc: "ALB0331", lat: -36.73909, lon: 174.690134 },
  ];
  expect(rows.map((r) => r.poc)).toEqual(expected.map((e) => e.poc));
  for (const [i, e] of expected.entries()) {
    expect(rows[i]?.lat).toBeCloseTo(e.lat, 6);
    expect(rows[i]?.lon).toBeCloseTo(e.lon, 6);
  }
});

test("every point of connection in the dispatch energy prices fixture resolves to an island", async () => {
  await archive("2026-11-19", await fixture("2026-11-19"));
  const result = await publish("2026-11-19");
  if (result.status !== "complete") throw new Error("expected ok");
  const prices = join(
    fixtures,
    "dispatch-energy-prices",
    "20261118_DispatchEnergyPrices.csv",
  );
  const rows = await query(
    result.path,
    `SELECT p.poc, any_value(m.island) AS island
     FROM (SELECT DISTINCT PointOfConnection AS poc
           FROM read_csv('${prices}', header = true, all_varchar = true)) p
     LEFT JOIN read_parquet($FILE) m ON m.point_of_connection = p.poc AND m.is_current
     GROUP BY p.poc ORDER BY p.poc`,
  );
  // OHG1101 has a blank island in the price file. The mapping gives one.
  expect(rows).toEqual([
    { poc: "ALB0331", island: "NI" },
    { poc: "OHG1101", island: "NI" },
  ]);
});

test("an earlier snapshot keeps the mapping that applied then", async () => {
  await archive("2026-01-06", await fixture("2026-01-06"));
  await archive("2026-11-19", await fixture("2026-11-19"));
  const early = await publish("2026-01-06");
  const late = await publish("2026-11-19");
  if (early.status !== "complete" || late.status !== "complete")
    throw new Error("expected ok");
  const sql = `SELECT point_of_connection AS poc FROM read_parquet($FILE)
               WHERE is_current GROUP BY ALL ORDER BY poc`;
  expect((await query(early.path, sql)).map((r) => r.poc)).toEqual([
    "ABY0111",
    "AER0011",
    "AKL0331",
    "ALB0331",
  ]);
  expect((await query(late.path, sql)).map((r) => r.poc)).toEqual([
    "ABY0111",
    "AER0011",
    "AKL0331",
    "ALB0331",
    "OHG1101",
  ]);
  // The January snapshot already holds AER0011 with a start date in the future.
  const [row] = await query(
    early.path,
    `SELECT start_date::VARCHAR AS start_date FROM read_parquet($FILE)
     WHERE point_of_connection = 'AER0011'`,
  );
  expect(row).toEqual({ start_date: "2026-02-01" });
});

test("a day uses the newest snapshot on or before it, then the rows in force that day", async () => {
  await archive("2026-01-06", await fixture("2026-01-06"));
  await archive("2026-11-19", await fixture("2026-11-19"));
  const early = await publish("2026-01-06");
  const late = await publish("2026-11-19");
  if (early.status !== "complete" || late.status !== "complete")
    throw new Error("expected ok");
  const mapping = async (day: string) => {
    const rows = await query(
      early.path,
      `WITH all_rows AS (
         SELECT * FROM read_parquet('${early.path}', hive_partitioning = false)
         UNION ALL
         SELECT * FROM read_parquet('${late.path}', hive_partitioning = false)
       ), chosen AS (
         SELECT max(snapshot_date) AS snapshot_date FROM all_rows
         WHERE snapshot_date <= DATE '${day}'
       )
       SELECT DISTINCT point_of_connection AS poc
       FROM all_rows r, chosen
       WHERE r.snapshot_date = chosen.snapshot_date
         AND r.start_date <= DATE '${day}'
         AND (r.end_date IS NULL OR r.end_date >= DATE '${day}')
       ORDER BY poc`,
    );
    return rows.map((r) => r.poc);
  };
  // January snapshot: AER0011 starts on 2026-02-01. OHG1101 is only in the November snapshot.
  expect(await mapping("2026-01-20")).toEqual([
    "ABY0111",
    "AKL0331",
    "ALB0331",
  ]);
  expect(await mapping("2026-02-01")).toEqual([
    "ABY0111",
    "AER0011",
    "AKL0331",
    "ALB0331",
  ]);
  expect(await mapping("2026-11-19")).toEqual([
    "ABY0111",
    "AER0011",
    "AKL0331",
    "ALB0331",
    "OHG1101",
  ]);
});

test("publishing the same snapshot again gives identical bytes", async () => {
  await archive("2026-11-19", await fixture("2026-11-19"));
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
    "no NSP",
    (lines: string[]) => [
      ...lines.slice(0, 1),
      (lines[1] as string).replace("1,ABY0111ALPEGN,,ABY0111,", "1,,,ABY0111,"),
      ...lines.slice(2),
    ],
    "1 rows have no NSP or point of connection",
  ],
  [
    "overlapping ranges",
    (lines: string[]) => [
      ...lines,
      (lines[1] as string).replace("2012-01-01", "2013-01-01"),
    ],
    "1 overlapping ranges for the same NSP",
  ],
  [
    "an island that is not NI or SI",
    (lines: string[]) => [
      ...lines.slice(0, 1),
      (lines[1] as string).replace(",NI,", ",XX,").replace(",SI,", ",XX,"),
      ...lines.slice(2),
    ],
    "1 rows have an island that is not NI or SI",
  ],
  [
    "a current flag that is not 0 or 1",
    (lines: string[]) => [
      ...lines.slice(0, 1),
      `2${(lines[1] as string).slice(1)}`,
      ...lines.slice(2),
    ],
    "1 rows have a current flag that is not 0 or 1",
  ],
  [
    "a start date that does not parse",
    (lines: string[]) => [
      ...lines.slice(0, 1),
      (lines[1] as string).replace(/,\d{4}-\d{2}-\d{2},1,,/, ",soon,1,,"),
      ...lines.slice(2),
    ],
    "1 rows have a missing or non-numeric value",
  ],
  [
    "an end date before the start date",
    (lines: string[]) => [
      ...lines.slice(0, 1),
      (lines[1] as string).replace(
        /,(\d{4}-\d{2}-\d{2}),1,,,/,
        ",$1,1,1990-01-01,48,",
      ),
      ...lines.slice(2),
    ],
    "1 rows end before they start",
  ],
  [
    "an easting without a northing",
    (lines: string[]) => [
      ...lines.slice(0, 1),
      (lines[1] as string).replace(/,(\d{7}),(\d{7}),/, ",$1,,"),
      ...lines.slice(2),
    ],
    "1 rows have coordinates that are not a pair of numbers",
  ],
  [
    "a bad region ID",
    (lines: string[]) => [
      ...lines.slice(0, 1),
      (lines[1] as string).replace(
        ",32,South Canterbury",
        ",x,South Canterbury",
      ),
      ...lines.slice(2),
    ],
    "1 rows have a missing or non-numeric value",
  ],
  [
    "a bad end period",
    (lines: string[]) => [
      ...lines.slice(0, 6),
      (lines[6] as string).replace(",2008-04-30,48,", ",2008-04-30,late,"),
      ...lines.slice(7),
    ],
    "1 rows have a missing or non-numeric value",
  ],
  ["no rows", (lines: string[]) => lines.slice(0, 1), "no rows"],
  [
    "a missing column",
    (lines: string[]) => [
      (lines[0] as string).replace("Island", "Isle"),
      ...lines.slice(1),
    ],
    expect.stringContaining("cannot read the file"),
  ],
])(
  "marks a snapshot with %s as invalid and writes nothing",
  async (_name, mutate, error) => {
    const lines = (await fixture("2026-11-19")).trimEnd().split("\n");
    // Row 1 is the first current row (ABY0111). It has coordinates, an island and no end date.
    await archive("2026-11-19", `${mutate(lines).join("\n")}\n`);
    const result = await publish("2026-11-19");
    expect(result).toMatchObject({ status: "invalid" });
    if (result.status === "invalid")
      expect(result.errors).toContainEqual(error);
    expect(existsSync(join(silverDir, DATASET))).toBe(false);
  },
);

test("uses the version with the newer manifest record", async () => {
  const csv = await fixture("2026-11-19");
  await archive("2026-11-19", csv, "2026-11-19T00:00:00.000Z");
  const newer = await archive(
    "2026-11-19",
    csv.replaceAll("ALBANY", "ALBANY NEW"),
    "2026-11-20T00:00:00.000Z",
  );
  const result = await publish("2026-11-19");
  if (result.status !== "complete") throw new Error("expected ok");
  const [row] = await query(
    result.path,
    "SELECT any_value(bronze_sha256) AS sha, count(*) FILTER (WHERE description = 'ALBANY NEW') AS n FROM read_parquet($FILE)",
  );
  expect(row).toMatchObject({ sha: newer.sha256, n: "3" });
});

test("an invalid snapshot leaves the older partition untouched", async () => {
  const csv = await fixture("2026-11-19");
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

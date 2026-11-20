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
import { runPublish } from "../runner.ts";
import { publishEntityMappings } from "../silver/entity-mappings.ts";
import { publishGenerationMd } from "../silver/generation-md.ts";
import { publishNetworkSupplyPoints } from "../silver/network-supply-points.ts";
import {
  fingerprint,
  goldPartitionPath,
  inputsComplete,
  writeGoldTables,
} from "./common.ts";
import {
  ANALYSIS_VERSION,
  generation,
  publishGeneration,
  TABLES,
} from "./generation.ts";

const FIXTURES = join(import.meta.dirname, "..", "silver", "fixtures");
let root: string;
let bronzeDir: string;
let silverDir: string;
let goldDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-gold-generation-"));
  bronzeDir = join(root, "bronze");
  silverDir = join(root, "silver");
  goldDir = join(root, "gold");
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function query(sql: string) {
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    return (
      await connection.runAndReadAll(
        sql.replaceAll("$S", silverDir).replaceAll("$G", goldDir),
      )
    ).getRowObjectsJson() as Array<Record<string, string | null>>;
  } finally {
    connection.closeSync();
  }
}

const gold = (table: string, date: string) =>
  `'$G/${table}/trading_date=${date}/data.parquet'`;

async function archive(
  dataset: string,
  folder: string,
  fileName: string,
  dates: string[],
) {
  const csv = await readFile(join(FIXTURES, folder, fileName), "utf8");
  const sha256 = createHash("sha256").update(csv).digest("hex");
  const path = `${dataset}/${sha256}/${fileName}`;
  await mkdir(join(bronzeDir, dataset, sha256), { recursive: true });
  await writeFile(join(bronzeDir, path), csv);
  await appendFile(
    join(bronzeDir, "manifest.jsonl"),
    `${JSON.stringify({ dataset, status: "new", retrieved_at: "2026-11-20T00:00:01.000Z", sha256, path, trading_dates: dates })}\n`,
  );
}

const DAYS = ["2026-04-05", "2026-09-26", "2026-09-27"]; // 50, 48 and 46 periods

/** Real silver from the fixtures: Generation_MD, the NSP snapshot, and the entity mappings. */
async function buildSilver() {
  await archive(
    "network_supply_points",
    "network-supply-points",
    "20260106_NetworkSupplyPointsTable.csv",
    ["2026-01-06"],
  );
  await archive("generation_md", "generation-md", "202604_Generation_MD.csv", [
    "2026-04-05",
  ]);
  await archive("generation_md", "generation-md", "202609_Generation_MD.csv", [
    "2026-09-26",
    "2026-09-27",
  ]);
  const args = { bronzeDir, silverDir };
  await publishNetworkSupplyPoints({ ...args, date: "2026-01-06" });
  for (const date of DAYS) {
    await publishGenerationMd({ ...args, date });
    expect(await publishEntityMappings({ silverDir, date })).toMatchObject({
      status: "complete",
    });
  }
}

test("daily totals by fuel, by plant and by period equal the Generation_MD silver total", {
  timeout: 60_000,
}, async () => {
  await buildSilver();
  for (const [date, periods] of [
    ["2026-04-05", 50],
    ["2026-09-26", 48],
    ["2026-09-27", 46],
  ] as const) {
    expect(await publishGeneration({ silverDir, goldDir, date })).toMatchObject(
      { status: "complete" },
    );
    const [silver] = await query(
      `SELECT sum(kilowatt_hours) / 1000 AS mwh FROM '$S/generation_md/trading_date=${date}/data.parquet'`,
    );
    const total = Number(silver?.mwh);
    expect(total).toBeGreaterThan(0);
    for (const table of [
      "generation_by_fuel_day",
      "generation_by_plant_day",
      "generation_by_fuel_period",
      "generation_by_plant_period",
    ]) {
      const [row] = await query(
        `SELECT sum(megawatt_hours) AS mwh FROM ${gold(table, date)}`,
      );
      expect(Number(row?.mwh), table).toBeCloseTo(total, 6);
    }
    // Each trading period has rows, so a DST day has 46 or 50 periods.
    const [count] = await query(
      `SELECT count(DISTINCT trading_period) AS n FROM ${gold("generation_by_fuel_period", date)}`,
    );
    expect(Number(count?.n)).toBe(periods);
    // MWh x 2 is the average MW of a half-hour period.
    const [avg] = await query(
      `SELECT count(*) AS n FROM ${gold("generation_by_plant_period", date)}
       WHERE abs(average_megawatts - megawatt_hours * 2) > 1e-9`,
    );
    expect(Number(avg?.n)).toBe(0);
    const [day] = await query(
      `SELECT sum(average_megawatts) AS mw FROM ${gold("generation_by_fuel_day", date)}`,
    );
    expect(Number(day?.mw)).toBeCloseTo(total / (periods / 2), 6);
  }
});

test("rows carry the analysis version, the fingerprint and the completeness flag", {
  timeout: 60_000,
}, async () => {
  await buildSilver();
  await publishGeneration({ silverDir, goldDir, date: "2026-09-26" });
  const wanted = (await generation.wantedVersions?.(silverDir))?.get(
    "2026-09-26",
  );
  for (const table of TABLES) {
    const rows = await query(
      `SELECT DISTINCT analysis_version, inputs_sha256, inputs_complete
       FROM ${gold(table, "2026-09-26")}`,
    );
    expect(rows).toEqual([
      {
        analysis_version: ANALYSIS_VERSION,
        inputs_sha256: wanted,
        inputs_complete: true,
      },
    ]);
  }
});

test("the same inputs and analysis version give identical bytes", {
  timeout: 60_000,
}, async () => {
  await buildSilver();
  const bytes = async () =>
    Promise.all(
      TABLES.map((t) =>
        readFile(goldPartitionPath(goldDir, t, "2026-04-05")).then((b) =>
          createHash("sha256").update(b).digest("hex"),
        ),
      ),
    );
  await publishGeneration({ silverDir, goldDir, date: "2026-04-05" });
  const first = await bytes();
  await publishGeneration({ silverDir, goldDir, date: "2026-04-05" });
  expect(await bytes()).toEqual(first);
});

test("the fingerprint changes with the analysis version and with an input", () => {
  const inputs = [["generation_md", "a"]] as const;
  expect(fingerprint(1, inputs)).toBe(fingerprint(1, inputs));
  expect(fingerprint(2, inputs)).not.toBe(fingerprint(1, inputs));
  expect(fingerprint(1, [["generation_md", "b"]])).not.toBe(
    fingerprint(1, inputs),
  );
});

/** Write a silver partition from a VALUES list. */
async function silver(table: string, date: string, select: string) {
  const dir = join(silverDir, table, `trading_date=${date}`);
  await mkdir(dir, { recursive: true });
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run(
      `COPY (${select}) TO '${join(dir, "data.parquet")}' (FORMAT parquet)`,
    );
  } finally {
    connection.closeSync();
  }
}

const generationRows = (
  rows: Array<[number, string, string, string, number]>,
) =>
  `SELECT DATE '2026-11-18' AS trading_date, tp::INTEGER AS trading_period,
     TIMESTAMPTZ '2026-11-17 11:00:00+00' + to_minutes(30 * (tp - 1)) AS event_start_utc,
     TIMESTAMPTZ '2026-11-17 11:30:00+00' + to_minutes(30 * (tp - 1)) AS event_end_utc,
     site AS site_code, poc AS point_of_connection, 'NET1' AS network_code, gen AS gen_code,
     'x' AS fuel_code, 'x' AS tech_code, kwh::DOUBLE AS kilowatt_hours,
     'sha-md' AS bronze_file_name, 'sha-md' AS bronze_sha256
   FROM (VALUES ${rows.map(([tp, site, poc, gen, kwh]) => `(${tp}, '${site}', '${poc}', '${gen}', ${kwh})`).join(", ")}) t(tp, site, poc, gen, kwh)`;

test("unmapped plants, battery and incomplete days are kept and flagged", async () => {
  const date = "2026-11-18";
  // Periods 1 and 2 only. A plant with no entity row, a battery, and a plant on an unmapped POC.
  await silver(
    "generation_md",
    date,
    generationRows([
      [1, "AAA", "AAA0111", "hydro1", 1000],
      [2, "AAA", "AAA0111", "hydro1", 3000],
      [1, "BBB", "BBB0111", "bat1", 500],
      [1, "ZZZ", "ZZZ0111", "mystery", 2000],
    ]),
  );
  await silver(
    "entity_plants",
    date,
    `SELECT 'AAA/hydro1' AS plant_id, 'hydro1' AS plant_name, 'hydro' AS fuel_category, 'sha-e' AS inputs_sha256
     UNION ALL SELECT 'BBB/bat1', 'bat1', 'battery', 'sha-e'`,
  );
  await silver(
    "entity_points_of_connection",
    date,
    `SELECT 'AAA0111' AS poc_id, 'SI' AS island, 'sha-e' AS inputs_sha256
     UNION ALL SELECT 'BBB0111', 'NI', 'sha-e'`,
  );
  const result = await publishGeneration({ silverDir, goldDir, date });
  expect(result).toMatchObject({ status: "partial" });
  expect(
    (result as { missingPeriods: number[] }).missingPeriods.slice(0, 3),
  ).toEqual([3, 4, 5]);
  expect(
    await query(
      `SELECT fuel_category, island, megawatt_hours, inputs_complete
       FROM ${gold("generation_by_fuel_day", date)} ORDER BY fuel_category`,
    ),
  ).toEqual([
    {
      fuel_category: "battery",
      island: "NI",
      megawatt_hours: 0.5,
      inputs_complete: false,
    },
    {
      fuel_category: "hydro",
      island: "SI",
      megawatt_hours: 4,
      inputs_complete: false,
    },
    {
      fuel_category: "unmapped",
      island: null,
      megawatt_hours: 2,
      inputs_complete: false,
    },
  ]);
  expect(
    await query(
      `SELECT plant_id, fuel_category, megawatt_hours FROM ${gold("generation_by_plant_day", date)} ORDER BY plant_id`,
    ),
  ).toEqual([
    { plant_id: "AAA/hydro1", fuel_category: "hydro", megawatt_hours: 4 },
    { plant_id: "BBB/bat1", fuel_category: "battery", megawatt_hours: 0.5 },
    { plant_id: "ZZZ/mystery", fuel_category: "unmapped", megawatt_hours: 2 },
  ]);
});

test("a date with no entity silver or no Generation_MD is missing", async () => {
  expect(
    await publishGeneration({ silverDir, goldDir, date: "2026-11-18" }),
  ).toEqual({ date: "2026-11-18", status: "missing" });
});

test("the runner builds gold, skips it when silver is unchanged and rebuilds it when an input changes", {
  timeout: 60_000,
}, async () => {
  await buildSilver();
  const run = () =>
    runPublish({
      bronzeDir,
      silverDir,
      goldDir,
      only: ["gold_generation"],
    }).then((s) => s[0]);
  expect(await run()).toMatchObject({ published: 3, upToDate: 0, failed: [] });
  expect(await run()).toMatchObject({ published: 0, upToDate: 3 });
  // New bronze version of Generation_MD for one day: silver is rewritten with a new sha.
  const file = join(
    silverDir,
    "generation_md",
    "trading_date=2026-09-26",
    "data.parquet",
  );
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run(
      `COPY (SELECT * REPLACE ('new-sha' AS bronze_sha256) FROM read_parquet('${file}')) TO '${file}.new' (FORMAT parquet)`,
    );
  } finally {
    connection.closeSync();
  }
  const { rename } = await import("node:fs/promises");
  await rename(`${file}.new`, file);
  expect(await run()).toMatchObject({ published: 1, upToDate: 2 });
});

test("a NULL trading period does not hide missing periods", async () => {
  const date = "2026-11-18";
  await silver(
    "generation_md",
    date,
    "SELECT 1 AS trading_period UNION ALL SELECT NULL",
  );
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    const result = await inputsComplete(connection, date, [
      join(silverDir, "generation_md", `trading_date=${date}`, "data.parquet"),
    ]);
    expect(result.complete).toBe(false);
    expect(result.missingPeriods).toHaveLength(47);
  } finally {
    connection.closeSync();
  }
});

test("a failure in a later table leaves the date out of date and writes nothing", async () => {
  const date = "2026-11-18";
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await expect(
      writeGoldTables(
        connection,
        [
          ["generation_by_plant_period", "SELECT 1 AS x"],
          ["generation_by_plant_day", "SELECT * FROM no_such_table"],
        ],
        goldDir,
        date,
      ),
    ).rejects.toThrow();
    for (const table of [
      "generation_by_plant_period",
      "generation_by_plant_day",
    ])
      expect(existsSync(goldPartitionPath(goldDir, table, date))).toBe(false);
    await writeGoldTables(
      connection,
      [
        ["generation_by_plant_period", "SELECT 1 AS x"],
        ["generation_by_plant_day", "SELECT 2 AS x"],
      ],
      goldDir,
      date,
    );
    for (const table of [
      "generation_by_plant_period",
      "generation_by_plant_day",
    ])
      expect(existsSync(goldPartitionPath(goldDir, table, date))).toBe(true);
  } finally {
    connection.closeSync();
  }
});

import { createHash } from "node:crypto";
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
import { publishDispatchEnergyPrices } from "./dispatch-energy-prices.ts";
import { publishEntityMappings, TABLES } from "./entity-mappings.ts";
import { FUEL_CATEGORIES, FUEL_MAP } from "./fuel-map.ts";
import { publishGenerationFleet } from "./generation-fleet.ts";
import { publishGenerationMd } from "./generation-md.ts";
import { publishNetworkSupplyPoints } from "./network-supply-points.ts";
import { publishNodalPricesAndVolumes } from "./nodal-prices-and-volumes.ts";

let root: string;
let bronzeDir: string;
let silverDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-entity-"));
  bronzeDir = join(root, "bronze");
  silverDir = join(root, "silver");
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function query(sql: string) {
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    return (
      await connection.runAndReadAll(sql.replaceAll("$S", silverDir))
    ).getRowObjectsJson() as Array<Record<string, string | null>>;
  } finally {
    connection.closeSync();
  }
}

const table = (name: string, date: string) =>
  `'$S/${name}/trading_date=${date}/data.parquet'`;

/** Write a small silver partition. `schema` maps column to SQL type; rows follow its order. */
async function silver(
  dataset: string,
  partition: string,
  schema: Record<string, string>,
  rows: unknown[][],
) {
  const names = Object.keys(schema);
  const literal = (value: unknown) =>
    value === null ? "NULL" : `'${String(value)}'`;
  const values = rows
    .map((row) => `(${row.map(literal).join(", ")})`)
    .join(", ");
  const cast = names.map((n) => `${n}::${schema[n]} AS ${n}`).join(", ");
  const dir = join(silverDir, dataset, partition);
  await mkdir(dir, { recursive: true });
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run(
      `COPY (SELECT ${cast} FROM (VALUES ${values}) t(${names.join(", ")})) TO '${join(dir, "data.parquet")}' (FORMAT parquet)`,
    );
  } finally {
    connection.closeSync();
  }
}

const NSP_SCHEMA = {
  nsp: "VARCHAR",
  point_of_connection: "VARCHAR",
  network_participant: "VARCHAR",
  embedded_under_network_participant: "VARCHAR",
  island: "VARCHAR",
  network_reporting_region_id: "INTEGER",
  network_reporting_region: "VARCHAR",
  latitude: "DOUBLE",
  longitude: "DOUBLE",
  start_date: "DATE",
  end_date: "DATE",
};
/** An NSP row. Only the arguments the tests care about are set. */
const nsp = (
  poc: string,
  island: string | null,
  start: string,
  end: string | null,
  region: [number, string] | null = [1, "Region One"],
  xy: [number, number] | null = null,
) => [
  `${poc}XXXXGN`,
  poc,
  "NET1",
  null,
  island,
  region?.[0] ?? null,
  region?.[1] ?? null,
  xy?.[0] ?? null,
  xy?.[1] ?? null,
  start,
  end,
];
/** The same row under a second NSP code. */
const otherNsp = (row: unknown[]) => ["AAA1101YYYYGN", ...row.slice(1)];
const writeNsp = (snapshot: string, rows: unknown[][]) =>
  silver(
    "network_supply_points",
    `snapshot_date=${snapshot}`,
    NSP_SCHEMA,
    rows,
  );

const DISPATCH_SCHEMA = {
  trading_date: "DATE",
  point_of_connection: "VARCHAR",
  island: "VARCHAR",
};
const writeDispatch = (date: string, rows: Array<[string, string | null]>) =>
  silver(
    "dispatch_energy_prices",
    `trading_date=${date}`,
    DISPATCH_SCHEMA,
    rows.map(([poc, island]) => [date, poc, island]),
  );

const build = (date: string) => publishEntityMappings({ silverDir, date });

test("a POC missing from the NSP table takes its island from the price files", async () => {
  await writeNsp("2026-11-01", [nsp("ABC1101", "NI", "2020-01-01", null)]);
  // Blank on 17 Nov: the value of another day fills it.
  await writeDispatch("2026-11-17", [
    ["BEN2201", null],
    ["ABC1101", "NI"],
  ]);
  await writeDispatch("2026-11-18", [
    ["BEN2201", "SI"],
    ["ABC1101", "NI"],
  ]);
  await writeDispatch("2026-11-19", [["BEN2201", "SI"]]);

  expect(await build("2026-11-17")).toMatchObject({ status: "complete" });
  const pocs = await query(
    `SELECT poc_id, site_id, island, island_source, nsp_row_status, region_id, latitude
     FROM ${table("entity_points_of_connection", "2026-11-17")} ORDER BY poc_id`,
  );
  expect(pocs).toEqual([
    {
      poc_id: "ABC1101",
      site_id: "ABC",
      island: "NI",
      island_source: "nsp",
      nsp_row_status: "in_force",
      region_id: 1,
      latitude: null,
    },
    {
      poc_id: "BEN2201",
      site_id: "BEN",
      island: "SI",
      island_source: "dispatch_prices",
      nsp_row_status: null,
      region_id: null,
      latitude: null,
    },
  ]);
  // BEN2201 is mapped, so it is not in the report.
  expect(
    await query(
      `SELECT * FROM ${table("entity_unmapped", "2026-11-17")} WHERE dataset = 'dispatch_energy_prices'`,
    ),
  ).toEqual([]);
});

test("a POC with two islands in the price files fails the build", async () => {
  await writeNsp("2026-11-01", [nsp("ABC1101", "NI", "2020-01-01", null)]);
  await writeDispatch("2026-11-17", [["BEN2201", "SI"]]);
  await writeDispatch("2026-11-18", [["BEN2201", "NI"]]);
  const result = await build("2026-11-18");
  expect(result).toEqual({
    date: "2026-11-18",
    status: "invalid",
    errors: ["BEN2201 has two islands in the dispatch price files (NI, SI)"],
  });
  expect(
    await query(
      `SELECT count(*) AS n FROM glob('${silverDir}/entity_*/*/data.parquet')`,
    ),
  ).toEqual([{ n: "0" }]);
});

test("a POC with only closed NSP rows keeps its newest closed row", async () => {
  await writeNsp("2026-11-01", [
    // In force with an older closed row: the row in force wins.
    nsp("AAA1101", "NI", "2000-01-01", "2010-12-31", [1, "Old"]),
    nsp("AAA1101", "NI", "2011-01-01", null, [2, "New"]),
    // Only closed rows: the newest closed row wins.
    nsp("BBB1101", "SI", "2000-01-01", "2005-12-31", [3, "Older"]),
    nsp("BBB1101", "SI", "2006-01-01", "2012-05-31", [4, "Newer"]),
    // Ends the day before: closed. Starts the day after: not yet in force, no mapping.
    nsp("CCC1101", "NI", "2020-01-01", "2026-11-17", [5, "Ended"]),
    nsp("DDD1101", "NI", "2026-11-19", null, [6, "Future"]),
    // Inclusive range: the end date itself is in force.
    nsp("EEE1101", "NI", "2020-01-01", "2026-11-18", [7, "Ends today"]),
  ]);
  await build("2026-11-18");
  expect(
    await query(
      `SELECT poc_id, nsp_row_status, region_id FROM ${table("entity_points_of_connection", "2026-11-18")} ORDER BY poc_id`,
    ),
  ).toEqual([
    { poc_id: "AAA1101", nsp_row_status: "in_force", region_id: 2 },
    { poc_id: "BBB1101", nsp_row_status: "last_closed", region_id: 4 },
    { poc_id: "CCC1101", nsp_row_status: "last_closed", region_id: 5 },
    { poc_id: "EEE1101", nsp_row_status: "in_force", region_id: 7 },
  ]);
});

test("the newest snapshot on or before the day is used, and no snapshot means missing", async () => {
  await writeNsp("2026-10-01", [nsp("OLD1101", "NI", "2020-01-01", null)]);
  await writeNsp("2026-11-01", [nsp("NEW1101", "NI", "2020-01-01", null)]);
  expect(await build("2026-09-30")).toEqual({
    date: "2026-09-30",
    status: "missing",
  });
  await build("2026-10-31");
  await build("2026-11-02");
  expect(
    await query(
      `SELECT poc_id, nsp_snapshot_date::VARCHAR AS snapshot FROM ${table("entity_points_of_connection", "2026-10-31")}`,
    ),
  ).toEqual([{ poc_id: "OLD1101", snapshot: "2026-10-01" }]);
  expect(
    await query(
      `SELECT poc_id FROM ${table("entity_points_of_connection", "2026-11-02")}`,
    ),
  ).toEqual([{ poc_id: "NEW1101" }]);
});

test("a POC with NSPs in two regions has no single region", async () => {
  await writeNsp("2026-11-01", [
    nsp("AAA1101", "NI", "2020-01-01", null, [1, "One"], [-41, 174]),
    otherNsp(nsp("AAA1101", "NI", "2020-01-01", null, [2, "Two"], [-41, 174])),
  ]);
  await build("2026-11-18");
  expect(
    await query(
      `SELECT region_id, region_count, nsp_count, latitude FROM ${table("entity_points_of_connection", "2026-11-18")}`,
    ),
  ).toEqual([
    { region_id: null, region_count: "2", nsp_count: "2", latitude: -41 },
  ]);
  expect(
    await query(
      `SELECT region_id FROM ${table("entity_regions", "2026-11-18")} ORDER BY 1`,
    ),
  ).toEqual([{ region_id: 1 }, { region_id: 2 }]);
});

test("a POC with two islands in the NSP rows fails the build", async () => {
  await writeNsp("2026-11-01", [
    nsp("AAA1101", "NI", "2020-01-01", null),
    otherNsp(nsp("AAA1101", "SI", "2020-01-01", null)),
  ]);
  expect(await build("2026-11-18")).toMatchObject({
    status: "invalid",
    errors: ["AAA1101 has two islands in the NSP rows"],
  });
});

test("every fuel code that has a map line gives a Gridwatch category", () => {
  for (const category of Object.values(FUEL_MAP))
    expect(FUEL_CATEGORIES).toContain(category);
  // The codes seen on live data on 2026-11-20, both vocabularies.
  const live =
    "Hydro HYD Wind WIN Geo GEO Solar SOL Gas GAS Diesel DSL Wood ELE CLG";
  for (const code of live.split(" ")) expect(FUEL_MAP).toHaveProperty(code);
});

test("an unknown fuel code, network code, POC and unit are reported, not dropped", async () => {
  await writeNsp("2026-11-18", [nsp("AAA1101", "NI", "2020-01-01", null)]);
  await silver(
    "generation_fleet",
    "snapshot_date=2026-11-18",
    {
      plant_name: "VARCHAR",
      point_of_connection: "VARCHAR",
      unit_code: "VARCHAR",
      technology_code: "VARCHAR",
      fuel_code: "VARCHAR",
      plant_operator_code: "VARCHAR",
      plant_operator: "VARCHAR",
      nameplate_megawatts: "DOUBLE",
      date_commissioned: "DATE",
      date_decommissioned: "DATE",
      effective_start_date: "DATE",
      effective_end_date: "DATE",
    },
    [
      [
        "A",
        "AAA1101",
        "AAA0",
        "HYD",
        "HYD",
        "OPR1",
        "Operator One",
        10,
        null,
        null,
        "1900-01-01",
        "2099-12-31",
      ],
      [
        "B",
        "AAA1101",
        "BBB0",
        "FUS",
        "FUS",
        "N/A",
        "N/A",
        10,
        null,
        null,
        "1900-01-01",
        "2099-12-31",
      ],
    ],
  );
  await silver(
    "generation_md",
    "trading_date=2026-11-18",
    {
      trading_date: "DATE",
      site_code: "VARCHAR",
      point_of_connection: "VARCHAR",
      network_code: "VARCHAR",
      gen_code: "VARCHAR",
      fuel_code: "VARCHAR",
      tech_code: "VARCHAR",
    },
    [
      ["2026-11-18", "AAA", "AAA1101", "NET1", "alpha", "Hydro", "Hydro"],
      ["2026-11-18", "AAA", "AAA1101", "NET1", "beta", "Fusion", "Fusion"],
      ["2026-11-18", "ZZZ", "ZZZ1101", "NET9", "gamma", "Hydro", "Hydro"],
    ],
  );
  await silver(
    "nodal_prices_and_volumes",
    "trading_date=2026-11-18",
    {
      trading_date: "DATE",
      point_of_connection: "VARCHAR",
      unit_code: "VARCHAR",
    },
    [
      ["2026-11-18", "AAA1101", "AAA0"],
      ["2026-11-18", "AAA1101", "AAA0"],
      ["2026-11-18", "AAA1101", "XXX9"],
      ["2026-11-18", "AAA1101", null],
      ["2026-11-18", "QQQ1101", null],
    ],
  );
  await writeDispatch("2026-11-18", [
    ["AAA1101", "NI"],
    ["RRR1101", null],
  ]);

  expect(await build("2026-11-18")).toMatchObject({ status: "complete" });
  expect(
    await query(
      `SELECT dataset, id_type, source_id, row_count FROM ${table("entity_unmapped", "2026-11-18")}`,
    ),
  ).toEqual([
    {
      dataset: "dispatch_energy_prices",
      id_type: "point_of_connection",
      source_id: "RRR1101",
      row_count: "1",
    },
    {
      dataset: "generation_fleet",
      id_type: "fuel_code",
      source_id: "FUS",
      row_count: "1",
    },
    {
      dataset: "generation_md",
      id_type: "fuel_code",
      source_id: "Fusion",
      row_count: "1",
    },
    {
      dataset: "generation_md",
      id_type: "network_code",
      source_id: "NET9",
      row_count: "1",
    },
    {
      dataset: "generation_md",
      id_type: "point_of_connection",
      source_id: "ZZZ1101",
      row_count: "1",
    },
    {
      dataset: "nodal_prices_and_volumes",
      id_type: "point_of_connection",
      source_id: "QQQ1101",
      row_count: "1",
    },
    {
      dataset: "nodal_prices_and_volumes",
      id_type: "unit",
      source_id: "AAA1101:XXX9",
      row_count: "1",
    },
  ]);
  // The placeholder operator is not a participant. The one plant at AAA1101 with the same
  // fuel category links to the unit; the unit with no category does not link.
  expect(
    await query(
      `SELECT unit_id, operator_participant_id, fuel_category, plant_id FROM ${table("entity_units", "2026-11-18")} ORDER BY unit_id`,
    ),
  ).toEqual([
    {
      unit_id: "AAA1101:AAA0",
      operator_participant_id: "OPR1",
      fuel_category: "hydro",
      plant_id: null,
    },
    {
      unit_id: "AAA1101:BBB0",
      operator_participant_id: null,
      fuel_category: null,
      plant_id: null,
    },
  ]);
});

// --- Fixture test: every identifier in the real fixtures resolves or is reported ---

const FIXTURES = join(import.meta.dirname, "fixtures");

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
    `${JSON.stringify({ dataset, status: "new", checked_at: "2026-11-20T00:00:00.000Z", retrieved_at: "2026-11-20T00:00:01.000Z", sha256, path, trading_dates: dates })}\n`,
  );
}

test("each fixture identifier resolves or is reported as unmapped", async () => {
  await archive(
    "network_supply_points",
    "network-supply-points",
    "20260106_NetworkSupplyPointsTable.csv",
    ["2026-01-06"],
  );
  await archive(
    "network_supply_points",
    "network-supply-points",
    "20261119_NetworkSupplyPointsTable.csv",
    ["2026-11-19"],
  );
  // The fleet snapshot is dated after both days, so the oldest-snapshot rule applies.
  await archive(
    "generation_fleet",
    "generation-fleet",
    "DispatchedGenerationPlant.csv",
    ["2026-11-19"],
  );
  const days = ["2026-09-27", "2026-11-18"];
  for (const date of days) {
    const compact = date.replaceAll("-", "");
    await archive(
      "dispatch_energy_prices",
      "dispatch-energy-prices",
      `${compact}_DispatchEnergyPrices.csv`,
      [date],
    );
    await archive(
      "nodal_prices_and_volumes",
      "nodal-prices-and-volumes",
      `${compact}_DispatchNodalPricesAndVolumes.csv`,
      [date],
    );
  }
  await archive("generation_md", "generation-md", "202609_Generation_MD.csv", [
    "2026-09-27",
  ]);

  const args = { bronzeDir, silverDir };
  for (const date of ["2026-01-06", "2026-11-19"])
    expect(await publishNetworkSupplyPoints({ ...args, date })).toMatchObject({
      status: "complete",
    });
  expect(
    await publishGenerationFleet({ ...args, date: "2026-11-19" }),
  ).toMatchObject({ status: "complete" });
  for (const date of days) {
    expect(await publishDispatchEnergyPrices({ ...args, date })).toMatchObject({
      status: expect.stringMatching(/complete|partial/),
    });
    expect(await publishNodalPricesAndVolumes({ ...args, date })).toMatchObject(
      { status: expect.stringMatching(/complete|partial/) },
    );
  }
  expect(
    await publishGenerationMd({ ...args, date: "2026-09-27" }),
  ).toMatchObject({ status: expect.stringMatching(/complete|partial/) });

  for (const date of days) {
    const result = await build(date);
    expect(result.status).toBe("complete");
    for (const name of TABLES)
      expect(
        await query(`SELECT count(*) AS n FROM ${table(name, date)}`),
      ).toHaveLength(1);

    const day = (dataset: string) =>
      `'$S/${dataset}/trading_date=${date}/data.parquet'`;
    const count = async (sql: string) => Number((await query(sql))[0]?.n);
    const unmapped = (dataset: string, idType: string) =>
      count(
        `SELECT count(*) AS n FROM ${table("entity_unmapped", date)} WHERE dataset = '${dataset}' AND id_type = '${idType}'`,
      );

    // Dispatch: every priced POC is in the POC table or in the report.
    const priced = await count(
      `SELECT count(DISTINCT point_of_connection) AS n FROM ${day("dispatch_energy_prices")}`,
    );
    const pricedMapped = await count(
      `SELECT count(DISTINCT point_of_connection) AS n FROM ${day("dispatch_energy_prices")}
       WHERE point_of_connection IN (SELECT poc_id FROM ${table("entity_points_of_connection", date)})`,
    );
    expect(priced).toBeGreaterThan(0);
    expect(pricedMapped).toBeGreaterThan(0);
    expect(
      pricedMapped +
        (await unmapped("dispatch_energy_prices", "point_of_connection")),
    ).toBe(priced);

    // Nodal: every POC and every (POC, unit) pair.
    const nodalPocs = await count(
      `SELECT count(DISTINCT point_of_connection) AS n FROM ${day("nodal_prices_and_volumes")}`,
    );
    const nodalPocsMapped = await count(
      `SELECT count(DISTINCT point_of_connection) AS n FROM ${day("nodal_prices_and_volumes")}
       WHERE point_of_connection IN (SELECT poc_id FROM ${table("entity_points_of_connection", date)})`,
    );
    expect(
      nodalPocsMapped +
        (await unmapped("nodal_prices_and_volumes", "point_of_connection")),
    ).toBe(nodalPocs);
    const units = await count(
      `SELECT count(DISTINCT (point_of_connection, unit_code)) AS n FROM ${day("nodal_prices_and_volumes")} WHERE unit_code IS NOT NULL`,
    );
    const unitsMapped = await count(
      `SELECT count(DISTINCT (point_of_connection, unit_code)) AS n FROM ${day("nodal_prices_and_volumes")}
       WHERE point_of_connection || ':' || unit_code IN (SELECT unit_id FROM ${table("entity_units", date)})`,
    );
    expect(
      unitsMapped + (await unmapped("nodal_prices_and_volumes", "unit")),
    ).toBe(units);
  }

  // Generation_MD: the fixture fuel codes are all in the map, and the plants are the fixture units.
  expect(
    await query(
      `SELECT * FROM ${table("entity_unmapped", "2026-09-27")} WHERE id_type = 'fuel_code'`,
    ),
  ).toEqual([]);
  expect(
    await query(
      `SELECT plant_id, fuel_category FROM ${table("entity_plants", "2026-09-27")} ORDER BY plant_id, network_code`,
    ),
  ).toEqual([
    { plant_id: "ARA/aratiatia", fuel_category: "hydro" },
    { plant_id: "ASB/highbank", fuel_category: "hydro" },
    { plant_id: "ASB/lauriston", fuel_category: "solar" },
    { plant_id: "BRB/ruakākā_energy_park", fuel_category: "other" },
    { plant_id: "BRB/ruakākā_energy_park", fuel_category: "other" },
    { plant_id: "CML/roaring_meg", fuel_category: "hydro" },
    { plant_id: "KIW/kaiwera_downs_(stage_2)", fuel_category: "wind" },
  ]);
});

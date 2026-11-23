import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { lit, writeParquetAtomically } from "./common.ts";
import {
  FUEL_MAP,
  FUEL_PLANT_OVERRIDES,
  UNIT_PLANT_OVERRIDES,
} from "./fuel-map.ts";

export const TABLES = [
  "entity_points_of_connection",
  "entity_regions",
  "entity_participants",
  "entity_plants",
  "entity_units",
  "entity_unmapped",
] as const;

/** The shared `PublishResult` shape, extended. `rows` and `path` are those of the POC table. */
export type EntityMappingsResult =
  | {
      date: string;
      status: "complete";
      rows: number;
      path: string;
      /** Rows per table. `entity_unmapped` is the count of unmapped identifiers. */
      tables: Record<(typeof TABLES)[number], number>;
      /** The `inputs_sha256` value written to every table. */
      inputsSha256: string;
    }
  /** No NSP snapshot on or before the date, so there is no mapping for it. */
  | { date: string; status: "missing" }
  | { date: string; status: "invalid"; errors: string[] };

/** The partition files of a silver dataset, oldest first, as `[date, file]`. */
async function partitions(silverDir: string, dataset: string) {
  let names: string[];
  try {
    names = await readdir(join(silverDir, dataset));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .flatMap((name) => {
      const match = /^(?:snapshot|trading)_date=(\d{4}-\d{2}-\d{2})$/.exec(
        name,
      );
      return match?.[1]
        ? [[match[1], join(silverDir, dataset, name, "data.parquet")] as const]
        : [];
    })
    .sort(([a], [b]) => a.localeCompare(b));
}

/** A SQL list of file names for `read_parquet`. */
const files = (list: ReadonlyArray<readonly [string, string]>) =>
  `[${list.map(([, file]) => lit(file)).join(", ")}]`;

type Partition = readonly [date: string, file: string];

/** Every silver partition that the entity mappings read, oldest first. */
async function loadPartitions(silverDir: string) {
  return {
    nsp: await partitions(silverDir, "network_supply_points"),
    fleet: await partitions(silverDir, "generation_fleet"),
    dispatch: await partitions(silverDir, "dispatch_energy_prices"),
    generation: await partitions(silverDir, "generation_md"),
    nodal: await partitions(silverDir, "nodal_prices_and_volumes"),
  };
}

/**
 * The partitions that one date reads (see `publishEntityMappings`). Undefined when there is no
 * NSP snapshot on or before the date.
 */
function pickInputs(
  all: Awaited<ReturnType<typeof loadPartitions>>,
  date: string,
) {
  const nsp = all.nsp.findLast(([snapshot]) => snapshot <= date);
  if (!nsp) return undefined;
  const upTo = (list: Partition[]) => list.filter(([d]) => d <= date);
  const dispatch = upTo(all.dispatch);
  const generation = upTo(all.generation);
  return {
    nsp,
    fleet: all.fleet.findLast(([snapshot]) => snapshot <= date) ?? all.fleet[0],
    dispatch,
    generation,
    nodalDay: all.nodal.filter(([d]) => d === date),
    dispatchDay: dispatch.filter(([d]) => d === date),
    generationDay: generation.filter(([d]) => d === date),
  };
}

const inputFiles = (picked: NonNullable<ReturnType<typeof pickInputs>>) => [
  picked.nsp,
  ...(picked.fleet ? [picked.fleet] : []),
  ...picked.dispatch,
  ...picked.generation,
  ...picked.nodalDay,
];

/** The `inputs_sha256` value: the bronze version behind each input partition, by path. */
function fingerprint(
  silverDir: string,
  inputs: Partition[],
  shaOf: Map<string, string>,
): string {
  const mapping = [
    "poc parent_poc_id",
    ...Object.entries(FUEL_MAP).map(
      ([code, category]) => `fuel ${code} ${category}`,
    ),
    ...Object.entries(FUEL_PLANT_OVERRIDES).map(
      ([plantId, category]) => `plant ${plantId} ${category}`,
    ),
    ...Object.entries(UNIT_PLANT_OVERRIDES).map(
      ([unitId, plantId]) => `unit ${unitId} ${plantId}`,
    ),
  ]
    .sort()
    .join("\n");
  return createHash("sha256")
    .update(
      [
        mapping,
        ...inputs
          .map(([, file]) => `${relative(silverDir, file)} ${shaOf.get(file)}`)
          .sort(),
      ].join("\n"),
    )
    .digest("hex");
}

/**
 * The `inputs_sha256` that a build would write, for each date that has dispatch, nodal or
 * Generation_MD silver and an NSP snapshot. The runner compares it with the stored value
 * (ADR-0008, ADR-0009). It reads each input partition once, not once for each date.
 */
export async function entityWantedVersions(
  silverDir: string,
): Promise<Map<string, string>> {
  const all = await loadPartitions(silverDir);
  const wanted = new Map<string, string>();
  const everything = [
    ...all.nsp,
    ...all.fleet,
    ...all.dispatch,
    ...all.generation,
    ...all.nodal,
  ];
  if (everything.length === 0) return wanted;
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    const reader = await connection.runAndReadAll(
      `SELECT DISTINCT filename, bronze_sha256
       FROM read_parquet(${files(everything)}, filename = true, union_by_name = true)
       ORDER BY filename, bronze_sha256`,
    );
    const shaOf = new Map(
      (
        reader.getRowObjectsJson() as Array<{
          filename: string;
          bronze_sha256: string;
        }>
      ).map((v) => [v.filename, v.bronze_sha256]),
    );
    const dates = new Set(
      [...all.dispatch, ...all.generation, ...all.nodal].map(([d]) => d),
    );
    for (const date of [...dates].sort()) {
      const picked = pickInputs(all, date);
      if (picked)
        wanted.set(date, fingerprint(silverDir, inputFiles(picked), shaOf));
    }
  } finally {
    connection.closeSync();
  }
  return wanted;
}

function overrideTableSql(
  table: string,
  columns: readonly [string, string],
  entries: ReadonlyArray<readonly [string, string]>,
): string {
  const [left, right] = columns;
  if (entries.length === 0) {
    return `CREATE TEMP TABLE ${table} AS
           SELECT NULL::VARCHAR AS ${left}, NULL::VARCHAR AS ${right} WHERE false`;
  }
  return `CREATE TEMP TABLE ${table} AS SELECT * FROM (VALUES
             ${entries
               .map(([a, b]) => `(${lit(a)}, ${lit(b)})`)
               .join(", ")}) t(${left}, ${right})`;
}

/**
 * Publish the entity mapping tables for one trading date, one partition per table:
 * `<silverDir>/<table>/trading_date=<date>/data.parquet`. The tables hold the mapping that
 * applies to that day (ADR-0008). The same call writes `entity_unmapped`: the identifiers in
 * that day's silver of dispatch energy prices, nodal prices and volumes, and Generation_MD
 * that do not resolve. A dataset with no partition for the day adds nothing to the report.
 * Unmapped identifiers do not make the build fail. There is no `processed_at` column
 * (ADR-0003, ADR-0005).
 *
 * Inputs: the newest NSP snapshot on or before the date; the newest fleet snapshot on or before
 * the date, or the oldest fleet snapshot when none is that old (ADR-0008 amends ADR-0006 for
 * the fleet, whose file holds its own history); every Generation_MD and dispatch energy
 * prices partition up to the date; that day's nodal prices for the report.
 *
 * Every table has `inputs_sha256`: a SHA-256 over the `bronze_sha256` values of the partitions
 * read, in a fixed order. A runner rebuilds a date when it changes (ADR-0008).
 *
 * Missing: there is no NSP snapshot on or before the date.
 * Invalid (nothing written): one POC has two islands in the NSP rows chosen for it; a dispatch
 * `Island` is not NI, SI or blank; one POC has two different islands in the dispatch price
 * files and no NSP island; one POC has an NSP island that differs from its dispatch island; one
 * region ID has two names.
 */
export async function publishEntityMappings(options: {
  silverDir: string;
  date: string;
  unitPlantOverrides?: Readonly<Record<string, string>>;
}): Promise<EntityMappingsResult> {
  const {
    silverDir,
    date,
    unitPlantOverrides = UNIT_PLANT_OVERRIDES,
  } = options;
  const day = `DATE ${lit(date)}`;
  const picked = pickInputs(await loadPartitions(silverDir), date);
  if (!picked) return { date, status: "missing" };
  const {
    nsp,
    fleet,
    dispatch,
    generation,
    nodalDay,
    dispatchDay,
    generationDay,
  } = picked;

  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    const run = (sql: string) => connection.run(sql);

    await run(
      `CREATE TEMP TABLE fuel_map AS SELECT * FROM (VALUES
         ${Object.entries(FUEL_MAP)
           .map(([code, category]) => `(${lit(code)}, ${lit(category)})`)
           .join(", ")}) t(fuel_code, fuel_category)`,
    );
    await run(
      overrideTableSql(
        "fuel_plant_overrides",
        ["plant_id", "fuel_category"],
        Object.entries(FUEL_PLANT_OVERRIDES),
      ),
    );
    await run(
      overrideTableSql(
        "unit_plant_overrides",
        ["unit_id", "plant_id"],
        Object.entries(unitPlantOverrides),
      ),
    );

    // NSP rows for the day. A row is in force when start_date <= day <= end_date (inclusive,
    // ADR-0006). A POC with no row in force keeps its newest closed row: a closed POC can
    // still carry a price, and the island and region of a place do not change.
    await run(
      `CREATE TEMP TABLE nsp_start AS
       SELECT * FROM read_parquet(${lit(nsp[1])}) WHERE start_date <= ${day}`,
    );
    const inForce = `coalesce(end_date, DATE 'infinity') >= ${day}`;
    await run(
      `CREATE TEMP TABLE nsp_in_force AS
       SELECT *, 'in_force' AS row_status FROM nsp_start WHERE ${inForce}`,
    );
    // QUALIFY keeps the newest closed row of each POC. It belongs to this table only.
    await run(
      `CREATE TEMP TABLE nsp_closed AS
       SELECT *, 'last_closed' AS row_status FROM nsp_start
       WHERE end_date < ${day}
         AND point_of_connection NOT IN (SELECT point_of_connection FROM nsp_in_force)
       QUALIFY end_date = max(end_date) OVER (PARTITION BY point_of_connection)`,
    );
    await run(
      "CREATE TEMP TABLE nsp_pick AS SELECT * FROM nsp_in_force UNION ALL SELECT * FROM nsp_closed",
    );

    await run(
      dispatch.length > 0
        ? `CREATE TEMP TABLE dispatch_islands AS
           SELECT point_of_connection, count(DISTINCT island) AS islands, min(island) AS island,
             string_agg(DISTINCT island, ', ' ORDER BY island) AS island_list,
             string_agg(DISTINCT island, ', ' ORDER BY island)
               FILTER (WHERE island NOT IN ('NI', 'SI')) AS bad_islands
           FROM read_parquet(${files(dispatch)})
           WHERE island IS NOT NULL GROUP BY point_of_connection`
        : `CREATE TEMP TABLE dispatch_islands AS SELECT NULL::VARCHAR AS point_of_connection,
             NULL::BIGINT AS islands, NULL::VARCHAR AS island, NULL::VARCHAR AS island_list,
             NULL::VARCHAR AS bad_islands
           WHERE false`,
    );

    // One row per POC from the NSP rows chosen above. Region is NULL when the POC has NSPs in
    // more than one region.
    await run(
      `CREATE TEMP TABLE nsp_poc AS
       SELECT point_of_connection AS poc_id, any_value(row_status) AS nsp_row_status,
         count(DISTINCT island) AS islands, min(island) AS island,
         count(DISTINCT network_reporting_region_id) AS region_count,
         CASE WHEN count(DISTINCT network_reporting_region_id) = 1
              THEN min(network_reporting_region_id) END AS region_id,
         CASE WHEN count(DISTINCT (latitude, longitude)) = 1 THEN min(latitude) END AS latitude,
         CASE WHEN count(DISTINCT (latitude, longitude)) = 1 THEN min(longitude) END AS longitude,
         CASE WHEN count(DISTINCT embedded_under_point_of_connection) = 1
              THEN min(embedded_under_point_of_connection) END AS parent_poc_id,
         count(*) AS nsp_count
       FROM nsp_pick GROUP BY point_of_connection`,
    );

    const errors: string[] = [];
    const found = async (sql: string) =>
      (await connection.runAndReadAll(sql)).getRowObjectsJson() as Array<
        Record<string, string>
      >;
    for (const row of await found(
      "SELECT poc_id FROM nsp_poc WHERE islands > 1 ORDER BY poc_id",
    ))
      errors.push(`${row.poc_id} has two islands in the NSP rows`);
    for (const row of await found(
      `SELECT point_of_connection AS poc, bad_islands FROM dispatch_islands
       WHERE bad_islands IS NOT NULL ORDER BY 1`,
    ))
      errors.push(
        `${row.poc} has the island ${row.bad_islands} in the dispatch price files (not NI or SI)`,
      );
    for (const row of await found(
      `SELECT n.poc_id AS poc, n.island AS nsp, d.island_list AS prices
       FROM nsp_poc n JOIN dispatch_islands d ON d.point_of_connection = n.poc_id
       WHERE d.island_list <> n.island AND d.bad_islands IS NULL ORDER BY 1`,
    ))
      errors.push(
        `${row.poc} has the island ${row.nsp} in the NSP table and ${row.prices} in the dispatch price files`,
      );
    for (const row of await found(
      `SELECT d.point_of_connection AS poc, d.island_list FROM dispatch_islands d
       WHERE d.islands > 1 AND d.bad_islands IS NULL
         AND d.point_of_connection NOT IN (SELECT poc_id FROM nsp_poc WHERE island IS NOT NULL)
       ORDER BY 1`,
    ))
      errors.push(
        `${row.poc} has two islands in the dispatch price files (${row.island_list})`,
      );
    for (const row of await found(
      `SELECT network_reporting_region_id AS id FROM nsp_pick
       WHERE network_reporting_region_id IS NOT NULL
       GROUP BY 1 HAVING count(DISTINCT network_reporting_region) > 1 ORDER BY 1`,
    ))
      errors.push(`region ${row.id} has two names`);
    if (errors.length > 0) return { date, status: "invalid", errors };

    // Points of connection: every NSP POC with an island, plus every priced POC that the NSP
    // table cannot place. These take their island from the price files.
    await run(
      `CREATE TEMP TABLE poc AS
       SELECT poc_id, island, 'nsp' AS island_source, nsp_row_status, region_id, region_count,
         latitude, longitude, nsp_count, parent_poc_id
       FROM nsp_poc WHERE island IS NOT NULL
       UNION ALL
       SELECT d.point_of_connection, d.island, 'dispatch_prices', n.nsp_row_status,
         n.region_id, coalesce(n.region_count, 0), n.latitude, n.longitude,
         coalesce(n.nsp_count, 0), n.parent_poc_id
       FROM dispatch_islands d LEFT JOIN nsp_poc n ON n.poc_id = d.point_of_connection
       WHERE n.island IS NULL`,
    );

    if (fleet) {
      await run(
        `CREATE TEMP TABLE fleet AS
         SELECT * FROM read_parquet(${lit(fleet[1])})
         WHERE effective_start_date <= ${day} AND ${day} < effective_end_date`,
      );
    } else {
      await run(
        `CREATE TEMP TABLE fleet AS SELECT NULL::DATE AS snapshot_date,
           NULL::VARCHAR AS plant_name, NULL::VARCHAR AS point_of_connection,
           NULL::VARCHAR AS unit_code, NULL::VARCHAR AS technology_code,
           NULL::VARCHAR AS fuel_code, NULL::VARCHAR AS plant_operator_code,
           NULL::VARCHAR AS plant_operator, NULL::DOUBLE AS nameplate_megawatts,
           NULL::DATE AS date_commissioned, NULL::DATE AS date_decommissioned WHERE false`,
      );
    }

    // Participants: network participants of the NSP rows in force, and plant operators of the
    // fleet.
    // The fleet placeholder operator `N/A` is not a participant.
    await run(
      `CREATE TEMP TABLE participants AS
       SELECT code AS participant_id, min(name) AS name,
         bool_or(is_operator) AS is_plant_operator, bool_or(is_network) AS is_network_participant
       FROM (
         SELECT network_participant AS code, NULL AS name, false AS is_operator, true AS is_network
           FROM nsp_in_force WHERE network_participant IS NOT NULL
         UNION ALL
         SELECT embedded_under_network_participant, NULL, false, true
           FROM nsp_in_force WHERE embedded_under_network_participant IS NOT NULL
         UNION ALL
         SELECT plant_operator_code, plant_operator, true, false
           FROM fleet WHERE plant_operator_code <> 'N/A')
       GROUP BY code`,
    );

    // Plant keys: one row per Generation_MD unit key. The plant ID is the site code and the
    // lower-case Gen_Code, so a Generation_MD row maps to its plant by that formula. The fuel
    // code comes from the newest day of each key.
    await run(
      generation.length > 0
        ? `CREATE TEMP TABLE plant_keys AS
           SELECT g.site_code || '/' || lower(g.gen_code) AS plant_id, g.site_code,
             g.point_of_connection, g.network_code, g.gen_code, g.fuel_code,
             coalesce(o.fuel_category, m.fuel_category) AS fuel_category
           FROM (
             SELECT site_code, point_of_connection, network_code, gen_code,
               arg_max(fuel_code, trading_date) AS fuel_code
             FROM read_parquet(${files(generation)})
             GROUP BY site_code, point_of_connection, network_code, gen_code) g
           LEFT JOIN fuel_map m ON m.fuel_code = g.fuel_code
           LEFT JOIN fuel_plant_overrides o
             ON o.plant_id = g.site_code || '/' || lower(g.gen_code)`
        : `CREATE TEMP TABLE plant_keys AS SELECT NULL::VARCHAR AS plant_id,
             NULL::VARCHAR AS site_code, NULL::VARCHAR AS point_of_connection,
             NULL::VARCHAR AS network_code, NULL::VARCHAR AS gen_code,
             NULL::VARCHAR AS fuel_code, NULL::VARCHAR AS fuel_category WHERE false`,
    );
    await run(
      `CREATE TEMP TABLE plants AS
       SELECT plant_id, any_value(site_code) AS site_id, min(gen_code) AS plant_name,
         min(fuel_category) AS fuel_category,
         list(DISTINCT fuel_code ORDER BY fuel_code) AS fuel_codes,
         list(DISTINCT point_of_connection ORDER BY point_of_connection) AS points_of_connection,
         list(DISTINCT network_code ORDER BY network_code) AS network_codes
       FROM plant_keys GROUP BY plant_id`,
    );

    // Units: fleet rows in force. A unit links to a plant when (POC, fuel category) has exactly
    // one Generation_MD plant, or when UNIT_PLANT_OVERRIDES names the plant (ADR-0008).
    await run(
      `CREATE TEMP TABLE units AS
       SELECT f.point_of_connection || ':' || f.unit_code AS unit_id,
         f.point_of_connection AS poc_id, coalesce(o.plant_id, p.plant_id) AS plant_id,
         f.point_of_connection, f.unit_code, f.plant_name, f.technology_code, f.fuel_code,
         m.fuel_category, f.plant_operator_code,
         nullif(f.plant_operator_code, 'N/A') AS operator_participant_id,
         f.nameplate_megawatts, f.date_commissioned, f.date_decommissioned
       FROM fleet f
       LEFT JOIN fuel_map m ON m.fuel_code = f.fuel_code
       LEFT JOIN (
         SELECT point_of_connection, fuel_category, any_value(plant_id) AS plant_id
         FROM plant_keys
         WHERE fuel_category IS NOT NULL
         GROUP BY point_of_connection, fuel_category
         HAVING count(DISTINCT plant_id) = 1) p
         ON p.point_of_connection = f.point_of_connection AND p.fuel_category = m.fuel_category
       LEFT JOIN unit_plant_overrides o
         ON o.unit_id = f.point_of_connection || ':' || f.unit_code`,
    );

    // The unmapped report.
    const unmapped: string[] = [
      `SELECT 'generation_fleet' AS dataset, 'fuel_code' AS id_type,
         coalesce(fuel_code, '') AS source_id, count(*) AS row_count
       FROM units WHERE fuel_category IS NULL GROUP BY fuel_code`,
    ];
    if (dispatchDay[0])
      unmapped.push(
        `SELECT 'dispatch_energy_prices', 'point_of_connection', point_of_connection, count(*)
         FROM read_parquet(${lit(dispatchDay[0][1])})
         WHERE point_of_connection NOT IN (SELECT poc_id FROM poc) GROUP BY 3`,
      );
    if (nodalDay[0]) {
      const nodal = lit(nodalDay[0][1]);
      unmapped.push(
        `SELECT 'nodal_prices_and_volumes', 'point_of_connection', point_of_connection, count(*)
         FROM read_parquet(${nodal})
         WHERE point_of_connection NOT IN (SELECT poc_id FROM poc) GROUP BY 3`,
        `SELECT 'nodal_prices_and_volumes', 'unit', point_of_connection || ':' || unit_code, count(*)
         FROM read_parquet(${nodal})
         WHERE unit_code IS NOT NULL
           AND point_of_connection || ':' || unit_code NOT IN (SELECT unit_id FROM units)
         GROUP BY 3`,
      );
    }
    if (generationDay[0]) {
      const md = lit(generationDay[0][1]);
      unmapped.push(
        `SELECT 'generation_md', 'point_of_connection', point_of_connection, count(*)
         FROM read_parquet(${md})
         WHERE point_of_connection NOT IN (SELECT poc_id FROM poc) GROUP BY 3`,
        `SELECT 'generation_md', 'fuel_code', coalesce(fuel_code, ''), count(*)
         FROM read_parquet(${md})
         WHERE fuel_code IS NULL OR fuel_code NOT IN (SELECT fuel_code FROM fuel_map)
         GROUP BY 3`,
        `SELECT 'generation_md', 'network_code', network_code, count(*)
         FROM read_parquet(${md})
         WHERE network_code NOT IN (SELECT participant_id FROM participants) GROUP BY 3`,
      );
    }

    const inputs = inputFiles(picked);
    const versions = await found(
      `SELECT DISTINCT filename, bronze_sha256
       FROM read_parquet(${files(inputs)}, filename = true, union_by_name = true)
       ORDER BY filename, bronze_sha256`,
    );
    const inputsSha256 = fingerprint(
      silverDir,
      inputs,
      new Map(
        versions.map((v) => [String(v.filename), String(v.bronze_sha256)]),
      ),
    );
    const stamp = `${day} AS trading_date, ${lit(inputsSha256)} AS inputs_sha256`;
    const selects: Record<(typeof TABLES)[number], string> = {
      entity_points_of_connection: `SELECT ${stamp}, poc_id, substr(poc_id, 1, 3) AS site_id,
          island, island_source, nsp_row_status, region_id, region_count, latitude, longitude,
          nsp_count, parent_poc_id, DATE ${lit(nsp[0])} AS nsp_snapshot_date
        FROM poc ORDER BY poc_id`,
      entity_regions: `SELECT ${stamp}, network_reporting_region_id AS region_id,
          min(network_reporting_region) AS region_name,
          bool_or(row_status = 'in_force') AS has_nsp_in_force
        FROM nsp_pick WHERE network_reporting_region_id IS NOT NULL
        GROUP BY network_reporting_region_id ORDER BY region_id`,
      entity_participants: `SELECT ${stamp}, * FROM participants ORDER BY participant_id`,
      entity_plants: `SELECT ${stamp}, * FROM plants ORDER BY plant_id`,
      entity_units: `SELECT ${stamp}, *,
          ${fleet ? `DATE ${lit(fleet[0])}` : "NULL::DATE"} AS fleet_snapshot_date
        FROM units ORDER BY unit_id`,
      entity_unmapped: `SELECT ${stamp}, * FROM (${unmapped.join(" UNION ALL ")})
        ORDER BY dataset, id_type, source_id`,
    };
    const tables = {} as Record<(typeof TABLES)[number], number>;
    const paths = {} as Record<(typeof TABLES)[number], string>;
    for (const table of TABLES) {
      const path = join(
        silverDir,
        table,
        `trading_date=${date}`,
        "data.parquet",
      );
      await writeParquetAtomically(connection, selects[table], path);
      const [count] = await found(
        `SELECT count(*) AS n FROM read_parquet(${lit(path)})`,
      );
      tables[table] = Number(count?.n);
      paths[table] = path;
    }
    return {
      date,
      status: "complete",
      rows: tables.entity_points_of_connection,
      path: paths.entity_points_of_connection,
      tables,
      inputsSha256,
    };
  } finally {
    connection.closeSync();
  }
}

import { existsSync } from "node:fs";
import type { DuckDBConnection } from "@duckdb/node-api";
import { DuckDBInstance } from "@duckdb/node-api";
import { lit, type PublishResult } from "../silver/common.ts";
import { periodsInTradingDate } from "../trading-time.ts";
import {
  type GoldInput,
  type GoldPublishOptions,
  goldDataset,
  goldPartitionPath,
  goldStamp,
  inputFingerprint,
  inputStatusesComplete,
  latestRtdCaseSql,
  periodsComplete,
  silverPartitionPath,
  writeGoldTables,
} from "./common.ts";

/**
 * Bump by hand when the logic of any table in this file changes. The runner then rebuilds every
 * date (ADR-0011).
 */
export const ANALYSIS_VERSION = 2;

/** The gold tables of this module. The first is the sentinel: the runner reads it and it is written last. */
export const TABLES = [
  "generation_by_plant_period",
  "generation_by_plant_day",
  "generation_by_fuel_period",
  "generation_by_fuel_day",
] as const;

type GenerationSource = "metered" | "dispatch";

const GENERATION_MD: GoldInput = {
  table: "generation_md",
  layer: "silver",
  versionColumn: "bronze_sha256",
  completenessDataset: "generation_md",
};
const NODAL: GoldInput = {
  table: "nodal_prices_and_volumes",
  layer: "silver",
  versionColumn: "bronze_sha256",
  completenessDataset: "nodal_prices_and_volumes",
};
const PLANTS: GoldInput = {
  table: "entity_plants",
  layer: "silver",
  versionColumn: "inputs_sha256",
  completenessDataset: "entity_mappings",
};
const UNITS: GoldInput = {
  table: "entity_units",
  layer: "silver",
  versionColumn: "inputs_sha256",
  completenessDataset: "entity_mappings",
};
const POINTS_OF_CONNECTION: GoldInput = {
  table: "entity_points_of_connection",
  layer: "silver",
  versionColumn: "inputs_sha256",
  completenessDataset: "entity_mappings",
};

/** Metered Generation_MD path. */
export const METERED_INPUTS: GoldInput[] = [
  GENERATION_MD,
  PLANTS,
  POINTS_OF_CONNECTION,
];
export const DISPATCH_INPUTS: GoldInput[] = [
  NODAL,
  UNITS,
  POINTS_OF_CONNECTION,
];
/** Metered path. The exporter lists these until the site-contract slice. */
export const INPUTS: GoldInput[] = METERED_INPUTS;

/**
 * Publish the generation gold tables for one trading date, one partition for each table in
 * `TABLES`: `<goldDir>/<table>/trading_date=<date>/data.parquet` (ADR-0011, ADR-0028).
 *
 * Prefer silver Generation_MD when that partition exists. Otherwise use nodal unit dispatch
 * megawatts. Each row has `source` `metered` or `dispatch`.
 *
 * Metered path: Generation_MD kWh, `entity_plants` (plant, fuel), `entity_points_of_connection`
 * (island). Plant id is `<site code>/<lower-case Gen_Code>`. Energy is kWh / 1000.
 *
 * Dispatch path: unit rows of the latest RTD case per 5-minute interval, mean MW times 0.5 hours
 * (the same case rule as gold load). Fuel and plant come from `entity_units`. A unit with no
 * `plant_id` stays in the fuel tables and is omitted from the plant tables.
 *
 * - Plant island: `min(island)` over the plant's rows.
 * - Fuel tables split by the unit's own island. A national total is a sum over fuel rows.
 * - Battery keeps the category `battery`. These tables have no total.
 * - Completeness: `inputs_complete` is true when the path's inputs are complete and every
 *   expected trading period has rows in the path's period file (Generation_MD or nodal).
 *
 * Missing: Generation_MD exists but an entity file is absent, or Generation_MD is absent and a
 * dispatch input is absent.
 */
export async function publishGeneration(
  options: GoldPublishOptions,
): Promise<PublishResult> {
  const { silverDir, date } = options;
  const generationMd = silverPartitionPath(
    silverDir,
    GENERATION_MD.table,
    date,
  );
  const plants = silverPartitionPath(silverDir, PLANTS.table, date);
  const units = silverPartitionPath(silverDir, UNITS.table, date);
  const nodal = silverPartitionPath(silverDir, NODAL.table, date);
  const pointsOfConnection = silverPartitionPath(
    silverDir,
    POINTS_OF_CONNECTION.table,
    date,
  );
  if (existsSync(generationMd))
    return publishPath(options, {
      source: "metered",
      inputs: METERED_INPUTS,
      files: [generationMd, plants, pointsOfConnection],
      periodFile: generationMd,
      createSql: `CREATE TEMP TABLE generation AS
       SELECT g.trading_date, g.trading_period, g.event_start_utc, g.event_end_utc,
         g.site_code || '/' || lower(g.gen_code) AS plant_id,
         p.plant_name,
         coalesce(p.fuel_category, 'unmapped') AS fuel_category,
         poc.island,
         g.kilowatt_hours / 1000.0 AS megawatt_hours
       FROM read_parquet(${lit(generationMd)}) g
       LEFT JOIN read_parquet(${lit(plants)}) p
         ON p.plant_id = g.site_code || '/' || lower(g.gen_code)
       LEFT JOIN read_parquet(${lit(pointsOfConnection)}) poc
         ON poc.poc_id = g.point_of_connection`,
    });
  return publishPath(options, {
    source: "dispatch",
    inputs: DISPATCH_INPUTS,
    files: [nodal, units, pointsOfConnection],
    periodFile: nodal,
    createSql: `CREATE TEMP TABLE generation AS
       SELECT DATE ${lit(date)} AS trading_date, trading_period,
         min(event_start_utc) AS event_start_utc,
         min(event_start_utc) + INTERVAL 30 MINUTE AS event_end_utc,
         plant_id, min(plant_name) AS plant_name, fuel_category, island,
         avg(mw) * 0.5 AS megawatt_hours
       FROM (
         SELECT n.trading_period, n.event_start_utc, u.plant_id,
           coalesce(u.plant_name, n.plant_name) AS plant_name,
           coalesce(u.fuel_category, 'unmapped') AS fuel_category,
           poc.island, sum(n.generation_megawatts) AS mw
         FROM read_parquet(${lit(nodal)}) n
         JOIN (${latestRtdCaseSql(nodal)}) latest
           ON latest.event_start_utc = n.event_start_utc AND latest.case_id = n.case_id
         LEFT JOIN read_parquet(${lit(units)}) u
           ON u.unit_id = n.point_of_connection || ':' || n.unit_code
         LEFT JOIN read_parquet(${lit(pointsOfConnection)}) poc
           ON poc.poc_id = n.point_of_connection
         WHERE n.case_type = 'RTD' AND n.unit_code IS NOT NULL
         GROUP BY n.trading_period, n.event_start_utc, u.plant_id,
           coalesce(u.plant_name, n.plant_name),
           coalesce(u.fuel_category, 'unmapped'), poc.island)
       GROUP BY trading_period, plant_id, fuel_category, island`,
  });
}

async function publishPath(
  options: GoldPublishOptions,
  path: {
    source: GenerationSource;
    inputs: readonly GoldInput[];
    files: readonly string[];
    periodFile: string;
    createSql: string;
  },
): Promise<PublishResult> {
  const { silverDir, goldDir, completeness: view, date } = options;
  if (!path.files.every((file) => existsSync(file)))
    return { date, status: "missing" };

  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    await connection.run("SET threads = 1");
    const periodCheck = await periodsComplete(connection, date, [
      path.periodFile,
    ]);
    const complete =
      periodCheck.complete && inputStatusesComplete(view, path.inputs, date);
    const stamp = goldStamp(
      ANALYSIS_VERSION,
      await inputFingerprint(
        silverDir,
        goldDir,
        ANALYSIS_VERSION,
        path.inputs,
        view,
        date,
      ),
      complete ? "true" : "false",
    );
    await connection.run(path.createSql);
    return await writeGenerationTables(
      connection,
      options,
      stamp,
      path.source,
      complete,
      periodCheck.missingPeriods,
    );
  } finally {
    connection.closeSync();
  }
}

async function writeGenerationTables(
  connection: DuckDBConnection,
  options: GoldPublishOptions,
  stamp: string,
  source: GenerationSource,
  complete: boolean,
  missingPeriods: number[],
): Promise<PublishResult> {
  const { goldDir, date } = options;
  const periods = periodsInTradingDate(date);
  const hours = `(${periods} / 2.0)`;
  const sourceSql = lit(source);
  const selects: Record<(typeof TABLES)[number], string> = {
    generation_by_plant_period: `SELECT trading_date, trading_period,
        min(event_start_utc) AS event_start_utc, min(event_end_utc) AS event_end_utc,
        plant_id, min(plant_name) AS plant_name, min(fuel_category) AS fuel_category,
        min(island) AS island,
        sum(megawatt_hours) AS megawatt_hours, sum(megawatt_hours) * 2 AS average_megawatts,
        ${sourceSql} AS source, ${stamp}
      FROM generation WHERE plant_id IS NOT NULL
      GROUP BY trading_date, trading_period, plant_id
      ORDER BY trading_period, plant_id`,
    generation_by_plant_day: `SELECT trading_date,
        plant_id, min(plant_name) AS plant_name, min(fuel_category) AS fuel_category,
        min(island) AS island,
        sum(megawatt_hours) AS megawatt_hours,
        sum(megawatt_hours) / ${hours} AS average_megawatts,
        ${sourceSql} AS source, ${stamp}
      FROM generation WHERE plant_id IS NOT NULL
      GROUP BY trading_date, plant_id
      ORDER BY plant_id`,
    generation_by_fuel_period: `SELECT trading_date, trading_period,
        min(event_start_utc) AS event_start_utc, min(event_end_utc) AS event_end_utc,
        fuel_category, island,
        sum(megawatt_hours) AS megawatt_hours, sum(megawatt_hours) * 2 AS average_megawatts,
        ${sourceSql} AS source, ${stamp}
      FROM generation GROUP BY trading_date, trading_period, fuel_category, island
      ORDER BY trading_period, fuel_category, island NULLS LAST`,
    generation_by_fuel_day: `SELECT trading_date, fuel_category, island,
        sum(megawatt_hours) AS megawatt_hours,
        sum(megawatt_hours) / ${hours} AS average_megawatts,
        ${sourceSql} AS source, ${stamp}
      FROM generation GROUP BY trading_date, fuel_category, island
      ORDER BY fuel_category, island NULLS LAST`,
  };

  await writeGoldTables(
    connection,
    TABLES.map((table) => [table, selects[table]] as const),
    goldDir,
    date,
  );
  const path = goldPartitionPath(goldDir, TABLES[0], date);
  const reader = await connection.runAndReadAll(
    `SELECT count(*) AS n FROM read_parquet(${lit(path)})`,
  );
  const rows = Number(
    (reader.getRowObjectsJson() as Array<{ n: string }>)[0]?.n,
  );
  return complete
    ? { date, status: "complete", rows, path }
    : { date, status: "partial", rows, path, missingPeriods };
}

export const generation = goldDataset({
  id: "gold_generation",
  tables: TABLES,
  inputs: METERED_INPUTS,
  fallbackInputs: DISPATCH_INPUTS,
  analysisVersion: ANALYSIS_VERSION,
  publish: publishGeneration,
});

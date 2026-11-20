import { existsSync } from "node:fs";
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
  periodsComplete,
  silverPartitionPath,
  writeGoldTables,
} from "./common.ts";

/**
 * Bump by hand when the logic of any table in this file changes. The runner then rebuilds every
 * date (ADR-0011).
 */
export const ANALYSIS_VERSION = 1;

/** The gold tables of this module. The first is the sentinel: the runner reads it and it is written last. */
export const TABLES = [
  "generation_by_plant_period",
  "generation_by_plant_day",
  "generation_by_fuel_period",
  "generation_by_fuel_day",
] as const;

const GENERATION: GoldInput = {
  table: "generation_md",
  versionColumn: "bronze_sha256",
  completenessDataset: "generation_md",
};
// Both entity tables carry the same `inputs_sha256`. Listing both keeps the rule simple:
// every silver table that the SQL reads is a fingerprint input. The runner records one
// `_completeness` row for each date under the dataset ID `entity_mappings` (ADR-0010).
const INPUTS: GoldInput[] = [
  GENERATION,
  {
    table: "entity_plants",
    versionColumn: "inputs_sha256",
    completenessDataset: "entity_mappings",
  },
  {
    table: "entity_points_of_connection",
    versionColumn: "inputs_sha256",
    completenessDataset: "entity_mappings",
  },
];

/**
 * Publish the generation gold tables for one trading date, one partition for each table in
 * `TABLES`: `<goldDir>/<table>/trading_date=<date>/data.parquet` (ADR-0011).
 *
 * Inputs: Generation_MD silver for the date (kWh for each unit and trading period) and the
 * entity mapping tables for the date: `entity_plants` (plant and fuel category) and
 * `entity_points_of_connection` (island) (ADR-0008).
 *
 * - Plant: `<site code>/<lower-case Gen_Code>`, as in `entity_plants`. One plant can have several
 *   Generation_MD units, and the plant row is their sum.
 * - Fuel category: from `entity_plants`. A plant that has no category, or that is not in
 *   `entity_plants`, has the category `unmapped`. No row is dropped.
 * - Plant island: `min(island)` over the plant's rows. A plant whose units are on two islands
 *   (not seen in the data) takes `NI` before `SI`. If some units are on an unmapped POC, the
 *   plant takes the island of the mapped units. The fuel tables split by the unit's own island.
 * - Island: from the unit's point of connection in `entity_points_of_connection`, `NI` or `SI`.
 *   It is null when the point of connection is not mapped. The fuel tables have one row for
 *   each island value, so a national total is a sum over all rows of a fuel. A fuel table has
 *   no row that already sums islands.
 * - Units: `megawatt_hours` is kWh / 1000. `average_megawatts` is the energy divided by the hours
 *   in the period (MWh x 2), or by the hours of the trading day (24, 23 or 25) for a day table.
 * - Battery is storage and keeps its own category `battery`. These tables have no total, so
 *   nothing counts it in a primary total.
 * - Completeness: every row has `inputs_complete`. It is true only when the `_completeness`
 *   status of Generation_MD is `complete` for the date (this run's rows, ADR-0010), the entity
 *   partitions exist, and Generation_MD has rows in every trading period of the day. A day that
 *   fails any check is written, flagged, and the result is `partial`. `missingPeriods` lists the
 *   periods that the data check found, and is empty when only the status failed.
 *
 * Missing (nothing written): the date has no Generation_MD or entity silver.
 * Repeatable: no `processed_at`. A total `ORDER BY` and one thread make the same inputs give the
 * same bytes (floating-point sums depend on the order of addition).
 */
export async function publishGeneration(
  options: GoldPublishOptions,
): Promise<PublishResult> {
  const { silverDir, goldDir, completeness: view, date } = options;
  const generationMd = silverPartitionPath(silverDir, GENERATION.table, date);
  const plants = silverPartitionPath(silverDir, "entity_plants", date);
  const pointsOfConnection = silverPartitionPath(
    silverDir,
    "entity_points_of_connection",
    date,
  );
  if (
    ![generationMd, plants, pointsOfConnection].every((file) =>
      existsSync(file),
    )
  )
    return { date, status: "missing" };

  const periods = periodsInTradingDate(date);
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    await connection.run("SET threads = 1");
    const periodCheck = await periodsComplete(connection, date, [generationMd]);
    const complete =
      periodCheck.complete && inputStatusesComplete(view, INPUTS, date);
    const stamp = goldStamp(
      ANALYSIS_VERSION,
      await inputFingerprint(silverDir, ANALYSIS_VERSION, INPUTS, view, date),
      complete ? "true" : "false",
    );

    // One row for each Generation_MD unit and period, with its plant, category and island.
    await connection.run(
      `CREATE TEMP TABLE generation AS
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
    );

    const hours = `(${periods} / 2.0)`;
    const selects: Record<(typeof TABLES)[number], string> = {
      generation_by_plant_period: `SELECT trading_date, trading_period,
          min(event_start_utc) AS event_start_utc, min(event_end_utc) AS event_end_utc,
          plant_id, min(plant_name) AS plant_name, min(fuel_category) AS fuel_category,
          min(island) AS island,
          sum(megawatt_hours) AS megawatt_hours, sum(megawatt_hours) * 2 AS average_megawatts,
          ${stamp}
        FROM generation GROUP BY trading_date, trading_period, plant_id
        ORDER BY trading_period, plant_id`,
      generation_by_plant_day: `SELECT trading_date,
          plant_id, min(plant_name) AS plant_name, min(fuel_category) AS fuel_category,
          min(island) AS island,
          sum(megawatt_hours) AS megawatt_hours,
          sum(megawatt_hours) / ${hours} AS average_megawatts,
          ${stamp}
        FROM generation GROUP BY trading_date, plant_id
        ORDER BY plant_id`,
      generation_by_fuel_period: `SELECT trading_date, trading_period,
          min(event_start_utc) AS event_start_utc, min(event_end_utc) AS event_end_utc,
          fuel_category, island,
          sum(megawatt_hours) AS megawatt_hours, sum(megawatt_hours) * 2 AS average_megawatts,
          ${stamp}
        FROM generation GROUP BY trading_date, trading_period, fuel_category, island
        ORDER BY trading_period, fuel_category, island NULLS LAST`,
      generation_by_fuel_day: `SELECT trading_date, fuel_category, island,
          sum(megawatt_hours) AS megawatt_hours,
          sum(megawatt_hours) / ${hours} AS average_megawatts,
          ${stamp}
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
      : {
          date,
          status: "partial",
          rows,
          path,
          missingPeriods: periodCheck.missingPeriods,
        };
  } finally {
    connection.closeSync();
  }
}

export const generation = goldDataset({
  id: "gold_generation",
  tables: TABLES,
  inputs: INPUTS,
  analysisVersion: ANALYSIS_VERSION,
  publish: publishGeneration,
});

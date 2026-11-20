import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  findBronze,
  lit,
  type PublishResult,
  writeParquetAtomically,
} from "./common.ts";

export const DATASET = "generation_fleet";

/**
 * Publish silver Parquet for one snapshot date:
 * `<silverDir>/generation_fleet/snapshot_date=<date>/data.parquet`.
 *
 * One row per plant unit at a point of connection and operator period. A row is in force on a
 * day when `effective_start_date <= day < effective_end_date`: the end is exclusive. Adjacent
 * operator periods share a date (one ends on 2021-10-01 and the next starts on it). The source
 * uses 1900-01-01 and 2099-12-31 for "always", and we keep those values. To find the operator
 * and fuel for a day, take the newest snapshot on or before that day, then the rows in force on
 * the day (ADR-0006). There is no `processed_at` column: it would change on every run
 * (ADR-0003, ADR-0005).
 *
 * Invalid snapshot (nothing written): the file cannot be read or lacks a column; no rows; a row
 * without plant name, unit code, point of connection, fuel code or operator code; an effective
 * date that does not parse; an effective end before the start; a commissioning or
 * decommissioning date that is set and does not parse; a capacity that is set and is not a finite
 * number; a peaking flag that is not Y or N; a duplicate key (unit, point of connection,
 * effective start); two rows for the same unit and point of connection whose ranges overlap
 * under the half-open rule. A snapshot has no expected periods, so it is never partial.
 */
export async function publishGenerationFleet(options: {
  bronzeDir: string;
  silverDir: string;
  date: string;
}): Promise<PublishResult> {
  const { silverDir, date } = options;
  const bronze = await findBronze(options.bronzeDir, DATASET, date);
  if (!bronze) return { date, status: "missing" };

  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");

    // Read as text, then TRY_CAST. The `*_text` columns tell "blank" from "bad".
    try {
      await connection.run(
        `CREATE TEMP TABLE fleet AS
         SELECT
           nullif(PlantName, '') AS plant_name,
           nullif(PointOfConnectionCode, '') AS point_of_connection,
           nullif(UnitCode, '') AS unit_code,
           nullif(ReconciliationTypeCode, '') AS reconciliation_type,
           nullif(TechnologyCode, '') AS technology_code,
           nullif(Technology, '') AS technology,
           nullif(FuelCode, '') AS fuel_code,
           nullif(Fuel, '') AS fuel,
           nullif(PeakingPlantFlag, '') AS peaking_flag,
           nullif(PlantOperatorCode, '') AS plant_operator_code,
           nullif(PlantOperator, '') AS plant_operator,
           nullif(DateCommissioned, '') AS commissioned_text,
           TRY_CAST(DateCommissioned AS DATE) AS date_commissioned,
           nullif(DateDecommissioned, '') AS decommissioned_text,
           TRY_CAST(DateDecommissioned AS DATE) AS date_decommissioned,
           nullif(NameplateMegawatts, '') AS nameplate_text,
           TRY_CAST(NameplateMegawatts AS DOUBLE) AS nameplate_megawatts,
           TRY_CAST(EffectiveStartDate AS DATE) AS effective_start_date,
           TRY_CAST(EffectiveEndDate AS DATE) AS effective_end_date
         FROM read_csv(${lit(bronze.path)}, header = true, all_varchar = true)`,
      );
    } catch (error) {
      return {
        date,
        status: "invalid",
        errors: [`cannot read the file: ${(error as Error).message}`],
      };
    }

    const [check] = (
      await connection.runAndReadAll(
        `SELECT
           count(*) AS rows,
           count(*) FILTER (WHERE plant_name IS NULL OR unit_code IS NULL
             OR point_of_connection IS NULL OR fuel_code IS NULL
             OR plant_operator_code IS NULL) AS no_ids,
           count(*) FILTER (WHERE effective_start_date IS NULL OR effective_end_date IS NULL
             OR (commissioned_text IS NOT NULL AND date_commissioned IS NULL)
             OR (decommissioned_text IS NOT NULL AND date_decommissioned IS NULL)
             OR (nameplate_text IS NOT NULL
                 AND (nameplate_megawatts IS NULL OR NOT isfinite(nameplate_megawatts)))) AS bad_values,
           count(*) FILTER (WHERE effective_end_date < effective_start_date) AS bad_ranges,
           count(*) FILTER (WHERE peaking_flag IS DISTINCT FROM 'Y' AND peaking_flag IS DISTINCT FROM 'N') AS bad_flags,
           count(*) - count(DISTINCT (unit_code, point_of_connection, effective_start_date)) AS duplicates,
           (SELECT count(*) FROM fleet a JOIN fleet b
              ON a.unit_code = b.unit_code AND a.point_of_connection = b.point_of_connection
             AND a.effective_start_date < b.effective_start_date
             AND b.effective_start_date < a.effective_end_date) AS overlaps
         FROM fleet`,
      )
    ).getRowObjectsJson() as Array<Record<string, unknown>>;
    const n = (key: string) => Number(check?.[key]);
    const errors: string[] = [];
    if (n("rows") === 0) errors.push("no rows");
    if (n("no_ids") > 0)
      errors.push(
        `${n("no_ids")} rows lack a plant name, unit, point of connection, fuel or operator`,
      );
    if (n("bad_values") > 0)
      errors.push(
        `${n("bad_values")} rows have a missing or non-numeric value`,
      );
    if (n("bad_ranges") > 0)
      errors.push(`${n("bad_ranges")} rows end before they start`);
    if (n("bad_flags") > 0)
      errors.push(
        `${n("bad_flags")} rows have a peaking flag that is not Y or N`,
      );
    if (n("duplicates") > 0) errors.push(`${n("duplicates")} duplicate keys`);
    if (n("overlaps") > 0)
      errors.push(`${n("overlaps")} overlapping ranges for the same unit`);
    if (errors.length > 0) return { date, status: "invalid", errors };

    const path = join(
      silverDir,
      DATASET,
      `snapshot_date=${date}`,
      "data.parquet",
    );
    await writeParquetAtomically(
      connection,
      `SELECT DATE ${lit(date)} AS snapshot_date,
         plant_name, point_of_connection, unit_code, reconciliation_type,
         technology_code, technology, fuel_code, fuel,
         peaking_flag = 'Y' AS is_peaking_plant,
         plant_operator_code, plant_operator,
         date_commissioned, date_decommissioned, nameplate_megawatts,
         effective_start_date, effective_end_date,
         ${lit(bronze.fileName)} AS bronze_file_name,
         ${lit(bronze.sha256)} AS bronze_sha256,
         ${bronze.retrievedAt ? `${lit(bronze.retrievedAt)}::TIMESTAMPTZ` : "NULL::TIMESTAMPTZ"} AS retrieved_at
       FROM fleet
       ORDER BY unit_code, point_of_connection, effective_start_date`,
      path,
    );
    return { date, status: "complete", rows: n("rows"), path };
  } finally {
    connection.closeSync();
  }
}

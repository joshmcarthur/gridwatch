import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  findBronze,
  lit,
  type PublishResult,
  writeParquetAtomically,
} from "./common.ts";

export const DATASET = "network_supply_points";

// NZTM2000 (EPSG:2193) is a transverse Mercator projection on the GRS80 ellipsoid. NZGD2000
// differs from WGS84 by less than a metre, so the result is WGS84 for our purposes.
const A = 6378137;
const F = 1 / 298.257222101;
const K0 = 0.9996;
const FALSE_EASTING = 1600000;
const FALSE_NORTHING = 10000000;
const CENTRAL_MERIDIAN = 173;

/**
 * SQL that turns NZTM `easting` and `northing` columns into `latitude` and `longitude`
 * (degrees, 6 decimals, about 0.1 m). It uses the Krueger series for the inverse
 * projection. NULL in gives NULL out. DuckDB has no projection without a spatial extension,
 * and the extension needs a network download at run time.
 */
function nztmToWgs84(): string {
  const n = F / (2 - F);
  const n2 = n ** 2;
  const n3 = n ** 3;
  const n4 = n ** 4;
  const radius = (A / (1 + n)) * (1 + n2 / 4 + n4 / 64);
  const beta = [
    n / 2 - (2 * n2) / 3 + (37 * n3) / 96 - n4 / 360,
    n2 / 48 + n3 / 15 - (437 * n4) / 1440,
    (17 * n3) / 480 - (37 * n4) / 840,
    (4397 * n4) / 161280,
  ];
  const delta = [
    2 * n - (2 * n2) / 3 - 2 * n3 + (116 * n4) / 45,
    (7 * n2) / 3 - (8 * n3) / 5 - (227 * n4) / 45,
    (56 * n3) / 15 - (136 * n4) / 35,
    (4279 * n4) / 630,
  ];
  const sum = (terms: string[]) => terms.join(" + ");
  const xi = sum(
    beta.map(
      (b, i) => `${b} * sin(${2 * (i + 1)} * xp) * cosh(${2 * (i + 1)} * ep)`,
    ),
  );
  const eta = sum(
    beta.map(
      (b, i) => `${b} * cos(${2 * (i + 1)} * xp) * sinh(${2 * (i + 1)} * ep)`,
    ),
  );
  const phi = sum(delta.map((d, i) => `${d} * sin(${2 * (i + 1)} * chi)`));
  return `
    WITH s1 AS (
      SELECT *, (northing - ${FALSE_NORTHING}) / ${K0 * radius} AS xp,
                (easting - ${FALSE_EASTING}) / ${K0 * radius} AS ep
      FROM raw
    ), s2 AS (
      SELECT *, xp - (${xi}) AS xi, ep - (${eta}) AS eta FROM s1
    ), s3 AS (
      SELECT *, asin(sin(xi) / cosh(eta)) AS chi FROM s2
    )
    SELECT * EXCLUDE (xp, ep, xi, eta, chi),
      round(degrees(chi + ${phi}), 6) AS latitude,
      round(${CENTRAL_MERIDIAN} + degrees(atan2(sinh(eta), cos(xi))), 6) AS longitude
    FROM s3`;
}

/**
 * Publish silver Parquet for one snapshot date:
 * `<silverDir>/network_supply_points/snapshot_date=<date>/data.parquet`.
 *
 * The partition holds every row of the bronze file of that snapshot, closed rows included.
 * A row is in force from (`start_date`, `start_trading_period`) to (`end_date`,
 * `end_trading_period`), both inclusive. A blank end means it is still open. To find the
 * mapping for a day, take the newest snapshot on or before that day, then the rows in force
 * on the day (ADR-0006). There is no `processed_at` column: it would change on every run
 * (ADR-0003, ADR-0005).
 *
 * Invalid snapshot (nothing written): the file cannot be read or lacks a column; no rows; a
 * row without NSP or point of connection; a flag that is not 0 or 1; a start date, start period
 * or region ID that does not parse; an end date or end period that is set and does not parse;
 * an end date before the start date; coordinates that are not both set or not numbers; an
 * island that is set and is not NI or SI; a duplicate key (NSP, start date, start period);
 * two rows for the same NSP whose ranges overlap under the inclusive rule.
 * A snapshot has no expected periods, so it is never partial.
 */
export async function publishNetworkSupplyPoints(options: {
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

    // Read as text, then TRY_CAST: a bad value becomes NULL and the validation counts it.
    // The `*_text` columns keep what the source held, so "blank" and "bad" can be told apart.
    try {
      await connection.run(
        `CREATE TEMP TABLE raw AS
         SELECT
           TRY_CAST("Current flag" AS INTEGER) AS current_flag,
           nullif("NSP", '') AS nsp,
           nullif("NSP replaced by", '') AS nsp_replaced_by,
           nullif("POC code", '') AS point_of_connection,
           nullif("Network participant", '') AS network_participant,
           nullif("Embedded under POC code", '') AS embedded_under_point_of_connection,
           nullif("Embedded under network participant", '') AS embedded_under_network_participant,
           nullif("Reconciliation type", '') AS reconciliation_type,
           nullif("Description", '') AS description,
           nullif("NZTM easting", '') AS easting_text,
           nullif("NZTM northing", '') AS northing_text,
           TRY_CAST("NZTM easting" AS DOUBLE) AS easting,
           TRY_CAST("NZTM northing" AS DOUBLE) AS northing,
           nullif("Network reporting region ID", '') AS region_text,
           TRY_CAST("Network reporting region ID" AS INTEGER) AS network_reporting_region_id,
           nullif("Network reporting region", '') AS network_reporting_region,
           nullif("Zone", '') AS zone,
           nullif("Island", '') AS island,
           TRY_CAST("Start date" AS DATE) AS start_date,
           TRY_CAST("Start TP" AS INTEGER) AS start_trading_period,
           nullif("End date", '') AS end_date_text,
           TRY_CAST("End date" AS DATE) AS end_date,
           nullif("End TP", '') AS end_period_text,
           TRY_CAST("End TP" AS INTEGER) AS end_trading_period
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
           count(*) FILTER (WHERE nsp IS NULL OR point_of_connection IS NULL) AS no_ids,
           count(*) FILTER (WHERE current_flag IS NULL OR current_flag NOT IN (0, 1)) AS bad_flags,
           count(*) FILTER (WHERE start_date IS NULL OR start_trading_period IS NULL
             OR (region_text IS NOT NULL AND network_reporting_region_id IS NULL)
             OR (end_date_text IS NOT NULL AND end_date IS NULL)
             OR (end_period_text IS NOT NULL AND end_trading_period IS NULL)) AS bad_values,
           count(*) FILTER (WHERE end_date < start_date) AS bad_ranges,
           count(*) FILTER (WHERE (easting_text IS NULL) != (northing_text IS NULL)
             OR (easting_text IS NOT NULL AND (easting IS NULL OR NOT isfinite(easting)))
             OR (northing_text IS NOT NULL AND (northing IS NULL OR NOT isfinite(northing)))) AS bad_coordinates,
           count(*) FILTER (WHERE island NOT IN ('NI', 'SI')) AS bad_islands,
           count(*) - count(DISTINCT (nsp, start_date, start_trading_period)) AS duplicates,
           (SELECT count(*) FROM raw a JOIN raw b
              ON a.nsp = b.nsp
             AND (a.start_date, a.start_trading_period) < (b.start_date, b.start_trading_period)
             AND (b.start_date, b.start_trading_period)
                 <= (coalesce(a.end_date, DATE 'infinity'), coalesce(a.end_trading_period, 1000))) AS overlaps
         FROM raw`,
      )
    ).getRowObjectsJson() as Array<Record<string, unknown>>;
    const n = (key: string) => Number(check?.[key]);
    const errors: string[] = [];
    if (n("rows") === 0) errors.push("no rows");
    if (n("no_ids") > 0)
      errors.push(`${n("no_ids")} rows have no NSP or point of connection`);
    if (n("bad_flags") > 0)
      errors.push(
        `${n("bad_flags")} rows have a current flag that is not 0 or 1`,
      );
    if (n("bad_values") > 0)
      errors.push(
        `${n("bad_values")} rows have a missing or non-numeric value`,
      );
    if (n("bad_ranges") > 0)
      errors.push(`${n("bad_ranges")} rows end before they start`);
    if (n("bad_coordinates") > 0)
      errors.push(
        `${n("bad_coordinates")} rows have coordinates that are not a pair of numbers`,
      );
    if (n("bad_islands") > 0)
      errors.push(
        `${n("bad_islands")} rows have an island that is not NI or SI`,
      );
    if (n("duplicates") > 0) errors.push(`${n("duplicates")} duplicate keys`);
    if (n("overlaps") > 0)
      errors.push(`${n("overlaps")} overlapping ranges for the same NSP`);
    if (errors.length > 0) return { date, status: "invalid", errors };

    const path = join(
      silverDir,
      DATASET,
      `snapshot_date=${date}`,
      "data.parquet",
    );
    await writeParquetAtomically(
      connection,
      `SELECT DATE ${lit(date)} AS snapshot_date, current_flag = 1 AS is_current,
         nsp, nsp_replaced_by, point_of_connection, network_participant,
         embedded_under_point_of_connection, embedded_under_network_participant,
         reconciliation_type, description,
         easting AS easting_nztm, northing AS northing_nztm, latitude, longitude,
         network_reporting_region_id, network_reporting_region, zone, island,
         start_date, start_trading_period, end_date, end_trading_period,
         ${lit(bronze.fileName)} AS bronze_file_name,
         ${lit(bronze.sha256)} AS bronze_sha256,
         ${bronze.retrievedAt ? `${lit(bronze.retrievedAt)}::TIMESTAMPTZ` : "NULL::TIMESTAMPTZ"} AS retrieved_at
       FROM (${nztmToWgs84()})
       ORDER BY nsp, start_date, start_trading_period`,
      path,
    );
    return { date, status: "complete", rows: n("rows"), path };
  } finally {
    connection.closeSync();
  }
}

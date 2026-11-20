import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { periodsInTradingDate, periodToUtc } from "../trading-time.ts";
import {
  findBronze,
  lit,
  type PublishResult,
  writeParquetAtomically,
} from "./common.ts";

export const DATASET = "generation_md";

/**
 * Publish silver Parquet for one trading date:
 * `<silverDir>/generation_md/trading_date=<date>/data.parquet`.
 *
 * The bronze file holds a whole month in wide form (`TP1`..`TP50`). Silver is long: one row
 * per unit and trading period, in kWh. A blank cell writes no row. The header case of the date
 * column does not matter (DuckDB matches names without case).
 *
 * A day that fails validation writes nothing and any earlier partition stays as it was.
 * There is no `processed_at` column: it would change on every run (ADR-0003, ADR-0005).
 *
 * Missing (nothing written): no bronze file; or the file has no rows for this date, or every
 * cell of the date is blank. Live data shows whole months only (every file holds all its
 * days), so this is a defence against a month published part way or a revised file that drops
 * a date. The collector lists every date of the month (ADR-0007).
 * Invalid day (nothing written): the file has no rows at all; a trading date that does not
 * parse; a blank site, point of connection, network or generation code; a duplicate
 * (site, point of connection, network, generation code) unit; a value that is not a finite
 * number; a non-empty value outside the periods of the day (TP47+ on a 46-period day, TP49+
 * on a 48-period day) or in a column whose number does not parse; a blank cell inside the
 * periods of the day. The source writes 0 for no generation, so a blank is missing data.
 * Expected cells are units x periods.
 * A day is never partial: every expected cell has a value, or the day is invalid or missing.
 */
export async function publishGenerationMd(options: {
  bronzeDir: string;
  silverDir: string;
  date: string;
}): Promise<PublishResult> {
  const { silverDir, date } = options;
  const periods = periodsInTradingDate(date);
  const bronze = await findBronze(options.bronzeDir, DATASET, date);
  if (!bronze) return { date, status: "missing" };

  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");

    // Read as text, then TRY_CAST: a bad value becomes NULL and the validation counts it.
    await connection.run(
      `CREATE TEMP TABLE wide AS
       SELECT * FROM read_csv(${lit(bronze.path)}, header = true, all_varchar = true)`,
    );
    const [file] = (
      await connection.runAndReadAll(
        `SELECT count(*) AS rows,
           count(*) FILTER (WHERE TRY_CAST(Trading_Date AS DATE) IS NULL) AS bad_dates,
           count(*) FILTER (WHERE TRY_CAST(Trading_Date AS DATE) = DATE ${lit(date)}) AS day_rows
         FROM wide`,
      )
    ).getRowObjectsJson() as Array<Record<string, unknown>>;
    const f = (key: string) => Number(file?.[key]);
    if (f("rows") === 0)
      return { date, status: "invalid", errors: ["no rows"] };
    if (f("bad_dates") > 0)
      return {
        date,
        status: "invalid",
        errors: [
          `${f("bad_dates")} rows have a trading date that does not parse`,
        ],
      };
    if (f("day_rows") === 0) return { date, status: "missing" };

    await connection.run(
      `CREATE TEMP TABLE units AS
       SELECT nullif(Site_Code, '') AS site_code,
         nullif(POC_Code, '') AS point_of_connection,
         nullif(Nwk_Code, '') AS network_code,
         nullif(Gen_Code, '') AS gen_code,
         nullif(Fuel_Code, '') AS fuel_code,
         nullif(Tech_Code, '') AS tech_code,
         * EXCLUDE (Site_Code, POC_Code, Nwk_Code, Gen_Code, Fuel_Code, Tech_Code, Trading_Date)
       FROM wide
       WHERE TRY_CAST(Trading_Date AS DATE) = DATE ${lit(date)}`,
    );
    // One row per unit and non-blank cell. The unit key is the first four columns.
    await connection.run(
      `CREATE TEMP TABLE cells AS
       SELECT site_code, point_of_connection, network_code, gen_code, fuel_code, tech_code,
         TRY_CAST(substr(tp, 3) AS INTEGER) AS trading_period,
         TRY_CAST(raw AS DOUBLE) AS kilowatt_hours
       FROM (
         SELECT site_code, point_of_connection, network_code, gen_code, fuel_code, tech_code,
           tp, nullif(trim(raw), '') AS raw
         FROM (
           UNPIVOT units ON COLUMNS('(?i)^TP[0-9]+$') INTO NAME tp VALUE raw
         )
       )
       WHERE raw IS NOT NULL`,
    );

    const [check] = (
      await connection.runAndReadAll(
        `SELECT
           (SELECT count(*) FROM units
             WHERE site_code IS NULL OR point_of_connection IS NULL
               OR network_code IS NULL OR gen_code IS NULL) AS no_ids,
           (SELECT count(*) - count(DISTINCT (site_code, point_of_connection, network_code, gen_code))
             FROM units) AS duplicates,
           (SELECT count(*) FROM units) AS units,
           count(*) FILTER (WHERE trading_period NOT BETWEEN 1 AND ${periods}
             OR trading_period IS NULL) AS bad_periods,
           count(*) FILTER (WHERE trading_period BETWEEN 1 AND ${periods}) AS in_period,
           count(*) FILTER (WHERE kilowatt_hours IS NULL OR NOT isfinite(kilowatt_hours)) AS bad_values,
           count(*) AS cells
         FROM cells`,
      )
    ).getRowObjectsJson() as Array<Record<string, unknown>>;
    const n = (key: string) => Number(check?.[key]);
    // Every cell of the date is blank: the source has no data for it.
    if (n("cells") === 0) return { date, status: "missing" };
    const errors: string[] = [];
    if (n("no_ids") > 0)
      errors.push(
        `${n("no_ids")} rows have a blank site, point of connection, network or generation code`,
      );
    if (n("duplicates") > 0) errors.push(`${n("duplicates")} duplicate units`);
    if (n("bad_periods") > 0)
      errors.push(
        `${n("bad_periods")} values are outside trading periods 1 to ${periods}`,
      );
    if (n("bad_values") > 0)
      errors.push(`${n("bad_values")} values are not finite numbers`);
    const blanks = n("units") * periods - n("in_period");
    if (blanks > 0)
      errors.push(
        `${blanks} blank cells inside trading periods 1 to ${periods}`,
      );
    if (errors.length > 0) return { date, status: "invalid", errors };

    // Map each period to its UTC span with the time model.
    const spans = Array.from({ length: periods }, (_, i) => {
      const span = periodToUtc(date, i + 1);
      return `(${i + 1}, ${lit(span.eventStartUtc.toString())}::TIMESTAMPTZ, ${lit(span.eventEndUtc.toString())}::TIMESTAMPTZ)`;
    }).join(", ");

    const path = join(
      silverDir,
      DATASET,
      `trading_date=${date}`,
      "data.parquet",
    );
    await writeParquetAtomically(
      connection,
      `SELECT DATE ${lit(date)} AS trading_date, c.trading_period,
         s.event_start_utc, s.event_end_utc,
         c.site_code, c.point_of_connection, c.network_code, c.gen_code,
         c.fuel_code, c.tech_code, c.kilowatt_hours,
         ${lit(bronze.fileName)} AS bronze_file_name,
         ${lit(bronze.sha256)} AS bronze_sha256,
         ${bronze.retrievedAt ? `${lit(bronze.retrievedAt)}::TIMESTAMPTZ` : "NULL::TIMESTAMPTZ"} AS retrieved_at
       FROM cells c
       JOIN (VALUES ${spans}) s(trading_period, event_start_utc, event_end_utc)
         USING (trading_period)
       ORDER BY c.trading_period, c.site_code, c.point_of_connection, c.network_code, c.gen_code`,
      path,
    );
    return { date, status: "complete", rows: n("cells"), path };
  } finally {
    connection.closeSync();
  }
}

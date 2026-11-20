import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { periodsInTradingDate, periodToUtc } from "../trading-time.ts";
import {
  findBronze,
  lit,
  type PublishResult,
  writeParquetAtomically,
} from "./common.ts";

export const DATASET = "hvdc_flows";

/**
 * Publish silver Parquet for one trading date:
 * `<silverDir>/hvdc_flows/trading_date=<date>/data.parquet`.
 *
 * The bronze file holds a whole month in wide form (`TP1`..`TP50`), four rows a day: each of
 * `BEN2201` and `HAY2201` with `Flow_Direction` `X` (offtake from the AC grid into the link) and
 * `I` (injection from the link into the AC grid). Silver is long: one row per point of
 * connection, flow direction and trading period, in kWh (ADR-0016). A blank cell writes no row.
 * A zero is a value, not a blank. Negative values are kept.
 *
 * A day that fails validation writes nothing and any earlier partition stays as it was.
 * There is no `processed_at` column: it would change on every run (ADR-0003, ADR-0005).
 *
 * Missing (nothing written): no bronze file; or the file has no rows for this date, or every
 * cell of the date is blank. The collector lists every date of the month (ADR-0007).
 * Invalid day (nothing written): the file has no rows at all; a trading date that does not
 * parse; a blank point of connection or flow direction; a unit of measure other than `kWh`; a
 * flow direction other than `X` or `I`; a duplicate (point of connection, flow direction) unit;
 * a value that is not a finite number; a non-empty value outside the periods of the day (TP49+
 * on a 48-period day) or in a column whose number does not parse; a blank cell for some units
 * in a period that other units fill.
 * Partial day (written): one or more periods 1..N are blank for every unit. The result lists
 * them (the owner's decision on #6, ADR-0005).
 */
export async function publishHvdcFlows(options: {
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
    // Name the required columns so a wrong header fails here. TP* stay as a pattern.
    try {
      await connection.run(
        `CREATE TEMP TABLE wide AS
         SELECT POC, Nwk_Code, Unit_Measure, Flow_Direction, Status, Trading_Date,
           COLUMNS('(?i)^TP[0-9]+$')
         FROM read_csv(${lit(bronze.path)}, header = true, all_varchar = true)`,
      );
    } catch (error) {
      return {
        date,
        status: "invalid",
        errors: [`cannot read the file: ${(error as Error).message}`],
      };
    }
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

    // One row per unit of the day: the unit key is (point of connection, flow direction).
    await connection.run(
      `CREATE TEMP TABLE units AS
       SELECT nullif(trim(POC), '') AS point_of_connection,
         nullif(trim(Flow_Direction), '') AS flow_direction,
         nullif(trim(Nwk_Code), '') AS network_code,
         nullif(trim(Status), '') AS status,
         nullif(trim(Unit_Measure), '') AS unit_measure,
         * EXCLUDE (POC, Nwk_Code, Unit_Measure, Flow_Direction, Status, Trading_Date)
       FROM wide
       WHERE TRY_CAST(Trading_Date AS DATE) = DATE ${lit(date)}`,
    );
    // One row per unit and non-blank cell.
    await connection.run(
      `CREATE TEMP TABLE cells AS
       SELECT point_of_connection, flow_direction, network_code, status,
         TRY_CAST(substr(tp, 3) AS INTEGER) AS trading_period,
         TRY_CAST(raw AS DOUBLE) AS kilowatt_hours
       FROM (
         SELECT point_of_connection, flow_direction, network_code, status,
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
             WHERE point_of_connection IS NULL OR flow_direction IS NULL) AS no_ids,
           (SELECT count(*) FROM units
             WHERE unit_measure IS NULL OR unit_measure <> 'kWh') AS bad_units,
           (SELECT count(*) FROM units
             WHERE flow_direction IS NOT NULL AND flow_direction NOT IN ('X', 'I')) AS bad_directions,
           (SELECT count(*) - count(DISTINCT (point_of_connection, flow_direction))
             FROM units) AS duplicates,
           (SELECT count(*) FROM units) AS units,
           count(*) FILTER (WHERE trading_period NOT BETWEEN 1 AND ${periods}
             OR trading_period IS NULL) AS bad_periods,
           count(*) FILTER (WHERE trading_period BETWEEN 1 AND ${periods}) AS in_period,
           list(DISTINCT trading_period) FILTER (WHERE trading_period BETWEEN 1 AND ${periods}) AS present,
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
        `${n("no_ids")} rows have a blank point of connection or flow direction`,
      );
    if (n("bad_units") > 0)
      errors.push(
        `${n("bad_units")} rows have a unit of measure other than kWh`,
      );
    if (n("bad_directions") > 0)
      errors.push(
        `${n("bad_directions")} rows have a flow direction other than X or I`,
      );
    if (n("duplicates") > 0) errors.push(`${n("duplicates")} duplicate units`);
    if (n("bad_periods") > 0)
      errors.push(
        `${n("bad_periods")} values are outside trading periods 1 to ${periods}`,
      );
    if (n("bad_values") > 0)
      errors.push(`${n("bad_values")} values are not finite numbers`);
    // A period that is blank for every unit is partial. A blank for some units is invalid.
    const present = new Set(((check?.present ?? []) as unknown[]).map(Number));
    const blanks = n("units") * present.size - n("in_period");
    if (blanks > 0)
      errors.push(
        `${blanks} blank cells in trading periods that other units fill`,
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
         c.point_of_connection, c.flow_direction, c.network_code, c.status,
         c.kilowatt_hours,
         ${lit(bronze.fileName)} AS bronze_file_name,
         ${lit(bronze.sha256)} AS bronze_sha256,
         ${bronze.retrievedAt ? `${lit(bronze.retrievedAt)}::TIMESTAMPTZ` : "NULL::TIMESTAMPTZ"} AS retrieved_at
       FROM cells c
       JOIN (VALUES ${spans}) s(trading_period, event_start_utc, event_end_utc)
         USING (trading_period)
       ORDER BY c.trading_period, c.point_of_connection, c.flow_direction`,
      path,
    );
    // Missing periods do not make a day invalid. The partition holds the rows that exist.
    const missingPeriods = Array.from(
      { length: periods },
      (_, i) => i + 1,
    ).filter((period) => !present.has(period));
    const rows = n("cells");
    return missingPeriods.length === 0
      ? { date, status: "complete", rows, path }
      : { date, status: "partial", rows, path, missingPeriods };
  } finally {
    connection.closeSync();
  }
}

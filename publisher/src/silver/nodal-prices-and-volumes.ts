import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { periodsInTradingDate, periodToUtc } from "../trading-time.ts";
import {
  findBronze,
  lit,
  type PublishResult,
  writeParquetAtomically,
} from "./common.ts";

export const DATASET = "nodal_prices_and_volumes";

// Numeric columns: silver name, source name.
const NUMBERS = [
  ["load_megawatts", "LoadMegawatts"],
  ["initial_megawatts", "InitialMegawatts"],
  ["generation_megawatts", "GenerationMegawatts"],
  ["location_factor", "LocationFactor"],
  ["dollars_per_megawatt_hour", "DollarsPerMegawattHour"],
] as const;

/**
 * Publish silver Parquet for one trading date:
 * `<silverDir>/nodal_prices_and_volumes/trading_date=<date>/data.parquet`.
 *
 * A row is one 5-minute interval of one RTD case for one point of connection and one unit.
 * `IntervalDateTime` is the interval start. The source can hold more than one case for an
 * interval (a re-run), and we keep every case. Rows with unit `N/A` are point of connection
 * rows (load and price). They get a null `unit_code` and `plant_name`.
 * A day that fails validation writes nothing and any earlier partition stays as it was.
 * There is no `processed_at` column: it would change on every run (ADR-0003, ADR-0005).
 *
 * Invalid day (nothing written): no rows; a row for another date; a period outside 1..N;
 * an interval that is not on a 5-minute boundary or is outside its period; a duplicate key
 * (interval, case, point of connection, unit); a value that does not parse or a non-finite
 * number; a dead or disconnected flag that is not Y or N.
 * Partial day (written): one or more periods 1..N have no rows. The result lists them.
 * A period with some intervals missing is not partial, because the source omits about ten
 * intervals on most days. Issue #14 counts intervals per period from silver.
 */
export async function publishNodalPricesAndVolumes(options: {
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

    // Dataset-specific casts. Read as text, then TRY_CAST: a bad value becomes NULL and
    // the validation counts it. `N/A` and blank text become NULL.
    try {
      await connection.run(
        `CREATE TEMP TABLE nodal AS
         SELECT
           TRY_CAST(TradingDate AS DATE) AS trading_date,
           TRY_CAST(TradingPeriodNumber AS INTEGER) AS trading_period,
           TRY_CAST(IntervalDateTime AS TIMESTAMPTZ) AS event_start_utc,
           TRY_CAST(RunDateTime AS TIMESTAMPTZ) AS source_run_at,
           nullif(CaseTypeCode, '') AS case_type,
           nullif(CaseID, '') AS case_id,
           nullif(PointOfConnectionCode, '') AS point_of_connection,
           nullif(nullif(UnitCode, 'N/A'), '') AS unit_code,
           nullif(nullif(PlantName, 'N/A'), '') AS plant_name,
           nullif(Island, '') AS island,
           ${NUMBERS.map(([name, source]) => `TRY_CAST(${source} AS DOUBLE) AS ${name}`).join(", ")},
           IsDeadFlag AS dead_flag,
           IsDisconnectedFlag AS disconnected_flag
         FROM read_csv(${lit(bronze.path)}, header = true, all_varchar = true)`,
      );
    } catch (error) {
      return {
        date,
        status: "invalid",
        errors: [`cannot read the file: ${(error as Error).message}`],
      };
    }

    // Map each period to its UTC span with the time model.
    const spans = Array.from({ length: periods }, (_, i) => {
      const span = periodToUtc(date, i + 1);
      return `(${i + 1}, ${lit(span.eventStartUtc.toString())}::TIMESTAMPTZ, ${lit(span.eventEndUtc.toString())}::TIMESTAMPTZ)`;
    }).join(", ");

    const badNumber = NUMBERS.map(
      ([name]) => `n.${name} IS NULL OR NOT isfinite(n.${name})`,
    ).join(" OR ");

    // Dataset-specific validation.
    const [check] = (
      await connection.runAndReadAll(
        `SELECT
           count(*) AS rows,
           count(*) FILTER (WHERE n.trading_date IS DISTINCT FROM DATE ${lit(date)}) AS wrong_date,
           count(*) FILTER (WHERE n.trading_period IS NULL OR n.event_start_utc IS NULL
             OR n.source_run_at IS NULL OR n.case_id IS NULL OR n.point_of_connection IS NULL
             OR ${badNumber}) AS bad_values,
           count(*) FILTER (WHERE n.dead_flag IS DISTINCT FROM 'Y' AND n.dead_flag IS DISTINCT FROM 'N'
             OR n.disconnected_flag IS DISTINCT FROM 'Y' AND n.disconnected_flag IS DISTINCT FROM 'N') AS bad_flags,
           count(*) FILTER (WHERE n.trading_period NOT BETWEEN 1 AND ${periods}) AS bad_periods,
           count(*) FILTER (WHERE s.trading_period IS NOT NULL AND n.event_start_utc IS NOT NULL
             AND (epoch_ms(n.event_start_utc) % 300000 <> 0
               OR n.event_start_utc < s.event_start_utc OR n.event_start_utc >= s.event_end_utc)) AS bad_intervals,
           count(*) - count(DISTINCT (n.event_start_utc, n.case_id, n.point_of_connection, n.unit_code)) AS duplicates,
           list(DISTINCT n.trading_period) FILTER (WHERE n.trading_period BETWEEN 1 AND ${periods}) AS present
         FROM nodal n
         LEFT JOIN (VALUES ${spans}) s(trading_period, event_start_utc, event_end_utc)
           ON n.trading_period = s.trading_period`,
      )
    ).getRowObjectsJson() as Array<Record<string, unknown>>;
    const n = (key: string) => Number(check?.[key]);
    const errors: string[] = [];
    if (n("rows") === 0) errors.push("no rows");
    if (n("wrong_date") > 0)
      errors.push(`${n("wrong_date")} rows are not for ${date}`);
    if (n("bad_values") > 0)
      errors.push(
        `${n("bad_values")} rows have a missing or non-numeric value`,
      );
    if (n("bad_flags") > 0)
      errors.push(
        `${n("bad_flags")} rows have a dead or disconnected flag that is not Y or N`,
      );
    if (n("bad_periods") > 0)
      errors.push(
        `${n("bad_periods")} rows have a trading period outside 1 to ${periods}`,
      );
    if (n("bad_intervals") > 0)
      errors.push(
        `${n("bad_intervals")} rows have an interval that is not on a 5-minute boundary inside its trading period`,
      );
    if (n("duplicates") > 0) errors.push(`${n("duplicates")} duplicate keys`);
    if (errors.length > 0) return { date, status: "invalid", errors };

    const path = join(
      silverDir,
      DATASET,
      `trading_date=${date}`,
      "data.parquet",
    );
    await writeParquetAtomically(
      connection,
      `SELECT trading_date, trading_period,
         event_start_utc, event_start_utc + INTERVAL 5 MINUTE AS event_end_utc,
         source_run_at, case_type, case_id, point_of_connection, unit_code, plant_name, island,
         ${NUMBERS.map(([name]) => name).join(", ")},
         dead_flag = 'Y' AS is_dead, disconnected_flag = 'Y' AS is_disconnected,
         ${lit(bronze.fileName)} AS bronze_file_name,
         ${lit(bronze.sha256)} AS bronze_sha256,
         ${bronze.retrievedAt ? `${lit(bronze.retrievedAt)}::TIMESTAMPTZ` : "NULL::TIMESTAMPTZ"} AS retrieved_at
       FROM nodal
       ORDER BY event_start_utc, case_id, point_of_connection, unit_code`,
      path,
    );
    // Missing periods do not make a day invalid. The partition holds the rows that exist.
    const present = new Set(((check?.present ?? []) as unknown[]).map(Number));
    const missingPeriods = Array.from(
      { length: periods },
      (_, i) => i + 1,
    ).filter((period) => !present.has(period));
    const rows = n("rows");
    return missingPeriods.length === 0
      ? { date, status: "complete", rows, path }
      : { date, status: "partial", rows, path, missingPeriods };
  } finally {
    connection.closeSync();
  }
}

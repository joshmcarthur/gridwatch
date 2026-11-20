import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { periodsInTradingDate, periodToUtc } from "../trading-time.ts";
import {
  findBronze,
  lit,
  type PublishResult,
  writeParquetAtomically,
} from "./common.ts";

export const DATASET = "dispatch_reserve_prices";

/**
 * Publish silver Parquet for one trading date:
 * `<silverDir>/dispatch_reserve_prices/trading_date=<date>/data.parquet`.
 *
 * Long form: each source row gives two silver rows, one per reserve class (FIR, SIR).
 * `rows` in the result counts silver rows, so it is twice the source rows.
 *
 * A day that fails validation writes nothing and any earlier partition stays as it was.
 * There is no `processed_at` column: it would change on every run (ADR-0003, ADR-0005).
 *
 * Invalid day (nothing written): no rows; a row for another date; a period outside 1..N;
 * a duplicate key (period, publish time, point of connection, reserve class), counted as
 * extra rows; a value that does not parse or a non-finite price; an island that is not NI
 * or SI. Publish times are irregular, so we do not count intervals.
 * Partial day (written): one or more periods 1..N have no rows. The result lists them.
 */
export async function publishDispatchReservePrices(options: {
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
    // the validation counts it.
    try {
      await connection.run(
        `CREATE TEMP TABLE source AS
         SELECT
           TRY_CAST(TradingDate AS DATE) AS trading_date,
           TRY_CAST(TradingPeriod AS INTEGER) AS trading_period,
           TRY_CAST(PublishDateTime AS TIMESTAMPTZ) AS source_published_at,
           nullif(PointOfConnection, '') AS point_of_connection,
           nullif(Island, '') AS island,
           TRY_CAST(FIRDollarsPerMegawattHour AS DOUBLE) AS fir,
           TRY_CAST(SIRDollarsPerMegawattHour AS DOUBLE) AS sir
         FROM read_csv(${lit(bronze.path)}, header = true, all_varchar = true)`,
      );
    } catch (error) {
      return {
        date,
        status: "invalid",
        errors: [`cannot read the file: ${(error as Error).message}`],
      };
    }
    // Long form: one row per reserve class. The class is a value, not a column name.
    await connection.run(
      `CREATE TEMP TABLE prices AS
       SELECT trading_date, trading_period, source_published_at, point_of_connection,
         island, 'FIR' AS reserve_class, fir AS dollars_per_megawatt_hour
       FROM source
       UNION ALL
       SELECT trading_date, trading_period, source_published_at, point_of_connection,
         island, 'SIR' AS reserve_class, sir AS dollars_per_megawatt_hour
       FROM source`,
    );

    // Dataset-specific validation, on the long rows.
    const [check] = (
      await connection.runAndReadAll(
        `SELECT
           count(*) AS rows,
           count(*) FILTER (WHERE trading_date IS DISTINCT FROM DATE ${lit(date)}) AS wrong_date,
           count(*) FILTER (WHERE trading_period IS NULL OR source_published_at IS NULL
             OR point_of_connection IS NULL OR dollars_per_megawatt_hour IS NULL
             OR NOT isfinite(dollars_per_megawatt_hour)) AS bad_values,
           count(*) FILTER (WHERE island IS NOT NULL AND island NOT IN ('NI', 'SI')) AS bad_islands,
           count(*) FILTER (WHERE trading_period NOT BETWEEN 1 AND ${periods}) AS bad_periods,
           count(*) - count(DISTINCT (trading_period, source_published_at, point_of_connection, reserve_class)) AS duplicates,
           list(DISTINCT trading_period) FILTER (WHERE trading_period BETWEEN 1 AND ${periods}) AS present
         FROM prices`,
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
    if (n("bad_islands") > 0)
      errors.push(
        `${n("bad_islands")} rows have an island that is not NI or SI`,
      );
    if (n("bad_periods") > 0)
      errors.push(
        `${n("bad_periods")} rows have a trading period outside 1 to ${periods}`,
      );
    if (n("duplicates") > 0) errors.push(`${n("duplicates")} duplicate keys`);
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
      `SELECT p.trading_date, p.trading_period,
         s.event_start_utc, s.event_end_utc, p.source_published_at,
         p.point_of_connection, p.island, p.reserve_class,
         p.dollars_per_megawatt_hour,
         ${lit(bronze.fileName)} AS bronze_file_name,
         ${lit(bronze.sha256)} AS bronze_sha256,
         ${bronze.retrievedAt ? `${lit(bronze.retrievedAt)}::TIMESTAMPTZ` : "NULL::TIMESTAMPTZ"} AS retrieved_at
       FROM prices p
       JOIN (VALUES ${spans}) s(trading_period, event_start_utc, event_end_utc)
         USING (trading_period)
       ORDER BY p.trading_period, p.source_published_at, p.point_of_connection, p.reserve_class`,
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

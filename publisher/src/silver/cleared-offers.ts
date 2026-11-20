import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { periodsInTradingDate, periodToUtc } from "../trading-time.ts";
import {
  findBronze,
  lit,
  type PublishResult,
  writeParquetAtomically,
} from "./common.ts";

export const DATASET = "cleared_offers";

// Numeric columns: silver name, source name. A blank means none cleared, and silver stores null.
const NUMBERS = [
  ["cleared_generation_megawatts", "ClearedGenerationMegawatts"],
  ["cleared_fir_megawatts", "ClearedFIRMegawatts"],
  ["cleared_sir_megawatts", "ClearedSIRMegawatts"],
] as const;

/**
 * Publish silver Parquet for one trading date:
 * `<silverDir>/cleared_offers/trading_date=<date>/data.parquet`.
 *
 * A row is one 5-minute interval of one RTD case for one point of connection and one unit,
 * for one product class (`Injection` or `Offtake`, kept as published). `IntervalDateTime` is
 * the interval start. The source can hold more than one case for an interval (a re-run), and
 * we keep every case. Energy (`cleared_generation_megawatts`) and the two reserve products
 * (`cleared_fir_megawatts`, `cleared_sir_megawatts`) stay in three columns. A blank in the
 * source means none cleared and becomes null. Rows with unit `N/A` get a null `unit_code`.
 * `N/A` plant names get a null `plant_name`.
 * A day that fails validation writes nothing and any earlier partition stays as it was.
 * There is no `processed_at` column: it would change on every run (ADR-0003, ADR-0005).
 *
 * Invalid day (nothing written): no rows; a row for another date; a period outside 1..N;
 * an interval that is not on a 5-minute boundary or is outside its period; a duplicate key
 * (interval, case, product class, point of connection, unit); a required value that is blank
 * or does not parse; a product class that is not `Injection` or `Offtake`; a megawatt value
 * that is present but not a finite number.
 * Partial day (written): one or more periods 1..N have no rows. The result lists them.
 * A period with some intervals missing is not partial, because the source omits about ten
 * intervals on most days. Issue #14 counts intervals per period from silver.
 */
export async function publishClearedOffers(options: {
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
    // the validation counts it. Blank text reads as NULL, and `N/A` becomes NULL here.
    // `bad_number` marks a megawatt value that is present but is not a finite number.
    try {
      await connection.run(
        `CREATE TEMP TABLE offers AS
         SELECT
           TRY_CAST(TradingDate AS DATE) AS trading_date,
           TRY_CAST(TradingPeriodNumber AS INTEGER) AS trading_period,
           TRY_CAST(IntervalDateTime AS TIMESTAMPTZ) AS event_start_utc,
           TRY_CAST(RunDateTime AS TIMESTAMPTZ) AS source_run_at,
           nullif(CaseTypeCode, '') AS case_type,
           nullif(CaseID, '') AS case_id,
           nullif(ProductClass, '') AS product_class,
           nullif(PointOfConnectionCode, '') AS point_of_connection,
           nullif(nullif(UnitCode, 'N/A'), '') AS unit_code,
           nullif(nullif(PlantName, 'N/A'), '') AS plant_name,
           nullif(Island, '') AS island,
           nullif(ParticipantCode, '') AS participant_code,
           ${NUMBERS.map(([name, source]) => `TRY_CAST(${source} AS DOUBLE) AS ${name}`).join(", ")},
           ${NUMBERS.map(([, source]) => `(${source} IS NOT NULL AND (TRY_CAST(${source} AS DOUBLE) IS NULL OR NOT isfinite(TRY_CAST(${source} AS DOUBLE))))`).join(" OR ")} AS bad_number
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

    // Dataset-specific validation.
    const [check] = (
      await connection.runAndReadAll(
        `SELECT
           count(*) AS rows,
           count(*) FILTER (WHERE o.trading_date IS DISTINCT FROM DATE ${lit(date)}) AS wrong_date,
           count(*) FILTER (WHERE o.trading_period IS NULL OR o.event_start_utc IS NULL
             OR o.source_run_at IS NULL OR o.case_id IS NULL OR o.point_of_connection IS NULL
             OR o.participant_code IS NULL OR o.bad_number) AS bad_values,
           count(*) FILTER (WHERE o.product_class IS DISTINCT FROM 'Injection'
             AND o.product_class IS DISTINCT FROM 'Offtake') AS bad_classes,
           count(*) FILTER (WHERE o.trading_period NOT BETWEEN 1 AND ${periods}) AS bad_periods,
           count(*) FILTER (WHERE s.trading_period IS NOT NULL AND o.event_start_utc IS NOT NULL
             AND (epoch_ms(o.event_start_utc) % 300000 <> 0
               OR o.event_start_utc < s.event_start_utc OR o.event_start_utc >= s.event_end_utc)) AS bad_intervals,
           count(*) - count(DISTINCT (o.event_start_utc, o.case_id, o.product_class, o.point_of_connection, o.unit_code)) AS duplicates,
           list(DISTINCT o.trading_period) FILTER (WHERE o.trading_period BETWEEN 1 AND ${periods}) AS present
         FROM offers o
         LEFT JOIN (VALUES ${spans}) s(trading_period, event_start_utc, event_end_utc)
           ON o.trading_period = s.trading_period`,
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
    if (n("bad_classes") > 0)
      errors.push(
        `${n("bad_classes")} rows have a product class that is not Injection or Offtake`,
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
         source_run_at, case_type, case_id, product_class, point_of_connection, unit_code,
         plant_name, island, participant_code,
         ${NUMBERS.map(([name]) => name).join(", ")},
         ${lit(bronze.fileName)} AS bronze_file_name,
         ${lit(bronze.sha256)} AS bronze_sha256,
         ${bronze.retrievedAt ? `${lit(bronze.retrievedAt)}::TIMESTAMPTZ` : "NULL::TIMESTAMPTZ"} AS retrieved_at
       FROM offers
       ORDER BY event_start_utc, case_id, product_class, point_of_connection, unit_code`,
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

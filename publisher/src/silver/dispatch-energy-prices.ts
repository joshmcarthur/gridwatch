import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { periodsInTradingDate, periodToUtc } from "../trading-time.ts";

export const DATASET = "dispatch_energy_prices";

export type PublishResult =
  | { date: string; status: "ok"; rows: number; path: string }
  | { date: string; status: "missing" }
  | { date: string; status: "invalid"; errors: string[] };

/** A SQL string literal. File paths cannot be bound as parameters in COPY. */
const lit = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * Publish silver Parquet for one trading date:
 * `<silverDir>/dispatch_energy_prices/trading_date=<date>/data.parquet`.
 *
 * Reads the latest bronze version listed for the date in the manifest. A day that fails
 * validation writes nothing and any earlier partition stays as it was. The output
 * has no `processed_at` column: it would change on every run and break repeatable output.
 */
export async function publishDispatchEnergyPrices(options: {
  bronzeDir: string;
  silverDir: string;
  date: string;
}): Promise<PublishResult> {
  const { bronzeDir, silverDir, date } = options;
  const periods = periodsInTradingDate(date);
  if (!existsSync(join(bronzeDir, "manifest.jsonl")))
    return { date, status: "missing" };
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");

    // The newest manifest record for this date gives the file. `retrieved_at` comes from
    // the record that first stored that version.
    const manifest = lit(join(bronzeDir, "manifest.jsonl"));
    const found = (
      await connection.runAndReadAll(
        `WITH m AS (
           SELECT * FROM read_json(${manifest}, format = 'newline_delimited', columns = {
             dataset: 'VARCHAR', checked_at: 'VARCHAR', retrieved_at: 'VARCHAR',
             sha256: 'VARCHAR', path: 'VARCHAR', trading_dates: 'VARCHAR[]'})
           WHERE dataset = ${lit(DATASET)}
         ), latest AS (
           SELECT path, sha256 FROM m
           WHERE list_contains(trading_dates, ${lit(date)})
           ORDER BY checked_at DESC LIMIT 1
         )
         SELECT latest.path, latest.sha256, min(m.retrieved_at) AS retrieved_at
         FROM latest JOIN m ON m.sha256 = latest.sha256
         GROUP BY latest.path, latest.sha256`,
      )
    ).getRowObjectsJson() as Array<{
      path: string;
      sha256: string;
      retrieved_at: string | null;
    }>;
    const bronze = found[0];
    if (!bronze) return { date, status: "missing" };

    // Parse every column as text, then cast. A value that fails to cast becomes NULL and
    // the validation below counts it.
    await connection.run(
      `CREATE TEMP TABLE prices AS
       SELECT
         TRY_CAST(TradingDate AS DATE) AS trading_date,
         TRY_CAST(TradingPeriod AS INTEGER) AS trading_period,
         TRY_CAST(PublishDateTime AS TIMESTAMPTZ) AS source_published_at,
         nullif(PointOfConnection, '') AS point_of_connection,
         nullif(Island, '') AS island,
         IsProxyPriceFlag = 'Y' AS is_proxy_price,
         TRY_CAST(DollarsPerMegawattHour AS DOUBLE) AS dollars_per_megawatt_hour
       FROM read_csv(${lit(join(bronzeDir, bronze.path))}, header = true, all_varchar = true)`,
    );

    // Validation. Publish times are irregular, so the rule is: every trading period of
    // the day is present, keys are unique, and every value parses.
    const [check] = (
      await connection.runAndReadAll(
        `SELECT
           count(*) AS rows,
           count(*) FILTER (WHERE trading_date IS DISTINCT FROM DATE ${lit(date)}) AS wrong_date,
           count(*) FILTER (WHERE trading_period IS NULL OR source_published_at IS NULL
             OR point_of_connection IS NULL OR dollars_per_megawatt_hour IS NULL
             OR NOT isfinite(dollars_per_megawatt_hour)) AS bad_values,
           count(*) - count(DISTINCT (trading_period, source_published_at, point_of_connection)) AS duplicates,
           count(DISTINCT trading_period) FILTER (WHERE trading_period BETWEEN 1 AND ${periods}) AS periods_present
         FROM prices`,
      )
    ).getRowObjectsJson() as Array<Record<string, string>>;
    const n = (key: string) => Number(check?.[key]);
    const errors: string[] = [];
    if (n("rows") === 0) errors.push("no rows");
    if (n("wrong_date") > 0)
      errors.push(`${n("wrong_date")} rows are not for ${date}`);
    if (n("bad_values") > 0)
      errors.push(
        `${n("bad_values")} rows have a missing or non-numeric value`,
      );
    if (n("duplicates") > 0) errors.push(`${n("duplicates")} duplicate keys`);
    if (n("periods_present") !== periods)
      errors.push(
        `${n("periods_present")} of ${periods} trading periods present`,
      );
    if (errors.length > 0) return { date, status: "invalid", errors };

    // Map each period to its UTC span with the time model.
    const spans = Array.from({ length: periods }, (_, i) => {
      const span = periodToUtc(date, i + 1);
      return `(${i + 1}, ${lit(span.eventStartUtc.toString())}::TIMESTAMPTZ, ${lit(span.eventEndUtc.toString())}::TIMESTAMPTZ)`;
    }).join(", ");

    // The total order is unique (the key is unique), so the same input gives the same bytes.
    const dir = join(silverDir, DATASET, `trading_date=${date}`);
    const final = join(dir, "data.parquet");
    const temp = `${final}.tmp`;
    await mkdir(dir, { recursive: true });
    try {
      await connection.run(
        `COPY (
           SELECT p.trading_date, p.trading_period,
             s.event_start_utc, s.event_end_utc, p.source_published_at,
             p.point_of_connection, p.island, p.is_proxy_price, p.dollars_per_megawatt_hour,
             ${lit(bronze.path.split("/").pop() as string)} AS bronze_file_name,
             ${lit(bronze.sha256)} AS bronze_sha256,
             ${bronze.retrieved_at ? `${lit(bronze.retrieved_at)}::TIMESTAMPTZ` : "NULL::TIMESTAMPTZ"} AS retrieved_at
           FROM prices p
           JOIN (VALUES ${spans}) s(trading_period, event_start_utc, event_end_utc)
             USING (trading_period)
           ORDER BY p.trading_period, p.source_published_at, p.point_of_connection
         ) TO ${lit(temp)} (FORMAT parquet)`,
      );
      await rename(temp, final);
    } finally {
      await rm(temp, { force: true });
    }
    return { date, status: "ok", rows: n("rows"), path: final };
  } finally {
    connection.closeSync();
  }
}

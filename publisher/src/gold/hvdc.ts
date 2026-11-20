import { existsSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { lit, type PublishResult } from "../silver/common.ts";
import { periodsInTradingDate, periodToUtc } from "../trading-time.ts";
import {
  type GoldInput,
  type GoldPublishOptions,
  goldDataset,
  goldPartitionPath,
  goldStamp,
  inputFingerprint,
  inputStatusesComplete,
  silverPartitionPath,
  writeGoldTables,
} from "./common.ts";

/**
 * Bump by hand when the logic of any table in this file changes. The runner then rebuilds every
 * date (ADR-0011).
 */
export const ANALYSIS_VERSION = 1;

/** The gold tables of this module. The first is the sentinel: the runner reads it and it is written last. */
export const TABLES = ["hvdc_transfer_period", "hvdc_transfer_day"] as const;

const HVDC: GoldInput = {
  table: "hvdc_flows",
  versionColumn: "bronze_sha256",
  completenessDataset: "hvdc_flows",
};
export const INPUTS: GoldInput[] = [HVDC];

/** The two HVDC terminals. Any other point of connection flags the date (ADR-0016). */
const BENMORE = "BEN2201";
const HAYWARDS = "HAY2201";

/**
 * The direction of the transfer. `north` when both ends agree on a net flow north, `south` when
 * both agree south, otherwise `none` (idle, or the ends disagree). The inputs are signed MWh,
 * positive north (ADR-0016). A null input gives `none`.
 */
const DIRECTION = (southIslandSent: string, northIslandReceived: string) =>
  `CASE WHEN ${southIslandSent} > 0 AND ${northIslandReceived} > 0 THEN 'north'
     WHEN ${southIslandSent} < 0 AND ${northIslandReceived} < 0 THEN 'south'
     ELSE 'none' END`;

/**
 * Publish the HVDC transfer gold tables for one trading date (ADR-0016):
 * `<goldDir>/hvdc_transfer_period/trading_date=<date>/data.parquet` and
 * `<goldDir>/hvdc_transfer_day/trading_date=<date>/data.parquet` (ADR-0011).
 *
 * Input: `hvdc_flows` silver for the date only. The four metered series are `BEN2201` and
 * `HAY2201` with flow direction `X` (offtake from the AC grid into the link) and `I` (injection
 * from the link into the AC grid). Units are kWh in silver. Gold converts to MWh.
 *
 * Sign convention, positive is north (it matches `W_HVDC_C`, northward at Haywards):
 * - `south_island_sent_mwh` = (Benmore `X` - Benmore `I`) / 1000.
 * - `north_island_received_mwh` = (Haywards `I` - Haywards `X`) / 1000.
 * - `losses_mwh` = (Benmore `X` + Haywards `X` - Benmore `I` - Haywards `I`) / 1000.
 * - `average_megawatts`: period = north received x 2 (a 30-minute period); day = north received
 *   over the hours of the day (periods / 2: 23, 24 or 25). It is signed.
 * - `direction`: `north` when both nets are above zero, `south` when both are below zero, and
 *   `none` otherwise. The day direction uses the same rule on the day sums.
 *
 * Rows: the period table has one row for every expected trading period (46, 48 or 50, from
 * `periodsInTradingDate`). A period that silver lacks has null energies and direction `none`,
 * and is flagged (ADR-0011: write and flag). The day table has one row, the sums of the periods.
 * Energy columns of a day with missing periods sum only the periods that exist, and the flag
 * is false.
 *
 * `inputs_complete` is true only when all of these hold:
 * - the `hvdc_flows` `_completeness` status is `complete` for the date (ADR-0010, ADR-0011);
 * - the silver file has no point of connection other than `BEN2201` and `HAY2201`;
 * - each period has all four series (for the period row) and every period has them (for the day).
 *
 * Missing (nothing written): no `hvdc_flows` silver for the date. Gold uses only silver for the
 * date. It does not estimate from island residuals (ADR-0016).
 * Repeatable: no `processed_at`. A total `ORDER BY` and one thread make the same inputs give the
 * same bytes.
 */
export async function publishHvdc(
  options: GoldPublishOptions,
): Promise<PublishResult> {
  const { silverDir, goldDir, completeness: view, date } = options;
  const flows = silverPartitionPath(silverDir, HVDC.table, date);
  if (!existsSync(flows)) return { date, status: "missing" };

  const periods = periodsInTradingDate(date);
  const statusOk = inputStatusesComplete(view, INPUTS, date);
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    await connection.run("SET threads = 1");

    // One row for each trading period of silver: the four series and how many of them exist.
    await connection.run(
      `CREATE TEMP TABLE flows_by_period AS
       SELECT trading_period,
         sum(kilowatt_hours) FILTER (WHERE point_of_connection = '${BENMORE}' AND flow_direction = 'X') AS ben_x,
         sum(kilowatt_hours) FILTER (WHERE point_of_connection = '${BENMORE}' AND flow_direction = 'I') AS ben_i,
         sum(kilowatt_hours) FILTER (WHERE point_of_connection = '${HAYWARDS}' AND flow_direction = 'I') AS hay_i,
         sum(kilowatt_hours) FILTER (WHERE point_of_connection = '${HAYWARDS}' AND flow_direction = 'X') AS hay_x,
         count(DISTINCT (point_of_connection, flow_direction)) FILTER (
           WHERE point_of_connection IN ('${BENMORE}', '${HAYWARDS}') AND flow_direction IN ('X', 'I')) AS series
       FROM read_parquet(${lit(flows)})
       GROUP BY trading_period`,
    );
    const spans = Array.from({ length: periods }, (_, i) => {
      const span = periodToUtc(date, i + 1);
      return `(${i + 1}, ${lit(span.eventStartUtc.toString())}::TIMESTAMPTZ, ${lit(span.eventEndUtc.toString())}::TIMESTAMPTZ)`;
    }).join(", ");
    // Every expected period has a row. A period that silver lacks has null energies.
    await connection.run(
      `CREATE TEMP TABLE hvdc_mwh AS
       SELECT DATE ${lit(date)} AS trading_date, s.trading_period, s.event_start_utc, s.event_end_utc,
         p.ben_x / 1000.0 AS benmore_offtake_mwh,
         p.ben_i / 1000.0 AS benmore_injection_mwh,
         p.hay_x / 1000.0 AS haywards_offtake_mwh,
         p.hay_i / 1000.0 AS haywards_injection_mwh,
         (p.ben_x - p.ben_i) / 1000.0 AS south_island_sent_mwh,
         (p.hay_i - p.hay_x) / 1000.0 AS north_island_received_mwh,
         (p.ben_x + p.hay_x - p.ben_i - p.hay_i) / 1000.0 AS losses_mwh,
         coalesce(p.series, 0) AS series
       FROM (VALUES ${spans}) s(trading_period, event_start_utc, event_end_utc)
       LEFT JOIN flows_by_period p USING (trading_period)
       ORDER BY s.trading_period`,
    );

    const [unexpected] = (
      await connection.runAndReadAll(
        `SELECT count(*) AS n FROM read_parquet(${lit(flows)})
         WHERE point_of_connection NOT IN ('${BENMORE}', '${HAYWARDS}')`,
      )
    ).getRowObjectsJson() as Array<{ n: string }>;
    const pocOk = Number(unexpected?.n) === 0;
    const missingPeriods = (
      (
        await connection.runAndReadAll(
          "SELECT trading_period FROM hvdc_mwh WHERE series < 4 ORDER BY trading_period",
        )
      ).getRowObjectsJson() as Array<{ trading_period: string }>
    ).map((row) => Number(row.trading_period));
    const dayComplete = statusOk && pocOk && missingPeriods.length === 0;

    const fingerprint = await inputFingerprint(
      silverDir,
      ANALYSIS_VERSION,
      INPUTS,
      view,
      date,
    );
    const periodStamp = goldStamp(
      ANALYSIS_VERSION,
      fingerprint,
      `series = 4 AND ${statusOk} AND ${pocOk}`,
    );
    const dayStamp = goldStamp(
      ANALYSIS_VERSION,
      fingerprint,
      dayComplete ? "true" : "false",
    );

    const selects: Record<(typeof TABLES)[number], string> = {
      hvdc_transfer_period: `SELECT trading_date, trading_period, event_start_utc, event_end_utc,
          benmore_offtake_mwh, benmore_injection_mwh, haywards_offtake_mwh, haywards_injection_mwh,
          south_island_sent_mwh, north_island_received_mwh, losses_mwh,
          north_island_received_mwh * 2 AS average_megawatts,
          ${DIRECTION("south_island_sent_mwh", "north_island_received_mwh")} AS direction,
          ${periodStamp}
        FROM hvdc_mwh ORDER BY trading_period`,
      hvdc_transfer_day: `SELECT trading_date,
          benmore_offtake_mwh, benmore_injection_mwh, haywards_offtake_mwh, haywards_injection_mwh,
          south_island_sent_mwh, north_island_received_mwh, losses_mwh,
          north_island_received_mwh / (${periods} / 2.0) AS average_megawatts,
          ${DIRECTION("south_island_sent_mwh", "north_island_received_mwh")} AS direction,
          ${dayStamp}
        FROM (
          SELECT trading_date,
            sum(benmore_offtake_mwh) AS benmore_offtake_mwh,
            sum(benmore_injection_mwh) AS benmore_injection_mwh,
            sum(haywards_offtake_mwh) AS haywards_offtake_mwh,
            sum(haywards_injection_mwh) AS haywards_injection_mwh,
            sum(south_island_sent_mwh) AS south_island_sent_mwh,
            sum(north_island_received_mwh) AS north_island_received_mwh,
            sum(losses_mwh) AS losses_mwh
          FROM hvdc_mwh GROUP BY trading_date
        )`,
    };

    await writeGoldTables(
      connection,
      TABLES.map((table) => [table, selects[table]] as const),
      goldDir,
      date,
    );
    const path = goldPartitionPath(goldDir, TABLES[0], date);
    const [count] = (
      await connection.runAndReadAll(
        `SELECT count(*) AS n FROM read_parquet(${lit(path)})`,
      )
    ).getRowObjectsJson() as Array<{ n: string }>;
    const rows = Number(count?.n);
    return dayComplete
      ? { date, status: "complete", rows, path }
      : { date, status: "partial", rows, path, missingPeriods };
  } finally {
    connection.closeSync();
  }
}

export const hvdc = goldDataset({
  id: "gold_hvdc",
  tables: TABLES,
  inputs: INPUTS,
  analysisVersion: ANALYSIS_VERSION,
  publish: publishHvdc,
});

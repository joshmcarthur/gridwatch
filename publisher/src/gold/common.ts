import { createHash } from "node:crypto";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { lit, partitionVersions } from "../silver/common.ts";
import { periodsInTradingDate } from "../trading-time.ts";

/**
 * Helpers shared by the gold tables (ADR-0010). A gold module exports `ANALYSIS_VERSION`, a
 * `<name>WantedVersions` function and a `publish<Name>` function, and uses these helpers for
 * the rest.
 */

/** A silver table that a gold table reads, and the column that holds its version. */
export interface GoldInput {
  /** The silver folder, for example `generation_md`. */
  table: string;
  /** `bronze_sha256` for a dataset with a bronze file, `inputs_sha256` for a derived table. */
  versionColumn: "bronze_sha256" | "inputs_sha256";
}

/** `<goldDir>/<table>/trading_date=<date>/data.parquet`, the same shape as silver. */
export const goldPartitionPath = (
  goldDir: string,
  table: string,
  date: string,
) => join(goldDir, table, `trading_date=${date}`, "data.parquet");

/** The silver partition of a table for a trading date. */
export const silverPartitionPath = (
  silverDir: string,
  table: string,
  date: string,
) => join(silverDir, table, `trading_date=${date}`, "data.parquet");

/**
 * The `inputs_sha256` value. A SHA-256 over the analysis version and the version of each input
 * partition, named by table. It changes when an input is rebuilt from new bronze data, and
 * when the analysis version is bumped. It does not change with the git SHA.
 */
export function fingerprint(
  analysisVersion: number,
  inputs: ReadonlyArray<readonly [table: string, version: string]>,
): string {
  return createHash("sha256")
    .update(
      [
        `analysis_version ${analysisVersion}`,
        ...inputs.map(([table, version]) => `${table} ${version}`).sort(),
      ].join("\n"),
    )
    .digest("hex");
}

/**
 * The fingerprint that a build would write, for each date on which every input has a silver
 * partition. The runner compares it with the value that gold holds (ADR-0009, ADR-0010).
 * It reads each input table once, not once for each date.
 */
export async function wantedFingerprints(
  silverDir: string,
  analysisVersion: number,
  inputs: readonly GoldInput[],
): Promise<Map<string, string>> {
  const versions = await Promise.all(
    inputs.map((input) =>
      partitionVersions(
        silverDir,
        input.table,
        "trading_date",
        input.versionColumn,
      ),
    ),
  );
  const wanted = new Map<string, string>();
  const [first, ...rest] = versions;
  for (const date of first?.keys() ?? []) {
    if (!rest.every((v) => v.has(date))) continue;
    wanted.set(
      date,
      fingerprint(
        analysisVersion,
        inputs.map((input, i) => [input.table, versions[i]?.get(date) ?? ""]),
      ),
    );
  }
  return wanted;
}

/** The same fingerprint for one date, read from the input partitions themselves. */
export async function inputFingerprint(
  connection: DuckDBConnection,
  silverDir: string,
  analysisVersion: number,
  inputs: readonly GoldInput[],
  date: string,
): Promise<string> {
  const versions: Array<[string, string]> = [];
  for (const input of inputs) {
    const reader = await connection.runAndReadAll(
      `SELECT min(${input.versionColumn}) AS version
       FROM read_parquet(${lit(silverPartitionPath(silverDir, input.table, date))})`,
    );
    const [row] = reader.getRowObjectsJson() as Array<{ version: string }>;
    versions.push([input.table, String(row?.version)]);
  }
  return fingerprint(analysisVersion, versions);
}

/**
 * Is every input complete for the date? Today the answer comes from the silver data: each input
 * file must have rows in every expected trading period (46, 48 or 50, from `periodsInTradingDate`).
 * Pass only inputs that have a `trading_period` column. Issue #14 builds a completeness table
 * in silver. When it does, this function is the one place to change (ADR-0010).
 */
export async function inputsComplete(
  connection: DuckDBConnection,
  date: string,
  periodFiles: readonly string[],
): Promise<{ complete: boolean; missingPeriods: number[] }> {
  const expected = periodsInTradingDate(date);
  const missing = new Set<number>();
  for (const file of periodFiles) {
    const reader = await connection.runAndReadAll(
      `SELECT p AS period FROM range(1, ${expected + 1}) t(p)
       WHERE p NOT IN (SELECT DISTINCT trading_period FROM read_parquet(${lit(file)}))`,
    );
    for (const row of reader.getRowObjectsJson() as Array<{ period: string }>)
      missing.add(Number(row.period));
  }
  const missingPeriods = [...missing].sort((a, b) => a - b);
  return { complete: missingPeriods.length === 0, missingPeriods };
}

/**
 * The three columns that every gold row ends with, as a SQL select list. Put them last in the
 * SELECT, after the data columns.
 */
export const goldStamp = (
  analysisVersion: number,
  inputsSha256: string,
  inputsAreComplete: boolean,
) =>
  `${analysisVersion}::INTEGER AS analysis_version, ${lit(inputsSha256)} AS inputs_sha256, ${inputsAreComplete}::BOOLEAN AS inputs_complete`;

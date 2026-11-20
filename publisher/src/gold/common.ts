import { createHash } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { PublisherDataset } from "../datasets.ts";
import {
  lit,
  type PublishResult,
  partitionVersions,
  type VersionColumn,
} from "../silver/common.ts";
import { periodsInTradingDate } from "../trading-time.ts";

/**
 * Helpers shared by the gold tables (ADR-0011). A gold module exports `ANALYSIS_VERSION`, a
 * `<name>WantedVersions` function and a `publish<Name>` function, and uses these helpers for
 * the rest.
 */

/** A silver table that a gold table reads, and the column that holds its version. */
export interface GoldInput {
  /** The silver folder, for example `generation_md`. */
  table: string;
  /** `bronze_sha256` for a dataset with a bronze file, `inputs_sha256` for a derived table. */
  versionColumn: VersionColumn;
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
 * partition. The runner compares it with the value that gold holds (ADR-0009, ADR-0011).
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
        inputs.map((input, i) => {
          const version = versions[i]?.get(date);
          if (version === undefined)
            throw new Error(`${input.table} has no version for ${date}`);
          return [input.table, version];
        }),
      ),
    );
  }
  return wanted;
}

/**
 * The same fingerprint for one date. It reads versions with `partitionVersions`, as
 * `wantedFingerprints` does, so the written and the wanted value always agree. Throws when an
 * input has no version for the date.
 */
export async function inputFingerprint(
  silverDir: string,
  analysisVersion: number,
  inputs: readonly GoldInput[],
  date: string,
): Promise<string> {
  const versions: Array<[string, string]> = [];
  for (const input of inputs) {
    const version = (
      await partitionVersions(
        silverDir,
        input.table,
        "trading_date",
        input.versionColumn,
        date,
      )
    ).get(date);
    if (version === undefined)
      throw new Error(`${input.table} has no version for ${date}`);
    versions.push([input.table, version]);
  }
  return fingerprint(analysisVersion, versions);
}

/**
 * Write every table of a date. Each is written to a `.tmp` file first. The files are then
 * renamed, and the sentinel table (the first, the one the runner reads) is renamed last. A
 * failure while writing leaves every partition as it was. A crash between renames leaves the
 * old sentinel, so the date stays out of date and the next run builds it again (ADR-0011).
 */
export async function writeGoldTables(
  connection: DuckDBConnection,
  selects: ReadonlyArray<readonly [table: string, selectSql: string]>,
  goldDir: string,
  date: string,
): Promise<void> {
  const targets = selects.map(
    ([table, sql]) => [goldPartitionPath(goldDir, table, date), sql] as const,
  );
  try {
    for (const [path, sql] of targets) {
      await mkdir(dirname(path), { recursive: true });
      await connection.run(
        `COPY (${sql}) TO ${lit(`${path}.tmp`)} (FORMAT parquet)`,
      );
    }
    // The sentinel is the first table, so rename it after the others.
    for (const [path] of [...targets.slice(1), ...targets.slice(0, 1)])
      await rename(`${path}.tmp`, path);
  } finally {
    for (const [path] of targets) await rm(`${path}.tmp`, { force: true });
  }
}

/**
 * The registry entry of a gold module. `tables[0]` is the sentinel table: the runner reads the
 * held fingerprint from it, and `writeGoldTables` writes it last. `publish` gets `goldDir`.
 */
export function goldDataset(options: {
  id: string;
  tables: readonly [string, ...string[]];
  inputs: readonly GoldInput[];
  analysisVersion: number;
  publish: (options: {
    silverDir: string;
    goldDir: string;
    date: string;
  }) => Promise<PublishResult>;
}): PublisherDataset {
  return {
    id: options.id,
    table: options.tables[0],
    partitionKey: "trading_date",
    versionColumn: "inputs_sha256",
    partitionRoot: ({ goldDir }) => goldDir,
    wantedVersions: (silverDir) =>
      wantedFingerprints(silverDir, options.analysisVersion, options.inputs),
    publish: options.publish,
  };
}

/**
 * Is every input complete for the date? Each input file must have rows in every expected trading
 * period (46, 48 or 50, from `periodsInTradingDate`). Pass only inputs that have a `trading_period`
 * column. This does not read `silver/_completeness` (ADR-0010): `completeness.ts` imports the
 * dataset registry, and gold already sits in that registry. Gold flags from the period count.
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
       WHERE NOT EXISTS (
         SELECT 1 FROM read_parquet(${lit(file)}) r WHERE r.trading_period = t.p)`,
    );
    for (const row of reader.getRowObjectsJson() as Array<{ period: string }>)
      missing.add(Number(row.period));
  }
  const missingPeriods = [...missing].sort((a, b) => a - b);
  return { complete: missingPeriods.length === 0, missingPeriods };
}

/**
 * The three columns that every gold row ends with, as a SQL select list. Put them last in the
 * SELECT, after the data columns. `inputsAreComplete` is a boolean for a date-level flag, or a
 * SQL expression for a per-row flag (gold prices: 6 intervals per period).
 */
export const goldStamp = (
  analysisVersion: number,
  inputsSha256: string,
  inputsAreComplete: boolean | string,
) =>
  `${analysisVersion}::INTEGER AS analysis_version, ${lit(inputsSha256)} AS inputs_sha256, (${inputsAreComplete})::BOOLEAN AS inputs_complete`;

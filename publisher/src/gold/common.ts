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
import {
  type CompletenessView,
  completenessKey,
} from "../silver/completeness.ts";
import { periodsInTradingDate } from "../trading-time.ts";

/**
 * Helpers shared by the gold tables (ADR-0011). A gold module exports `ANALYSIS_VERSION`, a
 * `<name>WantedVersions` function and a `publish<Name>` function, and uses these helpers for
 * the rest.
 */

/** The two islands. Gold tables that split by island use this list, not a string fallback. */
export const ISLANDS = ["NI", "SI"] as const;
export type Island = (typeof ISLANDS)[number];

/** SQL string literals for the two islands, in order. Exhaustive over `ISLANDS`. */
export function islandLiterals(): string[] {
  return ISLANDS.map((island) => {
    switch (island) {
      case "NI":
        return "'NI'";
      case "SI":
        return "'SI'";
      default: {
        const unreachable: never = island;
        return unreachable;
      }
    }
  });
}

/** `(VALUES ('NI'), ('SI'))`, for a `CROSS JOIN` of every island. */
export const islandsValuesSql = () =>
  `(VALUES ${islandLiterals()
    .map((literal) => `(${literal})`)
    .join(", ")})`;

/**
 * An input table of a gold module (ADR-0011). `layer` is required. A `gold` input is read from
 * `goldDir`; its `versionColumn` and `completenessDataset` are fixed because gold has no
 * `_completeness` row and its `inputs_sha256` already holds the status of its own inputs. Registry
 * order is the DAG: a gold table that reads gold must come after that gold table in `datasets`.
 */
export type GoldInput = GoldSilverInput | GoldGoldInput;

interface GoldInputBase {
  /** The table folder, in silver or in gold (see `layer`), for example `generation_md`. */
  table: string;
}

/** A silver input. `completenessDataset` is null when the table has no `_completeness` row. */
export interface GoldSilverInput extends GoldInputBase {
  layer: "silver";
  /** `bronze_sha256` for a dataset with a bronze file, `inputs_sha256` for a derived table. */
  versionColumn: VersionColumn;
  completenessDataset: string | null;
}

/**
 * A gold input. The type enforces `inputs_sha256` and no `_completeness` row. `windowDays` N
 * folds in the versions of `date-N` … `date` that exist; a date is still wanted only when the
 * subject date has a partition (ADR-0019).
 */
export interface GoldGoldInput extends GoldInputBase {
  layer: "gold";
  versionColumn: "inputs_sha256";
  completenessDataset: null;
  windowDays?: number;
}

export const shiftDate = (date: string, days: number) =>
  Temporal.PlainDate.from(date).add({ days }).toString();

/** The dates from `date` minus `days` to `date`, in order. */
export const windowDates = (date: string, days: number) =>
  Array.from({ length: days + 1 }, (_, i) => shiftDate(date, i - days));

/** The rolling window of a gold input, or `undefined` for a single-date input. */
export const goldInputWindowDays = (input: GoldInput): number | undefined => {
  switch (input.layer) {
    case "gold":
      return input.windowDays;
    case "silver":
      return undefined;
    default: {
      const unreachable: never = input;
      return unreachable;
    }
  }
};

/** The directory that holds the partitions of an input. */
const inputRoot = (
  silverDir: string,
  goldDir: string,
  input: GoldInput,
): string => {
  switch (input.layer) {
    case "gold":
      return goldDir;
    case "silver":
      return silverDir;
    default: {
      const unreachable: never = input;
      return unreachable;
    }
  }
};

/** The `_completeness` status of an input on a date. No row counts as `missing`. */
const inputStatus = (
  completeness: CompletenessView,
  input: GoldInput,
  date: string,
) =>
  input.completenessDataset === null
    ? "complete"
    : (completeness.get(completenessKey(input.completenessDataset, date))
        ?.status ?? "missing");

/** True when every input is `complete` for the date. It is the first half of `inputs_complete`. */
export const inputStatusesComplete = (
  completeness: CompletenessView,
  inputs: readonly GoldInput[],
  date: string,
) =>
  inputs.every(
    (input) => inputStatus(completeness, input, date) === "complete",
  );

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
 * The `inputs_sha256` value. A SHA-256 over the analysis version and, for each input, its
 * partition version and its `_completeness` status, named by table. A gold input contributes
 * `complete` as its status (it has no `_completeness` row). A windowed gold input names each
 * day that exists. It changes when an input is rebuilt, when a silver input changes status,
 * and when the analysis version is bumped. It does not change with the git SHA.
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

const inputFingerprintRows = (
  input: GoldInput,
  completeness: CompletenessView,
  date: string,
  versionOf: (input: GoldInput, day: string) => string | undefined,
): Array<readonly [string, string]> => {
  const windowDays = goldInputWindowDays(input);
  const days =
    windowDays === undefined ? [date] : windowDates(date, windowDays);
  const rows: Array<readonly [string, string]> = [];
  for (const day of days) {
    const version = versionOf(input, day);
    if (version === undefined) {
      if (day === date)
        throw new Error(`${input.table} has no version for ${date}`);
      continue;
    }
    const name =
      windowDays === undefined ? input.table : `${input.table} ${day}`;
    rows.push([name, `${version} ${inputStatus(completeness, input, day)}`]);
  }
  return rows;
};

/**
 * The fingerprint of one date from the version of each input and the completeness view. Both
 * `wantedFingerprints` and `inputFingerprint` call it, so the wanted and the written value
 * always agree. A gold input with `windowDays` includes each window day that has a partition
 * and omits missing days.
 */
const dateFingerprint = (
  analysisVersion: number,
  inputs: readonly GoldInput[],
  completeness: CompletenessView,
  date: string,
  versionOf: (input: GoldInput, day: string) => string | undefined,
) =>
  fingerprint(
    analysisVersion,
    inputs.flatMap((input) =>
      inputFingerprintRows(input, completeness, date, versionOf),
    ),
  );

/**
 * The fingerprint that a build would write, for each date on which every input has a
 * partition. A windowed gold input still wants a date only when the subject date has a
 * partition; earlier window days are optional. The runner compares it with the value that gold
 * holds (ADR-0009, ADR-0011). It reads each input table once, not once for each date.
 */
export async function wantedFingerprints(
  silverDir: string,
  goldDir: string,
  analysisVersion: number,
  inputs: readonly GoldInput[],
  completeness: CompletenessView,
): Promise<Map<string, string>> {
  const versions = await Promise.all(
    inputs.map((input) =>
      partitionVersions(
        inputRoot(silverDir, goldDir, input),
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
      dateFingerprint(
        analysisVersion,
        inputs,
        completeness,
        date,
        (input, day) => versions[inputs.indexOf(input)]?.get(day),
      ),
    );
  }
  return wanted;
}

/**
 * The same fingerprint for one date. It reads versions with `partitionVersions` and builds the
 * value with the same code as `wantedFingerprints`. Throws when an input has no version for the
 * subject date. A windowed gold input omits missing earlier days.
 */
export async function inputFingerprint(
  silverDir: string,
  goldDir: string,
  analysisVersion: number,
  inputs: readonly GoldInput[],
  completeness: CompletenessView,
  date: string,
): Promise<string> {
  const versions = new Map<GoldInput, Map<string, string>>();
  for (const input of inputs) {
    const windowDays = goldInputWindowDays(input);
    versions.set(
      input,
      await partitionVersions(
        inputRoot(silverDir, goldDir, input),
        input.table,
        "trading_date",
        input.versionColumn,
        windowDays === undefined ? date : undefined,
      ),
    );
  }
  return dateFingerprint(
    analysisVersion,
    inputs,
    completeness,
    date,
    (input, day) => versions.get(input)?.get(day),
  );
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

/** What a gold `publish` function gets. `completeness` is the view of this run (ADR-0010). */
export interface GoldPublishOptions {
  silverDir: string;
  goldDir: string;
  completeness: CompletenessView;
  date: string;
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
  publish: (options: GoldPublishOptions) => Promise<PublishResult>;
}): PublisherDataset {
  return {
    id: options.id,
    table: options.tables[0],
    partitionKey: "trading_date",
    versionColumn: "inputs_sha256",
    partitionRoot: ({ goldDir }) => goldDir,
    wantedVersions: (silverDir, completeness, goldDir) =>
      wantedFingerprints(
        silverDir,
        goldDir,
        options.analysisVersion,
        options.inputs,
        completeness,
      ),
    publish: options.publish,
  };
}

/**
 * The row-level data rule of the generation tables: does each file have rows in every expected
 * trading period (46, 48 or 50, from `periodsInTradingDate`)? Pass only files that have a
 * `trading_period` column. It is the second half of `inputs_complete`. The first half is
 * `inputStatusesComplete`, from `_completeness`.
 */
export async function periodsComplete(
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
 * SELECT, after the data columns. `inputsCompleteSql` is a SQL boolean expression.
 */
export const goldStamp = (
  analysisVersion: number,
  inputsSha256: string,
  inputsCompleteSql: string,
) =>
  `${analysisVersion}::INTEGER AS analysis_version, ${lit(inputsSha256)} AS inputs_sha256, (${inputsCompleteSql})::BOOLEAN AS inputs_complete`;

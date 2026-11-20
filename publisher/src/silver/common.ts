import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";

export type PublishResult =
  | { date: string; status: "complete"; rows: number; path: string }
  /** Some expected trading periods have no rows. The partition holds the rows that exist. */
  | {
      date: string;
      status: "partial";
      rows: number;
      path: string;
      missingPeriods: number[];
    }
  | { date: string; status: "missing" }
  | { date: string; status: "invalid"; errors: string[] };

/** A SQL string literal. File paths cannot be bound as parameters in COPY. */
export const lit = (value: string) => `'${value.replaceAll("'", "''")}'`;

export interface BronzeFile {
  /** Absolute path of the stored file. */
  path: string;
  fileName: string;
  sha256: string;
  /** When the collector first stored this version. */
  retrievedAt: string | null;
}

interface ManifestLine {
  dataset: string;
  retrieved_at?: string;
  sha256: string;
  path: string;
  trading_dates: string[];
}

/**
 * The newest bronze version that covers `date`, or undefined. The manifest is append-only,
 * so the last matching line is the newest. The field names are a contract with the
 * collector (ADR-0004).
 */
export async function findBronze(
  bronzeDir: string,
  dataset: string,
  date: string,
): Promise<BronzeFile | undefined> {
  let text: string;
  try {
    text = await readFile(join(bronzeDir, "manifest.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const lines = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ManifestLine)
    .filter((line) => line.dataset === dataset);
  const latest = lines.findLast((line) => line.trading_dates.includes(date));
  if (!latest) return undefined;
  const stored = lines.find(
    (line) => line.sha256 === latest.sha256 && line.retrieved_at,
  );
  return {
    path: join(bronzeDir, latest.path),
    fileName: basename(latest.path),
    sha256: latest.sha256,
    retrievedAt: stored?.retrieved_at ?? null,
  };
}

/**
 * The SHA-256 of the newest bronze version for every date the manifest lists for `dataset`.
 * This is `findBronze` for all dates in one pass over the manifest.
 */
export async function bronzeVersions(
  bronzeDir: string,
  dataset: string,
): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  let text: string;
  try {
    text = await readFile(join(bronzeDir, "manifest.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return versions;
    throw error;
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const record = JSON.parse(line) as ManifestLine;
    if (record.dataset !== dataset) continue;
    // The manifest is append-only, so a later line replaces an earlier one.
    for (const date of record.trading_dates) versions.set(date, record.sha256);
  }
  return versions;
}

/**
 * Write the rows of `selectSql` to `finalPath` as Parquet. Writes a `.tmp` file first and
 * renames it, so a reader never sees a partial file. The SELECT must have a total
 * `ORDER BY`, so the same input gives the same bytes.
 */
export async function writeParquetAtomically(
  connection: DuckDBConnection,
  selectSql: string,
  finalPath: string,
): Promise<void> {
  const temp = `${finalPath}.tmp`;
  await mkdir(dirname(finalPath), { recursive: true });
  try {
    await connection.run(
      `COPY (${selectSql}) TO ${lit(temp)} (FORMAT parquet)`,
    );
    await rename(temp, finalPath);
  } finally {
    await rm(temp, { force: true });
  }
}

/** The partition folder name prefix of a table. It goes into SQL raw, so it is a literal union. */
export type PartitionKey = "trading_date" | "snapshot_date";
/** The column that holds the input version of a row. It goes into SQL raw. */
export type VersionColumn = "bronze_sha256" | "inputs_sha256";

/**
 * The value of `versionColumn` in each partition of a table, by partition date. Works for any
 * layer: `root` is the silver or gold directory. A folder without `data.parquet` is not a
 * partition (a failed first write leaves one). Pass `only` to read one date. Every row of a
 * partition must hold one version: more than one throws. A null version is left out.
 */
export async function partitionVersions(
  root: string,
  table: string,
  partitionKey: PartitionKey,
  versionColumn: VersionColumn,
  only?: string,
): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  const dir = join(root, table);
  const folders = await readdir(dir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const files = folders
    .filter(
      (f) =>
        f.isDirectory() &&
        (only === undefined
          ? f.name.startsWith(`${partitionKey}=`)
          : f.name === `${partitionKey}=${only}`),
    )
    .map((f) => join(dir, f.name, "data.parquet"))
    .filter((file) => existsSync(file));
  if (files.length === 0) return versions;
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    const reader = await connection.runAndReadAll(
      `SELECT DISTINCT
         regexp_extract(filename, '${partitionKey}=(\\d{4}-\\d{2}-\\d{2})', 1) AS date,
         ${versionColumn} AS version
       FROM read_parquet([${files.map(lit).join(", ")}], filename = true)
       WHERE ${versionColumn} IS NOT NULL
       ORDER BY 1, 2`,
    );
    for (const row of reader.getRowObjectsJson() as Array<{
      date: string;
      version: string;
    }>) {
      if (versions.has(row.date))
        throw new Error(
          `${table} ${partitionKey}=${row.date} holds more than one ${versionColumn}`,
        );
      versions.set(row.date, row.version);
    }
  } finally {
    connection.closeSync();
  }
  return versions;
}

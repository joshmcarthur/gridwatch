import { existsSync } from "node:fs";
import type { DuckDBConnection } from "@duckdb/node-api";
import { goldPartitionPath } from "../gold/common.ts";
import { lit } from "../silver/common.ts";

/** Round half away from zero. The sign is kept, and -0 becomes 0. */
export function round(value: number, places: number): number {
  const factor = 10 ** places;
  const rounded =
    (Math.round(Math.abs(value) * factor) / factor) * Math.sign(value);
  return rounded === 0 ? 0 : rounded;
}

export const roundOrNull = (value: number | null, places: number) =>
  value === null ? null : round(value, places);

export const numberOrNull = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);

/** The sentinel of a section on a date: its stamp, or null when gold has no partition. */
export interface Stamp {
  analysis_version: number;
  inputs_sha256: string;
  inputs_complete: boolean;
}

export async function readStamp(
  connection: DuckDBConnection,
  path: string,
): Promise<Stamp | null> {
  if (!existsSync(path)) return null;
  const reader = await connection.runAndReadAll(
    `SELECT any_value(analysis_version) AS analysis_version,
       any_value(inputs_sha256) AS inputs_sha256,
       bool_and(inputs_complete) AS inputs_complete
     FROM read_parquet(${lit(path)})`,
  );
  const [row] = reader.getRowObjectsJson() as Array<{
    analysis_version: unknown;
    inputs_sha256: unknown;
    inputs_complete: unknown;
  }>;
  if (!row || typeof row.inputs_sha256 !== "string") return null;
  return {
    analysis_version: Number(row.analysis_version),
    inputs_sha256: row.inputs_sha256,
    inputs_complete: row.inputs_complete === true,
  };
}

/** Rows of one gold table on a date, read in the order of the query. */
export async function rowsOf(
  connection: DuckDBConnection,
  goldDir: string,
  table: string,
  date: string,
  columns: string,
  order: string,
): Promise<Array<Record<string, unknown>>> {
  const reader = await connection.runAndReadAll(
    `SELECT ${columns} FROM read_parquet(${lit(goldPartitionPath(goldDir, table, date))})
     ORDER BY ${order}`,
  );
  return reader.getRowObjectsJson() as Array<Record<string, unknown>>;
}

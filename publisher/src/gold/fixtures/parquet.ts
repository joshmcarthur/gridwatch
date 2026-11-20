import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

/** Write rows as Parquet through a JSON file. `columns` is the DuckDB type of each column. */
export async function writeParquet(
  path: string,
  columns: Record<string, string>,
  rows: object[],
) {
  await mkdir(dirname(path), { recursive: true });
  const json = `${path}.json`;
  await writeFile(json, rows.map((row) => JSON.stringify(row)).join("\n"));
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    const columnSql = Object.entries(columns)
      .map(([name, type]) => `'${name}': '${type}'`)
      .join(", ");
    await connection.run(
      `COPY (SELECT * FROM read_json('${json}', format = 'newline_delimited', columns = {${columnSql}}))
       TO '${path}' (FORMAT parquet)`,
    );
  } finally {
    connection.closeSync();
  }
  await rm(json);
}

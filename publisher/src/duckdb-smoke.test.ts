import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { expect, test } from "vitest";

test("DuckDB writes and reads back a Parquet file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gridwatch-"));
  const file = join(dir, "smoke.parquet");
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run(
      `COPY (SELECT * FROM (VALUES (1, 'a'), (2, 'b')) t(id, name)) TO '${file}' (FORMAT parquet)`,
    );
    const reader = await connection.runAndReadAll(
      `SELECT id, name FROM read_parquet('${file}') ORDER BY id`,
    );
    expect(reader.getRowObjectsJson()).toEqual([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);
  } finally {
    connection.closeSync();
    await rm(dir, { recursive: true, force: true });
  }
});

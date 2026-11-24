import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { goldPartitionPath } from "../gold/common.ts";
import { completenessView } from "../gold/fixtures/completeness.ts";
import { writeParquet } from "../gold/fixtures/parquet.ts";
import { buildSiteDay } from "./export.ts";

const DATE = "2026-11-18";
const STAMP = {
  analysis_version: 1,
  inputs_sha256: `sha-${DATE}`,
  inputs_complete: true,
};

let goldDir = "";

beforeEach(async () => {
  goldDir = await mkdtemp(join(tmpdir(), "gw-export-gen-"));
});
afterEach(async () => {
  if (goldDir !== "") await rm(goldDir, { recursive: true, force: true });
  goldDir = "";
});

async function writeDispatchGeneration() {
  await writeParquet(
    goldPartitionPath(goldDir, "generation_by_plant_period", DATE),
    {
      trading_period: "INTEGER",
      source: "VARCHAR",
      analysis_version: "INTEGER",
      inputs_sha256: "VARCHAR",
      inputs_complete: "BOOLEAN",
    },
    [{ trading_period: 1, source: "dispatch", ...STAMP }],
  );
  await writeParquet(
    goldPartitionPath(goldDir, "generation_by_fuel_period", DATE),
    {
      trading_period: "INTEGER",
      fuel_category: "VARCHAR",
      island: "VARCHAR",
      megawatt_hours: "DOUBLE",
      analysis_version: "INTEGER",
      inputs_sha256: "VARCHAR",
      inputs_complete: "BOOLEAN",
    },
    [
      {
        trading_period: 1,
        fuel_category: "hydro",
        island: "NI",
        megawatt_hours: 10,
        ...STAMP,
      },
    ],
  );
  await writeParquet(
    goldPartitionPath(goldDir, "generation_by_fuel_day", DATE),
    {
      fuel_category: "VARCHAR",
      island: "VARCHAR",
      megawatt_hours: "DOUBLE",
      average_megawatts: "DOUBLE",
      analysis_version: "INTEGER",
      inputs_sha256: "VARCHAR",
      inputs_complete: "BOOLEAN",
    },
    [
      {
        fuel_category: "hydro",
        island: "NI",
        megawatt_hours: 10,
        average_megawatts: 0.4,
        ...STAMP,
      },
    ],
  );
}

test("dispatch generation is complete when nodal is complete and Generation_MD is missing", async () => {
  await writeDispatchGeneration();
  const completeness = completenessView([["generation_md", DATE, "missing"]]);
  const day = await buildSiteDay({ goldDir, date: DATE, completeness });
  expect(day.generation.source).toBe("dispatch");
  expect(day.generation.state).toBe("complete");
  expect(day.generation.silver_tables).toEqual([
    "nodal_prices_and_volumes",
    "entity_units",
    "entity_points_of_connection",
  ]);
  expect(day.generation.datasets).toEqual([
    "nodal_prices_and_volumes",
    "entity_mappings",
  ]);
  expect(day.datasets.generation_md?.status).toBe("missing");
  expect(day.datasets.nodal_prices_and_volumes?.status).toBe("complete");
});

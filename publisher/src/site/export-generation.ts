import { existsSync } from "node:fs";
import type { DuckDBConnection } from "@duckdb/node-api";
import { goldPartitionPath } from "../gold/common.ts";
import {
  INPUTS as GENERATION_INPUTS,
  TABLES as GENERATION_TABLES,
  INPUTS_BY_SOURCE,
} from "../gold/generation.ts";
import { lit } from "../silver/common.ts";
import type { CompletenessView } from "../silver/completeness.ts";
import type {
  FuelCategory,
  GenerationSection,
  GenerationSource,
  Island,
  SiteDay,
} from "./contract.ts";
import {
  type Section,
  sectionDatasets,
  sectionState,
} from "./export-common.ts";
import {
  numberOrNull,
  round,
  roundOrNull,
  rowsOf,
  type Stamp,
} from "./gold-read.ts";

export const GENERATION_SECTION: Section = {
  name: "generation",
  sentinel: GENERATION_TABLES[0],
  inputs: GENERATION_INPUTS,
};

export async function buildGeneration(
  connection: DuckDBConnection,
  goldDir: string,
  date: string,
  completeness: CompletenessView,
  axis: SiteDay["periods"],
): Promise<GenerationSection> {
  const sentinel = goldPartitionPath(
    goldDir,
    GENERATION_SECTION.sentinel,
    date,
  );
  const stamp = await readGenerationStamp(connection, sentinel);
  const path = {
    ...GENERATION_SECTION,
    inputs: stamp ? INPUTS_BY_SOURCE[stamp.source] : GENERATION_INPUTS,
  };
  const base = {
    silver_tables: path.inputs.map((input) => input.table),
    gold_tables: [...GENERATION_TABLES],
    datasets: [...new Set(sectionDatasets(path))],
  };
  const state = sectionState(stamp, path, completeness, date);
  if (!stamp)
    return {
      ...base,
      state: "missing",
      missing_periods: [],
      analysis_version: null,
      inputs_sha256: null,
      series: [],
      daily: [],
      plants: [],
      totals: null,
    };

  const periodRows = await rowsOf(
    connection,
    goldDir,
    "generation_by_fuel_period",
    date,
    "trading_period, fuel_category, island, megawatt_hours",
    "fuel_category, island NULLS LAST, trading_period",
  );
  const present = new Set(periodRows.map((row) => Number(row.trading_period)));
  const missingPeriods = axis
    .map((p) => p.period)
    .filter((period) => !present.has(period));

  const seriesByKey = new Map<
    string,
    {
      fuel: FuelCategory;
      island: Island | null;
      megawatt_hours: Array<number | null>;
    }
  >();
  for (const row of periodRows) {
    const fuel = String(row.fuel_category) as FuelCategory;
    const island = (row.island ?? null) as Island | null;
    const key = `${fuel}|${island ?? ""}`;
    let series = seriesByKey.get(key);
    if (!series) {
      series = {
        fuel,
        island,
        megawatt_hours: axis.map(() => null),
      };
      seriesByKey.set(key, series);
    }
    series.megawatt_hours[Number(row.trading_period) - 1] = roundOrNull(
      numberOrNull(row.megawatt_hours),
      3,
    );
  }

  const dayRows = await rowsOf(
    connection,
    goldDir,
    "generation_by_fuel_day",
    date,
    "fuel_category, island, megawatt_hours, average_megawatts",
    "fuel_category, island NULLS LAST",
  );
  let primary = 0;
  let battery = 0;
  const daily = dayRows.map((row) => {
    const fuel = String(row.fuel_category) as FuelCategory;
    const mwh = numberOrNull(row.megawatt_hours) ?? 0;
    if (fuel === "battery") battery += mwh;
    else primary += mwh;
    return {
      fuel,
      island: (row.island ?? null) as Island | null,
      megawatt_hours: round(mwh, 3),
      average_megawatts: round(numberOrNull(row.average_megawatts) ?? 0, 3),
    };
  });

  const plantPath = goldPartitionPath(goldDir, "generation_by_plant_day", date);
  const plantRows = existsSync(plantPath)
    ? await rowsOf(
        connection,
        goldDir,
        "generation_by_plant_day",
        date,
        "plant_id, plant_name, fuel_category, island, megawatt_hours, average_megawatts",
        "fuel_category, megawatt_hours DESC, plant_id",
      )
    : [];
  const plants = plantRows.map((row) => ({
    plant_id: String(row.plant_id),
    plant_name: row.plant_name == null ? "" : String(row.plant_name),
    fuel: String(row.fuel_category) as FuelCategory,
    island: (row.island ?? null) as Island | null,
    megawatt_hours: round(numberOrNull(row.megawatt_hours) ?? 0, 3),
    average_megawatts: round(numberOrNull(row.average_megawatts) ?? 0, 3),
  }));

  return {
    ...base,
    state,
    missing_periods: missingPeriods,
    analysis_version: stamp.analysis_version,
    inputs_sha256: stamp.inputs_sha256,
    series: [...seriesByKey.values()],
    daily,
    plants,
    totals: {
      primary_megawatt_hours: round(primary, 3),
      battery_megawatt_hours: round(battery, 3),
    },
    source: stamp.source,
  };
}

async function readGenerationStamp(
  connection: DuckDBConnection,
  path: string,
): Promise<(Stamp & { source: GenerationSource }) | null> {
  if (!existsSync(path)) return null;
  const reader = await connection.runAndReadAll(
    `SELECT any_value(analysis_version) AS analysis_version,
       any_value(inputs_sha256) AS inputs_sha256,
       bool_and(inputs_complete) AS inputs_complete,
       any_value(source) AS source
     FROM read_parquet(${lit(path)})`,
  );
  const [row] = reader.getRowObjectsJson() as Array<{
    analysis_version: unknown;
    inputs_sha256: unknown;
    inputs_complete: unknown;
    source: unknown;
  }>;
  if (!row || typeof row.inputs_sha256 !== "string") return null;
  return {
    analysis_version: Number(row.analysis_version),
    inputs_sha256: row.inputs_sha256,
    inputs_complete: row.inputs_complete === true,
    source: generationSource(row.source),
  };
}

function generationSource(value: unknown): GenerationSource {
  if (value === "metered" || value === "dispatch") return value;
  throw new TypeError(`generation source ${String(value)}`);
}

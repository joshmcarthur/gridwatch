import type { DuckDBConnection } from "@duckdb/node-api";
import { goldPartitionPath } from "../gold/common.ts";
import {
  INPUTS as GENERATION_INPUTS,
  TABLES as GENERATION_TABLES,
} from "../gold/generation.ts";
import type { CompletenessView } from "../silver/completeness.ts";
import type {
  FuelCategory,
  GenerationSection,
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
  readStamp,
  round,
  roundOrNull,
  rowsOf,
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
  const section = GENERATION_SECTION;
  const base = {
    silver_tables: section.inputs.map((input) => input.table),
    gold_tables: [...GENERATION_TABLES],
    datasets: sectionDatasets(section),
  };
  const stamp = await readStamp(
    connection,
    goldPartitionPath(goldDir, section.sentinel, date),
  );
  const state = sectionState(stamp, section, completeness, date);
  if (!stamp)
    return {
      ...base,
      state: "missing",
      missing_periods: [],
      analysis_version: null,
      inputs_sha256: null,
      series: [],
      daily: [],
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

  return {
    ...base,
    state,
    missing_periods: missingPeriods,
    analysis_version: stamp.analysis_version,
    inputs_sha256: stamp.inputs_sha256,
    series: [...seriesByKey.values()],
    daily,
    totals: {
      primary_megawatt_hours: round(primary, 3),
      battery_megawatt_hours: round(battery, 3),
    },
  };
}

import { existsSync } from "node:fs";
import type { DuckDBConnection } from "@duckdb/node-api";
import { goldPartitionPath, ISLANDS } from "../gold/common.ts";
import {
  INPUTS as ENERGY_BALANCE_INPUTS,
  TABLES as ENERGY_BALANCE_TABLES,
} from "../gold/energy-balance.ts";
import { TABLES as HVDC_TABLES } from "../gold/hvdc.ts";
import type { CompletenessView } from "../silver/completeness.ts";
import type { SankeySection, SiteDay } from "./contract.ts";
import {
  type Section,
  sectionDatasets,
  sectionState,
} from "./export-common.ts";
import { numberOrNull, readStamp, roundOrNull, rowsOf } from "./gold-read.ts";

export const SANKEY_SECTION: Section = {
  name: "sankey",
  sentinel: ENERGY_BALANCE_TABLES[0],
  inputs: ENERGY_BALANCE_INPUTS,
};
const [, HVDC_DAY_TABLE] = HVDC_TABLES;

const missingSankey = (base: {
  silver_tables: string[];
  gold_tables: string[];
  datasets: string[];
}): SankeySection => ({
  ...base,
  state: "missing",
  missing_periods: [],
  analysis_version: null,
  inputs_sha256: null,
  islands: [],
  link_losses_megawatt_hours: null,
  inputs_complete: null,
});

export async function buildSankey(
  connection: DuckDBConnection,
  goldDir: string,
  date: string,
  completeness: CompletenessView,
  axis: SiteDay["periods"],
): Promise<SankeySection> {
  const section = SANKEY_SECTION;
  const base = {
    silver_tables: [] as string[],
    gold_tables: [...ENERGY_BALANCE_TABLES, HVDC_DAY_TABLE],
    datasets: sectionDatasets(section),
  };
  const stamp = await readStamp(
    connection,
    goldPartitionPath(goldDir, section.sentinel, date),
  );
  if (!stamp) return missingSankey(base);

  const dayPath = goldPartitionPath(goldDir, "energy_balance_day", date);
  if (!existsSync(dayPath)) return missingSankey(base);

  const state = sectionState(stamp, section, completeness, date);
  const dayRows = await rowsOf(
    connection,
    goldDir,
    "energy_balance_day",
    date,
    "island, generation_mwh, hvdc_import_mwh, load_mwh, residual_mwh, residual_pct_of_load, inputs_complete",
    "island",
  );
  const periodRows = await rowsOf(
    connection,
    goldDir,
    "energy_balance_period",
    date,
    "trading_period, island, hvdc_import_mwh, residual_mwh",
    "trading_period, island",
  );
  const byPeriod = new Map<string, Array<number | null>>(
    ISLANDS.map((island) => [
      island,
      Array.from({ length: axis.length }, () => null),
    ]),
  );
  for (const row of periodRows) {
    const values = byPeriod.get(String(row.island));
    const period = Number(row.trading_period);
    if (!values || period < 1 || period > axis.length) continue;
    values[period - 1] = roundOrNull(numberOrNull(row.hvdc_import_mwh), 3);
  }
  const byIsland = new Map(dayRows.map((row) => [String(row.island), row]));
  const islands = ISLANDS.flatMap((island) => {
    const row = byIsland.get(island);
    if (!row) return [];
    return [
      {
        island,
        generation_megawatt_hours: roundOrNull(
          numberOrNull(row.generation_mwh),
          3,
        ),
        hvdc_import_megawatt_hours: roundOrNull(
          numberOrNull(row.hvdc_import_mwh),
          3,
        ),
        load_megawatt_hours: roundOrNull(numberOrNull(row.load_mwh), 3),
        residual_megawatt_hours: roundOrNull(numberOrNull(row.residual_mwh), 3),
        residual_percent_of_load: roundOrNull(
          numberOrNull(row.residual_pct_of_load),
          2,
        ),
        inputs_complete: row.inputs_complete === true,
        hvdc_import_by_period:
          byPeriod.get(island) ??
          Array.from({ length: axis.length }, () => null),
      },
    ];
  });

  const missingPeriods = [
    ...new Set(
      periodRows
        .filter((row) => numberOrNull(row.residual_mwh) === null)
        .map((row) => Number(row.trading_period)),
    ),
  ].sort((a, b) => a - b);

  const hvdcPath = goldPartitionPath(goldDir, HVDC_DAY_TABLE, date);
  let linkLosses: number | null = null;
  if (existsSync(hvdcPath)) {
    const hvdcRows = await rowsOf(
      connection,
      goldDir,
      HVDC_DAY_TABLE,
      date,
      "losses_mwh",
      "losses_mwh",
    );
    linkLosses = roundOrNull(numberOrNull(hvdcRows[0]?.losses_mwh), 3);
  }

  return {
    ...base,
    state,
    missing_periods: missingPeriods,
    analysis_version: stamp.analysis_version,
    inputs_sha256: stamp.inputs_sha256,
    islands,
    link_losses_megawatt_hours: linkLosses,
    inputs_complete: stamp.inputs_complete,
  };
}

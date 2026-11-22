import { existsSync } from "node:fs";
import type { DuckDBConnection } from "@duckdb/node-api";
import { goldPartitionPath } from "../gold/common.ts";
import {
  INPUTS as RESERVE_INPUTS,
  TABLES as RESERVE_TABLES,
} from "../gold/reserves.ts";
import type { CompletenessView } from "../silver/completeness.ts";
import type { Island, ReserveClass, ReservesSection } from "./contract.ts";
import {
  type Section,
  sectionDatasets,
  sectionState,
} from "./export-common.ts";
import { numberOrNull, readStamp, roundOrNull, rowsOf } from "./gold-read.ts";

export const RESERVES_SECTION: Section = {
  name: "reserves",
  sentinel: RESERVE_TABLES[0],
  inputs: RESERVE_INPUTS,
};

function missingReserves(
  base: Pick<ReservesSection, "silver_tables" | "gold_tables" | "datasets">,
): ReservesSection {
  return {
    ...base,
    state: "missing",
    missing_periods: [],
    analysis_version: null,
    inputs_sha256: null,
    classes: [],
  };
}

export async function buildReserves(
  connection: DuckDBConnection,
  goldDir: string,
  date: string,
  completeness: CompletenessView,
): Promise<ReservesSection> {
  const section = RESERVES_SECTION;
  const base = {
    silver_tables: section.inputs.map((input) => input.table),
    gold_tables: [...RESERVE_TABLES],
    datasets: sectionDatasets(section),
  };
  const stamp = await readStamp(
    connection,
    goldPartitionPath(goldDir, section.sentinel, date),
  );
  if (!stamp) return missingReserves(base);
  const dayPath = goldPartitionPath(goldDir, RESERVE_TABLES[1], date);
  if (!existsSync(dayPath)) return missingReserves(base);

  const dayRows = await rowsOf(
    connection,
    goldDir,
    RESERVE_TABLES[1],
    date,
    "reserve_class, island, mean_price, min_price, max_price, periods_present, periods_expected, rows_present, inputs_complete",
    "reserve_class, island NULLS LAST",
  );
  const classes = dayRows.map((row) => ({
    reserve_class: String(row.reserve_class) as ReserveClass,
    island: (row.island ?? null) as Island | null,
    mean_price: roundOrNull(numberOrNull(row.mean_price), 2),
    min_price: roundOrNull(numberOrNull(row.min_price), 2),
    max_price: roundOrNull(numberOrNull(row.max_price), 2),
    periods_present: Number(row.periods_present ?? 0),
    periods_expected: Number(row.periods_expected ?? 0),
    rows_present: Number(row.rows_present ?? 0),
    inputs_complete: row.inputs_complete === true,
  }));

  const periodRows = await rowsOf(
    connection,
    goldDir,
    RESERVE_TABLES[0],
    date,
    "trading_period, dollars_per_megawatt_hour",
    "trading_period, reserve_class, island NULLS LAST",
  );
  const missingPeriods = [
    ...new Set(
      periodRows
        .filter((row) => numberOrNull(row.dollars_per_megawatt_hour) === null)
        .map((row) => Number(row.trading_period)),
    ),
  ].sort((a, b) => a - b);

  return {
    ...base,
    state: sectionState(stamp, section, completeness, date),
    missing_periods: missingPeriods,
    analysis_version: stamp.analysis_version,
    inputs_sha256: stamp.inputs_sha256,
    classes,
  };
}

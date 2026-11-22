import { existsSync } from "node:fs";
import type { DuckDBConnection } from "@duckdb/node-api";
import {
  type GoldInput,
  goldPartitionPath,
  silverPartitionPath,
} from "../gold/common.ts";
import { INPUTS as PRICE_INPUTS } from "../gold/prices.ts";
import { lit } from "../silver/common.ts";
import type { CompletenessView } from "../silver/completeness.ts";
import type {
  Island,
  NodalMapPoc,
  NodalMapSection,
  NodalMapUnlocated,
  SiteDay,
} from "./contract.ts";
import {
  numberOrNull,
  readStamp,
  roundOrNull,
  type Section,
  sectionDatasets,
  sectionState,
} from "./export-common.ts";

const asIsland = (value: unknown): Island | null => {
  const text = value === null || value === undefined ? "" : String(value);
  if (text === "NI" || text === "SI") return text;
  return null;
};

function missingNodalMap(
  base: Pick<NodalMapSection, "silver_tables" | "gold_tables" | "datasets">,
): NodalMapSection {
  return {
    ...base,
    state: "missing",
    missing_periods: [],
    analysis_version: null,
    inputs_sha256: null,
    pocs: [],
    unlocated: [],
  };
}

export async function buildNodalMap(
  connection: DuckDBConnection,
  goldDir: string,
  silverDir: string,
  date: string,
  completeness: CompletenessView,
  axis: SiteDay["periods"],
): Promise<NodalMapSection> {
  const section = NODAL_MAP_SECTION;
  const base = {
    silver_tables: ["dispatch_energy_prices", "entity_points_of_connection"],
    gold_tables: ["nodal_price_periods"],
    datasets: sectionDatasets(section),
  };
  const stamp = await readStamp(
    connection,
    goldPartitionPath(goldDir, section.sentinel, date),
  );
  if (!stamp) return missingNodalMap(base);

  const entityPath = silverPartitionPath(
    silverDir,
    "entity_points_of_connection",
    date,
  );
  const joinSql = existsSync(entityPath)
    ? `LEFT JOIN read_parquet(${lit(entityPath)}) e ON e.poc_id = n.point_of_connection`
    : "";
  const coordSql = existsSync(entityPath)
    ? "e.latitude, e.longitude, e.island"
    : "NULL AS latitude, NULL AS longitude, NULL AS island";
  const reader = await connection.runAndReadAll(
    `SELECT n.point_of_connection, n.trading_period, n.price, n.has_proxy_price,
       ${coordSql}
     FROM read_parquet(${lit(goldPartitionPath(goldDir, section.sentinel, date))}) n
     ${joinSql}
     ORDER BY n.point_of_connection, n.trading_period`,
  );
  const rows = reader.getRowObjectsJson() as Array<Record<string, unknown>>;

  const byPoc = new Map<
    string,
    {
      island: Island | null;
      latitude: number | null;
      longitude: number | null;
      price: Array<number | null>;
      proxyPeriods: number[];
    }
  >();
  for (const row of rows) {
    const poc = String(row.point_of_connection);
    let entry = byPoc.get(poc);
    if (!entry) {
      entry = {
        island: asIsland(row.island),
        latitude: numberOrNull(row.latitude),
        longitude: numberOrNull(row.longitude),
        price: axis.map(() => null),
        proxyPeriods: [],
      };
      byPoc.set(poc, entry);
    }
    const period = Number(row.trading_period);
    entry.price[period - 1] = roundOrNull(numberOrNull(row.price), 2);
    if (row.has_proxy_price === true) entry.proxyPeriods.push(period);
  }

  const pocs: NodalMapPoc[] = [];
  const unlocated: NodalMapUnlocated[] = [];
  for (const [point_of_connection, entry] of byPoc) {
    const shared = {
      point_of_connection,
      island: entry.island,
      price: entry.price,
      proxy_periods: entry.proxyPeriods.sort((a, b) => a - b),
    };
    if (entry.latitude !== null && entry.longitude !== null) {
      pocs.push({
        ...shared,
        latitude: entry.latitude,
        longitude: entry.longitude,
      });
    } else {
      unlocated.push(shared);
    }
  }

  const missingPeriods = axis
    .map((p) => p.period)
    .filter((period) =>
      [...byPoc.values()].every((entry) => entry.price[period - 1] === null),
    );

  return {
    ...base,
    state: sectionState(stamp, section, completeness, date),
    missing_periods: missingPeriods,
    analysis_version: stamp.analysis_version,
    inputs_sha256: stamp.inputs_sha256,
    pocs,
    unlocated,
  };
}

const ENTITY_POINTS: GoldInput = {
  table: "entity_points_of_connection",
  layer: "silver",
  versionColumn: "inputs_sha256",
  completenessDataset: "entity_mappings",
};
export const NODAL_MAP_SECTION: Section = {
  name: "nodal_map",
  sentinel: "nodal_price_periods",
  inputs: [...PRICE_INPUTS, ENTITY_POINTS],
};

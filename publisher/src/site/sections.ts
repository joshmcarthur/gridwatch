import { existsSync } from "node:fs";
import type { DuckDBConnection } from "@duckdb/node-api";
import { goldPartitionPath, ISLANDS } from "../gold/common.ts";
import { TABLES as ENERGY_BALANCE_TABLES } from "../gold/energy-balance.ts";
import { TABLES as EPISODE_TABLES } from "../gold/episodes.ts";
import { TABLES as GENERATION_TABLES } from "../gold/generation.ts";
import { TABLES as HVDC_TABLES } from "../gold/hvdc.ts";
import {
  TABLES as PRICE_TABLES,
  REFERENCE_NODES,
  SPREAD_PAIRS,
} from "../gold/prices.ts";
import { TABLES as RESERVE_TABLES } from "../gold/reserves.ts";
import type { CompletenessView } from "../silver/completeness.ts";
import type {
  EpisodesSection,
  FuelCategory,
  GenerationSection,
  Island,
  PricesSection,
  ReserveClass,
  ReservesSection,
  SankeySection,
  SiteDay,
  SiteEpisode,
} from "./contract.ts";
import {
  numberOrNull,
  readStamp,
  round,
  roundOrNull,
  rowsOf,
} from "./gold-read.ts";
import {
  EPISODES_SECTION,
  GENERATION_SECTION,
  PRICES_SECTION,
  RESERVES_SECTION,
  SANKEY_SECTION,
  sectionDatasets,
  sectionState,
} from "./section-registry.ts";

const [, HVDC_DAY_TABLE] = HVDC_TABLES;

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

export async function buildPrices(
  connection: DuckDBConnection,
  goldDir: string,
  date: string,
  completeness: CompletenessView,
  axis: SiteDay["periods"],
): Promise<PricesSection> {
  const section = PRICES_SECTION;
  const base = {
    silver_tables: section.inputs.map((input) => input.table),
    gold_tables: [...PRICE_TABLES],
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
      nodes: [],
      spreads: [],
      distribution: {
        poc_count: [],
        min: [],
        p05: [],
        p25: [],
        median: [],
        p75: [],
        p95: [],
        max: [],
      },
    };

  const count = axis.length;
  const periodRows = await rowsOf(
    connection,
    goldDir,
    "price_periods",
    date,
    "point_of_connection, trading_period, price, has_proxy_price",
    "point_of_connection, trading_period",
  );
  const nodes = REFERENCE_NODES.map((reference) => {
    const price: Array<number | null> = axis.map(() => null);
    const proxyPeriods: number[] = [];
    for (const row of periodRows) {
      if (row.point_of_connection !== reference.pointOfConnection) continue;
      const period = Number(row.trading_period);
      price[period - 1] = roundOrNull(numberOrNull(row.price), 2);
      if (row.has_proxy_price === true) proxyPeriods.push(period);
    }
    return {
      point_of_connection: reference.pointOfConnection,
      price_region: reference.priceRegion,
      price,
      proxy_periods: proxyPeriods.sort((a, b) => a - b),
    };
  });

  const dailyRows = await rowsOf(
    connection,
    goldDir,
    "price_daily_summary",
    date,
    "point_of_connection, mean_price, min_price, max_price, periods_present, periods_expected, rows_present, inputs_complete",
    "point_of_connection",
  );
  const withDaily = nodes.map((node) => {
    const row = dailyRows.find(
      (candidate) => candidate.point_of_connection === node.point_of_connection,
    );
    return {
      ...node,
      daily: {
        mean_price: roundOrNull(numberOrNull(row?.mean_price), 2),
        min_price: roundOrNull(numberOrNull(row?.min_price), 2),
        max_price: roundOrNull(numberOrNull(row?.max_price), 2),
        periods_present: Number(row?.periods_present ?? 0),
        periods_expected: Number(row?.periods_expected ?? count),
        rows_present: Number(row?.rows_present ?? 0),
        inputs_complete: row?.inputs_complete === true,
      },
    };
  });

  const spreadRows = await rowsOf(
    connection,
    goldDir,
    "price_spreads",
    date,
    "from_point_of_connection, to_point_of_connection, trading_period, spread",
    "from_point_of_connection, to_point_of_connection, trading_period",
  );
  const regionOf = (poc: string) =>
    REFERENCE_NODES.find((node) => node.pointOfConnection === poc)
      ?.priceRegion ?? poc;
  const spreads = SPREAD_PAIRS.map(([from, to]) => {
    const spread: Array<number | null> = axis.map(() => null);
    for (const row of spreadRows) {
      if (
        row.from_point_of_connection !== from ||
        row.to_point_of_connection !== to
      )
        continue;
      spread[Number(row.trading_period) - 1] = roundOrNull(
        numberOrNull(row.spread),
        2,
      );
    }
    return {
      from,
      to,
      from_price_region: regionOf(from),
      to_price_region: regionOf(to),
      spread,
    };
  });

  const distributionRows = await rowsOf(
    connection,
    goldDir,
    "price_distribution",
    date,
    "trading_period, poc_count, min_price, p05_price, p25_price, median_price, p75_price, p95_price, max_price",
    "trading_period",
  );
  const column = (name: string) =>
    axis.map((p) => {
      const row = distributionRows.find(
        (candidate) => Number(candidate.trading_period) === p.period,
      );
      return roundOrNull(numberOrNull(row?.[name]), 2);
    });
  const distribution = {
    poc_count: axis.map((p) => {
      const row = distributionRows.find(
        (candidate) => Number(candidate.trading_period) === p.period,
      );
      return Number(row?.poc_count ?? 0);
    }),
    min: column("min_price"),
    p05: column("p05_price"),
    p25: column("p25_price"),
    median: column("median_price"),
    p75: column("p75_price"),
    p95: column("p95_price"),
    max: column("max_price"),
  };

  // A period is missing when any reference node has no price in it.
  const missingPeriods = axis
    .map((p) => p.period)
    .filter((period) =>
      withDaily.some((node) => node.price[period - 1] === null),
    );

  return {
    ...base,
    state,
    missing_periods: missingPeriods,
    analysis_version: stamp.analysis_version,
    inputs_sha256: stamp.inputs_sha256,
    nodes: withDaily,
    spreads,
    distribution,
  };
}

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
      },
    ];
  });

  const periodRows = await rowsOf(
    connection,
    goldDir,
    "energy_balance_period",
    date,
    "trading_period, residual_mwh",
    "trading_period, island",
  );
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

const asUtc = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString().replace(/\.000Z$/, "Z");
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw new TypeError(`not an instant: ${value}`);
    return new Date(ms).toISOString().replace(/\.000Z$/, "Z");
  }
  throw new TypeError("event time is not a string or Date");
};

const stringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
};

const islandList = (value: unknown): Island[] =>
  stringList(value).flatMap((item) => {
    if (item === "NI" || item === "SI") return [item];
    return [];
  });

function missingReserves(
  base: Pick<ReservesSection, "silver_tables" | "gold_tables" | "datasets">,
): ReservesSection {
  return {
    ...base,
    state: "missing",
    missing_periods: [],
    analysis_version: null,
    inputs_sha256: null,
    daily: [],
  };
}

const requireReserveClass = (value: unknown): ReserveClass => {
  if (value === "FIR" || value === "SIR") return value;
  throw new TypeError(`reserve_class is not FIR or SIR: ${String(value)}`);
};

const requireIsland = (value: unknown): Island => {
  if (value === "NI" || value === "SI") return value;
  throw new TypeError(`island is not NI or SI: ${String(value)}`);
};

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

  const dayRows = await rowsOf(
    connection,
    goldDir,
    RESERVE_TABLES[1],
    date,
    "reserve_class, island, mean_price, min_price, max_price, periods_present, periods_expected, rows_present, inputs_complete",
    "reserve_class, island NULLS LAST",
  );
  const daily = dayRows.map((row) => ({
    reserve_class: requireReserveClass(row.reserve_class),
    island: requireIsland(row.island),
    mean_price: roundOrNull(numberOrNull(row.mean_price), 2),
    min_price: roundOrNull(numberOrNull(row.min_price), 2),
    max_price: roundOrNull(numberOrNull(row.max_price), 2),
    periods_present: Number(row.periods_present),
    periods_expected: Number(row.periods_expected),
    rows_present: Number(row.rows_present),
    inputs_complete: row.inputs_complete === true,
  }));

  const periodRows = await rowsOf(
    connection,
    goldDir,
    RESERVE_TABLES[0],
    date,
    "trading_period, dollars_per_megawatt_hour",
    "trading_period",
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
    daily,
  };
}

function missingEpisodes(
  base: Pick<EpisodesSection, "silver_tables" | "gold_tables" | "datasets">,
): EpisodesSection {
  return {
    ...base,
    state: "missing",
    missing_periods: [],
    analysis_version: null,
    inputs_sha256: null,
    items: [],
  };
}

export async function buildEpisodes(
  connection: DuckDBConnection,
  goldDir: string,
  date: string,
  completeness: CompletenessView,
): Promise<EpisodesSection> {
  const section = EPISODES_SECTION;
  const base = {
    silver_tables: [] as string[],
    gold_tables: [...EPISODE_TABLES],
    datasets: sectionDatasets(section),
  };
  const stamp = await readStamp(
    connection,
    goldPartitionPath(goldDir, section.sentinel, date),
  );
  if (!stamp) return missingEpisodes(base);
  const itemsPath = goldPartitionPath(goldDir, EPISODE_TABLES[1], date);
  const rows = existsSync(itemsPath)
    ? await rowsOf(
        connection,
        goldDir,
        EPISODE_TABLES[1],
        date,
        `episode_id, seed_observation_id, event_start_utc, event_end_utc,
         start_trading_period, end_trading_period, member_count,
         observation_types, islands, severity`,
        "severity DESC, episode_id",
      )
    : [];
  const items: SiteEpisode[] = rows.map((row) => ({
    episode_id: String(row.episode_id),
    seed_observation_id: String(row.seed_observation_id),
    start_utc: asUtc(row.event_start_utc),
    end_utc: asUtc(row.event_end_utc),
    start_trading_period: Number(row.start_trading_period),
    end_trading_period: Number(row.end_trading_period),
    member_count: Number(row.member_count),
    observation_types: stringList(row.observation_types),
    islands: islandList(row.islands),
    severity: round(Number(row.severity), 2),
  }));
  return {
    ...base,
    state: sectionState(stamp, section, completeness, date),
    missing_periods: [],
    analysis_version: stamp.analysis_version,
    inputs_sha256: stamp.inputs_sha256,
    items,
  };
}

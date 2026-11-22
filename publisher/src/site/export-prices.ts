import type { DuckDBConnection } from "@duckdb/node-api";
import { goldPartitionPath } from "../gold/common.ts";
import {
  INPUTS as PRICE_INPUTS,
  PRICE_SECTION_TABLES,
  TABLES as PRICE_TABLES,
  REFERENCE_NODES,
  SPREAD_PAIRS,
} from "../gold/prices.ts";
import type { CompletenessView } from "../silver/completeness.ts";
import type { PricesSection, SiteDay } from "./contract.ts";
import {
  type Section,
  sectionDatasets,
  sectionState,
} from "./export-common.ts";
import { numberOrNull, readStamp, roundOrNull, rowsOf } from "./gold-read.ts";

export const PRICES_SECTION: Section = {
  name: "prices",
  sentinel: PRICE_TABLES[0],
  inputs: PRICE_INPUTS,
};

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
    gold_tables: [...PRICE_SECTION_TABLES],
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

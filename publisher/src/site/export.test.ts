import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, expect, test } from "vitest";
import { datasets } from "../datasets.ts";
import { goldPartitionPath } from "../gold/common.ts";
import { completenessView } from "../gold/fixtures/completeness.ts";
import { runPublish } from "../runner.ts";
import { lit } from "../silver/common.ts";
import {
  type CompletenessRow,
  completenessKey,
  saveCompleteness,
} from "../silver/completeness.ts";
import { periodsInTradingDate } from "../trading-time.ts";
import {
  assertSiteDay,
  assertSiteIndex,
  SITE_CONTRACT_VERSION,
  type SiteDay,
} from "./contract.ts";
import { buildSiteDay, exportSite } from "./export.ts";
import { round } from "./gold-read.ts";

/** A valid day on a 46-period date. Generation is incomplete, prices are missing. */
function sampleDay(): SiteDay {
  const periods = Array.from({ length: 46 }, (_, i) => ({
    period: i + 1,
    start_utc: "2026-09-26T12:00:00Z",
  }));
  return {
    contract_version: SITE_CONTRACT_VERSION,
    trading_date: "2026-09-27",
    periods,
    complete: false,
    datasets: {
      generation_md: {
        status: "partial",
        expected_period_count: 46,
        actual_period_count: 45,
        missing_periods: [46],
        bronze_sha256s: ["abc"],
        errors: [],
      },
    },
    generation: {
      state: "incomplete",
      missing_periods: [],
      analysis_version: 1,
      inputs_sha256: "abc",
      silver_tables: ["generation_md"],
      gold_tables: ["generation_by_fuel_period"],
      datasets: ["generation_md"],
      series: [
        {
          fuel: "hydro",
          island: "NI",
          megawatt_hours: periods.map((_, i) => (i === 0 ? 10.5 : null)),
        },
      ],
      daily: [
        {
          fuel: "hydro",
          island: "NI",
          megawatt_hours: 10.5,
          average_megawatts: 0.1,
        },
      ],
      totals: { primary_megawatt_hours: 10.5, battery_megawatt_hours: 0 },
    },
    prices: {
      state: "missing",
      missing_periods: [],
      analysis_version: null,
      inputs_sha256: null,
      silver_tables: ["dispatch_energy_prices"],
      gold_tables: ["price_periods"],
      datasets: [],
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
    },
  };
}

test("a valid day passes, with and without the optional extensions", () => {
  const day = sampleDay();
  expect(() => assertSiteDay(day)).not.toThrow();
  expect(() =>
    assertSiteDay({
      ...day,
      reserves: {
        state: "missing",
        missing_periods: [],
        analysis_version: null,
        inputs_sha256: null,
        silver_tables: [],
        gold_tables: [],
        datasets: [],
        classes: [],
      },
      sankey: {
        state: "missing",
        missing_periods: [],
        analysis_version: null,
        inputs_sha256: null,
        silver_tables: [],
        gold_tables: [],
        datasets: [],
        islands: [],
        link_losses_megawatt_hours: null,
        inputs_complete: null,
      },
      observations: { state: "incomplete" },
      nodal_map: {
        state: "missing",
        missing_periods: [],
        analysis_version: null,
        inputs_sha256: null,
        silver_tables: [],
        gold_tables: [],
        datasets: [],
        pocs: [],
        unlocated: [],
      },
    }),
  ).not.toThrow();
});

test("the validator rejects a missing reserves section that carries classes", () => {
  const day = sampleDay();
  expect(() =>
    assertSiteDay({
      ...day,
      reserves: {
        state: "missing",
        missing_periods: [],
        analysis_version: null,
        inputs_sha256: null,
        silver_tables: ["dispatch_reserve_prices"],
        gold_tables: ["reserve_by_class_island_period"],
        datasets: [],
        classes: [
          {
            reserve_class: "FIR",
            island: "NI",
            mean_price: 0,
            min_price: 0,
            max_price: 0,
            periods_present: 0,
            periods_expected: 48,
            rows_present: 0,
            inputs_complete: false,
          },
        ],
      },
    }),
  ).toThrow("reserves.classes: a missing section has no entries");
});

test("a reserves class may omit price", () => {
  const day = sampleDay();
  expect(() =>
    assertSiteDay({
      ...day,
      reserves: {
        state: "complete",
        missing_periods: [],
        analysis_version: 1,
        inputs_sha256: "abc",
        silver_tables: ["dispatch_reserve_prices"],
        gold_tables: ["reserve_by_class_island_period"],
        datasets: [],
        classes: [
          {
            reserve_class: "FIR",
            island: "NI",
            mean_price: 1,
            min_price: 0,
            max_price: 2,
            periods_present: 46,
            periods_expected: 46,
            rows_present: 46,
            inputs_complete: true,
          },
        ],
      },
    }),
  ).not.toThrow();
});

test("a reserves class price must match the period axis", () => {
  const day = sampleDay();
  expect(() =>
    assertSiteDay({
      ...day,
      reserves: {
        state: "complete",
        missing_periods: [],
        analysis_version: 1,
        inputs_sha256: "abc",
        silver_tables: ["dispatch_reserve_prices"],
        gold_tables: ["reserve_by_class_island_period"],
        datasets: [],
        classes: [
          {
            reserve_class: "FIR",
            island: "NI",
            mean_price: 1,
            min_price: 0,
            max_price: 2,
            periods_present: 46,
            periods_expected: 46,
            rows_present: 46,
            inputs_complete: true,
            price: [1],
          },
        ],
      },
    }),
  ).toThrow("reserves.classes[0].price: expected 46 entries");
});

test("the validator rejects a missing sankey that carries zeros", () => {
  const day = sampleDay();
  expect(() =>
    assertSiteDay({
      ...day,
      sankey: {
        state: "missing",
        missing_periods: [],
        analysis_version: null,
        inputs_sha256: null,
        silver_tables: [],
        gold_tables: [],
        datasets: [],
        islands: [
          {
            island: "NI",
            generation_megawatt_hours: 0,
            hvdc_import_megawatt_hours: 0,
            load_megawatt_hours: 0,
            residual_megawatt_hours: 0,
            residual_percent_of_load: 0,
            inputs_complete: false,
          },
        ],
        link_losses_megawatt_hours: null,
        inputs_complete: null,
      },
    }),
  ).toThrow("sankey.islands: a missing section has no entries");
});

test("the validator rejects a truncated array, a missing state, a bad state and an unknown dataset", () => {
  const day = sampleDay();
  const [first] = day.generation.series;
  const short = {
    ...day,
    generation: {
      ...day.generation,
      series: [{ ...first, megawatt_hours: [1] }],
    },
  };
  expect(() => assertSiteDay(short)).toThrow(
    "generation.series[0].megawatt_hours: expected 46 entries",
  );

  const { state: _state, ...noState } = day.prices;
  expect(() => assertSiteDay({ ...day, prices: noState })).toThrow(
    "prices.state",
  );
  expect(() =>
    assertSiteDay({ ...day, prices: { ...day.prices, state: "ok" } }),
  ).toThrow("prices.state: expected one of");

  expect(() =>
    assertSiteDay({
      ...day,
      generation: { ...day.generation, datasets: ["generation_md", "nope"] },
    }),
  ).toThrow("nope is read by a section but is not a key");
});

test("the validator rejects a day length that is not 46, 48 or 50", () => {
  const day = sampleDay();
  expect(() =>
    assertSiteDay({ ...day, periods: day.periods.slice(1) }),
  ).toThrow("periods: expected 46, 48 or 50 entries");
});

const validIndex = {
  contract_version: SITE_CONTRACT_VERSION,
  days: [
    {
      date: "2026-09-26",
      path: "days/2026-09-26.json",
      complete: true,
      sections: { generation: "complete", prices: "complete" },
      export_sha256: "a",
    },
    {
      date: "2026-09-27",
      path: "days/2026-09-27.json",
      complete: false,
      sections: { generation: "incomplete", prices: "missing" },
      export_sha256: "b",
    },
  ],
  latest_complete: { generation_md: "2026-09-26", cleared_offers: null },
  latest_complete_sections: { generation: "2026-09-26", prices: null },
};

test("the index validator accepts a valid index and rejects dates out of order", () => {
  expect(() => assertSiteIndex(validIndex)).not.toThrow();
  expect(() =>
    assertSiteIndex({ ...validIndex, days: [...validIndex.days].reverse() }),
  ).toThrow("expected ascending, unique dates");
  expect(() =>
    assertSiteIndex({
      ...validIndex,
      days: [
        {
          ...validIndex.days[0],
          sections: { generation: "ok", prices: "complete" },
        },
      ],
    }),
  ).toThrow("expected one of");
});

// The exporter, on hand-written gold partitions.

let root: string;
let goldDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gw-site-"));
  goldDir = join(root, "gold");
});
afterEach(() => rm(root, { recursive: true, force: true }));

type Row = Record<string, string | number | boolean | null>;

const literal = (value: string | number | boolean | null, type: string) =>
  value === null
    ? `NULL::${type}`
    : typeof value === "string"
      ? `${lit(value)}::${type}`
      : `${value}::${type}`;

/**
 * Write one gold partition by hand. The stamp columns are filled in for each row, and a row can
 * override them. Zero rows write an empty table with the same columns.
 */
async function writeGold(
  table: string,
  date: string,
  types: Record<string, string>,
  rows: Row[],
) {
  const columns: Record<string, string> = {
    analysis_version: "INTEGER",
    inputs_sha256: "VARCHAR",
    inputs_complete: "BOOLEAN",
    ...types,
  };
  const names = Object.keys(columns);
  const filled: Row[] = rows.map((row) => ({
    analysis_version: 1,
    inputs_sha256: `sha-${date}`,
    inputs_complete: true,
    ...row,
  }));
  const select =
    filled.length === 0
      ? `SELECT ${names.map((n) => `NULL::${columns[n]} AS ${n}`).join(", ")} WHERE false`
      : `SELECT * FROM (VALUES ${filled
          .map(
            (row) =>
              `(${names.map((n) => literal(row[n] ?? null, columns[n] ?? "VARCHAR")).join(", ")})`,
          )
          .join(", ")}) t(${names.join(", ")})`;
  const path = goldPartitionPath(goldDir, table, date);
  await mkdir(dirname(path), { recursive: true });
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run(`COPY (${select}) TO ${lit(path)} (FORMAT parquet)`);
  } finally {
    connection.closeSync();
  }
}

/** Generation gold for a date. `stamp` overrides the sentinel row's stamp. */
async function writeGeneration(
  date: string,
  {
    period = [],
    day = [],
    stamp = {},
  }: { period?: Row[]; day?: Row[]; stamp?: Row } = {},
) {
  await writeGold(
    "generation_by_plant_period",
    date,
    { trading_period: "INTEGER" },
    [{ trading_period: 1, ...stamp }],
  );
  await writeGold(
    "generation_by_fuel_period",
    date,
    {
      trading_period: "INTEGER",
      fuel_category: "VARCHAR",
      island: "VARCHAR",
      megawatt_hours: "DOUBLE",
      average_megawatts: "DOUBLE",
    },
    period,
  );
  await writeGold(
    "generation_by_fuel_day",
    date,
    {
      fuel_category: "VARCHAR",
      island: "VARCHAR",
      megawatt_hours: "DOUBLE",
      average_megawatts: "DOUBLE",
    },
    day,
  );
}

/** Price gold for a date. The `price_periods` rows are the sentinel, so their stamp is the section's. */
async function writePrices(
  date: string,
  {
    periods = [],
    daily = [],
    spreads = [],
    distribution = [],
  }: {
    periods?: Row[];
    daily?: Row[];
    spreads?: Row[];
    distribution?: Row[];
  } = {},
) {
  await writeGold(
    "price_periods",
    date,
    {
      trading_period: "INTEGER",
      point_of_connection: "VARCHAR",
      price: "DOUBLE",
      has_proxy_price: "BOOLEAN",
    },
    periods,
  );
  await writeGold(
    "price_daily_summary",
    date,
    {
      point_of_connection: "VARCHAR",
      mean_price: "DOUBLE",
      min_price: "DOUBLE",
      max_price: "DOUBLE",
      periods_present: "INTEGER",
      periods_expected: "INTEGER",
      rows_present: "INTEGER",
    },
    daily,
  );
  await writeGold(
    "price_spreads",
    date,
    {
      trading_period: "INTEGER",
      from_point_of_connection: "VARCHAR",
      to_point_of_connection: "VARCHAR",
      from_price_region: "VARCHAR",
      to_price_region: "VARCHAR",
      spread: "DOUBLE",
    },
    spreads,
  );
  await writeGold(
    "price_distribution",
    date,
    {
      trading_period: "INTEGER",
      poc_count: "INTEGER",
      min_price: "DOUBLE",
      p05_price: "DOUBLE",
      p25_price: "DOUBLE",
      median_price: "DOUBLE",
      p75_price: "DOUBLE",
      p95_price: "DOUBLE",
      max_price: "DOUBLE",
    },
    distribution,
  );
}

const NODES = ["OTA2201", "HAY2201", "BEN2201"];

/** Reserve gold for a date. The period table is the reserves sentinel. */
async function writeReservesGold(
  date: string,
  {
    period = [],
    day = [],
    stamp = {},
  }: { period?: Row[]; day?: Row[]; stamp?: Row } = {},
) {
  await writeGold(
    "reserve_by_class_island_period",
    date,
    {
      trading_period: "INTEGER",
      reserve_class: "VARCHAR",
      island: "VARCHAR",
      dollars_per_megawatt_hour: "DOUBLE",
    },
    period.map((row) => ({ ...stamp, ...row })),
  );
  await writeGold(
    "reserve_by_class_island_day",
    date,
    {
      reserve_class: "VARCHAR",
      island: "VARCHAR",
      mean_price: "DOUBLE",
      min_price: "DOUBLE",
      max_price: "DOUBLE",
      periods_present: "INTEGER",
      periods_expected: "INTEGER",
      rows_present: "INTEGER",
    },
    day.map((row) => ({ ...stamp, ...row })),
  );
}

/** Energy-balance gold for a date. The period table is the sankey sentinel. */
async function writeSankeyGold(
  date: string,
  {
    period = [],
    day = [],
    hvdcDay,
    stamp = {},
  }: {
    period?: Row[];
    day?: Row[];
    hvdcDay?: Row[];
    stamp?: Row;
  } = {},
) {
  await writeGold(
    "energy_balance_period",
    date,
    {
      trading_period: "INTEGER",
      island: "VARCHAR",
      residual_mwh: "DOUBLE",
    },
    period.map((row) => ({ ...stamp, ...row })),
  );
  await writeGold(
    "energy_balance_day",
    date,
    {
      island: "VARCHAR",
      generation_mwh: "DOUBLE",
      hvdc_import_mwh: "DOUBLE",
      load_mwh: "DOUBLE",
      residual_mwh: "DOUBLE",
      residual_pct_of_load: "DOUBLE",
    },
    day.map((row) => ({ ...stamp, ...row })),
  );
  if (hvdcDay)
    await writeGold(
      "hvdc_transfer_day",
      date,
      { losses_mwh: "DOUBLE" },
      hvdcDay.map((row) => ({ ...stamp, ...row })),
    );
}

/** One price row for each reference node and period. `price` gives null for a null price. */
function pricePeriods(
  periods: number,
  price: (node: string, period: number) => number | null,
  stamp: (node: string, period: number) => Row = () => ({}),
): Row[] {
  return NODES.flatMap((node) =>
    Array.from({ length: periods }, (_, i) => ({
      trading_period: i + 1,
      point_of_connection: node,
      price: price(node, i + 1),
      has_proxy_price: false,
      ...stamp(node, i + 1),
    })),
  );
}

/** Spread rows for the three reference pairs over `periods` periods, each with spread 10. */
function spreadRows(periods: number): Row[] {
  const pairs: Array<[string, string]> = [
    ["OTA2201", "HAY2201"],
    ["HAY2201", "BEN2201"],
    ["OTA2201", "BEN2201"],
  ];
  return pairs.flatMap(([from, to]) =>
    Array.from({ length: periods }, (_, i) => ({
      trading_period: i + 1,
      from_point_of_connection: from,
      to_point_of_connection: to,
      from_price_region: "region_from",
      to_price_region: "region_to",
      spread: 10,
    })),
  );
}

const DATE = "2026-11-18";
const readIndex = async () =>
  JSON.parse(await readFile(join(goldDir, "site", "index.json"), "utf8"));

test("generation pivots by fuel and island, and the totals split battery from primary", async () => {
  await writeGeneration(DATE, {
    period: [
      {
        trading_period: 1,
        fuel_category: "hydro",
        island: "NI",
        megawatt_hours: 10.5,
      },
      {
        trading_period: 2,
        fuel_category: "hydro",
        island: "NI",
        megawatt_hours: 11,
      },
      {
        trading_period: 1,
        fuel_category: "hydro",
        island: "SI",
        megawatt_hours: 20,
      },
      {
        trading_period: 1,
        fuel_category: "gas",
        island: "NI",
        megawatt_hours: 5,
      },
      {
        trading_period: 1,
        fuel_category: "battery",
        island: "SI",
        megawatt_hours: 1.25,
      },
      {
        trading_period: 1,
        fuel_category: "unmapped",
        island: null,
        megawatt_hours: 0.75,
      },
    ],
    day: [
      {
        fuel_category: "hydro",
        island: "NI",
        megawatt_hours: 21.5,
        average_megawatts: 0.9,
      },
      {
        fuel_category: "hydro",
        island: "SI",
        megawatt_hours: 20,
        average_megawatts: 0.8,
      },
      {
        fuel_category: "gas",
        island: "NI",
        megawatt_hours: 5,
        average_megawatts: 0.2,
      },
      {
        fuel_category: "battery",
        island: "SI",
        megawatt_hours: 1.25,
        average_megawatts: 0.05,
      },
      {
        fuel_category: "unmapped",
        island: null,
        megawatt_hours: 0.75,
        average_megawatts: 0.03,
      },
    ],
  });
  const day = await buildSiteDay({
    goldDir,
    date: DATE,
    completeness: completenessView(),
  });
  expect(day.periods).toHaveLength(48);
  expect(day.generation.totals).toEqual({
    primary_megawatt_hours: 47.25,
    battery_megawatt_hours: 1.25,
  });
  expect(day.generation.series).toHaveLength(5);
  const hydroNi = day.generation.series.find(
    (s) => s.fuel === "hydro" && s.island === "NI",
  );
  expect(hydroNi?.megawatt_hours).toHaveLength(48);
  expect(hydroNi?.megawatt_hours.slice(0, 3)).toEqual([10.5, 11, null]);
  expect(
    day.generation.series.find((s) => s.fuel === "unmapped")?.island,
  ).toBeNull();
});

test("values round to 3 decimals for MWh and 2 for prices, keeping the sign and no negative zero", async () => {
  expect(round(-12.345, 2)).toBe(-12.35);
  expect(round(12.345, 2)).toBe(12.35);
  expect(Object.is(round(-0.001, 2), 0)).toBe(true);

  await writeGeneration(DATE, {
    period: [
      {
        trading_period: 1,
        fuel_category: "hydro",
        island: "NI",
        megawatt_hours: 10.12349,
      },
    ],
  });
  await writePrices(DATE, {
    periods: [
      {
        trading_period: 1,
        point_of_connection: "OTA2201",
        price: 50.74995555,
        has_proxy_price: false,
      },
      {
        trading_period: 1,
        point_of_connection: "HAY2201",
        price: -12.345,
        has_proxy_price: false,
      },
      {
        trading_period: 1,
        point_of_connection: "BEN2201",
        price: -0.001,
        has_proxy_price: false,
      },
    ],
  });
  const day = await buildSiteDay({
    goldDir,
    date: DATE,
    completeness: completenessView(),
  });
  expect(day.generation.series[0]?.megawatt_hours[0]).toBe(10.123);
  const [ota, hay, ben] = day.prices.nodes;
  expect(ota?.price[0]).toBe(50.75);
  expect(hay?.price[0]).toBe(-12.35);
  expect(Object.is(ben?.price[0], 0)).toBe(true);
});

test("the axis has 46 periods on the DST-start day and 50 on the DST-end day", async () => {
  const start = await buildSiteDay({
    goldDir,
    date: "2026-09-27",
    completeness: completenessView(),
  });
  expect(start.periods).toHaveLength(46);
  expect(start.periods[0]?.start_utc).toBe("2026-09-26T12:00:00Z");
  expect(start.periods[4]?.start_utc).toBe("2026-09-26T14:00:00Z");
  expect(start.periods[45]?.start_utc).toBe("2026-09-27T10:30:00Z");
  expect(start.generation.state).toBe("missing");
  const end = await buildSiteDay({
    goldDir,
    date: "2026-04-05",
    completeness: completenessView(),
  });
  expect(end.periods).toHaveLength(50);
});

test("a section without gold is written as missing, with empty arrays, and the day is not complete", async () => {
  await writeGeneration(DATE, {
    period: [
      {
        trading_period: 1,
        fuel_category: "hydro",
        island: "NI",
        megawatt_hours: 1,
      },
    ],
    day: [
      {
        fuel_category: "hydro",
        island: "NI",
        megawatt_hours: 1,
        average_megawatts: 0.1,
      },
    ],
  });
  const completeness = completenessView([
    ["dispatch_energy_prices", DATE, "missing"],
  ]);
  const day = await buildSiteDay({ goldDir, date: DATE, completeness });
  expect(day.prices).toMatchObject({
    state: "missing",
    nodes: [],
    spreads: [],
    missing_periods: [],
    analysis_version: null,
    inputs_sha256: null,
  });
  expect(day.prices.distribution.median).toEqual([]);
  expect(day.datasets.dispatch_energy_prices?.status).toBe("missing");
  expect(day.complete).toBe(false);
  expect(day.sankey).toMatchObject({
    state: "missing",
    islands: [],
    link_losses_megawatt_hours: null,
    inputs_complete: null,
    analysis_version: null,
    inputs_sha256: null,
  });
  expect(day.reserves).toMatchObject({
    state: "missing",
    classes: [],
    missing_periods: [],
    analysis_version: null,
    inputs_sha256: null,
  });
  expect(() => assertSiteDay(day)).not.toThrow();
});

test("reserves carries the gold day table, FIR then SIR, islands north to south", async () => {
  await writeReservesGold(DATE, {
    period: [
      {
        trading_period: 1,
        reserve_class: "FIR",
        island: "NI",
        dollars_per_megawatt_hour: 1.25,
      },
      {
        trading_period: 1,
        reserve_class: "FIR",
        island: "SI",
        dollars_per_megawatt_hour: 0.5,
      },
      {
        trading_period: 1,
        reserve_class: "SIR",
        island: "NI",
        dollars_per_megawatt_hour: 0.4,
      },
      {
        trading_period: 1,
        reserve_class: "SIR",
        island: "SI",
        dollars_per_megawatt_hour: 0.2,
      },
    ],
    day: [
      {
        reserve_class: "FIR",
        island: "NI",
        mean_price: 1.249,
        min_price: 0.1,
        max_price: 4,
        periods_present: 48,
        periods_expected: 48,
        rows_present: 200,
      },
      {
        reserve_class: "FIR",
        island: "SI",
        mean_price: 0.5,
        min_price: 0,
        max_price: 1,
        periods_present: 48,
        periods_expected: 48,
        rows_present: 180,
      },
      {
        reserve_class: "SIR",
        island: "NI",
        mean_price: 0.4,
        min_price: 0,
        max_price: 2,
        periods_present: 48,
        periods_expected: 48,
        rows_present: 200,
      },
      {
        reserve_class: "SIR",
        island: "SI",
        mean_price: 0.2,
        min_price: 0,
        max_price: 1,
        periods_present: 48,
        periods_expected: 48,
        rows_present: 180,
      },
    ],
  });
  const day = await buildSiteDay({
    goldDir,
    date: DATE,
    completeness: completenessView(),
  });
  expect(day.reserves).toMatchObject({
    state: "complete",
    analysis_version: 1,
    inputs_sha256: `sha-${DATE}`,
    silver_tables: ["dispatch_reserve_prices"],
    gold_tables: [
      "reserve_by_class_island_period",
      "reserve_by_class_island_day",
    ],
    datasets: ["dispatch_reserve_prices"],
    missing_periods: [],
  });
  expect(day.reserves?.classes).toEqual([
    {
      reserve_class: "FIR",
      island: "NI",
      mean_price: 1.25,
      min_price: 0.1,
      max_price: 4,
      periods_present: 48,
      periods_expected: 48,
      rows_present: 200,
      inputs_complete: true,
    },
    {
      reserve_class: "FIR",
      island: "SI",
      mean_price: 0.5,
      min_price: 0,
      max_price: 1,
      periods_present: 48,
      periods_expected: 48,
      rows_present: 180,
      inputs_complete: true,
    },
    {
      reserve_class: "SIR",
      island: "NI",
      mean_price: 0.4,
      min_price: 0,
      max_price: 2,
      periods_present: 48,
      periods_expected: 48,
      rows_present: 200,
      inputs_complete: true,
    },
    {
      reserve_class: "SIR",
      island: "SI",
      mean_price: 0.2,
      min_price: 0,
      max_price: 1,
      periods_present: 48,
      periods_expected: 48,
      rows_present: 180,
      inputs_complete: true,
    },
  ]);
  expect(day.complete).toBe(false);
  expect(() => assertSiteDay(day)).not.toThrow();
});

test("a day with no reserve gold exports reserves as missing, never zeros", async () => {
  const day = await buildSiteDay({
    goldDir,
    date: DATE,
    completeness: completenessView(),
  });
  expect(day.reserves?.state).toBe("missing");
  expect(day.reserves?.classes).toEqual([]);
  expect(day.reserves?.analysis_version).toBeNull();
  expect(day.reserves?.inputs_sha256).toBeNull();
});

test("reserves is incomplete when a class-island period has no price", async () => {
  await writeReservesGold(DATE, {
    period: [
      {
        trading_period: 1,
        reserve_class: "FIR",
        island: "NI",
        dollars_per_megawatt_hour: 1,
      },
      {
        trading_period: 2,
        reserve_class: "FIR",
        island: "NI",
        dollars_per_megawatt_hour: null,
        inputs_complete: false,
      },
    ],
    day: [
      {
        reserve_class: "FIR",
        island: "NI",
        mean_price: 1,
        min_price: 1,
        max_price: 1,
        periods_present: 47,
        periods_expected: 48,
        rows_present: 100,
        inputs_complete: false,
      },
    ],
    stamp: { inputs_complete: false },
  });
  const day = await buildSiteDay({
    goldDir,
    date: DATE,
    completeness: completenessView(),
  });
  expect(day.reserves?.state).toBe("incomplete");
  expect(day.reserves?.missing_periods).toEqual([2]);
  expect(day.reserves?.classes[0]).toMatchObject({
    reserve_class: "FIR",
    island: "NI",
    mean_price: 1,
    inputs_complete: false,
  });
});

test("sankey carries the gold day table, with residual sign and percent of load", async () => {
  // Hand values from the #23 / ADR-0018 base case: 48 periods, NI 6+1-5=2 per period,
  // SI 4-1.2-2.5=0.3, link losses 0.2. Day sums: NI 288, 48, 240, 96 (40% of load);
  // SI 192, -57.6, 120, 14.4 (12% of load); losses 9.6.
  await writeSankeyGold(DATE, {
    period: [
      { trading_period: 1, island: "NI", residual_mwh: 2 },
      { trading_period: 1, island: "SI", residual_mwh: 0.3 },
    ],
    day: [
      {
        island: "NI",
        generation_mwh: 288,
        hvdc_import_mwh: 48,
        load_mwh: 240,
        residual_mwh: 96,
        residual_pct_of_load: 40,
      },
      {
        island: "SI",
        generation_mwh: 192,
        hvdc_import_mwh: -57.6,
        load_mwh: 120,
        residual_mwh: 14.4,
        residual_pct_of_load: 12,
      },
    ],
    hvdcDay: [{ losses_mwh: 9.6 }],
  });
  const day = await buildSiteDay({
    goldDir,
    date: DATE,
    completeness: completenessView(),
  });
  expect(day.sankey).toMatchObject({
    state: "complete",
    inputs_complete: true,
    link_losses_megawatt_hours: 9.6,
    missing_periods: [],
  });
  expect(day.sankey?.islands).toEqual([
    {
      island: "NI",
      generation_megawatt_hours: 288,
      hvdc_import_megawatt_hours: 48,
      load_megawatt_hours: 240,
      residual_megawatt_hours: 96,
      residual_percent_of_load: 40,
      inputs_complete: true,
    },
    {
      island: "SI",
      generation_megawatt_hours: 192,
      hvdc_import_megawatt_hours: -57.6,
      load_megawatt_hours: 120,
      residual_megawatt_hours: 14.4,
      residual_percent_of_load: 12,
      inputs_complete: true,
    },
  ]);
  expect(day.complete).toBe(false);
  expect(() => assertSiteDay(day)).not.toThrow();
});

test("a day with no energy-balance row exports sankey as missing, never zeros", async () => {
  const day = await buildSiteDay({
    goldDir,
    date: DATE,
    completeness: completenessView(),
  });
  expect(day.sankey?.state).toBe("missing");
  expect(day.sankey?.islands).toEqual([]);
  expect(day.sankey?.link_losses_megawatt_hours).toBeNull();
  expect(day.sankey?.inputs_complete).toBeNull();
});

test("HVDC gold alone does not invent a sankey transfer during the month lag", async () => {
  await writeGold("hvdc_transfer_day", DATE, { losses_mwh: "DOUBLE" }, [
    { losses_mwh: 400 },
  ]);
  const day = await buildSiteDay({
    goldDir,
    date: DATE,
    completeness: completenessView(),
  });
  expect(day.sankey?.state).toBe("missing");
  expect(day.sankey?.link_losses_megawatt_hours).toBeNull();
  expect(day.sankey?.islands).toEqual([]);
});

test("an incomplete energy-balance day is incomplete, lists null-residual periods, and keeps a negative residual", async () => {
  await writeSankeyGold(DATE, {
    stamp: { inputs_complete: false },
    period: [
      { trading_period: 5, island: "NI", residual_mwh: null },
      { trading_period: 5, island: "SI", residual_mwh: 0.3 },
    ],
    day: [
      {
        island: "NI",
        generation_mwh: 288,
        hvdc_import_mwh: -96,
        load_mwh: null,
        residual_mwh: null,
        residual_pct_of_load: null,
        inputs_complete: false,
      },
      {
        island: "SI",
        generation_mwh: 192,
        hvdc_import_mwh: 105.6,
        load_mwh: 120,
        residual_mwh: 177.6,
        residual_pct_of_load: 148,
        inputs_complete: false,
      },
    ],
    hvdcDay: [{ losses_mwh: 9.6, inputs_complete: false }],
  });
  const day = await buildSiteDay({
    goldDir,
    date: DATE,
    completeness: completenessView(),
  });
  expect(day.sankey?.state).toBe("incomplete");
  expect(day.sankey?.inputs_complete).toBe(false);
  expect(day.sankey?.missing_periods).toEqual([5]);
  expect(day.sankey?.islands[0]).toMatchObject({
    island: "NI",
    hvdc_import_megawatt_hours: -96,
    load_megawatt_hours: null,
    residual_megawatt_hours: null,
    residual_percent_of_load: null,
    inputs_complete: false,
  });
});

test("a null price on an incomplete row makes the section incomplete, and lists that period", async () => {
  await writePrices(DATE, {
    periods: pricePeriods(
      48,
      (node, p) => (node === "OTA2201" && p === 7 ? null : 10 + p),
      (node, p): Row =>
        node === "OTA2201" && p === 7 ? { inputs_complete: false } : {},
    ),
  });
  const day = await buildSiteDay({
    goldDir,
    date: DATE,
    completeness: completenessView(),
  });
  expect(day.prices.state).toBe("incomplete");
  expect(day.prices.missing_periods).toEqual([7]);
  const [ota, hay] = day.prices.nodes;
  expect(ota?.price[6]).toBeNull();
  expect(ota?.price[5]).toBe(16);
  expect(hay?.price[6]).toBe(17);
});

test("a day with every price null lists every period and still validates", async () => {
  await writePrices(DATE, {
    periods: pricePeriods(
      48,
      () => null,
      () => ({ inputs_complete: false }),
    ),
  });
  const day = await buildSiteDay({
    goldDir,
    date: DATE,
    completeness: completenessView(),
  });
  expect(day.prices.missing_periods).toHaveLength(48);
  expect(day.prices.nodes.every((n) => n.daily.mean_price === null)).toBe(true);
  expect(() => assertSiteDay(day)).not.toThrow();
});

test("a partial input status with full data is incomplete, and lists no missing periods", async () => {
  await writePrices(DATE, {
    periods: pricePeriods(
      48,
      (_node, p) => p,
      () => ({ inputs_complete: false }),
    ),
  });
  const completeness = completenessView([
    ["dispatch_energy_prices", DATE, "partial"],
  ]);
  const day = await buildSiteDay({ goldDir, date: DATE, completeness });
  expect(day.prices.state).toBe("incomplete");
  expect(day.prices.missing_periods).toEqual([]);
});

test("a partial input in _completeness makes its section incomplete even when gold says complete", async () => {
  await writeGeneration(DATE, {
    period: [
      {
        trading_period: 1,
        fuel_category: "hydro",
        island: "NI",
        megawatt_hours: 1,
      },
    ],
    day: [
      {
        fuel_category: "hydro",
        island: "NI",
        megawatt_hours: 1,
        average_megawatts: 0.1,
      },
    ],
  });
  const completeness = completenessView([["generation_md", DATE, "partial"]]);
  const day = await buildSiteDay({ goldDir, date: DATE, completeness });
  expect(day.generation.state).toBe("incomplete");
  expect(day.datasets.generation_md?.status).toBe("partial");
  expect(day.complete).toBe(false);
});

test("nodes and spreads follow the reference order, and the distribution keeps period order", async () => {
  await writePrices(DATE, {
    periods: [
      {
        trading_period: 1,
        point_of_connection: "BEN2201",
        price: 40,
        has_proxy_price: false,
      },
      {
        trading_period: 1,
        point_of_connection: "HAY2201",
        price: 50,
        has_proxy_price: false,
      },
      {
        trading_period: 1,
        point_of_connection: "OTA2201",
        price: 60,
        has_proxy_price: false,
      },
    ],
    spreads: [
      {
        trading_period: 1,
        from_point_of_connection: "HAY2201",
        to_point_of_connection: "BEN2201",
        from_price_region: "lower_north_island",
        to_price_region: "south_island",
        spread: 10,
      },
      {
        trading_period: 1,
        from_point_of_connection: "OTA2201",
        to_point_of_connection: "BEN2201",
        from_price_region: "upper_north_island",
        to_price_region: "south_island",
        spread: 20,
      },
      {
        trading_period: 1,
        from_point_of_connection: "OTA2201",
        to_point_of_connection: "HAY2201",
        from_price_region: "upper_north_island",
        to_price_region: "lower_north_island",
        spread: 10,
      },
    ],
    distribution: [
      {
        trading_period: 2,
        poc_count: 2,
        min_price: 5,
        p05_price: 5,
        p25_price: 5,
        median_price: 6,
        p75_price: 6,
        p95_price: 6,
        max_price: 6,
      },
      {
        trading_period: 1,
        poc_count: 3,
        min_price: 40,
        p05_price: 40,
        p25_price: 45,
        median_price: 50,
        p75_price: 55,
        p95_price: 60,
        max_price: 60,
      },
    ],
  });
  const day = await buildSiteDay({
    goldDir,
    date: DATE,
    completeness: completenessView(),
  });
  expect(day.prices.nodes.map((n) => n.point_of_connection)).toEqual([
    "OTA2201",
    "HAY2201",
    "BEN2201",
  ]);
  expect(day.prices.nodes.map((n) => n.price[0])).toEqual([60, 50, 40]);
  expect(day.prices.spreads.map((s) => `${s.from}-${s.to}`)).toEqual([
    "OTA2201-HAY2201",
    "HAY2201-BEN2201",
    "OTA2201-BEN2201",
  ]);
  expect(day.prices.spreads.map((s) => s.spread[0])).toEqual([10, 10, 20]);
  expect(day.prices.distribution.poc_count.slice(0, 2)).toEqual([3, 2]);
  expect(day.prices.distribution.median.slice(0, 2)).toEqual([50, 6]);
});

test("nodal_map plots only POCs with coordinates and lists the rest unlocated", async () => {
  const silverDir = join(root, "silver");
  await writeGold(
    "nodal_price_periods",
    DATE,
    {
      point_of_connection: "VARCHAR",
      trading_period: "INTEGER",
      price: "DOUBLE",
      has_proxy_price: "BOOLEAN",
    },
    [
      {
        point_of_connection: "ALB0331",
        trading_period: 1,
        price: 90.126,
        has_proxy_price: false,
      },
      {
        point_of_connection: "HAY2201",
        trading_period: 1,
        price: 50,
        has_proxy_price: true,
      },
    ],
  );
  const entityPath = join(
    silverDir,
    "entity_points_of_connection",
    `trading_date=${DATE}`,
    "data.parquet",
  );
  await mkdir(dirname(entityPath), { recursive: true });
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run(
      `COPY (SELECT 'ALB0331' AS poc_id, -36.739 AS latitude, 174.69 AS longitude,
         'NI' AS island) TO ${lit(entityPath)} (FORMAT parquet)`,
    );
  } finally {
    connection.closeSync();
  }

  const day = await buildSiteDay({
    goldDir,
    silverDir,
    date: DATE,
    completeness: completenessView(),
  });
  assertSiteDay(day);
  expect(day.nodal_map?.state).toBe("complete");
  expect(day.nodal_map?.pocs).toEqual([
    {
      point_of_connection: "ALB0331",
      latitude: -36.739,
      longitude: 174.69,
      island: "NI",
      price: [90.13, ...Array.from({ length: 47 }, () => null)],
      proxy_periods: [],
    },
  ]);
  expect(day.nodal_map?.unlocated).toEqual([
    {
      point_of_connection: "HAY2201",
      island: null,
      price: [50, ...Array.from({ length: 47 }, () => null)],
      proxy_periods: [1],
    },
  ]);
});

test("nodal_map is missing when gold has no nodal_price_periods partition", async () => {
  const day = await buildSiteDay({
    goldDir,
    date: DATE,
    completeness: completenessView(),
  });
  expect(day.nodal_map).toMatchObject({
    state: "missing",
    pocs: [],
    unlocated: [],
    analysis_version: null,
  });
});

test("the index records which days have a complete sankey", async () => {
  await writePrices(DATE, { periods: pricePeriods(48, (_n, p) => p) });
  await writeSankeyGold(DATE, {
    period: [{ trading_period: 1, island: "NI", residual_mwh: 1 }],
    day: [
      {
        island: "NI",
        generation_mwh: 1,
        hvdc_import_mwh: 0,
        load_mwh: 1,
        residual_mwh: 0,
        residual_pct_of_load: 0,
      },
    ],
    hvdcDay: [{ losses_mwh: 0 }],
  });
  const summary = await exportSite({
    goldDir,
    completeness: completenessView(),
    registry: datasets,
  });
  expect(summary.failed).toEqual([]);
  const index = await readIndex();
  assertSiteIndex(index);
  expect(index.days[0]?.sections.sankey).toBe("complete");
  expect(index.latest_complete_sections.sankey).toBe(DATE);
});

test("the index records which days have complete reserves", async () => {
  await writeReservesGold(DATE, {
    period: [
      {
        trading_period: 1,
        reserve_class: "FIR",
        island: "NI",
        dollars_per_megawatt_hour: 1,
      },
    ],
    day: [
      {
        reserve_class: "FIR",
        island: "NI",
        mean_price: 1,
        min_price: 1,
        max_price: 1,
        periods_present: 48,
        periods_expected: 48,
        rows_present: 10,
      },
    ],
  });
  const summary = await exportSite({
    goldDir,
    completeness: completenessView(),
    registry: datasets,
  });
  expect(summary.failed).toEqual([]);
  const index = await readIndex();
  assertSiteIndex(index);
  expect(index.days[0]?.sections.reserves).toBe("complete");
  expect(index.latest_complete_sections.reserves).toBe(DATE);
});

test("the index gives the latest complete date for each dataset, and null when there is none", async () => {
  await writePrices(DATE, { periods: pricePeriods(48, (_n, p) => p) });
  await writePrices("2026-11-17", { periods: pricePeriods(48, (_n, p) => p) });
  const completeness = completenessView([
    ["generation_md", "2026-11-17", "complete"],
    ["generation_md", DATE, "partial"],
    ["dispatch_energy_prices", "2026-11-17", "complete"],
    ["dispatch_energy_prices", DATE, "complete"],
  ]);
  const summary = await exportSite({
    goldDir,
    completeness,
    registry: datasets,
  });
  expect(summary.failed).toEqual([]);
  const index = await readIndex();
  assertSiteIndex(index);
  expect(index.days.map((d) => d.date)).toEqual(["2026-11-17", DATE]);
  expect(index.latest_complete.generation_md).toBe("2026-11-17");
  expect(index.latest_complete.dispatch_energy_prices).toBe(DATE);
  expect(index.latest_complete.cleared_offers).toBeNull();
  expect(index.days.map((d) => d.sections.sankey)).toEqual([
    "missing",
    "missing",
  ]);
  expect(index.latest_complete_sections.sankey).toBeNull();
  expect(index.days.map((d) => d.sections.reserves)).toEqual([
    "missing",
    "missing",
  ]);
  expect(index.latest_complete_sections.reserves).toBeNull();
});

test("a range never removes a day from the index, and a changed day outside the range is not rebuilt", async () => {
  await writePrices(DATE, { periods: pricePeriods(48, (_n, p) => p) });
  await writePrices("2026-11-17", { periods: pricePeriods(48, (_n, p) => p) });
  const completeness = completenessView();
  const first = await exportSite({ goldDir, completeness, registry: [] });
  expect(first.published).toBe(2);
  const dayOf17 = join(goldDir, "site", "days", "2026-11-17.json");
  const before = (await stat(dayOf17)).mtimeMs;

  // Forced for one date: only that date is rewritten, and both stay in the index.
  const forced = await exportSite({
    goldDir,
    completeness,
    registry: [],
    range: { from: DATE, to: DATE },
    force: true,
  });
  expect(forced).toMatchObject({ published: 1, upToDate: 1 });
  expect((await stat(dayOf17)).mtimeMs).toBe(before);
  expect((await readIndex()).days.map((d: { date: string }) => d.date)).toEqual(
    ["2026-11-17", DATE],
  );

  // A gold input of 17 Nov changes, but the range excludes it: nothing is rebuilt.
  await writePrices("2026-11-17", {
    periods: pricePeriods(
      48,
      (_n, p) => p,
      () => ({
        inputs_sha256: "sha-changed",
      }),
    ),
  });
  const outside = await exportSite({
    goldDir,
    completeness,
    registry: [],
    range: { from: DATE, to: DATE },
  });
  // 17 Nov is kept, because it is outside the range. 18 Nov is up to date.
  expect(outside).toMatchObject({ published: 0, upToDate: 2 });
  expect((await readIndex()).days.map((d: { date: string }) => d.date)).toEqual(
    ["2026-11-17", DATE],
  );
});

test("the worst realistic day stays under 40 KB", async () => {
  // 50 periods (2026-04-05), 9 fuels x 3 islands, 3 nodes, a full distribution.
  const fuels = [
    "hydro",
    "geothermal",
    "wind",
    "gas",
    "coal_gas",
    "solar",
    "battery",
    "other",
    "unmapped",
  ];
  const islands: Array<string | null> = ["NI", "SI", null];
  const date = "2026-04-05";
  const period: Row[] = [];
  const day: Row[] = [];
  for (const fuel of fuels)
    for (const island of islands) {
      day.push({
        fuel_category: fuel,
        island,
        megawatt_hours: 1234.5678,
        average_megawatts: 12.3456,
      });
      for (let p = 1; p <= 50; p++)
        period.push({
          trading_period: p,
          fuel_category: fuel,
          island,
          megawatt_hours: 12.34567,
          average_megawatts: 24.6913,
        });
    }
  await writeGeneration(date, { period, day });
  await writePrices(date, {
    periods: pricePeriods(50, (_n, p) => 50.123 + p),
    daily: NODES.map((poc) => ({
      point_of_connection: poc,
      mean_price: 55.5,
      min_price: 1,
      max_price: 99,
      periods_present: 50,
      periods_expected: 50,
      rows_present: 300,
    })),
    spreads: spreadRows(50),
    distribution: Array.from({ length: 50 }, (_, i) => ({
      trading_period: i + 1,
      poc_count: 3,
      min_price: 1,
      p05_price: 2,
      p25_price: 3,
      median_price: 4,
      p75_price: 5,
      p95_price: 6,
      max_price: 7,
    })),
  });
  const built = await buildSiteDay({
    goldDir,
    date,
    completeness: completenessView(),
  });
  assertSiteDay(built);
  expect(JSON.stringify(built).length).toBeLessThan(40_000);
});

test("the runner exports on each run, rebuilds only the days that changed, and honours --dataset", async () => {
  const bronzeDir = join(root, "bronze");
  const silverDir = join(root, "silver");
  const run = (options: Partial<Parameters<typeof runPublish>[0]> = {}) =>
    runPublish({
      bronzeDir,
      silverDir,
      goldDir,
      registry: [],
      ...options,
    });
  const summaryOf = (summaries: Awaited<ReturnType<typeof run>>) =>
    summaries.find((s) => s.id === "site_days");

  await writePrices("2026-11-17", { periods: pricePeriods(48, (_n, p) => p) });
  await writePrices(DATE, { periods: pricePeriods(48, (_n, p) => p) });
  expect(summaryOf(await run())).toMatchObject({ published: 2, upToDate: 0 });
  const dayOf17 = join(goldDir, "site", "days", "2026-11-17.json");
  const mtime = (await stat(dayOf17)).mtimeMs;

  // Nothing changed, so nothing is written.
  expect(summaryOf(await run())).toMatchObject({ published: 0, upToDate: 2 });
  expect((await stat(dayOf17)).mtimeMs).toBe(mtime);

  // A gold input of 18 Nov changes: only that day is rebuilt.
  await writePrices(DATE, {
    periods: pricePeriods(
      48,
      (_n, p) => p,
      () => ({ inputs_sha256: "sha-2" }),
    ),
  });
  expect(summaryOf(await run())).toMatchObject({ published: 1, upToDate: 1 });

  // Only the status of an input changes, with the same gold: that day is rebuilt.
  const row: CompletenessRow = {
    dataset: "dispatch_energy_prices",
    tradingDate: DATE,
    status: "partial",
    expectedPeriodCount: 48,
    actualPeriodCount: 47,
    missingPeriods: [48],
    bronzeSha256s: [],
    sourcePublishedAt: null,
    processedAt: "2026-11-20T00:00:00.000Z",
    errors: [],
  };
  await saveCompleteness(
    silverDir,
    new Map([[completenessKey(row.dataset, row.tradingDate), row]]),
  );
  expect(summaryOf(await run())).toMatchObject({ published: 1, upToDate: 1 });

  // A run for another dataset does not export. A run for the export alone does.
  expect(await run({ only: ["gold_prices"] })).toEqual([]);
  expect(await run({ only: ["site_days"] })).toEqual([
    expect.objectContaining({ id: "site_days", upToDate: 2 }),
  ]);
});

/** Store `csv` in bronze the way the collector does, and add its manifest record. */
async function archive(
  bronzeDir: string,
  dataset: string,
  fileName: string,
  dates: string[],
  csv: string,
) {
  const sha256 = createHash("sha256").update(csv).digest("hex");
  const path = `${dataset}/${sha256}/${fileName}`;
  await mkdir(join(bronzeDir, dataset, sha256), { recursive: true });
  await writeFile(join(bronzeDir, path), csv);
  await appendFile(
    join(bronzeDir, "manifest.jsonl"),
    `${JSON.stringify({
      dataset,
      status: "new",
      retrieved_at: "2026-11-20T00:00:01.000Z",
      sha256,
      path,
      trading_dates: dates,
    })}\n`,
  );
}

/**
 * A dispatch energy prices file for one date, with the three reference nodes. Each period has one
 * row, published 10 seconds after the period starts. OTA is 80 + period, HAY 70 + period and BEN
 * 60 + period.
 */
function syntheticDispatch(date: string): string {
  const start =
    Temporal.PlainDate.from(date).toZonedDateTime("Pacific/Auckland");
  const rows = Array.from({ length: periodsInTradingDate(date) }, (_, i) => {
    const period = i + 1;
    const published = start
      .add({ minutes: i * 30, seconds: 10 })
      .toString({ fractionalSecondDigits: 3, timeZoneName: "never" });
    return [
      [date, period, published, "OTA2201", "NI", "N", 80 + period],
      [date, period, published, "HAY2201", "NI", "N", 70 + period],
      [date, period, published, "BEN2201", "SI", "N", 60 + period],
      [date, period, published, "ALB0331", "NI", "N", 82 + period],
      [date, period, published, "AKL0331", "NI", "N", 95 + period],
      [date, period, published, "ABY0111", "SI", "N", 40 + period],
    ].map((row) => row.join(","));
  }).flat();
  return [
    "TradingDate,TradingPeriod,PublishDateTime,PointOfConnection,Island,IsProxyPriceFlag,DollarsPerMegawattHour",
    ...rows,
  ].join("\n");
}

const exporterFixtures = join(import.meta.dirname, "fixtures");
const FIXTURE_DAY = join(exporterFixtures, "days", "2026-09-27.json");
const FIXTURE_INDEX = join(exporterFixtures, "index.json");

test("the exporter lock sample matches end to end, on trimmed generation and synthetic prices", {
  timeout: 60_000,
}, async () => {
  const bronzeDir = join(root, "bronze");
  const silverDir = join(root, "silver");
  const fixtureDir = join(import.meta.dirname, "..", "silver", "fixtures");
  const generation = await readFile(
    join(fixtureDir, "generation-md", "202609_Generation_MD.csv"),
    "utf8",
  );
  const nsp = await readFile(
    join(
      fixtureDir,
      "network-supply-points",
      "20260106_NetworkSupplyPointsTable.csv",
    ),
    "utf8",
  );
  await archive(
    bronzeDir,
    "generation_md",
    "202609_Generation_MD.csv",
    ["2026-09-27"],
    generation,
  );
  await archive(
    bronzeDir,
    "network_supply_points",
    "20260106_NetworkSupplyPointsTable.csv",
    ["2026-01-06"],
    nsp,
  );
  await archive(
    bronzeDir,
    "dispatch_energy_prices",
    "20260927_DispatchEnergyPrices.csv",
    ["2026-09-27"],
    syntheticDispatch("2026-09-27"),
  );

  // No range: a range would drop the 2026-01-06 network snapshot.
  await runPublish({ bronzeDir, silverDir, goldDir });
  const day = await readFile(
    join(goldDir, "site", "days", "2026-09-27.json"),
    "utf8",
  );
  const index = await readFile(join(goldDir, "site", "index.json"), "utf8");

  if (process.env.UPDATE_SITE_FIXTURES) {
    await mkdir(join(exporterFixtures, "days"), { recursive: true });
    await writeFile(FIXTURE_DAY, day);
    await writeFile(FIXTURE_INDEX, index);
  }
  expect(day).toBe(await readFile(FIXTURE_DAY, "utf8"));
  expect(index).toBe(await readFile(FIXTURE_INDEX, "utf8"));

  // Hand-calculated anchors.
  const built: unknown = JSON.parse(day);
  assertSiteDay(built);
  expect(built.periods).toHaveLength(46);
  const [ota, hay] = built.prices.nodes;
  expect(ota?.price[0]).toBe(81);
  expect(hay?.price[0]).toBe(71);
  const otaBen = built.prices.spreads.find(
    (s) => s.from === "OTA2201" && s.to === "BEN2201",
  );
  expect(otaBen?.spread.every((value) => value === 20)).toBe(true);
  // 2026-09-27 has generation and prices, but no HVDC_Flows: the month-lag day.
  expect(built.sankey).toMatchObject({
    state: "missing",
    islands: [],
    link_losses_megawatt_hours: null,
    inputs_complete: null,
  });
  expect(built.episodes).toMatchObject({
    state: "missing",
    items: [],
  });
  expect(built.reserves).toMatchObject({
    state: "missing",
    classes: [],
  });
  const parsedIndex: unknown = JSON.parse(index);
  assertSiteIndex(parsedIndex);
  expect(parsedIndex.days[0]?.sections.sankey).toBe("missing");
  expect(parsedIndex.latest_complete_sections.sankey).toBeNull();
  expect(parsedIndex.days[0]?.sections.episodes).toBe("missing");
  expect(parsedIndex.latest_complete_sections.episodes).toBeNull();
  expect(parsedIndex.days[0]?.sections.reserves).toBe("missing");
  expect(parsedIndex.latest_complete_sections.reserves).toBeNull();
  expect(
    built.nodal_map?.pocs.map((p) => p.point_of_connection).sort(),
  ).toEqual(["ABY0111", "AKL0331", "ALB0331"]);
  expect(
    built.nodal_map?.unlocated.map((p) => p.point_of_connection).sort(),
  ).toEqual(["BEN2201", "HAY2201", "OTA2201"]);
  expect(built.nodal_map?.pocs[0]?.price).toHaveLength(46);
  expect(parsedIndex.days[0]?.sections.nodal_map).toBe("complete");
});

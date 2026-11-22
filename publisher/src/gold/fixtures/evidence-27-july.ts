import { periodsInTradingDate, periodToUtc } from "../../trading-time.ts";
import { goldPartitionPath } from "../common.ts";
import { CORROBORATION_RULES } from "../episodes.ts";
import { episodeIdOf } from "../episodes-group.ts";
import { TABLES as PRICE_ANOMALY_TABLES } from "../price-anomaly.ts";
import { TABLES as PRICE_SEPARATION_TABLES } from "../price-separation.ts";
import { TABLES as RESERVE_PRICE_ANOMALY_TABLES } from "../reserve-price-anomaly.ts";
import { writeParquet } from "./parquet.ts";

/**
 * A synthetic lake for the evidence package tests. The numbers are the ones of the #21
 * write-up for Monday 27 July 2026 (gold figures only). Nothing is read from a real lake. Where
 * the write-up has no number for a period, the fixture uses a plain default.
 */

export const DAY = "2026-07-27";
export const OBSERVATION_ID = "obs-reserve-sir-ni-0727";
/** Sorts before `OBSERVATION_ID`, so the SIR observation is not at index 0. */
export const PRICE_OBSERVATION_ID = "obs-price-high-ota-0727";
export const EPISODE_ID = episodeIdOf(OBSERVATION_ID);

const STAMP_COLUMNS = {
  analysis_version: "INTEGER",
  inputs_sha256: "VARCHAR",
  inputs_complete: "BOOLEAN",
};
const stamp = (complete = true) => ({
  analysis_version: 1,
  inputs_sha256: "fixture",
  inputs_complete: complete,
});

/** Values by period. A period that is not listed takes the default of its series. */
type ByPeriod = Record<number, number>;

const PRICE: Record<string, ByPeriod> = {
  OTA2201: {
    16: 1228.29,
    34: 156.25,
    35: 141.04,
    36: 3296.04,
    37: 1311.29,
    38: 1038.33,
    39: 1116.46,
    40: 215.57,
  },
  HAY2201: {
    16: 1066.2,
    34: 130.14,
    35: 119.64,
    36: 2853.43,
    37: 1133.28,
    38: 892.53,
    39: 963.99,
    40: 183.95,
  },
  BEN2201: {
    16: 145.23,
    34: 22.36,
    35: 54.09,
    36: 571.46,
    37: 258.1,
    38: 83.41,
    39: 94.7,
    40: 101,
  },
};
const PRICE_DEFAULT: Record<string, number> = {
  OTA2201: 150,
  HAY2201: 130,
  BEN2201: 40,
};
/** The highest publish of the period. Silver gives OTA2201 20,459.18 and BEN2201 9,793.96 at 17:50:26. */
const PRICE_MAX: Record<string, ByPeriod> = {
  OTA2201: { 36: 20459.18 },
  HAY2201: { 36: 19980.5 },
  BEN2201: { 36: 9793.96 },
};

/** [price, max price] by reserve class and island. */
const RESERVE: Record<
  string,
  Record<string, Record<number, [number, number]>>
> = {
  SIR: {
    NI: {
      35: [49.78, 81.14],
      36: [2154.45, 6500],
      37: [835.13, 4375.05],
      38: [787.79, 4401.5],
      39: [851.46, 4424.61],
    },
    SI: {},
  },
  FIR: {
    NI: {
      35: [7, 14],
      36: [49.93, 99.86],
      37: [5, 10],
      38: [10, 20],
      39: [4.97, 9.94],
    },
    SI: {},
  },
};

/** Average MW by fuel, island and period (write-up Q10d). */
const FUEL: Array<{
  fuel: string;
  island: string;
  fallback: number;
  mw: ByPeriod;
}> = [
  {
    fuel: "coal_gas",
    island: "NI",
    fallback: 300,
    mw: { 32: 151.9, 34: 206.4, 35: 255.9, 36: 295.5, 37: 353.2 },
  },
  {
    fuel: "gas",
    island: "NI",
    fallback: 400,
    mw: { 32: 110.4, 34: 204.5, 35: 309.5, 36: 451.2, 37: 460.4 },
  },
  {
    fuel: "hydro",
    island: "NI",
    fallback: 1500,
    mw: { 32: 1026.6, 34: 1224.1, 35: 1412, 36: 1571.9, 37: 1580.3 },
  },
  {
    fuel: "hydro",
    island: "SI",
    fallback: 3200,
    mw: { 32: 2935.8, 34: 3132.1, 35: 3208.5, 36: 3207.8, 37: 3206.2 },
  },
  {
    fuel: "wind",
    island: "NI",
    fallback: 60,
    mw: { 32: 59.3, 34: 49.9, 35: 46.8, 36: 69.3, 37: 93.7 },
  },
  { fuel: "wind", island: "SI", fallback: 80, mw: { 36: 80.7 } },
  { fuel: "battery", island: "NI", fallback: 0, mw: { 36: 40.6 } },
  { fuel: "other", island: "NI", fallback: 0, mw: { 36: 7.8, 37: 35.4 } },
];

/** Plants at period 36 (write-up Q11e). Five big plants sit above Huntly, so the top ten stop at P40. */
const PLANTS: Array<{
  id: string;
  name: string;
  fuel: string;
  island: string;
  fallback: number;
  mw: ByPeriod;
}> = [
  {
    id: "MAN/manapouri",
    name: "manapouri",
    fuel: "hydro",
    island: "SI",
    fallback: 700,
    mw: {},
  },
  {
    id: "CYD/clyde",
    name: "clyde",
    fuel: "hydro",
    island: "SI",
    fallback: 420,
    mw: {},
  },
  {
    id: "WTK/waitaki",
    name: "waitaki",
    fuel: "hydro",
    island: "SI",
    fallback: 380,
    mw: {},
  },
  {
    id: "WRK/wairakei",
    name: "wairakei",
    fuel: "geothermal",
    island: "NI",
    fallback: 330,
    mw: {},
  },
  {
    id: "OHK/ohakuri",
    name: "ohakuri",
    fuel: "hydro",
    island: "NI",
    fallback: 310,
    mw: {},
  },
  {
    id: "HLY/huntly_1_4",
    name: "huntly_1_4",
    fuel: "coal_gas",
    island: "NI",
    fallback: 300,
    mw: { 32: 151.9, 34: 206.4, 35: 255.9, 36: 295.5, 37: 353.2 },
  },
  {
    id: "SFD/stratford",
    name: "stratford",
    fuel: "gas",
    island: "NI",
    fallback: 170,
    mw: { 36: 172.4 },
  },
  {
    id: "JRD/junctionroad",
    name: "junction_road",
    fuel: "gas",
    island: "NI",
    fallback: 90,
    mw: { 36: 90.3 },
  },
  {
    id: "MKE/mckee",
    name: "mckee",
    fuel: "gas",
    island: "NI",
    fallback: 80,
    mw: { 36: 83.8 },
  },
  {
    id: "HLY/huntly_p40",
    name: "huntly_p40",
    fuel: "gas",
    island: "NI",
    fallback: 45,
    mw: { 34: 0, 35: 40.4, 36: 45.9 },
  },
  {
    id: "RKA/ruakaka",
    name: "ruakaka",
    fuel: "battery",
    island: "NI",
    fallback: 0,
    mw: { 36: 40.6 },
  },
  {
    id: "WHI/whirinaki",
    name: "whirinaki",
    fuel: "other",
    island: "NI",
    fallback: 0,
    mw: { 35: 0, 36: 7.8, 37: 35.4 },
  },
  {
    id: "SFD/tcc",
    name: "taranaki_cc",
    fuel: "gas",
    island: "NI",
    fallback: 5,
    mw: { 36: 8.2 },
  },
];

const HVDC_MW: ByPeriod = { 34: 1098, 36: 966.4 };
const HVDC_DEFAULT = 1000;
/** National modelled load in MW (write-up Q12). The North Island share is a fixture choice. */
const LOAD_NATIONAL: ByPeriod = { 16: 7098.8, 36: 6879.7, 37: 6954 };
const LOAD_DEFAULT = 6800;
const NI_LOAD_SHARE = 0.64;

const DAY_FUEL_MWH: Array<[string, string, number]> = [
  ["hydro", "NI", 40000],
  ["hydro", "SI", 56683.5],
  ["geothermal", "NI", 30192.5],
  ["gas", "NI", 4599.9],
  ["wind", "NI", 2476.2],
  ["wind", "SI", 2000],
  ["coal_gas", "NI", 4117.8],
  ["solar", "NI", 739.5],
  ["other", "NI", 321.5],
  ["battery", "NI", 165.6],
];

export interface EvidenceLakeOptions {
  goldDir: string;
  date?: string;
  /** Episode periods. The default is a grouped episode, periods 35 to 41. */
  episode?: { start: number; end: number };
  /** Gold tables to leave out. */
  omit?: readonly string[];
  /** Gold tables to write with `inputs_complete = false`. */
  incomplete?: readonly string[];
  /** Gold tables to write with zero rows. The partition is present. */
  empty?: readonly string[];
  /** Write no episodes row, so the episode partition is empty. */
  noEpisode?: boolean;
}

/** Write the gold side of the lake. */
export async function writeEvidenceGold(options: EvidenceLakeOptions) {
  const { goldDir, date = DAY, episode = { start: 35, end: 41 } } = options;
  const omit = new Set(options.omit ?? []);
  const incomplete = new Set(options.incomplete ?? []);
  const empty = new Set(options.empty ?? []);
  const count = periodsInTradingDate(date);
  const all = Array.from({ length: count }, (_, i) => i + 1);
  const span = (period: number) => {
    const { eventStartUtc, eventEndUtc } = periodToUtc(date, period);
    return {
      event_start_utc: eventStartUtc.toString(),
      event_end_utc: eventEndUtc.toString(),
    };
  };
  const write = async (
    table: string,
    columns: Record<string, string>,
    rows: object[],
  ) => {
    if (omit.has(table)) return;
    const body = empty.has(table) ? [] : rows;
    await writeParquet(
      goldPartitionPath(goldDir, table, date),
      { ...columns, ...STAMP_COLUMNS },
      body.map((row) => ({ ...row, ...stamp(!incomplete.has(table)) })),
    );
  };
  const TS = "TIMESTAMPTZ";
  const periodColumns = {
    trading_date: "DATE",
    trading_period: "INTEGER",
    event_start_utc: TS,
    event_end_utc: TS,
  };
  const base = (period: number) => ({
    trading_date: date,
    trading_period: period,
    ...span(period),
  });
  const pick = (series: ByPeriod, period: number, fallback: number) =>
    series[period] ?? fallback;

  // Episode spanning the SIR run (35-40) and a price run that extends it to 41. The price
  // observation id sorts first, so the SIR observation is not at index 0.
  const sirEnd = Math.min(episode.end, episode.start + 5);
  const priceStart = Math.min(episode.end, episode.start + 1);
  const start = periodToUtc(date, episode.start).eventStartUtc.toString();
  const end = periodToUtc(date, episode.end).eventEndUtc.toString();
  const sirEndUtc = periodToUtc(date, sirEnd).eventEndUtc.toString();
  const priceStartUtc = periodToUtc(date, priceStart).eventStartUtc.toString();
  await write(
    "episodes",
    {
      episode_id: "VARCHAR",
      seed_observation_id: "VARCHAR",
      trading_date: "DATE",
      start_trading_period: "INTEGER",
      end_trading_period: "INTEGER",
      period_count: "INTEGER",
      event_start_utc: TS,
      event_end_utc: TS,
      member_observation_ids: "VARCHAR[]",
      member_count: "INTEGER",
      observation_types: "VARCHAR[]",
      subjects: "VARCHAR",
      islands: "VARCHAR[]",
      plant_ids: "VARCHAR[]",
      severity: "DOUBLE",
      grouping_reason: "VARCHAR",
    },
    options.noEpisode
      ? []
      : [
          {
            episode_id: EPISODE_ID,
            seed_observation_id: OBSERVATION_ID,
            trading_date: date,
            start_trading_period: episode.start,
            end_trading_period: episode.end,
            period_count: episode.end - episode.start + 1,
            event_start_utc: start,
            event_end_utc: end,
            member_observation_ids: [OBSERVATION_ID, PRICE_OBSERVATION_ID],
            member_count: 2,
            observation_types: ["price_high", "reserve_price_high"],
            subjects: "SIR|NI",
            islands: ["NI"],
            plant_ids: [],
            severity: 170.5,
            grouping_reason: "seed",
          },
        ],
  );
  const observationColumns = {
    observation_id: "VARCHAR",
    observation_type: "VARCHAR",
    trading_date: "DATE",
    start_trading_period: "INTEGER",
    end_trading_period: "INTEGER",
    event_start_utc: TS,
    event_end_utc: TS,
    subject_type: "VARCHAR",
    subject_id: "VARCHAR",
    island: "VARCHAR",
    plant_id: "VARCHAR",
    measured_value: "DOUBLE",
    severity: "DOUBLE",
  };
  await write(RESERVE_PRICE_ANOMALY_TABLES[1], observationColumns, [
    {
      observation_id: OBSERVATION_ID,
      observation_type: "reserve_price_high",
      trading_date: date,
      start_trading_period: episode.start,
      end_trading_period: sirEnd,
      event_start_utc: start,
      event_end_utc: sirEndUtc,
      subject_type: "reserve_class",
      subject_id: "SIR|NI",
      island: "NI",
      plant_id: null,
      measured_value: 2154.45,
      severity: 170.5,
    },
  ]);
  await write(PRICE_ANOMALY_TABLES[1], observationColumns, [
    {
      observation_id: PRICE_OBSERVATION_ID,
      observation_type: "price_high",
      trading_date: date,
      start_trading_period: priceStart,
      end_trading_period: episode.end,
      event_start_utc: priceStartUtc,
      event_end_utc: end,
      subject_type: "point_of_connection",
      subject_id: "OTA2201",
      island: "NI",
      plant_id: null,
      measured_value: 3296.04,
      severity: 29.2,
    },
  ]);
  await write(PRICE_SEPARATION_TABLES[1], observationColumns, []);

  // Corroborating observations (#180, #223). Three match the episode. The rest miss: the other
  // island, a run outside the episode, a hit with no island, or the wrong direction.
  const related = (
    id: string,
    type: string,
    subjectType: string,
    subjectId: string,
    island: string | null,
    periods: [number, number],
    plantId: string | null = null,
  ) => ({
    observation_id: id,
    observation_type: type,
    trading_date: date,
    start_trading_period: periods[0],
    end_trading_period: periods[1],
    event_start_utc: periodToUtc(date, periods[0]).eventStartUtc.toString(),
    event_end_utc: periodToUtc(date, periods[1]).eventEndUtc.toString(),
    subject_type: subjectType,
    subject_id: subjectId,
    island,
    plant_id: plantId,
    measured_value: 100,
    severity: 2,
  });
  const [fuelRule, demandRule, plantRule] = CORROBORATION_RULES;
  await write(fuelRule.table, observationColumns, [
    related(
      "obs-fuel-wind-ni",
      "generation_low",
      "fuel_category",
      "wind|NI",
      "NI",
      [38, 42],
    ),
    related(
      "obs-fuel-wind-si",
      "generation_low",
      "fuel_category",
      "wind|SI",
      "SI",
      [38, 42],
    ),
    related(
      "obs-fuel-coal-high",
      "generation_high",
      "fuel_category",
      "coal_gas|NI",
      "NI",
      [38, 42],
    ),
  ]);
  await write(demandRule.table, observationColumns, [
    related("obs-demand-ni", "demand_high", "island", "NI", "NI", [30, 35]),
    related(
      "obs-demand-ni-late",
      "demand_high",
      "island",
      "NI",
      "NI",
      [42, 44],
    ),
    related("obs-demand-nz", "demand_high", "island", "NZ", null, [35, 40]),
  ]);
  await write(plantRule.table, observationColumns, [
    related(
      "obs-plant-huntly-ni",
      "generation_low",
      "plant",
      "huntly_1_4",
      "NI",
      [38, 42],
      "huntly_1_4",
    ),
    related(
      "obs-plant-manapouri-si",
      "generation_low",
      "plant",
      "manapouri",
      "SI",
      [38, 42],
      "manapouri",
    ),
    related(
      "obs-plant-huntly-high",
      "generation_high",
      "plant",
      "huntly_1_4",
      "NI",
      [38, 42],
      "huntly_1_4",
    ),
  ]);

  // Prices and spreads.
  const nodes = Object.keys(PRICE);
  await write(
    "price_periods",
    {
      ...periodColumns,
      point_of_connection: "VARCHAR",
      price_region: "VARCHAR",
      price: "DOUBLE",
      min_price: "DOUBLE",
      max_price: "DOUBLE",
      rows_present: "INTEGER",
      has_proxy_price: "BOOLEAN",
    },
    nodes.flatMap((node) =>
      all.map((period) => {
        const price = pick(PRICE[node] ?? {}, period, PRICE_DEFAULT[node] ?? 0);
        return {
          ...base(period),
          point_of_connection: node,
          price_region: "region",
          price,
          min_price: price / 2,
          max_price: pick(PRICE_MAX[node] ?? {}, period, price * 1.1),
          rows_present: 6,
          has_proxy_price: false,
        };
      }),
    ),
  );
  const price = (node: string, period: number) =>
    pick(PRICE[node] ?? {}, period, PRICE_DEFAULT[node] ?? 0);
  await write(
    "price_spreads",
    {
      ...periodColumns,
      from_point_of_connection: "VARCHAR",
      to_point_of_connection: "VARCHAR",
      spread: "DOUBLE",
    },
    [
      ["OTA2201", "HAY2201"],
      ["HAY2201", "BEN2201"],
      ["OTA2201", "BEN2201"],
    ].flatMap(([a = "", b = ""]) =>
      all.map((period) => ({
        ...base(period),
        from_point_of_connection: a,
        to_point_of_connection: b,
        spread: price(a, period) - price(b, period),
      })),
    ),
  );
  await write(
    "price_daily_summary",
    {
      trading_date: "DATE",
      point_of_connection: "VARCHAR",
      mean_price: "DOUBLE",
      min_price: "DOUBLE",
      max_price: "DOUBLE",
    },
    [
      {
        trading_date: date,
        point_of_connection: "OTA2201",
        mean_price: 248.67,
        min_price: 1,
        max_price: 20459.18,
      },
      {
        trading_date: date,
        point_of_connection: "HAY2201",
        mean_price: 214.72,
        min_price: 1,
        max_price: 19980.5,
      },
      {
        trading_date: date,
        point_of_connection: "BEN2201",
        mean_price: 70.6,
        min_price: 1,
        max_price: 9793.96,
      },
    ],
  );
  await write(
    "price_distribution",
    {
      ...periodColumns,
      poc_count: "INTEGER",
      median_price: "DOUBLE",
      max_price: "DOUBLE",
    },
    all.map((period) => ({
      ...base(period),
      poc_count: 246,
      median_price: period === 36 ? 2918.21 : 100,
      max_price: period === 36 ? 3557.49 : 200,
    })),
  );

  // Reserves.
  await write(
    "reserve_by_class_island_period",
    {
      ...periodColumns,
      reserve_class: "VARCHAR",
      island: "VARCHAR",
      dollars_per_megawatt_hour: "DOUBLE",
      min_price: "DOUBLE",
      max_price: "DOUBLE",
    },
    Object.entries(RESERVE).flatMap(([reserveClass, islands]) =>
      Object.entries(islands).flatMap(([island, series]) =>
        all.map((period) => {
          const [mean, max] = series[period] ?? [0, 0];
          return {
            ...base(period),
            reserve_class: reserveClass,
            island,
            dollars_per_megawatt_hour: mean,
            min_price: 0,
            max_price: max,
          };
        }),
      ),
    ),
  );

  // Generation.
  await write(
    "generation_by_fuel_period",
    {
      ...periodColumns,
      fuel_category: "VARCHAR",
      island: "VARCHAR",
      average_megawatts: "DOUBLE",
    },
    FUEL.flatMap((item) =>
      all.map((period) => ({
        ...base(period),
        fuel_category: item.fuel,
        island: item.island,
        average_megawatts: pick(item.mw, period, item.fallback),
      })),
    ),
  );
  await write(
    "generation_by_plant_period",
    {
      ...periodColumns,
      plant_id: "VARCHAR",
      plant_name: "VARCHAR",
      fuel_category: "VARCHAR",
      island: "VARCHAR",
      average_megawatts: "DOUBLE",
    },
    PLANTS.flatMap((plant) =>
      all.map((period) => ({
        ...base(period),
        plant_id: plant.id,
        plant_name: plant.name,
        fuel_category: plant.fuel,
        island: plant.island,
        average_megawatts: pick(plant.mw, period, plant.fallback),
      })),
    ),
  );
  await write(
    "generation_by_fuel_day",
    {
      trading_date: "DATE",
      fuel_category: "VARCHAR",
      island: "VARCHAR",
      megawatt_hours: "DOUBLE",
      average_megawatts: "DOUBLE",
    },
    DAY_FUEL_MWH.map(([fuel, island, mwh]) => ({
      trading_date: date,
      fuel_category: fuel,
      island,
      megawatt_hours: mwh,
      average_megawatts: mwh / 24,
    })),
  );

  // HVDC, load and balance.
  const directionOf = (mw: number) =>
    mw > 0 ? "north" : mw < 0 ? "south" : "none";
  await write(
    "hvdc_transfer_period",
    { ...periodColumns, average_megawatts: "DOUBLE", direction: "VARCHAR" },
    all.map((period) => {
      const mw = pick(HVDC_MW, period, HVDC_DEFAULT);
      return {
        ...base(period),
        average_megawatts: mw,
        direction: directionOf(mw),
      };
    }),
  );
  await write(
    "hvdc_transfer_day",
    {
      trading_date: "DATE",
      north_island_received_mwh: "DOUBLE",
      average_megawatts: "DOUBLE",
      direction: "VARCHAR",
    },
    [
      {
        trading_date: date,
        north_island_received_mwh: 21493.034,
        average_megawatts: 21493.034 / 24,
        direction: "north",
      },
    ],
  );
  const loadMw = (island: string, period: number) => {
    const national = pick(LOAD_NATIONAL, period, LOAD_DEFAULT);
    return island === "NI"
      ? national * NI_LOAD_SHARE
      : national * (1 - NI_LOAD_SHARE);
  };
  await write(
    "grid_load_period",
    { ...periodColumns, island: "VARCHAR", load_mwh: "DOUBLE" },
    ["NI", "SI"].flatMap((island) =>
      all.map((period) => ({
        ...base(period),
        island,
        load_mwh: loadMw(island, period) / 2,
      })),
    ),
  );
  const RESIDUAL_MW: Record<string, number> = { NI: 23, SI: 42 };
  await write(
    "energy_balance_period",
    { ...periodColumns, island: "VARCHAR", residual_mwh: "DOUBLE" },
    ["NI", "SI"].flatMap((island) =>
      all.map((period) => ({
        ...base(period),
        island,
        residual_mwh: (RESIDUAL_MW[island] ?? 0) / 2,
      })),
    ),
  );
}

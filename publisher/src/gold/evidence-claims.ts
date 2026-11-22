import { ISLANDS } from "./common.ts";
import type {
  Claim,
  ClaimValue,
  DispatchPeak,
  EVIDENCE_CONFIG,
  EvidenceEpisode,
  EvidencePackage,
  Series,
} from "./evidence.ts";
import { REFERENCE_NODES, SPREAD_PAIRS } from "./prices.ts";

/**
 * The claim catalogue of the evidence package: one function for each family of claims. Each
 * reads one or two tables through the context, adds `confirmed` claims, and returns the series
 * that the package keeps beside them. Claim ids are stable names, such as `price.OTA2201.p36`.
 */

export type Row = Record<string, unknown>;

export interface ClaimInput {
  id: string;
  label: string;
  value: ClaimValue;
  unit: string;
  table: string;
  queryId: string;
  period?: number;
  subject?: string;
  dependsOn?: string[];
  note?: string;
  /** False adds a note: the source row has `inputs_complete = false`. */
  rowComplete?: boolean;
}

export interface ClaimContext {
  date: string;
  config: typeof EVIDENCE_CONFIG;
  episode: EvidenceEpisode;
  /** The window, from first to last period. */
  periods: number[];
  peak: number;
  /** The period where the thermal ramp starts. It is the peak when there is no room. */
  rampStart: number;
  /** The periods that get a claim for each series: the episode start and the peak. */
  claimPeriods: number[];
  claims: Claim[];
  query: (sql: string) => Promise<Row[]>;
  /** `read_parquet(...)` of a registered table. */
  from: (table: string) => string;
  present: (table: string) => boolean;
  claim: (input: ClaimInput) => void;
}

export const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

/** Local rounding. It removes floating-point noise and keeps four decimals. */
export const round = (value: number, places = 4): number => {
  const factor = 10 ** places;
  const rounded =
    (Math.round(Math.abs(value) * factor) / factor) * Math.sign(value);
  return rounded === 0 ? 0 : rounded;
};

const roundOrNull = (value: number | null) =>
  value === null ? null : round(value);

const inWindow = (c: ClaimContext) =>
  `trading_period BETWEEN ${c.periods[0]} AND ${c.periods[c.periods.length - 1]}`;

/** One value for each period of the window, null where the rows have none. */
const align = (c: ClaimContext, rows: Row[], key: string): Series => {
  const byPeriod = new Map(
    rows.map((row) => [Number(row.trading_period), num(row[key])]),
  );
  return c.periods.map((period) => roundOrNull(byPeriod.get(period) ?? null));
};

const rowAt = (rows: Row[], period: number) =>
  rows.find((row) => Number(row.trading_period) === period);

const claimFind = (c: ClaimContext, id: string) =>
  c.claims.find((claim) => claim.id === id);

/** The peak: the episode period with the highest price at a reference node. Ties take the first. */
export async function findPeak(
  query: ClaimContext["query"],
  priceTable: string | null,
  episode: EvidenceEpisode,
): Promise<number> {
  if (priceTable === null) return episode.start_trading_period;
  const [best] = await query(
    `SELECT trading_period FROM ${priceTable}
     WHERE price IS NOT NULL
       AND trading_period BETWEEN ${episode.start_trading_period} AND ${episode.end_trading_period}
     ORDER BY price DESC, trading_period LIMIT 1`,
  );
  return best === undefined
    ? episode.start_trading_period
    : Number(best.trading_period);
}

export async function priceClaims(
  c: ClaimContext,
): Promise<EvidencePackage["context"]["prices"]> {
  const rows = c.present("price_periods")
    ? await c.query(
        `SELECT trading_period, point_of_connection, price, max_price, inputs_complete
         FROM ${c.from("price_periods")} WHERE ${inWindow(c)}
         ORDER BY point_of_connection, trading_period`,
      )
    : [];
  const prices: EvidencePackage["context"]["prices"] = {};
  for (const node of REFERENCE_NODES) {
    const id = node.pointOfConnection;
    const own = rows.filter((row) => row.point_of_connection === id);
    prices[id] = {
      price: align(c, own, "price"),
      max_price: align(c, own, "max_price"),
    };
    for (const period of c.claimPeriods) {
      const row = rowAt(own, period);
      const price = num(row?.price);
      const maxPrice = num(row?.max_price);
      if (row === undefined || price === null || maxPrice === null) continue;
      const common = {
        table: "price_periods",
        queryId: "priceClaims",
        period,
        subject: id,
        rowComplete: Boolean(row.inputs_complete),
      };
      c.claim({
        ...common,
        id: `price.${id}.p${period}`,
        label: `Period price at ${id}, period ${period} (time-weighted mean of dispatch publishes)`,
        value: price,
        unit: "$/MWh",
      });
      c.claim({
        ...common,
        id: `price_max.${id}.p${period}`,
        label: `Highest dispatch publish at ${id} inside period ${period}`,
        value: maxPrice,
        unit: "$/MWh",
        note: "The period price is a mean. This is the highest single publish.",
      });
    }
  }
  return prices;
}

export async function spreadClaims(
  c: ClaimContext,
): Promise<Record<string, Series>> {
  const rows = c.present("price_spreads")
    ? await c.query(
        `SELECT trading_period, from_point_of_connection AS a, to_point_of_connection AS b,
           spread, inputs_complete
         FROM ${c.from("price_spreads")} WHERE ${inWindow(c)}
         ORDER BY a, b, trading_period`,
      )
    : [];
  const spreads: Record<string, Series> = {};
  for (const [a, b] of SPREAD_PAIRS) {
    const key = `${a}-${b}`;
    const own = rows.filter((row) => row.a === a && row.b === b);
    spreads[key] = align(c, own, "spread");
    for (const period of c.claimPeriods) {
      const row = rowAt(own, period);
      const spread = num(row?.spread);
      if (row === undefined || spread === null) continue;
      c.claim({
        id: `spread.${key}.p${period}`,
        label: `Price spread ${a} minus ${b}, period ${period}`,
        value: spread,
        unit: "$/MWh",
        table: "price_spreads",
        queryId: "spreadClaims",
        period,
        subject: key,
        rowComplete: Boolean(row.inputs_complete),
      });
    }
  }
  return spreads;
}

export async function reserveClaims(
  c: ClaimContext,
): Promise<EvidencePackage["context"]["reserves"]> {
  const rows = c.present("reserve_by_class_island_period")
    ? await c.query(
        `SELECT trading_period, reserve_class, island, dollars_per_megawatt_hour AS price,
           max_price, inputs_complete
         FROM ${c.from("reserve_by_class_island_period")} WHERE ${inWindow(c)}
         ORDER BY reserve_class, island, trading_period`,
      )
    : [];
  const reserves: EvidencePackage["context"]["reserves"] = {};
  for (const reserveClass of [
    ...new Set(rows.map((row) => String(row.reserve_class))),
  ].sort()) {
    const byIsland: Record<string, { price: Series; max_price: Series }> = {};
    reserves[reserveClass] = byIsland;
    for (const island of ISLANDS) {
      const own = rows.filter(
        (row) => row.reserve_class === reserveClass && row.island === island,
      );
      if (own.length === 0) continue;
      byIsland[island] = {
        price: align(c, own, "price"),
        max_price: align(c, own, "max_price"),
      };
      for (const period of c.claimPeriods) {
        const row = rowAt(own, period);
        const price = num(row?.price);
        const maxPrice = num(row?.max_price);
        if (row === undefined || price === null || maxPrice === null) continue;
        const common = {
          table: "reserve_by_class_island_period",
          queryId: "reserveClaims",
          period,
          subject: `${reserveClass}|${island}`,
          rowComplete: Boolean(row.inputs_complete),
        };
        c.claim({
          ...common,
          id: `reserve.${reserveClass}.${island}.p${period}`,
          label: `${reserveClass} reserve price, ${island}, period ${period}`,
          value: price,
          unit: "$/MWh",
        });
        c.claim({
          ...common,
          id: `reserve_max.${reserveClass}.${island}.p${period}`,
          label: `Highest ${reserveClass} reserve publish, ${island}, period ${period}`,
          value: maxPrice,
          unit: "$/MWh",
        });
      }
    }
  }
  return reserves;
}

/** Fuel claims at the peak, and at the ramp start for thermal fuel in the North Island. Then the top plants. */
export async function generationClaims(c: ClaimContext): Promise<{
  generation_by_fuel: EvidencePackage["context"]["generation_by_fuel"];
  generation_by_plant: EvidencePackage["context"]["generation_by_plant"];
}> {
  const fuelRows = c.present("generation_by_fuel_period")
    ? await c.query(
        `SELECT trading_period, fuel_category, coalesce(island, 'unmapped') AS island,
           average_megawatts, inputs_complete
         FROM ${c.from("generation_by_fuel_period")} WHERE ${inWindow(c)}
         ORDER BY fuel_category, island, trading_period`,
      )
    : [];
  const byFuel: Record<string, Series> = {};
  const thermal: readonly string[] = c.config.thermalFuels;
  for (const key of [
    ...new Set(fuelRows.map((row) => `${row.fuel_category}|${row.island}`)),
  ]) {
    const [fuel = "", island = ""] = key.split("|");
    const own = fuelRows.filter(
      (row) => `${row.fuel_category}|${row.island}` === key,
    );
    byFuel[key] = align(c, own, "average_megawatts");
    const periods = new Set([c.peak]);
    if (thermal.includes(fuel) && island === "NI") periods.add(c.rampStart);
    for (const period of [...periods].sort((a, b) => a - b)) {
      const row = rowAt(own, period);
      const mw = num(row?.average_megawatts);
      if (row === undefined || mw === null) continue;
      c.claim({
        id: `generation.fuel.${fuel}.${island}.p${period}`,
        label: `Average generation, ${fuel}, ${island}, period ${period}`,
        value: mw,
        unit: "MW",
        table: "generation_by_fuel_period",
        queryId: "generationClaims",
        period,
        subject: key,
        rowComplete: Boolean(row.inputs_complete),
      });
    }
  }

  const byPlant: EvidencePackage["context"]["generation_by_plant"] = {};
  if (c.present("generation_by_plant_period")) {
    const top = await c.query(
      `SELECT plant_id FROM ${c.from("generation_by_plant_period")}
       WHERE trading_period = ${c.peak} AND average_megawatts IS NOT NULL
       ORDER BY average_megawatts DESC, plant_id
       LIMIT ${c.config.topPlants}`,
    );
    const ids = top.map((row) => String(row.plant_id));
    const rows =
      ids.length === 0
        ? []
        : await c.query(
            `SELECT trading_period, plant_id, plant_name, fuel_category, island,
               average_megawatts, inputs_complete
             FROM ${c.from("generation_by_plant_period")}
             WHERE ${inWindow(c)} AND list_contains(${listSql(ids)}, plant_id)
             ORDER BY plant_id, trading_period`,
          );
    for (const id of ids) {
      const own = rows.filter((row) => row.plant_id === id);
      const head = own[0];
      byPlant[id] = {
        plant_name: String(head?.plant_name ?? id),
        fuel_category: String(head?.fuel_category ?? "unmapped"),
        island:
          head?.island === null || head?.island === undefined
            ? null
            : String(head.island),
        average_megawatts: align(c, own, "average_megawatts"),
      };
      const row = rowAt(own, c.peak);
      const mw = num(row?.average_megawatts);
      if (row === undefined || mw === null) continue;
      c.claim({
        id: `generation.plant.${id}.p${c.peak}`,
        label: `Average generation, plant ${id}, period ${c.peak}`,
        value: mw,
        unit: "MW",
        table: "generation_by_plant_period",
        queryId: "generationClaims",
        period: c.peak,
        subject: id,
        rowComplete: Boolean(row.inputs_complete),
      });
    }
  }
  return { generation_by_fuel: byFuel, generation_by_plant: byPlant };
}

const HVDC_NOTE =
  "A 30-minute metered average at Haywards. It is not an instantaneous peak.";

export async function hvdcClaims(
  c: ClaimContext,
): Promise<EvidencePackage["context"]["hvdc"]> {
  const rows = c.present("hvdc_transfer_period")
    ? await c.query(
        `SELECT trading_period, average_megawatts, direction, inputs_complete
         FROM ${c.from("hvdc_transfer_period")} WHERE ${inWindow(c)} ORDER BY trading_period`,
      )
    : [];
  const hvdc: EvidencePackage["context"]["hvdc"] = {
    average_megawatts: align(c, rows, "average_megawatts"),
    direction: c.periods.map((period) => {
      const row = rowAt(rows, period);
      return row === undefined || row.direction === null
        ? null
        : String(row.direction);
    }),
    note: HVDC_NOTE,
  };
  const peakRow = rowAt(rows, c.peak);
  const peakMw = num(peakRow?.average_megawatts);
  if (peakRow !== undefined && peakMw !== null) {
    const common = {
      table: "hvdc_transfer_period",
      queryId: "hvdcClaims",
      period: c.peak,
      subject: "HAY2201",
      rowComplete: Boolean(peakRow.inputs_complete),
      note: HVDC_NOTE,
    };
    c.claim({
      ...common,
      id: `hvdc.mw.p${c.peak}`,
      label: `HVDC transfer received in the North Island, period ${c.peak}`,
      value: peakMw,
      unit: "MW",
    });
    c.claim({
      ...common,
      id: `hvdc.direction.p${c.peak}`,
      label: `HVDC direction, period ${c.peak}`,
      value: String(peakRow.direction),
      unit: "direction",
    });
  }
  const values = rows
    .map((row) => ({
      period: Number(row.trading_period),
      mw: num(row.average_megawatts),
    }))
    .filter((item): item is { period: number; mw: number } => item.mw !== null);
  if (values.length > 0) {
    const top = values.reduce((best, item) =>
      item.mw > best.mw ? item : best,
    );
    c.claim({
      id: "hvdc.window_peak_mw",
      label: `Highest 30-minute HVDC transfer in the window (period ${top.period})`,
      value: top.mw,
      unit: "MW",
      table: "hvdc_transfer_period",
      queryId: "hvdcClaims",
      period: top.period,
      subject: "HAY2201",
      note: HVDC_NOTE,
    });
    c.claim({
      id: "hvdc.window_mean_mw",
      label: "Mean HVDC transfer over the window",
      value: values.reduce((sum, item) => sum + item.mw, 0) / values.length,
      unit: "MW",
      table: "hvdc_transfer_period",
      queryId: "hvdcClaims",
      subject: "HAY2201",
      note: HVDC_NOTE,
    });
  }
  return hvdc;
}

const LOAD_NOTE =
  "Real-time dispatch model load at grid exit points, not metered consumption.";
const RESIDUAL_NOTE =
  "Generation plus HVDC import minus modelled load. It is not the system operator residual.";

export async function loadClaims(c: ClaimContext): Promise<{
  load: EvidencePackage["context"]["load"];
  energy_balance_residual: EvidencePackage["context"]["energy_balance_residual"];
}> {
  const load: EvidencePackage["context"]["load"] = {
    modelled: true,
    megawatts: {},
  };
  const loadRows = c.present("grid_load_period")
    ? await c.query(
        `SELECT trading_period, island, load_mwh * 2 AS megawatts, inputs_complete
         FROM ${c.from("grid_load_period")} WHERE ${inWindow(c)} ORDER BY island, trading_period`,
      )
    : [];
  for (const island of ISLANDS) {
    const own = loadRows.filter((row) => row.island === island);
    if (own.length === 0) continue;
    load.megawatts[island] = align(c, own, "megawatts");
    const row = rowAt(own, c.peak);
    const mw = num(row?.megawatts);
    if (row === undefined || mw === null) continue;
    c.claim({
      id: `load.${island}.p${c.peak}`,
      label: `Modelled load, ${island}, period ${c.peak}`,
      value: mw,
      unit: "MW",
      table: "grid_load_period",
      queryId: "loadClaims",
      period: c.peak,
      subject: island,
      rowComplete: Boolean(row.inputs_complete),
      note: LOAD_NOTE,
    });
  }
  const ni = claimFind(c, `load.NI.p${c.peak}`);
  const si = claimFind(c, `load.SI.p${c.peak}`);
  if (ni !== undefined && si !== undefined)
    c.claim({
      id: `load.national.p${c.peak}`,
      label: `Modelled load, both islands, period ${c.peak}`,
      value: Number(ni.value) + Number(si.value),
      unit: "MW",
      table: "grid_load_period",
      queryId: "loadClaims",
      period: c.peak,
      subject: "NZ",
      dependsOn: [ni.id, si.id],
      note: LOAD_NOTE,
    });

  const residual: EvidencePackage["context"]["energy_balance_residual"] = {
    modelled: true,
    note: RESIDUAL_NOTE,
    megawatts: {},
  };
  const balanceRows = c.present("energy_balance_period")
    ? await c.query(
        `SELECT trading_period, island, residual_mwh * 2 AS megawatts, inputs_complete
         FROM ${c.from("energy_balance_period")} WHERE ${inWindow(c)} ORDER BY island, trading_period`,
      )
    : [];
  for (const island of ISLANDS) {
    const own = balanceRows.filter((row) => row.island === island);
    if (own.length === 0) continue;
    residual.megawatts[island] = align(c, own, "megawatts");
    const row = rowAt(own, c.peak);
    const mw = num(row?.megawatts);
    if (row === undefined || mw === null) continue;
    c.claim({
      id: `balance_residual.${island}.p${c.peak}`,
      label: `Modelled energy-balance residual, ${island}, period ${c.peak}`,
      value: mw,
      unit: "MW",
      table: "energy_balance_period",
      queryId: "loadClaims",
      period: c.peak,
      subject: island,
      rowComplete: Boolean(row.inputs_complete),
      note: RESIDUAL_NOTE,
    });
  }
  return { load, energy_balance_residual: residual };
}

export function episodeClaims(c: ClaimContext): void {
  for (const [key, label, value, unit] of [
    [
      "severity",
      "Episode severity (worst member)",
      c.episode.severity,
      "severity",
    ],
    [
      "member_count",
      "Observations in the episode",
      c.episode.member_count,
      "count",
    ],
    [
      "period_count",
      "Trading periods in the episode",
      c.episode.period_count,
      "periods",
    ],
  ] as const)
    c.claim({
      id: `episode.${key}`,
      label,
      value,
      unit,
      table: "episodes",
      queryId: "episodeClaims",
      subject: c.episode.episode_id,
      rowComplete: c.episode.inputs_complete,
    });
}

/** Day-level figures from the daily tables, for the context of the day. */
export async function dayClaims(c: ClaimContext): Promise<void> {
  if (c.present("price_daily_summary")) {
    const rows = await c.query(
      `SELECT point_of_connection, mean_price, max_price, inputs_complete
       FROM ${c.from("price_daily_summary")} ORDER BY point_of_connection`,
    );
    for (const row of rows) {
      const id = String(row.point_of_connection);
      const common = {
        table: "price_daily_summary",
        queryId: "dayClaims",
        subject: id,
        rowComplete: Boolean(row.inputs_complete),
      };
      const mean = num(row.mean_price);
      const max = num(row.max_price);
      if (mean !== null)
        c.claim({
          ...common,
          id: `day.price_mean.${id}`,
          label: `Mean of the period prices at ${id} for the day`,
          value: mean,
          unit: "$/MWh",
        });
      if (max !== null)
        c.claim({
          ...common,
          id: `day.price_max.${id}`,
          label: `Highest dispatch publish at ${id} for the day`,
          value: max,
          unit: "$/MWh",
          note: "An extremum of dispatch publishes, not of period prices.",
        });
    }
  }
  if (c.present("price_distribution")) {
    const [row] = await c.query(
      `SELECT poc_count, median_price, max_price, inputs_complete
       FROM ${c.from("price_distribution")} WHERE trading_period = ${c.peak}`,
    );
    if (row !== undefined) {
      const common = {
        table: "price_distribution",
        queryId: "dayClaims",
        period: c.peak,
        rowComplete: Boolean(row.inputs_complete),
      };
      const median = num(row.median_price);
      const max = num(row.max_price);
      const count = num(row.poc_count);
      if (median !== null)
        c.claim({
          ...common,
          id: `distribution.median.p${c.peak}`,
          label: `Median period price over all priced points of connection, period ${c.peak}`,
          value: median,
          unit: "$/MWh",
        });
      if (max !== null)
        c.claim({
          ...common,
          id: `distribution.max.p${c.peak}`,
          label: `Highest period price over all priced points of connection, period ${c.peak}`,
          value: max,
          unit: "$/MWh",
          note: "Gold does not keep which point of connection it was.",
        });
      if (count !== null)
        c.claim({
          ...common,
          id: `distribution.poc_count.p${c.peak}`,
          label: `Points of connection with a period price, period ${c.peak}`,
          value: count,
          unit: "count",
        });
    }
  }
  if (c.present("generation_by_fuel_day")) {
    const rows = await c.query(
      `SELECT fuel_category, sum(megawatt_hours) AS mwh, bool_and(inputs_complete) AS inputs_complete
       FROM ${c.from("generation_by_fuel_day")} GROUP BY fuel_category ORDER BY fuel_category`,
    );
    const primaryIds: string[] = [];
    let primary = 0;
    let hydro = 0;
    for (const row of rows) {
      const fuel = String(row.fuel_category);
      const mwh = num(row.mwh);
      if (mwh === null) continue;
      const id = `day.generation.${fuel}.mwh`;
      c.claim({
        id,
        label: `Metered generation for the day, ${fuel}, all islands`,
        value: mwh,
        unit: "MWh",
        table: "generation_by_fuel_day",
        queryId: "dayClaims",
        subject: fuel,
        rowComplete: Boolean(row.inputs_complete),
      });
      if (fuel === "battery") continue;
      primaryIds.push(id);
      primary += mwh;
      if (fuel === "hydro") hydro = mwh;
    }
    if (primary > 0 && primaryIds.includes("day.generation.hydro.mwh"))
      c.claim({
        id: "day.generation.hydro_share",
        label: "Hydro share of primary energy for the day (battery excluded)",
        value: (hydro / primary) * 100,
        unit: "%",
        table: "generation_by_fuel_day",
        queryId: "dayClaims",
        subject: "hydro",
        dependsOn: primaryIds,
        note: "Battery is storage and is not in the total (ADR-0008).",
      });
  }
  if (c.present("hvdc_transfer_day")) {
    const [row] = await c.query(
      `SELECT north_island_received_mwh, average_megawatts, inputs_complete
       FROM ${c.from("hvdc_transfer_day")}`,
    );
    if (row !== undefined) {
      const common = {
        table: "hvdc_transfer_day",
        queryId: "dayClaims",
        subject: "HAY2201",
        rowComplete: Boolean(row.inputs_complete),
      };
      const mwh = num(row.north_island_received_mwh);
      const mw = num(row.average_megawatts);
      if (mwh !== null)
        c.claim({
          ...common,
          id: "day.hvdc.received_mwh",
          label: "HVDC energy received in the North Island for the day",
          value: mwh,
          unit: "MWh",
        });
      if (mw !== null)
        c.claim({
          ...common,
          id: "day.hvdc.average_mw",
          label: "HVDC average transfer for the day",
          value: mw,
          unit: "MW",
          note: HVDC_NOTE,
        });
    }
  }
}

/** `['a', 'b']::VARCHAR[]` for a DuckDB `list_contains`. */
export const listSql = (values: readonly string[]) =>
  values.length === 0
    ? "[]::VARCHAR[]"
    : `[${values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ")}]::VARCHAR[]`;

/** The highest dispatch publish of the peak period, with counts of nodes at or above set prices. */
async function publishPeak(
  c: ClaimContext,
  table: string,
  kind: "energy" | "sir",
): Promise<DispatchPeak | null> {
  const keys =
    kind === "energy"
      ? "point_of_connection"
      : "point_of_connection, island, reserve_class";
  const where = kind === "energy" ? "" : "AND reserve_class = 'SIR'";
  const thresholds = c.config.scarcityPrices;
  const publishes = `SELECT point_of_connection AS node, island, source_published_at AS t,
       dollars_per_megawatt_hour AS v, event_end_utc,
       lead(source_published_at) OVER (
         PARTITION BY ${keys} ORDER BY source_published_at, dollars_per_megawatt_hour) AS next_t
     FROM ${c.from(table)} WHERE trading_period = ${c.peak} ${where}`;
  const [top] = await c.query(
    `WITH r AS (${publishes})
     SELECT node, island, strftime(t, '%Y-%m-%dT%H:%M:%SZ') AS time_utc, v,
       epoch(coalesce(next_t, event_end_utc) - t) AS seconds
     FROM r ORDER BY v DESC, t, node LIMIT 1`,
  );
  if (top === undefined) return null;
  const [counts] = await c.query(
    `WITH r AS (${publishes})
     SELECT ${thresholds.map((limit) => `count(DISTINCT node) FILTER (WHERE v >= ${limit}) AS n${limit}`).join(", ")}
     FROM r`,
  );
  return {
    node: String(top.node),
    island: top.island === null ? null : String(top.island),
    time_utc: String(top.time_utc),
    price: round(Number(top.v)),
    seconds_to_next_publish: round(Number(top.seconds), 3),
    nodes_at_or_above: Object.fromEntries(
      thresholds.map((limit) => [String(limit), Number(counts?.[`n${limit}`])]),
    ),
  };
}

/**
 * Dispatch publishes of the peak period (silver). One rule: store the highest publish (node,
 * time, price, seconds to the next publish of that node, or to the period end when it has none)
 * and the count of nodes that reach each scarcity price in that period. Energy and SIR.
 */
export async function dispatchClaims(
  c: ClaimContext,
): Promise<EvidencePackage["context"]["dispatch_peak"]> {
  const out: EvidencePackage["context"]["dispatch_peak"] = {
    trading_period: c.peak,
    energy: null,
    sir: null,
  };
  for (const [kind, table, label] of [
    ["energy", "dispatch_energy_prices", "dispatch energy price"],
    ["sir", "dispatch_reserve_prices", "SIR dispatch price"],
  ] as const) {
    if (!c.present(table)) continue;
    const peak = await publishPeak(c, table, kind);
    out[kind] = peak;
    if (peak === null) continue;
    const common = {
      table,
      queryId: "dispatchClaims",
      period: c.peak,
      subject:
        peak.island === null ? peak.node : `${peak.node} (${peak.island})`,
    };
    const base = `dispatch.${kind}`;
    c.claim({
      ...common,
      id: `${base}.max_publish.p${c.peak}`,
      label: `Highest ${label} publish in period ${c.peak}`,
      value: peak.price,
      unit: "$/MWh",
    });
    c.claim({
      ...common,
      id: `${base}.max_publish_node.p${c.peak}`,
      label: `Node of the highest ${label} publish, period ${c.peak}`,
      value: peak.node,
      unit: "node",
    });
    c.claim({
      ...common,
      id: `${base}.max_publish_time.p${c.peak}`,
      label: `Time of the highest ${label} publish, period ${c.peak}`,
      value: peak.time_utc,
      unit: "UTC",
    });
    c.claim({
      ...common,
      id: `${base}.max_publish_seconds.p${c.peak}`,
      label: `Seconds from the highest ${label} publish to the next publish of that node`,
      value: peak.seconds_to_next_publish,
      unit: "s",
      note: "When the node has no later publish in the period, the period end is the end.",
    });
    for (const [limit, count] of Object.entries(peak.nodes_at_or_above))
      c.claim({
        ...common,
        id: `${base}.nodes_ge_${limit}.p${c.peak}`,
        label: `Nodes with a ${label} publish of $${Number(limit).toLocaleString("en-NZ")} or more in period ${c.peak}`,
        value: count,
        unit: "count",
        note: "Counted over the whole period, not at one instant.",
      });
  }
  return out;
}

/**
 * Claims that join confirmed claims. They read no table. Each names its inputs in `depends_on`
 * and states no cause.
 */
export function derivedClaims(c: ClaimContext): void {
  // The thermal ramp, North Island: coal/gas plus gas, from the ramp start to the peak.
  if (c.rampStart < c.peak) {
    const at = (period: number) =>
      c.config.thermalFuels.map((fuel) =>
        claimFind(c, `generation.fuel.${fuel}.NI.p${period}`),
      );
    const thermal = [c.rampStart, c.peak].map((period) => {
      const parts = at(period);
      if (parts.some((part) => part === undefined)) return undefined;
      const claims = parts as Claim[];
      const id = `generation.thermal.NI.p${period}`;
      c.claim({
        id,
        label: `Thermal generation (${c.config.thermalFuels.join(" + ")}), NI, period ${period}`,
        value: claims.reduce((sum, part) => sum + Number(part.value), 0),
        unit: "MW",
        table: "generation_by_fuel_period",
        queryId: "derivedClaims",
        period,
        subject: "thermal|NI",
        dependsOn: claims.map((part) => part.id),
      });
      return id;
    });
    const [from, to] = thermal;
    const start = from === undefined ? undefined : claimFind(c, from);
    const end = to === undefined ? undefined : claimFind(c, to);
    if (from !== undefined && to !== undefined && start && end)
      c.claim({
        id: "generation.thermal_ramp.NI",
        label: `Rise in NI thermal generation from period ${c.rampStart} to period ${c.peak}`,
        value: Number(end.value) - Number(start.value),
        unit: "MW",
        table: "generation_by_fuel_period",
        queryId: "derivedClaims",
        period: c.peak,
        subject: "thermal|NI",
        dependsOn: [from, to],
        note: `The ramp starts ${c.config.rampPeriods} periods before the peak.`,
      });
  }

  // The north-south spread and the HVDC direction of the peak period, side by side.
  const spread = claimFind(c, `spread.OTA2201-BEN2201.p${c.peak}`);
  const direction = claimFind(c, `hvdc.direction.p${c.peak}`);
  if (spread !== undefined && direction !== undefined)
    c.claim({
      id: `separation.OTA2201-BEN2201.hvdc_north.p${c.peak}`,
      label: `OTA2201 dearer than BEN2201 while the HVDC link carried power north, period ${c.peak}`,
      value: Number(spread.value) > 0 && direction.value === "north",
      unit: "boolean",
      table: "price_spreads",
      queryId: "derivedClaims",
      period: c.peak,
      subject: "OTA2201-BEN2201",
      dependsOn: [spread.id, direction.id],
      note: "Two confirmed values side by side. It names no cause.",
    });
}

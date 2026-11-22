import { existsSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { lit } from "../silver/common.ts";
import type { CompletenessView } from "../silver/completeness.ts";
import { periodsInTradingDate } from "../trading-time.ts";
import { goldPartitionPath, ISLANDS } from "./common.ts";
import { TABLES as PRICE_ANOMALY_TABLES } from "./price-anomaly.ts";
import { TABLES as PRICE_SEPARATION_TABLES } from "./price-separation.ts";
import { REFERENCE_NODES, SPREAD_PAIRS } from "./prices.ts";
import { TABLES as RESERVE_PRICE_ANOMALY_TABLES } from "./reserve-price-anomaly.ts";

/**
 * Evidence package for one episode (issue #38, ADR-0024). The builder reads gold (and, for
 * dispatch and reference data, silver), and returns one JSON-ready object. It writes no prose and
 * no file. The CLI (`evidence.cli.ts`) writes the file.
 *
 * Every claim is `confirmed`: its value is read straight from a gold or silver row, or it is a
 * plain sum, difference or join of confirmed claims, named in `depends_on`. The type keeps the
 * other two levels of brief section 7.2 so that later work needs no schema change. This builder
 * never writes them.
 */

/** Bump when the shape of the package changes. */
export const EVIDENCE_SCHEMA_VERSION = 1;
/** Bump by hand when a claim, a rule or a config value of the builder changes. */
export const BUILDER_VERSION = 1;

export const EVIDENCE_CONFIG = {
  /** Periods before the episode start that the window holds (clamped to period 1). */
  periodsBefore: 4,
  /** Periods after the episode end that the window holds (clamped to the last period). */
  periodsAfter: 2,
  /** Plants listed from the peak period, by average MW. */
  topPlants: 10,
  /** The thermal ramp starts this many periods before the peak (not before the window). */
  rampPeriods: 4,
  /** Dispatch publish counts. A node counts when any publish in the peak period reaches it. */
  scarcityPrices: [20000, 10000],
  /** Fuel categories that make up thermal generation (ADR-0008). */
  thermalFuels: ["coal_gas", "gas"],
} as const;

export type Confidence =
  | "confirmed"
  | "strong_evidence"
  | "possible_explanation";

export type ClaimValue = number | string | boolean;

export interface ClaimSource {
  kind: "gold" | "silver";
  table: string;
  /** The name of the builder function that reads the value. It is not SQL. */
  query_id: string;
  period?: number;
  subject?: string;
  /** The partition, relative to the data root. It is always listed in `links`. */
  path: string;
}

export interface Claim {
  /** Stable. Keys of #40. For example `price.OTA2201.p36`. */
  id: string;
  label: string;
  value: ClaimValue;
  unit: string;
  source: ClaimSource;
  confidence: Confidence;
  depends_on?: string[];
  note?: string;
}

export type InputStatus = "complete" | "partial" | "missing" | "invalid";

export interface CompletenessEntry {
  layer: "gold" | "silver";
  table: string;
  path: string;
  status: InputStatus;
  detail?: string;
}

type Series = Array<number | null>;

export interface EvidenceEpisode {
  episode_id: string;
  seed_observation_id: string;
  trading_date: string;
  start_trading_period: number;
  end_trading_period: number;
  period_count: number;
  event_start_utc: string;
  event_end_utc: string;
  member_observation_ids: string[];
  member_count: number;
  observation_types: string[];
  subjects: string;
  islands: string[];
  plant_ids: string[];
  severity: number;
  grouping_reason: string;
  inputs_complete: boolean;
}

export interface EvidenceObservation {
  observation_id: string;
  observation_type: string;
  start_trading_period: number;
  end_trading_period: number;
  event_start_utc: string;
  event_end_utc: string;
  subject_type: string;
  subject_id: string;
  island: string | null;
  plant_id: string | null;
  measured_value: number;
  severity: number;
  inputs_complete: boolean;
}

export interface EvidencePackage {
  schema_version: number;
  builder_version: number;
  episode: EvidenceEpisode;
  window: {
    trading_date: string;
    start_trading_period: number;
    end_trading_period: number;
    peak_trading_period: number;
    periods: number[];
  };
  observations: EvidenceObservation[];
  /** Series are aligned to `window.periods`. A null is a period with no row. */
  context: {
    prices: Record<string, { price: Series; max_price: Series }>;
    spreads: Record<string, Series>;
    reserves: Record<
      string,
      Record<string, { price: Series; max_price: Series }>
    >;
    generation_by_fuel: Record<string, Series>;
    generation_by_plant: Record<
      string,
      {
        plant_name: string;
        fuel_category: string;
        island: string | null;
        average_megawatts: Series;
      }
    >;
    hvdc: {
      average_megawatts: Series;
      direction: Array<string | null>;
      note: string;
    };
    load: { modelled: true; megawatts: Record<string, Series> };
    energy_balance_residual: {
      modelled: true;
      note: string;
      megawatts: Record<string, Series>;
    };
  };
  completeness: CompletenessEntry[];
  claims: Claim[];
  limits: Array<{ issue: number; text: string }>;
  links: {
    daily_page: string;
    day_json: string;
    gold_partitions: string[];
    silver_partitions: string[];
    source_datasets: string[];
  };
}

/** What the lake cannot show yet. Each line points at the issue that will add it. */
export const EVIDENCE_LIMITS: EvidencePackage["limits"] = [
  {
    issue: 44,
    text: "No SPD case files: no scarcity flag, no risk setter, no offer tranches, no operator residual.",
  },
  { issue: 45, text: "No generator or transmission outage record." },
  { issue: 46, text: "No named transmission constraints." },
  { issue: 47, text: "No hydro storage or inflow series." },
];

const GOLD_DETECTOR_TABLES = [
  PRICE_ANOMALY_TABLES[1],
  PRICE_SEPARATION_TABLES[1],
  RESERVE_PRICE_ANOMALY_TABLES[1],
] as const;

const GOLD_TABLES = [
  "episodes",
  ...GOLD_DETECTOR_TABLES,
  "price_periods",
  "price_spreads",
  "price_daily_summary",
  "price_distribution",
  "reserve_by_class_island_period",
  "generation_by_fuel_period",
  "generation_by_plant_period",
  "generation_by_fuel_day",
  "hvdc_transfer_period",
  "hvdc_transfer_day",
  "grid_load_period",
  "energy_balance_period",
] as const;

type Row = Record<string, unknown>;

const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

/** Local rounding. It removes floating-point noise and keeps four decimals. */
const round = (value: number, places = 4): number => {
  const factor = 10 ** places;
  const rounded =
    (Math.round(Math.abs(value) * factor) / factor) * Math.sign(value);
  return rounded === 0 ? 0 : rounded;
};

const roundOrNull = (value: number | null) =>
  value === null ? null : round(value);

const asIso = (value: unknown): string => {
  const ms =
    value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (Number.isNaN(ms)) throw new TypeError(`not an instant: ${String(value)}`);
  return new Date(ms).toISOString().replace(/\.000Z$/, "Z");
};

const relativePath = (layer: "gold" | "silver", table: string, date: string) =>
  `${layer}/${table}/trading_date=${date}/data.parquet`;

/** One table that the builder reads: where it is and how complete it is. */
interface Use extends CompletenessEntry {
  abs: string;
}

export interface BuildEvidenceOptions {
  goldDir: string;
  silverDir: string;
  completeness: CompletenessView;
  episodeId: string;
  date: string;
}

/**
 * Build the evidence package of one episode. Throws when the date has no episodes partition or
 * the id is not in it. A table that is absent gives a `missing` entry in `completeness` and no
 * claim. The same inputs give the same bytes: nothing in the package is a clock reading.
 */
export async function buildEvidencePackage(
  options: BuildEvidenceOptions,
): Promise<EvidencePackage> {
  const { goldDir, episodeId, date } = options;
  const periodsInDay = periodsInTradingDate(date);

  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    await connection.run("SET threads = 1");
    const query = async (sql: string): Promise<Row[]> =>
      (await connection.runAndReadAll(sql)).getRowObjectsJson() as Row[];

    // Every table the builder reads gets one completeness entry, present or not.
    const uses = new Map<string, Use>();
    for (const table of GOLD_TABLES) {
      const abs = goldPartitionPath(goldDir, table, date);
      const use: Use = {
        layer: "gold",
        table,
        path: relativePath("gold", table, date),
        abs,
        status: "missing",
      };
      if (existsSync(abs)) {
        const [counts] = await query(
          `SELECT count(*) FILTER (WHERE NOT inputs_complete) AS incomplete
           FROM read_parquet(${lit(abs)})`,
        );
        use.status = Number(counts?.incomplete) === 0 ? "complete" : "partial";
        if (use.status === "partial")
          use.detail = `${counts?.incomplete} row(s) have inputs_complete = false`;
      }
      uses.set(table, use);
    }
    const use = (table: string): Use => {
      const found = uses.get(table);
      if (!found) throw new Error(`table ${table} is not registered`);
      return found;
    };
    const from = (table: string) => `read_parquet(${lit(use(table).abs)})`;
    const present = (table: string) => use(table).status !== "missing";

    // The episode.
    if (!present("episodes"))
      throw new Error(`no episodes partition for ${date}`);
    const [episodeRow] = await query(
      `SELECT episode_id, seed_observation_id, trading_date::VARCHAR AS trading_date,
         start_trading_period, end_trading_period, period_count,
         event_start_utc, event_end_utc, member_observation_ids, member_count,
         observation_types, subjects, islands, plant_ids, severity, grouping_reason,
         inputs_complete
       FROM ${from("episodes")} WHERE episode_id = ${lit(episodeId)}`,
    );
    if (!episodeRow)
      throw new Error(`episode ${episodeId} is not in the episodes of ${date}`);
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.map(String) : [];
    const episode: EvidenceEpisode = {
      episode_id: String(episodeRow.episode_id),
      seed_observation_id: String(episodeRow.seed_observation_id),
      trading_date: String(episodeRow.trading_date),
      start_trading_period: Number(episodeRow.start_trading_period),
      end_trading_period: Number(episodeRow.end_trading_period),
      period_count: Number(episodeRow.period_count),
      event_start_utc: asIso(episodeRow.event_start_utc),
      event_end_utc: asIso(episodeRow.event_end_utc),
      member_observation_ids: strings(episodeRow.member_observation_ids),
      member_count: Number(episodeRow.member_count),
      observation_types: strings(episodeRow.observation_types),
      subjects: String(episodeRow.subjects),
      islands: strings(episodeRow.islands),
      plant_ids: strings(episodeRow.plant_ids),
      severity: round(Number(episodeRow.severity)),
      grouping_reason: String(episodeRow.grouping_reason),
      inputs_complete: Boolean(episodeRow.inputs_complete),
    };

    // The window.
    const first = Math.max(
      1,
      episode.start_trading_period - EVIDENCE_CONFIG.periodsBefore,
    );
    const last = Math.min(
      periodsInDay,
      episode.end_trading_period + EVIDENCE_CONFIG.periodsAfter,
    );
    const periods = Array.from(
      { length: last - first + 1 },
      (_, i) => first + i,
    );
    const inWindow = `trading_period BETWEEN ${first} AND ${last}`;
    const align = (rows: Row[], key: string): Series => {
      const byPeriod = new Map(
        rows.map((row) => [Number(row.trading_period), num(row[key])]),
      );
      return periods.map((period) => roundOrNull(byPeriod.get(period) ?? null));
    };

    // Observations that are members of the episode.
    const observations: EvidenceObservation[] = [];
    for (const table of GOLD_DETECTOR_TABLES) {
      if (!present(table)) continue;
      const rows = await query(
        `SELECT observation_id, observation_type, start_trading_period,
           end_trading_period, event_start_utc, event_end_utc, subject_type,
           subject_id, island, plant_id, measured_value, severity, inputs_complete
         FROM ${from(table)}
         WHERE list_contains(${listSql(episode.member_observation_ids)}, observation_id)`,
      );
      for (const row of rows)
        observations.push({
          observation_id: String(row.observation_id),
          observation_type: String(row.observation_type),
          start_trading_period: Number(row.start_trading_period),
          end_trading_period: Number(row.end_trading_period),
          event_start_utc: asIso(row.event_start_utc),
          event_end_utc: asIso(row.event_end_utc),
          subject_type: String(row.subject_type),
          subject_id: String(row.subject_id),
          island: row.island === null ? null : String(row.island),
          plant_id: row.plant_id === null ? null : String(row.plant_id),
          measured_value: round(Number(row.measured_value)),
          severity: round(Number(row.severity)),
          inputs_complete: Boolean(row.inputs_complete),
        });
    }
    observations.sort((a, b) =>
      a.observation_id.localeCompare(b.observation_id),
    );

    const claims: Claim[] = [];
    const claim = (input: {
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
      rowComplete?: boolean;
    }) => {
      if (claims.some((existing) => existing.id === input.id))
        throw new Error(`duplicate claim id ${input.id}`);
      const table = use(input.table);
      const notes = [
        input.note,
        input.rowComplete === false
          ? "The source row has inputs_complete = false."
          : undefined,
      ].filter((text): text is string => text !== undefined);
      claims.push({
        id: input.id,
        label: input.label,
        value:
          typeof input.value === "number" ? round(input.value) : input.value,
        unit: input.unit,
        source: {
          kind: table.layer,
          table: table.table,
          query_id: input.queryId,
          ...(input.period === undefined ? {} : { period: input.period }),
          ...(input.subject === undefined ? {} : { subject: input.subject }),
          path: table.path,
        },
        confidence: "confirmed",
        ...(input.dependsOn === undefined
          ? {}
          : { depends_on: input.dependsOn }),
        ...(notes.length === 0 ? {} : { note: notes.join(" ") }),
      });
    };

    // Prices, and the peak period (highest reference-node price inside the episode).
    const priceRows = present("price_periods")
      ? await query(
          `SELECT trading_period, point_of_connection, price, max_price, inputs_complete
           FROM ${from("price_periods")} WHERE ${inWindow}
           ORDER BY point_of_connection, trading_period`,
        )
      : [];
    let peak = episode.start_trading_period;
    let peakPrice = Number.NEGATIVE_INFINITY;
    for (const row of priceRows) {
      const period = Number(row.trading_period);
      const price = num(row.price);
      if (
        price !== null &&
        period >= episode.start_trading_period &&
        period <= episode.end_trading_period &&
        (price > peakPrice || (price === peakPrice && period < peak))
      ) {
        peak = period;
        peakPrice = price;
      }
    }
    const claimPeriods = [
      ...new Set([episode.start_trading_period, peak]),
    ].sort((a, b) => a - b);
    const rowAt = (rows: Row[], period: number, test: (row: Row) => boolean) =>
      rows.find((row) => Number(row.trading_period) === period && test(row));

    const prices: EvidencePackage["context"]["prices"] = {};
    for (const node of REFERENCE_NODES) {
      const id = node.pointOfConnection;
      const rows = priceRows.filter((row) => row.point_of_connection === id);
      prices[id] = {
        price: align(rows, "price"),
        max_price: align(rows, "max_price"),
      };
      for (const period of claimPeriods) {
        const row = rowAt(rows, period, () => true);
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
        claim({
          ...common,
          id: `price.${id}.p${period}`,
          label: `Period price at ${id}, period ${period} (time-weighted mean of dispatch publishes)`,
          value: price,
          unit: "$/MWh",
        });
        claim({
          ...common,
          id: `price_max.${id}.p${period}`,
          label: `Highest dispatch publish at ${id} inside period ${period}`,
          value: maxPrice,
          unit: "$/MWh",
          note: "The period price is a mean. This is the highest single publish.",
        });
      }
    }

    // Spreads.
    const spreadRows = present("price_spreads")
      ? await query(
          `SELECT trading_period, from_point_of_connection AS a, to_point_of_connection AS b,
             spread, inputs_complete
           FROM ${from("price_spreads")} WHERE ${inWindow}
           ORDER BY a, b, trading_period`,
        )
      : [];
    const spreads: Record<string, Series> = {};
    for (const [a, b] of SPREAD_PAIRS) {
      const key = `${a}-${b}`;
      const rows = spreadRows.filter((row) => row.a === a && row.b === b);
      spreads[key] = align(rows, "spread");
      for (const period of claimPeriods) {
        const row = rowAt(rows, period, () => true);
        const spread = num(row?.spread);
        if (row === undefined || spread === null) continue;
        claim({
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

    // Reserves, by class and island.
    const reserveRows = present("reserve_by_class_island_period")
      ? await query(
          `SELECT trading_period, reserve_class, island, dollars_per_megawatt_hour AS price,
             max_price, inputs_complete
           FROM ${from("reserve_by_class_island_period")} WHERE ${inWindow}
           ORDER BY reserve_class, island, trading_period`,
        )
      : [];
    const reserves: EvidencePackage["context"]["reserves"] = {};
    for (const reserveClass of [
      ...new Set(reserveRows.map((row) => String(row.reserve_class))),
    ].sort()) {
      const byIsland: Record<string, { price: Series; max_price: Series }> = {};
      reserves[reserveClass] = byIsland;
      for (const island of ISLANDS) {
        const rows = reserveRows.filter(
          (row) => row.reserve_class === reserveClass && row.island === island,
        );
        if (rows.length === 0) continue;
        const slot = {
          price: align(rows, "price"),
          max_price: align(rows, "max_price"),
        };
        byIsland[island] = slot;
        for (const period of claimPeriods) {
          const row = rowAt(rows, period, () => true);
          const price = num(row?.price);
          const maxPrice = num(row?.max_price);
          if (row === undefined || price === null || maxPrice === null)
            continue;
          const common = {
            table: "reserve_by_class_island_period",
            queryId: "reserveClaims",
            period,
            subject: `${reserveClass}|${island}`,
            rowComplete: Boolean(row.inputs_complete),
          };
          claim({
            ...common,
            id: `reserve.${reserveClass}.${island}.p${period}`,
            label: `${reserveClass} reserve price, ${island}, period ${period}`,
            value: price,
            unit: "$/MWh",
          });
          claim({
            ...common,
            id: `reserve_max.${reserveClass}.${island}.p${period}`,
            label: `Highest ${reserveClass} reserve publish, ${island}, period ${period}`,
            value: maxPrice,
            unit: "$/MWh",
          });
        }
      }
    }

    // Generation by fuel and island.
    const fuelRows = present("generation_by_fuel_period")
      ? await query(
          `SELECT trading_period, fuel_category, coalesce(island, 'unmapped') AS island,
             average_megawatts, inputs_complete
           FROM ${from("generation_by_fuel_period")} WHERE ${inWindow}
           ORDER BY fuel_category, island, trading_period`,
        )
      : [];
    const generationByFuel: Record<string, Series> = {};
    for (const key of [
      ...new Set(fuelRows.map((row) => `${row.fuel_category}|${row.island}`)),
    ]) {
      const rows = fuelRows.filter(
        (row) => `${row.fuel_category}|${row.island}` === key,
      );
      generationByFuel[key] = align(rows, "average_megawatts");
      const row = rowAt(rows, peak, () => true);
      const mw = num(row?.average_megawatts);
      if (row === undefined || mw === null) continue;
      const [fuel, island] = key.split("|");
      claim({
        id: `generation.fuel.${fuel}.${island}.p${peak}`,
        label: `Average generation, ${fuel}, ${island}, period ${peak}`,
        value: mw,
        unit: "MW",
        table: "generation_by_fuel_period",
        queryId: "generationFuelClaims",
        period: peak,
        subject: key,
        rowComplete: Boolean(row.inputs_complete),
      });
    }

    // The top plants of the peak period, with their series across the window.
    const generationByPlant: EvidencePackage["context"]["generation_by_plant"] =
      {};
    if (present("generation_by_plant_period")) {
      const top = await query(
        `SELECT plant_id FROM ${from("generation_by_plant_period")}
         WHERE trading_period = ${peak} AND average_megawatts IS NOT NULL
         ORDER BY average_megawatts DESC, plant_id
         LIMIT ${EVIDENCE_CONFIG.topPlants}`,
      );
      const ids = top.map((row) => String(row.plant_id));
      const plantRows =
        ids.length === 0
          ? []
          : await query(
              `SELECT trading_period, plant_id, plant_name, fuel_category, island,
                 average_megawatts, inputs_complete
               FROM ${from("generation_by_plant_period")}
               WHERE ${inWindow} AND list_contains(${listSql(ids)}, plant_id)
               ORDER BY plant_id, trading_period`,
            );
      for (const id of ids) {
        const rows = plantRows.filter((row) => row.plant_id === id);
        const head = rows[0];
        generationByPlant[id] = {
          plant_name: String(head?.plant_name ?? id),
          fuel_category: String(head?.fuel_category ?? "unmapped"),
          island:
            head?.island === null || head?.island === undefined
              ? null
              : String(head.island),
          average_megawatts: align(rows, "average_megawatts"),
        };
        const row = rowAt(rows, peak, () => true);
        const mw = num(row?.average_megawatts);
        if (row === undefined || mw === null) continue;
        claim({
          id: `generation.plant.${id}.p${peak}`,
          label: `Average generation, plant ${id}, period ${peak}`,
          value: mw,
          unit: "MW",
          table: "generation_by_plant_period",
          queryId: "generationPlantClaims",
          period: peak,
          subject: id,
          rowComplete: Boolean(row.inputs_complete),
        });
      }
    }

    // HVDC. A 30-minute metered average, not an instantaneous peak.
    const hvdcNote =
      "A 30-minute metered average at Haywards. It is not an instantaneous peak.";
    const hvdcRows = present("hvdc_transfer_period")
      ? await query(
          `SELECT trading_period, average_megawatts, direction, inputs_complete
           FROM ${from("hvdc_transfer_period")} WHERE ${inWindow} ORDER BY trading_period`,
        )
      : [];
    const hvdc: EvidencePackage["context"]["hvdc"] = {
      average_megawatts: align(hvdcRows, "average_megawatts"),
      direction: periods.map((period) => {
        const row = rowAt(hvdcRows, period, () => true);
        return row === undefined || row.direction === null
          ? null
          : String(row.direction);
      }),
      note: hvdcNote,
    };
    const hvdcPeakRow = rowAt(hvdcRows, peak, () => true);
    const hvdcMw = num(hvdcPeakRow?.average_megawatts);
    if (hvdcPeakRow !== undefined && hvdcMw !== null) {
      const common = {
        table: "hvdc_transfer_period",
        queryId: "hvdcClaims",
        period: peak,
        subject: "HAY2201",
        rowComplete: Boolean(hvdcPeakRow.inputs_complete),
        note: hvdcNote,
      };
      claim({
        ...common,
        id: `hvdc.mw.p${peak}`,
        label: `HVDC transfer received in the North Island, period ${peak}`,
        value: hvdcMw,
        unit: "MW",
      });
      claim({
        ...common,
        id: `hvdc.direction.p${peak}`,
        label: `HVDC direction, period ${peak}`,
        value: String(hvdcPeakRow.direction),
        unit: "direction",
      });
    }
    const hvdcValues = hvdcRows
      .map((row) => ({
        period: Number(row.trading_period),
        mw: num(row.average_megawatts),
      }))
      .filter(
        (item): item is { period: number; mw: number } => item.mw !== null,
      );
    if (hvdcValues.length > 0) {
      const top = hvdcValues.reduce((best, item) =>
        item.mw > best.mw ? item : best,
      );
      claim({
        id: "hvdc.window_peak_mw",
        label: `Highest 30-minute HVDC transfer in the window (period ${top.period})`,
        value: top.mw,
        unit: "MW",
        table: "hvdc_transfer_period",
        queryId: "hvdcClaims",
        period: top.period,
        subject: "HAY2201",
        note: hvdcNote,
      });
      claim({
        id: "hvdc.window_mean_mw",
        label: "Mean HVDC transfer over the window",
        value:
          hvdcValues.reduce((sum, item) => sum + item.mw, 0) /
          hvdcValues.length,
        unit: "MW",
        table: "hvdc_transfer_period",
        queryId: "hvdcClaims",
        subject: "HAY2201",
        note: hvdcNote,
      });
    }

    // Modelled load and the modelled energy-balance residual.
    const loadRows = present("grid_load_period")
      ? await query(
          `SELECT trading_period, island, load_mwh * 2 AS megawatts, inputs_complete
           FROM ${from("grid_load_period")} WHERE ${inWindow} ORDER BY island, trading_period`,
        )
      : [];
    const load: EvidencePackage["context"]["load"] = {
      modelled: true,
      megawatts: {},
    };
    for (const island of ISLANDS) {
      const rows = loadRows.filter((row) => row.island === island);
      if (rows.length === 0) continue;
      load.megawatts[island] = align(rows, "megawatts");
      const row = rowAt(rows, peak, () => true);
      const mw = num(row?.megawatts);
      if (row === undefined || mw === null) continue;
      claim({
        id: `load.${island}.p${peak}`,
        label: `Modelled load, ${island}, period ${peak}`,
        value: mw,
        unit: "MW",
        table: "grid_load_period",
        queryId: "loadClaims",
        period: peak,
        subject: island,
        rowComplete: Boolean(row.inputs_complete),
        note: "Real-time dispatch model load at grid exit points, not metered consumption.",
      });
    }
    const niLoad = claims.find((c) => c.id === `load.NI.p${peak}`);
    const siLoad = claims.find((c) => c.id === `load.SI.p${peak}`);
    if (niLoad !== undefined && siLoad !== undefined)
      claim({
        id: `load.national.p${peak}`,
        label: `Modelled load, both islands, period ${peak}`,
        value: Number(niLoad.value) + Number(siLoad.value),
        unit: "MW",
        table: "grid_load_period",
        queryId: "loadClaims",
        period: peak,
        subject: "NZ",
        dependsOn: [niLoad.id, siLoad.id],
        note: "Real-time dispatch model load at grid exit points, not metered consumption.",
      });

    const residualNote =
      "Generation plus HVDC import minus modelled load. It is not the system operator residual.";
    const balanceRows = present("energy_balance_period")
      ? await query(
          `SELECT trading_period, island, residual_mwh * 2 AS megawatts, inputs_complete
           FROM ${from("energy_balance_period")} WHERE ${inWindow} ORDER BY island, trading_period`,
        )
      : [];
    const residual: EvidencePackage["context"]["energy_balance_residual"] = {
      modelled: true,
      note: residualNote,
      megawatts: {},
    };
    for (const island of ISLANDS) {
      const rows = balanceRows.filter((row) => row.island === island);
      if (rows.length === 0) continue;
      residual.megawatts[island] = align(rows, "megawatts");
      const row = rowAt(rows, peak, () => true);
      const mw = num(row?.megawatts);
      if (row === undefined || mw === null) continue;
      claim({
        id: `balance_residual.${island}.p${peak}`,
        label: `Modelled energy-balance residual, ${island}, period ${peak}`,
        value: mw,
        unit: "MW",
        table: "energy_balance_period",
        queryId: "balanceClaims",
        period: peak,
        subject: island,
        rowComplete: Boolean(row.inputs_complete),
        note: residualNote,
      });
    }

    // The episode itself.
    for (const [key, label, value, unit] of [
      [
        "severity",
        "Episode severity (worst member)",
        episode.severity,
        "severity",
      ],
      [
        "member_count",
        "Observations in the episode",
        episode.member_count,
        "count",
      ],
      [
        "period_count",
        "Trading periods in the episode",
        episode.period_count,
        "periods",
      ],
    ] as const)
      claim({
        id: `episode.${key}`,
        label,
        value,
        unit,
        table: "episodes",
        queryId: "episodeClaims",
        subject: episode.episode_id,
        rowComplete: episode.inputs_complete,
      });

    // Day-level figures, for the context of the day.
    const dayPrices = present("price_daily_summary")
      ? await query(
          `SELECT point_of_connection, mean_price, max_price, inputs_complete
           FROM ${from("price_daily_summary")} ORDER BY point_of_connection`,
        )
      : [];
    for (const row of dayPrices) {
      const id = String(row.point_of_connection);
      const common = {
        table: "price_daily_summary",
        queryId: "dayPriceClaims",
        subject: id,
        rowComplete: Boolean(row.inputs_complete),
      };
      const mean = num(row.mean_price);
      const max = num(row.max_price);
      if (mean !== null)
        claim({
          ...common,
          id: `day.price_mean.${id}`,
          label: `Mean of the period prices at ${id} for the day`,
          value: mean,
          unit: "$/MWh",
        });
      if (max !== null)
        claim({
          ...common,
          id: `day.price_max.${id}`,
          label: `Highest dispatch publish at ${id} for the day`,
          value: max,
          unit: "$/MWh",
          note: "An extremum of dispatch publishes, not of period prices.",
        });
    }
    if (present("price_distribution")) {
      const [row] = await query(
        `SELECT poc_count, median_price, max_price, inputs_complete
         FROM ${from("price_distribution")} WHERE trading_period = ${peak}`,
      );
      if (row !== undefined) {
        const common = {
          table: "price_distribution",
          queryId: "distributionClaims",
          period: peak,
          rowComplete: Boolean(row.inputs_complete),
        };
        const median = num(row.median_price);
        const max = num(row.max_price);
        const count = num(row.poc_count);
        if (median !== null)
          claim({
            ...common,
            id: `distribution.median.p${peak}`,
            label: `Median period price over all priced points of connection, period ${peak}`,
            value: median,
            unit: "$/MWh",
          });
        if (max !== null)
          claim({
            ...common,
            id: `distribution.max.p${peak}`,
            label: `Highest period price over all priced points of connection, period ${peak}`,
            value: max,
            unit: "$/MWh",
            note: "Gold does not keep which point of connection it was.",
          });
        if (count !== null)
          claim({
            ...common,
            id: `distribution.poc_count.p${peak}`,
            label: `Points of connection with a period price, period ${peak}`,
            value: count,
            unit: "count",
          });
      }
    }
    if (present("generation_by_fuel_day")) {
      const rows = await query(
        `SELECT fuel_category, sum(megawatt_hours) AS mwh, bool_and(inputs_complete) AS inputs_complete
         FROM ${from("generation_by_fuel_day")} GROUP BY fuel_category ORDER BY fuel_category`,
      );
      const ids: string[] = [];
      let primary = 0;
      let hydro = 0;
      for (const row of rows) {
        const fuel = String(row.fuel_category);
        const mwh = num(row.mwh);
        if (mwh === null) continue;
        const id = `day.generation.${fuel}.mwh`;
        claim({
          id,
          label: `Metered generation for the day, ${fuel}, all islands`,
          value: mwh,
          unit: "MWh",
          table: "generation_by_fuel_day",
          queryId: "dayGenerationClaims",
          subject: fuel,
          rowComplete: Boolean(row.inputs_complete),
        });
        if (fuel === "battery") continue;
        ids.push(id);
        primary += mwh;
        if (fuel === "hydro") hydro = mwh;
      }
      if (primary > 0 && ids.includes("day.generation.hydro.mwh"))
        claim({
          id: "day.generation.hydro_share",
          label: "Hydro share of primary energy for the day (battery excluded)",
          value: (hydro / primary) * 100,
          unit: "%",
          table: "generation_by_fuel_day",
          queryId: "dayGenerationClaims",
          subject: "hydro",
          dependsOn: ids,
        });
    }
    if (present("hvdc_transfer_day")) {
      const [row] = await query(
        `SELECT north_island_received_mwh, average_megawatts, inputs_complete
         FROM ${from("hvdc_transfer_day")}`,
      );
      if (row !== undefined) {
        const common = {
          table: "hvdc_transfer_day",
          queryId: "dayHvdcClaims",
          subject: "HAY2201",
          rowComplete: Boolean(row.inputs_complete),
        };
        const mwh = num(row.north_island_received_mwh);
        const mw = num(row.average_megawatts);
        if (mwh !== null)
          claim({
            ...common,
            id: "day.hvdc.received_mwh",
            label: "HVDC energy received in the North Island for the day",
            value: mwh,
            unit: "MWh",
          });
        if (mw !== null)
          claim({
            ...common,
            id: "day.hvdc.average_mw",
            label: "HVDC average transfer for the day",
            value: mw,
            unit: "MW",
            note: hvdcNote,
          });
      }
    }

    const completenessEntries: CompletenessEntry[] = [...uses.values()]
      .map(({ abs: _abs, ...entry }) => entry)
      .sort((a, b) =>
        a.layer === b.layer
          ? a.table.localeCompare(b.table)
          : a.layer.localeCompare(b.layer),
      );
    const goldPartitions = completenessEntries
      .filter((entry) => entry.layer === "gold" && entry.status !== "missing")
      .map((entry) => entry.path);

    return {
      schema_version: EVIDENCE_SCHEMA_VERSION,
      builder_version: BUILDER_VERSION,
      episode,
      window: {
        trading_date: date,
        start_trading_period: first,
        end_trading_period: last,
        peak_trading_period: peak,
        periods,
      },
      observations,
      context: {
        prices,
        spreads,
        reserves,
        generation_by_fuel: generationByFuel,
        generation_by_plant: generationByPlant,
        hvdc,
        load,
        energy_balance_residual: residual,
      },
      completeness: completenessEntries,
      claims,
      limits: EVIDENCE_LIMITS,
      links: {
        daily_page: `/${date.slice(0, 4)}/${date.slice(5, 7)}/${date.slice(8, 10)}/`,
        day_json: `gold/site/days/${date}.json`,
        gold_partitions: goldPartitions,
        silver_partitions: [],
        source_datasets: [],
      },
    };
  } finally {
    connection.closeSync();
  }
}

/** `['a', 'b']::VARCHAR[]` for a DuckDB `list_contains`. */
const listSql = (values: readonly string[]) =>
  values.length === 0
    ? "[]::VARCHAR[]"
    : `[${values.map(lit).join(", ")}]::VARCHAR[]`;

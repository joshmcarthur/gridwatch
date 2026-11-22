import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { lit } from "../silver/common.ts";
import {
  type CompletenessView,
  completenessKey,
} from "../silver/completeness.ts";
import { periodsInTradingDate } from "../trading-time.ts";
import {
  asIso,
  byString,
  goldPartitionPath,
  listSql,
  silverPartitionPath,
} from "./common.ts";
import { CORROBORATION_RULES } from "./episodes.ts";
import {
  type ClaimContext,
  type ClaimInput,
  dayClaims,
  derivedClaims,
  dispatchClaims,
  episodeClaims,
  findPeak,
  generationClaims,
  hvdcClaims,
  loadClaims,
  priceClaims,
  type Row,
  reserveClaims,
  round,
  spreadClaims,
} from "./evidence-claims.ts";
import { TABLES as PRICE_ANOMALY_TABLES } from "./price-anomaly.ts";
import { TABLES as PRICE_SEPARATION_TABLES } from "./price-separation.ts";
import { REFERENCE_NODES } from "./prices.ts";
import { TABLES as RESERVE_PRICE_ANOMALY_TABLES } from "./reserve-price-anomaly.ts";

/**
 * Evidence package for one episode (issue #38, ADR-0025). The builder reads gold (and, for
 * dispatch publishes and reference data, silver) and returns one JSON-ready object. It writes no
 * prose and no file. The CLI (`evidence.cli.ts`) writes the file. The claim catalogue is in
 * `evidence-claims.ts`.
 *
 * Every claim is `confirmed`: its value is read straight from a gold or silver row, or it is a
 * plain sum, difference or join of confirmed claims, named in `depends_on`. The type keeps the
 * other two levels of brief section 7.2 so that later work needs no schema change. This builder
 * never writes them.
 */

/** Bump when the shape of the package changes. */
export const EVIDENCE_SCHEMA_VERSION = 2;
/** Bump by hand when a claim, a rule or a config value of the builder changes. */
export const BUILDER_VERSION = 3;

export const EVIDENCE_CONFIG = {
  /** Periods before the episode start that the window holds (clamped to period 1). */
  periodsBefore: 4,
  /** Periods after the episode end that the window holds (clamped to the last period). */
  periodsAfter: 2,
  /** Plants listed from the peak period: the top N by average MW, the episode's plants and North Island thermal plants. */
  topPlants: 10,
  /** The thermal ramp starts this many periods before the peak (not before the window). */
  rampPeriods: 4,
  /** Dispatch publish counts. A node counts when any publish in the peak period reaches it. */
  scarcityPrices: [20000, 10000],
  /** Fuel categories that make up thermal generation (ADR-0008). */
  thermalFuels: ["coal_gas", "gas"],
  /** Extra energy nodes whose highest peak-period publish is stored beside the overall highest. */
  namedEnergyNodes: ["HEP0331"],
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

export type Series = Array<number | null>;

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

/** The highest dispatch publish of the peak period. */
export interface DispatchPeak {
  node: string;
  island: string | null;
  time_utc: string;
  price: number;
  seconds_to_next_publish: number;
  /** Nodes with a publish at or above each scarcity price, keyed by the price. */
  nodes_at_or_above: Record<string, number>;
}

export interface EvidencePlantReference {
  plant_id: string;
  plant_name: string | null;
  fuel_category: string | null;
  island: string | null;
  operator: string | null;
  points_of_connection: string[];
  latitude: number | null;
  longitude: number | null;
}

export interface EvidencePointReference {
  point_of_connection: string;
  description: string | null;
  island: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
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
  /** Observations that overlap the episode on its island but are not members (ADR-0021, #180). */
  related_observations: EvidenceObservation[];
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
    dispatch_peak: {
      trading_period: number;
      energy: DispatchPeak | null;
      sir: DispatchPeak | null;
    };
  };
  /** A plant or node is null in a field when no source row matches it. */
  reference: {
    plants: EvidencePlantReference[];
    points_of_connection: EvidencePointReference[];
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
  ...CORROBORATION_RULES.map((rule) => rule.table),
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

/**
 * Fact tables that must have rows for the date. An empty partition is `partial`. Detector
 * observation tables may be empty on a quiet day and stay `complete`.
 */
const GOLD_TABLES_EMPTY_IS_PARTIAL = new Set<(typeof GOLD_TABLES)[number]>([
  "price_periods",
  "generation_by_fuel_period",
  "generation_by_plant_period",
  "generation_by_fuel_day",
]);

/** Silver tables for a trading date. `dataset` is the `_completeness` id. */
const SILVER_DATE_TABLES = [
  { table: "dispatch_energy_prices", dataset: "dispatch_energy_prices" },
  { table: "dispatch_reserve_prices", dataset: "dispatch_reserve_prices" },
  { table: "entity_units", dataset: "entity_mappings" },
] as const;

/** Silver tables with one snapshot for each collect day. They have no `_completeness` row. */
const SILVER_SNAPSHOT_TABLES = [
  "generation_fleet",
  "network_supply_points",
] as const;

const relativePath = (layer: "gold" | "silver", table: string, date: string) =>
  `${layer}/${table}/trading_date=${date}/data.parquet`;

/**
 * The snapshot of a table for a date: the newest on or before the date, or the oldest when none
 * is that old (the rule of ADR-0008 for the fleet). Undefined when the table has no snapshot.
 */
const snapshotDate = (
  silverDir: string,
  table: string,
  date: string,
): string | undefined => {
  const dir = join(silverDir, table);
  if (!existsSync(dir)) return undefined;
  const dates = readdirSync(dir)
    .filter((name) => name.startsWith("snapshot_date="))
    .map((name) => name.slice("snapshot_date=".length))
    .sort();
  return [...dates].reverse().find((day) => day <= date) ?? dates[0];
};

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

const INCOMPLETE_NOTE =
  "A source row has inputs_complete = false, or its table is not complete.";

type Query = (sql: string) => Promise<Row[]>;

/** Every table the builder reads gets one completeness entry, present or not. */
async function registerInputs(options: BuildEvidenceOptions, query: Query) {
  const { goldDir, silverDir, completeness, date } = options;
  const uses = new Map<string, Use>();
  for (const table of GOLD_TABLES) {
    const abs = goldPartitionPath(goldDir, table, date);
    const entry: Use = {
      layer: "gold",
      table,
      path: relativePath("gold", table, date),
      abs,
      status: "missing",
    };
    if (existsSync(abs)) {
      const [counts] = await query(
        `SELECT count(*) AS n,
            count(*) FILTER (WHERE NOT inputs_complete) AS incomplete
           FROM read_parquet(${lit(abs)})`,
      );
      const n = Number(counts?.n);
      const incomplete = Number(counts?.incomplete);
      if (n === 0 && GOLD_TABLES_EMPTY_IS_PARTIAL.has(table)) {
        entry.status = "partial";
        entry.detail = "0 rows";
      } else if (incomplete === 0) {
        entry.status = "complete";
      } else {
        entry.status = "partial";
        entry.detail = `${incomplete} row(s) have inputs_complete = false`;
      }
    }
    uses.set(table, entry);
  }
  for (const { table, dataset } of SILVER_DATE_TABLES) {
    const abs = silverPartitionPath(silverDir, table, date);
    uses.set(table, {
      layer: "silver",
      table,
      path: relativePath("silver", table, date),
      abs,
      status: existsSync(abs)
        ? (completeness.get(completenessKey(dataset, date))?.status ??
          "missing")
        : "missing",
    });
  }
  for (const table of SILVER_SNAPSHOT_TABLES) {
    const day = snapshotDate(silverDir, table, date);
    uses.set(table, {
      layer: "silver",
      table,
      path: `silver/${table}/snapshot_date=${day ?? date}/data.parquet`,
      abs:
        day === undefined
          ? ""
          : join(silverDir, table, `snapshot_date=${day}`, "data.parquet"),
      status: day === undefined ? "missing" : "complete",
      ...(day === undefined ? {} : { detail: `snapshot ${day}` }),
    });
  }
  const use = (table: string): Use => {
    const found = uses.get(table);
    if (!found) throw new Error(`table ${table} is not registered`);
    return found;
  };
  const from = (table: string) => `read_parquet(${lit(use(table).abs)})`;
  // invalid is not read: a table is present when it is complete or partial.
  const present = (table: string) => {
    const { status } = use(table);
    return status === "complete" || status === "partial";
  };
  return { uses, use, from, present };
}

/** The episode row. Throws when the date has no episodes partition or the id is not in it. */
async function loadEpisode(
  options: BuildEvidenceOptions,
  query: Query,
  from: (table: string) => string,
  present: (table: string) => boolean,
): Promise<EvidenceEpisode> {
  const { episodeId, date } = options;
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
  return episode;
}

/**
 * Build the evidence package of one episode. Throws when the date has no episodes partition or
 * the id is not in it. A table that is absent gives a `missing` entry in `completeness` and no
 * claim. The same inputs give the same bytes: nothing in the package is a clock reading.
 */
export async function buildEvidencePackage(
  options: BuildEvidenceOptions,
): Promise<EvidencePackage> {
  const { date } = options;
  const periodsInDay = periodsInTradingDate(date);

  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    await connection.run("SET threads = 1");
    const query: Query = async (sql) =>
      (await connection.runAndReadAll(sql)).getRowObjectsJson() as Row[];

    const { uses, use, from, present } = await registerInputs(options, query);
    const episode = await loadEpisode(options, query, from, present);

    // The window, and the peak: the episode period with the highest reference-node price.
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
    const peak = await findPeak(
      query,
      present("price_periods") ? from("price_periods") : null,
      episode,
    );

    // Members of the episode, and observations that corroborate it without being members.
    const readObservations = async (table: string, where: string) => {
      if (!present(table)) return [];
      const rows = await query(
        `SELECT observation_id, observation_type, start_trading_period,
           end_trading_period, event_start_utc, event_end_utc, subject_type,
           subject_id, island, plant_id, measured_value, severity, inputs_complete
         FROM ${from(table)}
         WHERE ${where}`,
      );
      return rows.map(
        (row): EvidenceObservation => ({
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
        }),
      );
    };
    const byId = (a: EvidenceObservation, b: EvidenceObservation) =>
      byString(a.observation_id, b.observation_id);
    const observations: EvidenceObservation[] = [];
    for (const table of GOLD_DETECTOR_TABLES)
      observations.push(
        ...(await readObservations(
          table,
          `list_contains(${listSql(episode.member_observation_ids)}, observation_id)`,
        )),
      );
    observations.sort(byId);
    const relatedObservations: EvidenceObservation[] = [];
    for (const rule of CORROBORATION_RULES)
      relatedObservations.push(
        ...(await readObservations(
          rule.table,
          `observation_type = ${lit(rule.observationType)}
           AND island IN (${episode.islands.map(lit).join(", ") || "NULL"})
           AND event_start_utc < ${lit(episode.event_end_utc)}::TIMESTAMPTZ
           AND ${lit(episode.event_start_utc)}::TIMESTAMPTZ < event_end_utc`,
        )),
      );
    relatedObservations.sort(byId);

    const claims: Claim[] = [];
    const claim = (input: ClaimInput) => {
      if (claims.some((existing) => existing.id === input.id))
        throw new Error(`duplicate claim id ${input.id}`);
      const table = use(input.table);
      const dependencies = (input.dependsOn ?? []).map((id) =>
        claims.find((existing) => existing.id === id),
      );
      const incomplete =
        input.rowComplete === false ||
        table.status !== "complete" ||
        dependencies.some((dependency) =>
          dependency?.note?.includes(INCOMPLETE_NOTE),
        );
      const notes = [
        input.note,
        incomplete ? INCOMPLETE_NOTE : undefined,
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
    const context: ClaimContext = {
      date,
      config: EVIDENCE_CONFIG,
      episode,
      periods,
      peak,
      rampStart: Math.max(first, peak - EVIDENCE_CONFIG.rampPeriods),
      claimPeriods: [...new Set([episode.start_trading_period, peak])].sort(
        (a, b) => a - b,
      ),
      claims,
      query,
      from,
      present,
      claim,
    };

    const prices = await priceClaims(context);
    const spreads = await spreadClaims(context);
    const reserves = await reserveClaims(context);
    const generation = await generationClaims(context);
    const hvdc = await hvdcClaims(context);
    const load = await loadClaims(context);
    episodeClaims(context);
    await dayClaims(context);
    const dispatchPeak = await dispatchClaims(context);
    derivedClaims(context);

    // Reference data: names, operators and places of what the claims mention.
    const reference = await referenceData({
      query,
      from,
      present,
      date,
      plantIds: [
        ...new Set([
          ...episode.plant_ids,
          ...Object.keys(generation.generation_by_plant),
        ]),
      ].sort(),
      plants: generation.generation_by_plant,
      nodes: [
        ...REFERENCE_NODES.map((node) => node.pointOfConnection),
        ...(dispatchPeak.energy === null ? [] : [dispatchPeak.energy.node]),
      ],
    });

    const entries: CompletenessEntry[] = [...uses.values()]
      .map(({ abs: _abs, ...entry }) => entry)
      .sort((a, b) =>
        a.layer === b.layer
          ? byString(a.table, b.table)
          : byString(a.layer, b.layer),
      );
    const partitions = (layer: "gold" | "silver") =>
      entries
        .filter((entry) => entry.layer === layer && entry.status !== "missing")
        .map((entry) => entry.path);
    const silverPartitions = partitions("silver");

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
      related_observations: relatedObservations,
      context: {
        prices,
        spreads,
        reserves,
        generation_by_fuel: generation.generation_by_fuel,
        generation_by_plant: generation.generation_by_plant,
        hvdc,
        load: load.load,
        energy_balance_residual: load.energy_balance_residual,
        dispatch_peak: dispatchPeak,
      },
      reference,
      completeness: entries,
      claims,
      limits: [
        ...EVIDENCE_LIMITS,
        ...episode.plant_ids
          .filter((id) => !(id in generation.generation_by_plant))
          .map((id) => ({
            issue: 38,
            text: `Episode plant ${id} has no row in the peak period and is not listed.`,
          })),
      ],
      links: {
        daily_page: `/${date.slice(0, 4)}/${date.slice(5, 7)}/${date.slice(8, 10)}/`,
        day_json: `gold/site/days/${date}.json`,
        gold_partitions: partitions("gold"),
        silver_partitions: silverPartitions,
        source_datasets: [
          ...SILVER_DATE_TABLES.map((item) => item.table),
          ...SILVER_SNAPSHOT_TABLES,
        ].filter((table) =>
          silverPartitions.some((path) => path.startsWith(`silver/${table}/`)),
        ),
      },
    };
  } finally {
    connection.closeSync();
  }
}

/** The package as the CLI writes it: two-space JSON and a final newline. */
export const serializeEvidencePackage = (pkg: EvidencePackage): string =>
  `${JSON.stringify(pkg, null, 2)}\n`;

/**
 * Plants and points of connection that the package mentions. The operator comes from the fleet
 * through the unit's operator code. The place is the point of connection in force in the network
 * supply points. A field is null when no row matches.
 */
async function referenceData(input: {
  query: ClaimContext["query"];
  from: ClaimContext["from"];
  present: ClaimContext["present"];
  date: string;
  plantIds: string[];
  plants: EvidencePackage["context"]["generation_by_plant"];
  nodes: string[];
}): Promise<EvidencePackage["reference"]> {
  const { query, from, present, date } = input;
  const units = present("entity_units")
    ? await query(
        `SELECT plant_id, point_of_connection, plant_operator_code
         FROM ${from("entity_units")}
         WHERE list_contains(${listSql(input.plantIds)}, plant_id)
         ORDER BY plant_id, point_of_connection, unit_code`,
      )
    : [];
  const operators = new Map<string, string>();
  if (present("generation_fleet"))
    for (const row of await query(
      `SELECT plant_operator_code, min(plant_operator) AS plant_operator
       FROM ${from("generation_fleet")}
       WHERE effective_start_date <= DATE ${lit(date)}
         AND coalesce(effective_end_date, DATE '9999-12-31') > DATE ${lit(date)}
       GROUP BY plant_operator_code`,
    ))
      if (row.plant_operator !== null)
        operators.set(
          String(row.plant_operator_code),
          String(row.plant_operator),
        );

  const plantPocs = (id: string) => [
    ...new Set(
      units
        .filter((row) => row.plant_id === id)
        .map((row) => String(row.point_of_connection)),
    ),
  ];
  const pocs = [
    ...new Set([...input.nodes, ...input.plantIds.flatMap(plantPocs)]),
  ];
  const places = new Map<string, Row>();
  if (present("network_supply_points") && pocs.length > 0)
    for (const row of await query(
      `SELECT point_of_connection, description, island, network_reporting_region,
         latitude, longitude
       FROM ${from("network_supply_points")}
       WHERE list_contains(${listSql(pocs)}, point_of_connection)
         AND start_date <= DATE ${lit(date)}
         AND coalesce(end_date, DATE '9999-12-31') >= DATE ${lit(date)}
       ORDER BY point_of_connection, start_date DESC, nsp`,
    ))
      if (!places.has(String(row.point_of_connection)))
        places.set(String(row.point_of_connection), row);

  const text = (value: unknown) =>
    value === null || value === undefined || value === ""
      ? null
      : String(value);
  const coordinate = (value: unknown) =>
    value === null || value === undefined ? null : round(Number(value), 6);

  return {
    plants: input.plantIds.map((id) => {
      const known = input.plants[id];
      const own = plantPocs(id);
      const place = own
        .map((poc) => places.get(poc))
        .find((row) => row !== undefined);
      const code = units.find(
        (row) => row.plant_id === id,
      )?.plant_operator_code;
      return {
        plant_id: id,
        plant_name: known?.plant_name ?? null,
        fuel_category: known?.fuel_category ?? null,
        island: known?.island ?? null,
        operator:
          code === null || code === undefined
            ? null
            : (operators.get(String(code)) ?? null),
        points_of_connection: own,
        latitude: coordinate(place?.latitude),
        longitude: coordinate(place?.longitude),
      };
    }),
    points_of_connection: [...new Set(input.nodes)].sort().map((poc) => {
      const place = places.get(poc);
      return {
        point_of_connection: poc,
        description: text(place?.description),
        island: text(place?.island),
        region: text(place?.network_reporting_region),
        latitude: coordinate(place?.latitude),
        longitude: coordinate(place?.longitude),
      };
    }),
  };
}

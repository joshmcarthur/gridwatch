/**
 * The site JSON contract (ADR-0014). The publisher writes these files and the site reads them.
 * This file has no imports, so the site can import types and assert helpers through the
 * `exports` entry of the publisher package, and nothing else from the publisher.
 */

/** Bump only for a breaking change. Adding an optional field is not one (ADR-0014). */
export const SITE_CONTRACT_VERSION = 1;

/** The `--dataset` ID of the export, and the ID of its summary. */
export const SITE_EXPORT_ID = "site_days";

export type SectionState = "complete" | "incomplete" | "missing";
/** The same words as the `_completeness` status (ADR-0010). */
export type DatasetState = "complete" | "partial" | "missing" | "invalid";
export type Island = "NI" | "SI";
/** Instantaneous reserve class (ADR-0013). FIR is 6-second reserve, SIR is 60-second. */
export type ReserveClass = "FIR" | "SIR";
export type FuelCategory =
  | "hydro"
  | "geothermal"
  | "wind"
  | "gas"
  | "coal_gas"
  | "solar"
  | "battery"
  | "other"
  | "unmapped";
/** Gold generation path. Absence means metered (ADR-0014, ADR-0028). */
export type GenerationSource = "metered" | "dispatch";

/** One trading period. The end is `start_utc` plus 30 minutes. */
export interface SitePeriod {
  period: number;
  /** For example `2026-09-26T12:00:00Z`. */
  start_utc: string;
}

/** A silver dataset's row in `_completeness`, for the day. No row reads as `missing`. */
export interface SiteDatasetStatus {
  status: DatasetState;
  expected_period_count: number | null;
  actual_period_count: number | null;
  missing_periods: number[];
  /** Provenance. The `inputs_sha256` of entity mappings is held here (ADR-0010). */
  bronze_sha256s: string[];
  /** Messages of an invalid day. */
  errors: string[];
}

/** The fields that every section has, so the site checks one shape before it draws. */
export interface SectionBase {
  /** `missing`: no gold partition. `incomplete`: see ADR-0014. `complete`: neither. */
  state: SectionState;
  /**
   * Generation: periods with no row in the fuel period table. Prices: periods where a reference
   * node has a null price. Empty when the section is missing.
   */
  missing_periods: number[];
  /** From the gold rows. Null when the section is missing. */
  analysis_version: number | null;
  /** The gold fingerprint. Null when the section is missing. */
  inputs_sha256: string | null;
  /** The silver tables that the section reads. */
  silver_tables: string[];
  /** The gold tables that the section writes. */
  gold_tables: string[];
  /** Keys of `SiteDay.datasets` that the section reads. */
  datasets: string[];
}

export interface GenerationSection extends SectionBase {
  /**
   * One series for each fuel and island. `island` is null when the point of connection is not
   * mapped. Each array is aligned to `SiteDay.periods`.
   */
  series: Array<{
    fuel: FuelCategory;
    island: Island | null;
    megawatt_hours: Array<number | null>;
  }>;
  daily: Array<{
    fuel: FuelCategory;
    island: Island | null;
    megawatt_hours: number;
    average_megawatts: number;
  }>;
  /**
   * Optional. Absence means the exporter has not listed plants yet. One row per plant for the
   * day, from gold `generation_by_plant_day`. Empty when the section is missing or that gold
   * table is absent.
   */
  plants?: Array<{
    plant_id: string;
    plant_name: string;
    fuel: FuelCategory;
    island: Island | null;
    megawatt_hours: number;
    average_megawatts: number;
  }>;
  /**
   * Sums over all islands. `primary` excludes battery and includes `unmapped`. Null when the
   * section is missing. Provisional (ADR-0014).
   */
  totals: {
    primary_megawatt_hours: number;
    battery_megawatt_hours: number;
  } | null;
  /**
   * Optional. Absence means metered Generation_MD. `dispatch` is nodal unit megawatts for
   * days the monthly meter file has not reached (ADR-0028).
   */
  source?: GenerationSource;
}

export interface PricesSection extends SectionBase {
  nodes: Array<{
    point_of_connection: string;
    price_region: string;
    /** $/MWh. Null when silver has no row for the period. */
    price: Array<number | null>;
    /** Periods where gold marks the price as a proxy. */
    proxy_periods: number[];
    daily: {
      mean_price: number | null;
      min_price: number | null;
      max_price: number | null;
      periods_present: number;
      periods_expected: number;
      rows_present: number;
      inputs_complete: boolean;
    };
  }>;
  /** `from` minus `to`, north to south (ADR-0014). */
  spreads: Array<{
    from: string;
    to: string;
    from_price_region: string;
    to_price_region: string;
    spread: Array<number | null>;
  }>;
  distribution: {
    poc_count: number[];
    min: Array<number | null>;
    p05: Array<number | null>;
    p25: Array<number | null>;
    median: Array<number | null>;
    p75: Array<number | null>;
    p95: Array<number | null>;
    max: Array<number | null>;
  };
}

/** One island row of the daily energy balance (ADR-0018). Null terms are not zeros. */
export interface SankeyIsland {
  island: Island;
  /** Metered generation of the island, all fuels, battery included. */
  generation_megawatt_hours: number | null;
  /** Energy the island receives over the HVDC link. Negative when the island sends. */
  hvdc_import_megawatt_hours: number | null;
  /**
   * MWh the island receives over the link in each half-hour, negative when it sends. Aligned
   * to `SiteDay.periods`; null where gold has no value. Optional so older site files still
   * validate (ADR-0014, ADR-0031).
   */
  hvdc_import_by_period?: Array<number | null>;
  /** Grid load (modelled), not metered consumption. */
  load_megawatt_hours: number | null;
  /** generation + HVDC import − load. The sign is kept. Null when any term is null. */
  residual_megawatt_hours: number | null;
  /** Residual as a percent of load. Null when residual or load is null or load is 0. */
  residual_percent_of_load: number | null;
  inputs_complete: boolean;
}

/**
 * Daily energy balance and HVDC transfer (ADR-0014, ADR-0016, ADR-0018). Optional: absence
 * means the exporter has not built it. A day with no gold balance row is `missing`, never zeros.
 */
export interface SankeySection extends SectionBase {
  islands: SankeyIsland[];
  /**
   * HVDC link losses for the day. Not an island term. Null when the section is missing or gold
   * has no HVDC day row. Never estimated from island residuals.
   */
  link_losses_megawatt_hours: number | null;
  /** True when every island row is complete. Null when the section is missing. */
  inputs_complete: boolean | null;
}

/**
 * The observation that leads one type in an episode: the highest severity, then the
 * largest absolute measured value. Pair subjects set `pair_from` / `pair_to` and leave
 * `point_of_connection` null. Older JSON omits `highlights`.
 */
export interface SiteEpisodeHighlight {
  observation_type: string;
  point_of_connection: string | null;
  pair_from: string | null;
  pair_to: string | null;
  island: Island | null;
  measured_value: number;
  baseline_value: number;
}

/** One grouped stretch of unusual readings (ADR-0021). */
export interface SiteEpisode {
  episode_id: string;
  seed_observation_id: string;
  start_utc: string;
  end_utc: string;
  start_trading_period: number;
  end_trading_period: number;
  member_count: number;
  observation_types: string[];
  islands: Island[];
  severity: number;
  /** One row per observation type. Omitted on older JSON. */
  highlights?: SiteEpisodeHighlight[];
}

/**
 * Detected episodes for the day (ADR-0021). Optional: absence means the exporter has not
 * built it. A day with no gold episode_days row is `missing`. An empty `items` list is a
 * quiet day, not missing.
 */
export interface EpisodesSection extends SectionBase {
  items: SiteEpisode[];
}

/** One reserve class and island's daily prices (ADR-0013). */
export interface ReservesClassDay {
  reserve_class: ReserveClass;
  island: Island | null;
  /** $/MWh. Null when the day row has no mean. */
  mean_price: number | null;
  min_price: number | null;
  max_price: number | null;
  periods_present: number;
  periods_expected: number;
  rows_present: number;
  inputs_complete: boolean;
  /**
   * $/MWh. Aligned to `SiteDay.periods`. Null when silver has no row.
   * Optional so older site files still validate (ADR-0014).
   */
  price?: Array<number | null>;
}

/**
 * Daily reserve prices by class and island (ADR-0013, ADR-0014). Optional: absence means
 * the exporter has not built it. A day with no gold partition is `missing`, never zeros.
 */
export interface ReservesSection extends SectionBase {
  classes: ReservesClassDay[];
}

/** A priced POC with WGS84 coordinates, for the nodal map (ADR-0023). */
export interface NodalMapPoc {
  point_of_connection: string;
  latitude: number;
  longitude: number;
  island: Island | null;
  /** $/MWh. Aligned to `SiteDay.periods`. Null when silver has no row. */
  price: Array<number | null>;
  /** Periods where gold marks the price as a proxy. */
  proxy_periods: number[];
}

/** A priced POC with no coordinates. It is in the table, not on the map (ADR-0023). */
export interface NodalMapUnlocated {
  point_of_connection: string;
  island: Island | null;
  price: Array<number | null>;
  proxy_periods: number[];
}

/**
 * Nodal prices for the map page (ADR-0023). Optional: absence means the exporter has not
 * built it. `pocs` is only POCs with coordinates. `unlocated` is every other priced POC.
 */
export interface NodalMapSection extends SectionBase {
  pocs: NodalMapPoc[];
  unlocated: NodalMapUnlocated[];
}

/** ADR-0022. Default at publish is `unreviewed`. */
export type ReviewStatus = "unreviewed" | "reviewed";

/** Brief §7.2. The evidence builder writes `confirmed`; the other two stay for later interpretation. */
export type ClaimConfidence =
  | "confirmed"
  | "strong_evidence"
  | "possible_explanation";

/** One published event: a ranked candidate whose narrative passed `checkNarrative`. */
export interface SiteEventClaim {
  id: string;
  label: string;
  value: number | string | boolean;
  unit: string;
  confidence: ClaimConfidence;
  source_kind: "gold" | "silver";
  source_path: string;
}

export interface SiteEventWindow {
  /** Trading periods of the evidence window, not the whole day. */
  periods: number[];
  /** Aligned to `periods`. */
  start_utc: string[];
  prices: Array<{
    point_of_connection: string;
    /** Aligned to `periods`. */
    price: Array<number | null>;
  }>;
  reserves: Array<{
    reserve_class: ReserveClass;
    island: Island;
    /** Aligned to `periods`. */
    price: Array<number | null>;
  }>;
}

export interface SiteEvent {
  episode_id: string;
  review_status: ReviewStatus;
  observation_types: string[];
  islands: Island[];
  start_utc: string;
  end_utc: string;
  start_trading_period: number;
  end_trading_period: number;
  package_id: string;
  what_happened: string;
  why: string;
  what_it_means: string;
  claims: SiteEventClaim[];
  daily_page: string;
  window: SiteEventWindow;
}

/**
 * Ranked candidates that have a stored narrative (issue #42, ADR-0022). Optional: absence
 * means the exporter has not built it. A day with no ranking gold is `missing`. Candidates
 * without a narrative are omitted, not invented. A failing number check warns; it does not omit.
 */
export interface EventsSection extends SectionBase {
  items: SiteEvent[];
}

/** An extension point. The v1 exporter never writes one. A consumer treats absence as "not built". */
export type SiteExtension = { state: SectionState } & Record<string, unknown>;

export interface SiteDay {
  contract_version: number;
  /** `YYYY-MM-DD`, a calendar date in Pacific/Auckland. */
  trading_date: string;
  /** 46, 48 or 50 periods, always the full axis. Every aligned array has this length. */
  periods: SitePeriod[];
  /** True when every section is complete. */
  complete: boolean;
  /** Every dataset that a section reads, sorted by key. */
  datasets: Record<string, SiteDatasetStatus>;
  /** Always present. `state` may be `missing`. */
  generation: GenerationSection;
  /** Always present. `state` may be `missing`. */
  prices: PricesSection;
  /** Optional. Absence means not built. The exporter writes it on every day, `missing` when gold has no row. */
  reserves?: ReservesSection;
  /** Optional. Absence means not built. The exporter writes it on every day, `missing` when gold has no row. */
  sankey?: SankeySection;
  observations?: SiteExtension;
  episodes?: EpisodesSection;
  /** Optional. Absence means not built. The exporter writes it on every day, `missing` when gold has no row. */
  nodal_map?: NodalMapSection;
  /** Optional. Absence means not built. The exporter writes it on every day, `missing` when ranking gold is absent. */
  events?: EventsSection;
  /**
   * The day write-up by AI (ADR-0031). Optional: absent when there is none, or when the text
   * was over its length budget. Adding it did not change the contract version (ADR-0014).
   */
  narrative?: SiteDayNarrative;
}

/** A day write-up and what it was written from, for the "What this was written from" list. */
export interface SiteDayNarrative {
  text: string;
  model: string;
  generated_at: string;
  /** The day's moments the model was given. */
  moments: Array<{ title: string; when: string }>;
  /** Whether the package held the cable, the reserve peak, and an incomplete-files flag. */
  cable: boolean;
  reserve: boolean;
  incomplete: boolean;
}

export interface SiteIndexDay {
  date: string;
  /** `days/YYYY-MM-DD.json`, relative to `index.json`. */
  path: string;
  complete: boolean;
  sections: {
    generation: SectionState;
    prices: SectionState;
    /** Optional. The exporter writes it; older index files omit it. */
    sankey?: SectionState;
    /** Optional. Detected episodes for the day (ADR-0021). */
    episodes?: SectionState;
    /** Optional. Daily reserve prices (ADR-0013). Older index files omit it. */
    reserves?: SectionState;
    /** Optional. Nodal price map for the day (ADR-0023). */
    nodal_map?: SectionState;
    /** Optional. Published events for the day (issue #42). */
    events?: SectionState;
  };
  /** The held version of the day file (ADR-0014). */
  export_sha256: string;
}

export interface SiteIndex {
  contract_version: number;
  /** Every gold trading date, ascending. */
  days: SiteIndexDay[];
  /** One entry for each silver dataset in the registry. Null means no complete date. */
  latest_complete: Record<string, string | null>;
  /** The latest day in `days` whose section is `complete`. */
  latest_complete_sections: {
    generation: string | null;
    prices: string | null;
    /** Optional. The exporter writes it; older index files omit it. */
    sankey?: string | null;
    /** Optional. Latest day whose episodes section is complete. */
    episodes?: string | null;
    /** Optional. Latest day whose reserves section is complete. */
    reserves?: string | null;
    /** Optional. Latest day whose nodal map section is complete. */
    nodal_map?: string | null;
    /** Optional. Latest day whose events section is complete. */
    events?: string | null;
  };
}

const SECTION_STATES: readonly SectionState[] = [
  "complete",
  "incomplete",
  "missing",
];
const DATASET_STATES: readonly DatasetState[] = [
  "complete",
  "partial",
  "missing",
  "invalid",
];
const ISLANDS: readonly Island[] = ["NI", "SI"];
const GENERATION_SOURCES: readonly GenerationSource[] = ["metered", "dispatch"];
const RESERVE_CLASSES: readonly ReserveClass[] = ["FIR", "SIR"];
const REVIEW_STATUSES: readonly ReviewStatus[] = ["unreviewed", "reviewed"];
const CLAIM_CONFIDENCES: readonly ClaimConfidence[] = [
  "confirmed",
  "strong_evidence",
  "possible_explanation",
];
const EXTENSIONS = [
  "reserves",
  "sankey",
  "observations",
  "episodes",
  "nodal_map",
  "events",
] as const;
const DAY_LENGTHS = [46, 48, 50];

function fail(path: string, message: string): never {
  throw new TypeError(`${path}: ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(path, "expected an object");
  return value as Record<string, unknown>;
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    fail(path, `expected one of ${allowed.join(", ")}`);
  return value as T;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "expected a string");
  return value;
}

function flag(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "expected a boolean");
  return value;
}

function integer(value: unknown, path: string): number {
  if (!Number.isInteger(value)) fail(path, "expected an integer");
  return value as number;
}

function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(path, "expected a finite number");
  return value;
}

function nullable<T>(
  value: unknown,
  check: (value: unknown, path: string) => T,
  path: string,
): T | null {
  return value === null ? null : check(value, path);
}

function texts(value: unknown, path: string): string[] {
  return list(value, path).map((item, i) => text(item, `${path}[${i}]`));
}

function integerList(value: unknown, path: string): number[] {
  return list(value, path).map((item, i) => integer(item, `${path}[${i}]`));
}

function integers(value: unknown, path: string, max: number): number[] {
  return list(value, path).map((item, i) => {
    const n = integer(item, `${path}[${i}]`);
    if (n < 1 || n > max)
      fail(`${path}[${i}]`, `expected a period from 1 to ${max}`);
    return n;
  });
}

/** An aligned array: exactly `length` finite numbers. */
function numbers(value: unknown, length: number, path: string): number[] {
  const items = list(value, path);
  if (items.length !== length) fail(path, `expected ${length} entries`);
  return items.map((item, i) => number(item, `${path}[${i}]`));
}

/** An aligned array of numbers, where null means no value for that period. */
function nullableNumbers(
  value: unknown,
  length: number,
  path: string,
): Array<number | null> {
  const items = list(value, path);
  if (items.length !== length) fail(path, `expected ${length} entries`);
  return items.map((item, i) =>
    item === null ? null : number(item, `${path}[${i}]`),
  );
}

function checkDatasetStatus(value: unknown, path: string): void {
  const status = record(value, path);
  oneOf(status.status, DATASET_STATES, `${path}.status`);
  nullable(
    status.expected_period_count,
    integer,
    `${path}.expected_period_count`,
  );
  nullable(status.actual_period_count, integer, `${path}.actual_period_count`);
  integerList(status.missing_periods, `${path}.missing_periods`);
  texts(status.bronze_sha256s, `${path}.bronze_sha256s`);
  texts(status.errors, `${path}.errors`);
}

/** The fields every section has. Returns the state and the length of its aligned arrays. */
function checkSectionBase(
  value: Record<string, unknown>,
  path: string,
  periodCount: number,
): { state: SectionState; length: number; datasets: string[] } {
  const state = oneOf(value.state, SECTION_STATES, `${path}.state`);
  const missing = state === "missing";
  const missingPeriods = integers(
    value.missing_periods,
    `${path}.missing_periods`,
    periodCount,
  );
  nullable(value.analysis_version, integer, `${path}.analysis_version`);
  nullable(value.inputs_sha256, text, `${path}.inputs_sha256`);
  texts(value.silver_tables, `${path}.silver_tables`);
  texts(value.gold_tables, `${path}.gold_tables`);
  const datasets = texts(value.datasets, `${path}.datasets`);
  if (missing) {
    if (missingPeriods.length > 0 || value.analysis_version !== null)
      fail(
        path,
        "a missing section has no missing periods or analysis version",
      );
    if (value.inputs_sha256 !== null)
      fail(`${path}.inputs_sha256`, "a missing section has no fingerprint");
  }
  return { state, length: missing ? 0 : periodCount, datasets };
}

function checkEmptyWhenMissing(
  items: unknown[],
  state: SectionState,
  path: string,
): void {
  if (state === "missing" && items.length > 0)
    fail(path, "a missing section has no entries");
}

function checkGeneration(
  value: unknown,
  path: string,
  periodCount: number,
): string[] {
  const section = record(value, path);
  const base = checkSectionBase(section, path, periodCount);
  const series = list(section.series, `${path}.series`);
  checkEmptyWhenMissing(series, base.state, `${path}.series`);
  series.forEach((item, i) => {
    const at = `${path}.series[${i}]`;
    const row = record(item, at);
    text(row.fuel, `${at}.fuel`);
    nullable(row.island, (v, p) => oneOf(v, ISLANDS, p), `${at}.island`);
    nullableNumbers(row.megawatt_hours, base.length, `${at}.megawatt_hours`);
  });
  const daily = list(section.daily, `${path}.daily`);
  checkEmptyWhenMissing(daily, base.state, `${path}.daily`);
  daily.forEach((item, i) => {
    const at = `${path}.daily[${i}]`;
    const row = record(item, at);
    text(row.fuel, `${at}.fuel`);
    nullable(row.island, (v, p) => oneOf(v, ISLANDS, p), `${at}.island`);
    number(row.megawatt_hours, `${at}.megawatt_hours`);
    number(row.average_megawatts, `${at}.average_megawatts`);
  });
  if (section.plants !== undefined) {
    const plants = list(section.plants, `${path}.plants`);
    checkEmptyWhenMissing(plants, base.state, `${path}.plants`);
    plants.forEach((item, i) => {
      const at = `${path}.plants[${i}]`;
      const row = record(item, at);
      text(row.plant_id, `${at}.plant_id`);
      text(row.plant_name, `${at}.plant_name`);
      text(row.fuel, `${at}.fuel`);
      nullable(row.island, (v, p) => oneOf(v, ISLANDS, p), `${at}.island`);
      number(row.megawatt_hours, `${at}.megawatt_hours`);
      number(row.average_megawatts, `${at}.average_megawatts`);
    });
  }
  if (section.source !== undefined)
    oneOf(section.source, GENERATION_SOURCES, `${path}.source`);
  if (base.state === "missing") {
    if (section.totals !== null)
      fail(`${path}.totals`, "a missing section has null totals");
  } else {
    const totals = record(section.totals, `${path}.totals`);
    number(
      totals.primary_megawatt_hours,
      `${path}.totals.primary_megawatt_hours`,
    );
    number(
      totals.battery_megawatt_hours,
      `${path}.totals.battery_megawatt_hours`,
    );
  }
  return base.datasets;
}

function checkPrices(
  value: unknown,
  path: string,
  periodCount: number,
): string[] {
  const section = record(value, path);
  const base = checkSectionBase(section, path, periodCount);
  const nodes = list(section.nodes, `${path}.nodes`);
  checkEmptyWhenMissing(nodes, base.state, `${path}.nodes`);
  nodes.forEach((item, i) => {
    const at = `${path}.nodes[${i}]`;
    const node = record(item, at);
    text(node.point_of_connection, `${at}.point_of_connection`);
    text(node.price_region, `${at}.price_region`);
    nullableNumbers(node.price, base.length, `${at}.price`);
    integers(node.proxy_periods, `${at}.proxy_periods`, periodCount);
    const daily = record(node.daily, `${at}.daily`);
    nullable(daily.mean_price, number, `${at}.daily.mean_price`);
    nullable(daily.min_price, number, `${at}.daily.min_price`);
    nullable(daily.max_price, number, `${at}.daily.max_price`);
    integer(daily.periods_present, `${at}.daily.periods_present`);
    integer(daily.periods_expected, `${at}.daily.periods_expected`);
    integer(daily.rows_present, `${at}.daily.rows_present`);
    flag(daily.inputs_complete, `${at}.daily.inputs_complete`);
  });
  const spreads = list(section.spreads, `${path}.spreads`);
  checkEmptyWhenMissing(spreads, base.state, `${path}.spreads`);
  spreads.forEach((item, i) => {
    const at = `${path}.spreads[${i}]`;
    const spread = record(item, at);
    text(spread.from, `${at}.from`);
    text(spread.to, `${at}.to`);
    text(spread.from_price_region, `${at}.from_price_region`);
    text(spread.to_price_region, `${at}.to_price_region`);
    nullableNumbers(spread.spread, base.length, `${at}.spread`);
  });
  const distribution = record(section.distribution, `${path}.distribution`);
  const at = `${path}.distribution`;
  numbers(distribution.poc_count, base.length, `${at}.poc_count`);
  for (const key of ["min", "p05", "p25", "median", "p75", "p95", "max"])
    nullableNumbers(distribution[key], base.length, `${at}.${key}`);
  return base.datasets;
}

function checkSankey(
  value: unknown,
  path: string,
  periodCount: number,
): string[] {
  const section = record(value, path);
  const base = checkSectionBase(section, path, periodCount);
  const islands = list(section.islands, `${path}.islands`);
  checkEmptyWhenMissing(islands, base.state, `${path}.islands`);
  islands.forEach((item, i) => {
    const at = `${path}.islands[${i}]`;
    const row = record(item, at);
    oneOf(row.island, ISLANDS, `${at}.island`);
    nullable(
      row.generation_megawatt_hours,
      number,
      `${at}.generation_megawatt_hours`,
    );
    nullable(
      row.hvdc_import_megawatt_hours,
      number,
      `${at}.hvdc_import_megawatt_hours`,
    );
    if (row.hvdc_import_by_period !== undefined)
      nullableNumbers(
        row.hvdc_import_by_period,
        base.length,
        `${at}.hvdc_import_by_period`,
      );
    nullable(row.load_megawatt_hours, number, `${at}.load_megawatt_hours`);
    nullable(
      row.residual_megawatt_hours,
      number,
      `${at}.residual_megawatt_hours`,
    );
    nullable(
      row.residual_percent_of_load,
      number,
      `${at}.residual_percent_of_load`,
    );
    flag(row.inputs_complete, `${at}.inputs_complete`);
  });
  nullable(
    section.link_losses_megawatt_hours,
    number,
    `${path}.link_losses_megawatt_hours`,
  );
  nullable(section.inputs_complete, flag, `${path}.inputs_complete`);
  if (base.state === "missing") {
    if (section.link_losses_megawatt_hours !== null)
      fail(
        `${path}.link_losses_megawatt_hours`,
        "a missing section has no link losses",
      );
    if (section.inputs_complete !== null)
      fail(
        `${path}.inputs_complete`,
        "a missing section has no inputs_complete",
      );
  }
  return base.datasets;
}

function checkNodalMapNode(
  value: unknown,
  path: string,
  periodCount: number,
  length: number,
  located: boolean,
): void {
  const row = record(value, path);
  text(row.point_of_connection, `${path}.point_of_connection`);
  if (located) {
    number(row.latitude, `${path}.latitude`);
    number(row.longitude, `${path}.longitude`);
  }
  nullable(row.island, (v, p) => oneOf(v, ISLANDS, p), `${path}.island`);
  nullableNumbers(row.price, length, `${path}.price`);
  integers(row.proxy_periods, `${path}.proxy_periods`, periodCount);
}

function checkNodalMap(
  value: unknown,
  path: string,
  periodCount: number,
): string[] {
  const section = record(value, path);
  const base = checkSectionBase(section, path, periodCount);
  const pocs = list(section.pocs, `${path}.pocs`);
  const unlocated = list(section.unlocated, `${path}.unlocated`);
  checkEmptyWhenMissing(pocs, base.state, `${path}.pocs`);
  checkEmptyWhenMissing(unlocated, base.state, `${path}.unlocated`);
  pocs.forEach((item, i) => {
    checkNodalMapNode(
      item,
      `${path}.pocs[${i}]`,
      periodCount,
      base.length,
      true,
    );
  });
  unlocated.forEach((item, i) => {
    checkNodalMapNode(
      item,
      `${path}.unlocated[${i}]`,
      periodCount,
      base.length,
      false,
    );
  });
  return base.datasets;
}

function checkReserves(
  value: unknown,
  path: string,
  periodCount: number,
): string[] {
  const section = record(value, path);
  const base = checkSectionBase(section, path, periodCount);
  const classes = list(section.classes, `${path}.classes`);
  checkEmptyWhenMissing(classes, base.state, `${path}.classes`);
  classes.forEach((item, i) => {
    const at = `${path}.classes[${i}]`;
    const row = record(item, at);
    oneOf(row.reserve_class, RESERVE_CLASSES, `${at}.reserve_class`);
    nullable(row.island, (v, p) => oneOf(v, ISLANDS, p), `${at}.island`);
    nullable(row.mean_price, number, `${at}.mean_price`);
    nullable(row.min_price, number, `${at}.min_price`);
    nullable(row.max_price, number, `${at}.max_price`);
    integer(row.periods_present, `${at}.periods_present`);
    integer(row.periods_expected, `${at}.periods_expected`);
    integer(row.rows_present, `${at}.rows_present`);
    flag(row.inputs_complete, `${at}.inputs_complete`);
    if (row.price !== undefined)
      nullableNumbers(row.price, base.length, `${at}.price`);
  });
  return base.datasets;
}

function checkEpisodes(
  value: unknown,
  path: string,
  periodCount: number,
): string[] {
  const section = record(value, path);
  const base = checkSectionBase(section, path, periodCount);
  const items = list(section.items, `${path}.items`);
  checkEmptyWhenMissing(items, base.state, `${path}.items`);
  items.forEach((item, i) => {
    const at = `${path}.items[${i}]`;
    const row = record(item, at);
    text(row.episode_id, `${at}.episode_id`);
    text(row.seed_observation_id, `${at}.seed_observation_id`);
    text(row.start_utc, `${at}.start_utc`);
    text(row.end_utc, `${at}.end_utc`);
    integer(row.start_trading_period, `${at}.start_trading_period`);
    integer(row.end_trading_period, `${at}.end_trading_period`);
    integer(row.member_count, `${at}.member_count`);
    texts(row.observation_types, `${at}.observation_types`);
    const islands = list(row.islands, `${at}.islands`);
    for (let j = 0; j < islands.length; j++)
      oneOf(islands[j], ISLANDS, `${at}.islands[${j}]`);
    number(row.severity, `${at}.severity`);
    if (row.highlights !== undefined) {
      const highlights = list(row.highlights, `${at}.highlights`);
      highlights.forEach((item, h) => {
        const pathAt = `${at}.highlights[${h}]`;
        const highlight = record(item, pathAt);
        text(highlight.observation_type, `${pathAt}.observation_type`);
        nullable(
          highlight.point_of_connection,
          text,
          `${pathAt}.point_of_connection`,
        );
        nullable(highlight.pair_from, text, `${pathAt}.pair_from`);
        nullable(highlight.pair_to, text, `${pathAt}.pair_to`);
        nullable(
          highlight.island,
          (value, islandPath) => oneOf(value, ISLANDS, islandPath),
          `${pathAt}.island`,
        );
        number(highlight.measured_value, `${pathAt}.measured_value`);
        number(highlight.baseline_value, `${pathAt}.baseline_value`);
      });
    }
  });
  return base.datasets;
}

function claimValue(value: unknown, path: string): number | string | boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  return number(value, path);
}

function checkEventWindow(value: unknown, path: string): void {
  const window = record(value, path);
  const periods = integerList(window.periods, `${path}.periods`);
  const start = texts(window.start_utc, `${path}.start_utc`);
  if (start.length !== periods.length)
    fail(`${path}.start_utc`, `expected ${periods.length} entries`);
  const prices = list(window.prices, `${path}.prices`);
  prices.forEach((item, i) => {
    const at = `${path}.prices[${i}]`;
    const row = record(item, at);
    text(row.point_of_connection, `${at}.point_of_connection`);
    nullableNumbers(row.price, periods.length, `${at}.price`);
  });
  const reserves = list(window.reserves, `${path}.reserves`);
  reserves.forEach((item, i) => {
    const at = `${path}.reserves[${i}]`;
    const row = record(item, at);
    oneOf(row.reserve_class, RESERVE_CLASSES, `${at}.reserve_class`);
    oneOf(row.island, ISLANDS, `${at}.island`);
    nullableNumbers(row.price, periods.length, `${at}.price`);
  });
}

function checkEvents(
  value: unknown,
  path: string,
  periodCount: number,
): string[] {
  const section = record(value, path);
  const base = checkSectionBase(section, path, periodCount);
  const items = list(section.items, `${path}.items`);
  checkEmptyWhenMissing(items, base.state, `${path}.items`);
  items.forEach((item, i) => {
    const at = `${path}.items[${i}]`;
    const row = record(item, at);
    text(row.episode_id, `${at}.episode_id`);
    oneOf(row.review_status, REVIEW_STATUSES, `${at}.review_status`);
    texts(row.observation_types, `${at}.observation_types`);
    const islands = list(row.islands, `${at}.islands`);
    for (let j = 0; j < islands.length; j++)
      oneOf(islands[j], ISLANDS, `${at}.islands[${j}]`);
    text(row.start_utc, `${at}.start_utc`);
    text(row.end_utc, `${at}.end_utc`);
    integer(row.start_trading_period, `${at}.start_trading_period`);
    integer(row.end_trading_period, `${at}.end_trading_period`);
    text(row.package_id, `${at}.package_id`);
    text(row.what_happened, `${at}.what_happened`);
    text(row.why, `${at}.why`);
    text(row.what_it_means, `${at}.what_it_means`);
    text(row.daily_page, `${at}.daily_page`);
    const claims = list(row.claims, `${at}.claims`);
    claims.forEach((claim, j) => {
      const claimAt = `${at}.claims[${j}]`;
      const entry = record(claim, claimAt);
      text(entry.id, `${claimAt}.id`);
      text(entry.label, `${claimAt}.label`);
      claimValue(entry.value, `${claimAt}.value`);
      text(entry.unit, `${claimAt}.unit`);
      oneOf(entry.confidence, CLAIM_CONFIDENCES, `${claimAt}.confidence`);
      oneOf(
        entry.source_kind,
        ["gold", "silver"] as const,
        `${claimAt}.source_kind`,
      );
      text(entry.source_path, `${claimAt}.source_path`);
    });
    checkEventWindow(row.window, `${at}.window`);
  });
  return base.datasets;
}

/**
 * Throws a `TypeError` with the path of the first field that does not match the contract. The
 * exporter calls it on every day it writes, and the site may call it on every day it reads.
 */
export function assertSiteDay(value: unknown): asserts value is SiteDay {
  const day = record(value, "day");
  integer(day.contract_version, "contract_version");
  const date = text(day.trading_date, "trading_date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    fail("trading_date", "expected YYYY-MM-DD");
  const periods = list(day.periods, "periods");
  if (!DAY_LENGTHS.includes(periods.length))
    fail("periods", "expected 46, 48 or 50 entries");
  periods.forEach((item, i) => {
    const period = record(item, `periods[${i}]`);
    if (period.period !== i + 1)
      fail(`periods[${i}].period`, `expected ${i + 1}`);
    text(period.start_utc, `periods[${i}].start_utc`);
  });
  flag(day.complete, "complete");
  const datasets = record(day.datasets, "datasets");
  for (const [id, status] of Object.entries(datasets))
    checkDatasetStatus(status, `datasets.${id}`);
  const sectionDatasets = [
    ...checkGeneration(day.generation, "generation", periods.length),
    ...checkPrices(day.prices, "prices", periods.length),
  ];
  for (const key of EXTENSIONS) {
    if (day[key] === undefined) continue;
    switch (key) {
      case "sankey":
        sectionDatasets.push(...checkSankey(day[key], key, periods.length));
        break;
      case "episodes":
        sectionDatasets.push(...checkEpisodes(day[key], key, periods.length));
        break;
      case "nodal_map":
        sectionDatasets.push(...checkNodalMap(day[key], key, periods.length));
        break;
      case "reserves":
        sectionDatasets.push(...checkReserves(day[key], key, periods.length));
        break;
      case "events":
        sectionDatasets.push(...checkEvents(day[key], key, periods.length));
        break;
      case "observations":
        oneOf(record(day[key], key).state, SECTION_STATES, `${key}.state`);
        break;
      default: {
        const _exhaustive: never = key;
        return _exhaustive;
      }
    }
  }
  for (const id of sectionDatasets)
    if (!(id in datasets))
      fail("datasets", `${id} is read by a section but is not a key`);
  if (day.narrative !== undefined) checkDayNarrative(day.narrative);
}

function checkDayNarrative(value: unknown): void {
  const narrative = record(value, "narrative");
  text(narrative.text, "narrative.text");
  text(narrative.model, "narrative.model");
  text(narrative.generated_at, "narrative.generated_at");
  list(narrative.moments, "narrative.moments").forEach((item, i) => {
    const moment = record(item, `narrative.moments[${i}]`);
    text(moment.title, `narrative.moments[${i}].title`);
    text(moment.when, `narrative.moments[${i}].when`);
  });
  flag(narrative.cable, "narrative.cable");
  flag(narrative.reserve, "narrative.reserve");
  flag(narrative.incomplete, "narrative.incomplete");
}

/** Throws a `TypeError` with the path of the first field that does not match the contract. */
export function assertSiteIndex(value: unknown): asserts value is SiteIndex {
  const index = record(value, "index");
  integer(index.contract_version, "contract_version");
  const days = list(index.days, "days");
  let previous = "";
  days.forEach((item, i) => {
    const at = `days[${i}]`;
    const day = record(item, at);
    const date = text(day.date, `${at}.date`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      fail(`${at}.date`, "expected YYYY-MM-DD");
    if (date <= previous)
      fail(`${at}.date`, "expected ascending, unique dates");
    previous = date;
    text(day.path, `${at}.path`);
    flag(day.complete, `${at}.complete`);
    const sections = record(day.sections, `${at}.sections`);
    oneOf(sections.generation, SECTION_STATES, `${at}.sections.generation`);
    oneOf(sections.prices, SECTION_STATES, `${at}.sections.prices`);
    if (sections.sankey !== undefined)
      oneOf(sections.sankey, SECTION_STATES, `${at}.sections.sankey`);
    if (sections.episodes !== undefined)
      oneOf(sections.episodes, SECTION_STATES, `${at}.sections.episodes`);
    if (sections.reserves !== undefined)
      oneOf(sections.reserves, SECTION_STATES, `${at}.sections.reserves`);
    if (sections.nodal_map !== undefined)
      oneOf(sections.nodal_map, SECTION_STATES, `${at}.sections.nodal_map`);
    if (sections.events !== undefined)
      oneOf(sections.events, SECTION_STATES, `${at}.sections.events`);
    text(day.export_sha256, `${at}.export_sha256`);
  });
  for (const [id, date] of Object.entries(
    record(index.latest_complete, "latest_complete"),
  ))
    nullable(date, text, `latest_complete.${id}`);
  const sections = record(
    index.latest_complete_sections,
    "latest_complete_sections",
  );
  nullable(sections.generation, text, "latest_complete_sections.generation");
  nullable(sections.prices, text, "latest_complete_sections.prices");
  if (sections.sankey !== undefined)
    nullable(sections.sankey, text, "latest_complete_sections.sankey");
  if (sections.episodes !== undefined)
    nullable(sections.episodes, text, "latest_complete_sections.episodes");
  if (sections.reserves !== undefined)
    nullable(sections.reserves, text, "latest_complete_sections.reserves");
  if (sections.nodal_map !== undefined)
    nullable(sections.nodal_map, text, "latest_complete_sections.nodal_map");
  if (sections.events !== undefined)
    nullable(sections.events, text, "latest_complete_sections.events");
}

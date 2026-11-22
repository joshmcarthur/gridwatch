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
   * Sums over all islands. `primary` excludes battery and includes `unmapped`. Null when the
   * section is missing. Provisional (ADR-0014).
   */
  totals: {
    primary_megawatt_hours: number;
    battery_megawatt_hours: number;
  } | null;
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
}

/**
 * Daily reserve prices by class and island (ADR-0013, ADR-0014). Optional: absence means
 * the exporter has not built it. A day with no gold partition is `missing`, never zeros.
 */
export interface ReservesSection extends SectionBase {
  classes: ReservesClassDay[];
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
const RESERVE_CLASSES: readonly ReserveClass[] = ["FIR", "SIR"];
const EXTENSIONS = ["reserves", "sankey", "observations", "episodes"] as const;
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
      case "reserves":
        sectionDatasets.push(...checkReserves(day[key], key, periods.length));
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
}

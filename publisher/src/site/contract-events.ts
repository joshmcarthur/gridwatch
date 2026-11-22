/**
 * Site event item types and the per-item contract check (ADR-0014 #42).
 * No imports: this file must not pull gold or DuckDB. `contract.ts` imports it.
 */

export type ReviewStatus = "unreviewed" | "reviewed";
export type EventConfidence =
  | "confirmed"
  | "strong_evidence"
  | "possible_explanation";
export type EventSourceKind = "gold" | "silver";
export type EventIsland = "NI" | "SI";
export type EventReserveClass = "FIR" | "SIR";

export interface SiteEventClaim {
  id: string;
  label: string;
  value: number | string | boolean;
  unit: string;
  confidence: EventConfidence;
  source_kind: EventSourceKind;
  source_table: string;
  source_path: string;
  depends_on?: string[];
  note?: string;
}

export interface SiteEventWindow {
  periods: number[];
  start_utc: string[];
  prices: Array<{
    point_of_connection: string;
    price: Array<number | null>;
  }>;
  reserves: Array<{
    reserve_class: EventReserveClass;
    island: EventIsland;
    price: Array<number | null>;
  }>;
}

export interface SiteEvent {
  episode_id: string;
  review_status: ReviewStatus;
  observation_types: string[];
  islands: EventIsland[];
  member_count: number;
  severity: number;
  start_utc: string;
  end_utc: string;
  start_trading_period: number;
  end_trading_period: number;
  claims: SiteEventClaim[];
  window: SiteEventWindow;
  limits: Array<{ issue: number; text: string }>;
  daily_page: string;
}

const REVIEW_STATUSES: readonly ReviewStatus[] = ["unreviewed", "reviewed"];
const CONFIDENCE: readonly EventConfidence[] = [
  "confirmed",
  "strong_evidence",
  "possible_explanation",
];
const SOURCE_KINDS: readonly EventSourceKind[] = ["gold", "silver"];
const ISLANDS: readonly EventIsland[] = ["NI", "SI"];
const RESERVE_CLASSES: readonly EventReserveClass[] = ["FIR", "SIR"];

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

function integer(value: unknown, path: string): number {
  if (!Number.isInteger(value)) fail(path, "expected an integer");
  return value as number;
}

function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(path, "expected a finite number");
  return value;
}

function texts(value: unknown, path: string): string[] {
  return list(value, path).map((item, i) => text(item, `${path}[${i}]`));
}

function claimValue(value: unknown, path: string): number | string | boolean {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value;
  fail(path, "expected a number, string or boolean");
}

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

function checkClaim(value: unknown, path: string): void {
  const row = record(value, path);
  text(row.id, `${path}.id`);
  text(row.label, `${path}.label`);
  claimValue(row.value, `${path}.value`);
  text(row.unit, `${path}.unit`);
  oneOf(row.confidence, CONFIDENCE, `${path}.confidence`);
  oneOf(row.source_kind, SOURCE_KINDS, `${path}.source_kind`);
  text(row.source_table, `${path}.source_table`);
  text(row.source_path, `${path}.source_path`);
  if (row.depends_on !== undefined) texts(row.depends_on, `${path}.depends_on`);
  if (row.note !== undefined) text(row.note, `${path}.note`);
}

/** Throws a `TypeError` at the first field that does not match. */
export function checkSiteEvent(
  value: unknown,
  path: string,
  periodCount: number,
): void {
  const row = record(value, path);
  text(row.episode_id, `${path}.episode_id`);
  oneOf(row.review_status, REVIEW_STATUSES, `${path}.review_status`);
  texts(row.observation_types, `${path}.observation_types`);
  const islands = list(row.islands, `${path}.islands`);
  for (let i = 0; i < islands.length; i++)
    oneOf(islands[i], ISLANDS, `${path}.islands[${i}]`);
  integer(row.member_count, `${path}.member_count`);
  number(row.severity, `${path}.severity`);
  text(row.start_utc, `${path}.start_utc`);
  text(row.end_utc, `${path}.end_utc`);
  integer(row.start_trading_period, `${path}.start_trading_period`);
  integer(row.end_trading_period, `${path}.end_trading_period`);
  list(row.claims, `${path}.claims`).forEach((claim, i) => {
    checkClaim(claim, `${path}.claims[${i}]`);
  });
  const window = record(row.window, `${path}.window`);
  const periods = list(window.periods, `${path}.window.periods`).map(
    (item, i) => {
      const n = integer(item, `${path}.window.periods[${i}]`);
      if (n < 1 || n > periodCount)
        fail(
          `${path}.window.periods[${i}]`,
          `expected a period from 1 to ${periodCount}`,
        );
      return n;
    },
  );
  const length = periods.length;
  const starts = list(window.start_utc, `${path}.window.start_utc`);
  if (starts.length !== length)
    fail(`${path}.window.start_utc`, `expected ${length} entries`);
  starts.forEach((item, i) => {
    text(item, `${path}.window.start_utc[${i}]`);
  });
  list(window.prices, `${path}.window.prices`).forEach((item, i) => {
    const at = `${path}.window.prices[${i}]`;
    const price = record(item, at);
    text(price.point_of_connection, `${at}.point_of_connection`);
    nullableNumbers(price.price, length, `${at}.price`);
  });
  list(window.reserves, `${path}.window.reserves`).forEach((item, i) => {
    const at = `${path}.window.reserves[${i}]`;
    const reserve = record(item, at);
    oneOf(reserve.reserve_class, RESERVE_CLASSES, `${at}.reserve_class`);
    oneOf(reserve.island, ISLANDS, `${at}.island`);
    nullableNumbers(reserve.price, length, `${at}.price`);
  });
  list(row.limits, `${path}.limits`).forEach((item, i) => {
    const at = `${path}.limits[${i}]`;
    const limit = record(item, at);
    integer(limit.issue, `${at}.issue`);
    text(limit.text, `${at}.text`);
  });
  text(row.daily_page, `${path}.daily_page`);
}

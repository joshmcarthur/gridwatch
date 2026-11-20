import { existsSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { datasets, type PublisherDataset } from "../datasets.ts";
import { periodsInTradingDate } from "../trading-time.ts";
import { lit, type PublishResult, writeParquetAtomically } from "./common.ts";

/**
 * One row of `silver/_completeness/data.parquet` (ADR-0010).
 * `processedAt` is null only for a date that has no stored row.
 */
export interface CompletenessRow {
  dataset: string;
  tradingDate: string;
  status: "complete" | "partial" | "missing" | "invalid";
  expectedPeriodCount: number | null;
  actualPeriodCount: number | null;
  missingPeriods: number[];
  bronzeSha256s: string[];
  sourcePublishedAt: string | null;
  processedAt: string | null;
  errors: string[];
}

export type CompletenessRows = Map<string, CompletenessRow>;

/** `silver/_completeness/data.parquet`. One file, one row per dataset and date. */
export const completenessPath = (silverDir: string) =>
  join(silverDir, "_completeness", "data.parquet");

export const completenessKey = (dataset: string, date: string) =>
  `${dataset}\0${date}`;

const dayLit = (date: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new RangeError(`Invalid trading date "${date}": expected YYYY-MM-DD`);
  return `DATE ${lit(date)}`;
};

const intOrNull = (value: number | null) =>
  value === null ? "NULL::INTEGER" : `${value}::INTEGER`;

const intArray = (values: number[]) => {
  if (values.some((value) => !Number.isInteger(value)))
    throw new TypeError("A period count must be an integer");
  return values.length === 0
    ? "[]::INTEGER[]"
    : `[${values.join(",")}]::INTEGER[]`;
};

const textArray = (values: string[]) =>
  values.length === 0
    ? "[]::VARCHAR[]"
    : `[${values.map((value) => lit(value)).join(", ")}]::VARCHAR[]`;

const uniqueSorted = (values: readonly number[]) =>
  [...new Set(values)].sort((a, b) => a - b);

const asList = (value: unknown): unknown[] => {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && Symbol.iterator in value)
    return [...(value as Iterable<unknown>)];
  throw new TypeError("Expected a list");
};

const asStatus = (value: unknown): CompletenessRow["status"] => {
  switch (value) {
    case "complete":
    case "partial":
    case "missing":
    case "invalid":
      return value;
    default:
      throw new TypeError(`Unknown completeness status ${String(value)}`);
  }
};

const fromEpochMs = (value: unknown): string | null => {
  if (value == null) return null;
  const ms = Number(value);
  if (!Number.isFinite(ms)) throw new TypeError("Bad timestamp");
  return new Date(ms).toISOString();
};

/**
 * The completeness row for one dataset and date.
 *
 * A date with no stored row is `missing`, not `invalid`. That is the 22-day
 * dispatch price gap (2025-09-11 to 2025-10-02) and a Generation_MD day before
 * its month file exists. `invalid` is stored only when publish returned `invalid`.
 *
 * Gold should call this instead of counting silver periods. The function to
 * replace is `inputsComplete` on the gold branch (issue #16). It is not on this
 * branch. See ADR-0010.
 */
export async function readCompleteness(
  silverDir: string,
  datasetId: string,
  tradingDate: string,
): Promise<CompletenessRow> {
  const stored = (await loadCompleteness(silverDir)).get(
    completenessKey(datasetId, tradingDate),
  );
  if (stored) return stored;
  const dataset = datasets.find((item) => item.id === datasetId);
  const counts = dataset?.countsTradingPeriods === true;
  return {
    dataset: datasetId,
    tradingDate,
    status: "missing",
    expectedPeriodCount: counts ? periodsInTradingDate(tradingDate) : null,
    actualPeriodCount: counts ? 0 : null,
    missingPeriods: [],
    bronzeSha256s: [],
    sourcePublishedAt: null,
    processedAt: null,
    errors: [],
  };
}

/** Latest complete trading date per dataset, in registry order. */
export async function completenessStatusLines(
  silverDir: string,
  registry: readonly PublisherDataset[] = datasets,
): Promise<string[]> {
  const latest = new Map<string, string>();
  const seen = new Set<string>();
  for (const row of (await loadCompleteness(silverDir)).values()) {
    seen.add(row.dataset);
    if (row.status !== "complete") continue;
    const prev = latest.get(row.dataset);
    if (!prev || row.tradingDate > prev)
      latest.set(row.dataset, row.tradingDate);
  }
  const extras = [...seen]
    .filter((id) => !registry.some((dataset) => dataset.id === id))
    .sort();
  // Gold sets partitionRoot and is not a row in this table (ADR-0011).
  const silverIds = registry
    .filter((dataset) => dataset.partitionRoot === undefined)
    .map((dataset) => dataset.id);
  return [...silverIds, ...extras].map(
    (id) => `${id}: latest complete ${latest.get(id) ?? "none"}`,
  );
}

export async function loadCompleteness(
  silverDir: string,
): Promise<CompletenessRows> {
  const rows: CompletenessRows = new Map();
  const path = completenessPath(silverDir);
  if (!existsSync(path)) return rows;
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    const reader = await connection.runAndReadAll(
      `SELECT dataset,
         strftime(trading_date, '%Y-%m-%d') AS trading_date,
         status,
         expected_period_count,
         actual_period_count,
         missing_periods,
         bronze_sha256s,
         epoch_ms(source_published_at) AS source_published_at,
         epoch_ms(processed_at) AS processed_at,
         errors
       FROM read_parquet(${lit(path)})`,
    );
    for (const raw of reader.getRowObjectsJson() as Array<
      Record<string, unknown>
    >) {
      const row: CompletenessRow = {
        dataset: String(raw.dataset),
        tradingDate: String(raw.trading_date),
        status: asStatus(raw.status),
        expectedPeriodCount:
          raw.expected_period_count == null
            ? null
            : Number(raw.expected_period_count),
        actualPeriodCount:
          raw.actual_period_count == null
            ? null
            : Number(raw.actual_period_count),
        missingPeriods: asList(raw.missing_periods).map(Number),
        bronzeSha256s: asList(raw.bronze_sha256s).map(String),
        sourcePublishedAt: fromEpochMs(raw.source_published_at),
        processedAt: fromEpochMs(raw.processed_at),
        errors: asList(raw.errors).map(String),
      };
      rows.set(completenessKey(row.dataset, row.tradingDate), row);
    }
  } finally {
    connection.closeSync();
  }
  return rows;
}

/**
 * Replace the row for this publish result. The result is the source of the
 * status. This does not read the partition just written.
 */
export function recordCompleteness(
  rows: CompletenessRows,
  dataset: PublisherDataset,
  version: string | undefined,
  result: PublishResult,
  processedAt: string,
): void {
  const counts = dataset.countsTradingPeriods === true;
  const expected = counts ? periodsInTradingDate(result.date) : null;
  const bronzeSha256s = version ? [version] : [];
  const key = completenessKey(dataset.id, result.date);
  const base = {
    dataset: dataset.id,
    tradingDate: result.date,
    bronzeSha256s,
    sourcePublishedAt: null,
    processedAt,
  };
  switch (result.status) {
    case "complete":
      rows.set(key, {
        ...base,
        status: "complete",
        expectedPeriodCount: expected,
        actualPeriodCount: expected,
        missingPeriods: [],
        errors: [],
      });
      return;
    case "partial": {
      const missingPeriods = uniqueSorted(result.missingPeriods);
      rows.set(key, {
        ...base,
        status: "partial",
        expectedPeriodCount: expected,
        actualPeriodCount:
          expected === null ? null : expected - missingPeriods.length,
        missingPeriods,
        errors: [],
      });
      return;
    }
    case "missing":
      rows.set(key, {
        ...base,
        status: "missing",
        expectedPeriodCount: expected,
        actualPeriodCount: counts ? 0 : null,
        missingPeriods: [],
        errors: [],
      });
      return;
    case "invalid":
      rows.set(key, {
        ...base,
        status: "invalid",
        expectedPeriodCount: expected,
        actualPeriodCount: null,
        missingPeriods: [],
        errors: [...result.errors],
      });
      return;
    default: {
      const unreachable: never = result;
      throw new Error(`Unknown publish status: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Write a row for each up-to-date date that has none. Dates that already have
 * a row are left as they are, including `processedAt`.
 */
export async function fillHeldCompleteness(
  rows: CompletenessRows,
  dataset: PublisherDataset,
  silverDir: string,
  dates: readonly string[],
  versions: ReadonlyMap<string, string>,
  processedAt: string,
): Promise<void> {
  const pending = dates.filter(
    (date) => !rows.has(completenessKey(dataset.id, date)),
  );
  if (pending.length === 0) return;
  const present = dataset.countsTradingPeriods
    ? await periodsPresent(silverDir, dataset, pending)
    : new Map<string, Set<number>>();
  for (const date of pending) {
    const version = versions.get(date);
    const bronzeSha256s = version ? [version] : [];
    const key = completenessKey(dataset.id, date);
    if (!dataset.countsTradingPeriods) {
      rows.set(key, {
        dataset: dataset.id,
        tradingDate: date,
        status: "complete",
        expectedPeriodCount: null,
        actualPeriodCount: null,
        missingPeriods: [],
        bronzeSha256s,
        sourcePublishedAt: null,
        processedAt,
        errors: [],
      });
      continue;
    }
    const expected = periodsInTradingDate(date);
    const have = present.get(date) ?? new Set<number>();
    const missingPeriods: number[] = [];
    for (let period = 1; period <= expected; period++) {
      if (!have.has(period)) missingPeriods.push(period);
    }
    rows.set(key, {
      dataset: dataset.id,
      tradingDate: date,
      status: missingPeriods.length === 0 ? "complete" : "partial",
      expectedPeriodCount: expected,
      actualPeriodCount: expected - missingPeriods.length,
      missingPeriods,
      bronzeSha256s,
      sourcePublishedAt: null,
      processedAt,
      errors: [],
    });
  }
}

async function periodsPresent(
  silverDir: string,
  dataset: PublisherDataset,
  dates: readonly string[],
): Promise<Map<string, Set<number>>> {
  const files = dates.map((date) =>
    join(
      silverDir,
      dataset.table ?? dataset.id,
      `${dataset.partitionKey}=${date}`,
      "data.parquet",
    ),
  );
  const found = new Map<string, Set<number>>();
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    const reader = await connection.runAndReadAll(
      `SELECT DISTINCT
         regexp_extract(filename, '${dataset.partitionKey}=(\\d{4}-\\d{2}-\\d{2})', 1) AS date,
         trading_period AS period
       FROM read_parquet([${files.map(lit).join(", ")}], filename = true)`,
    );
    for (const row of reader.getRowObjectsJson() as Array<{
      date: string;
      period: unknown;
    }>) {
      const period = Number(row.period);
      if (!Number.isInteger(period)) continue;
      const set = found.get(row.date) ?? new Set<number>();
      set.add(period);
      found.set(row.date, set);
    }
  } finally {
    connection.closeSync();
  }
  return found;
}

/** Rewrite the table. A caller that changed nothing should not call this. */
export async function saveCompleteness(
  silverDir: string,
  rows: CompletenessRows,
): Promise<void> {
  if (rows.size === 0) return;
  const sorted = [...rows.values()].sort(
    (a, b) =>
      a.dataset.localeCompare(b.dataset) ||
      a.tradingDate.localeCompare(b.tradingDate),
  );
  const selects = sorted.map((row, index) => {
    if (row.processedAt === null)
      throw new Error(
        `Completeness row ${row.dataset} ${row.tradingDate} has no processed_at`,
      );
    const source = row.sourcePublishedAt
      ? `${lit(row.sourcePublishedAt)}::TIMESTAMPTZ`
      : "NULL::TIMESTAMPTZ";
    const values = [
      lit(row.dataset),
      dayLit(row.tradingDate),
      lit(row.status),
      intOrNull(row.expectedPeriodCount),
      intOrNull(row.actualPeriodCount),
      intArray(row.missingPeriods),
      textArray(row.bronzeSha256s),
      source,
      `${lit(row.processedAt)}::TIMESTAMPTZ`,
      textArray(row.errors),
    ];
    // Names live on the first branch of the UNION only.
    if (index === 0) {
      const named = [
        "dataset",
        "trading_date",
        "status",
        "expected_period_count",
        "actual_period_count",
        "missing_periods",
        "bronze_sha256s",
        "source_published_at",
        "processed_at",
        "errors",
      ];
      return `SELECT ${values.map((value, i) => `${value} AS ${named[i]}`).join(", ")}`;
    }
    return `SELECT ${values.join(", ")}`;
  });
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    await writeParquetAtomically(
      connection,
      `SELECT * FROM (\n${selects.join("\nUNION ALL\n")}\n) ORDER BY dataset, trading_date`,
      completenessPath(silverDir),
    );
  } finally {
    connection.closeSync();
  }
}

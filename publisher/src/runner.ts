import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DuckDBInstance } from "@duckdb/node-api";
import { datasets, type PublisherDataset } from "./datasets.ts";
import { bronzeVersions, lit } from "./silver/common.ts";

export interface RunOptions {
  bronzeDir: string;
  silverDir: string;
  /** Publish only dates in this range (inclusive). Default: every date in the manifest. */
  range?: { from: string; to: string };
  /** Publish dates again even when silver is up to date. */
  force?: boolean;
  /** Dataset IDs to run. Default: all. */
  only?: string[];
  registry?: PublisherDataset[];
}

export interface DatasetSummary {
  id: string;
  /** Partitions written (complete or partial). */
  published: number;
  /** Dates whose silver partition already came from the newest bronze version. */
  upToDate: number;
  /** Dates with a bronze file but no data for that date. */
  missing: number;
  /** One line for each partial day, as the dataset CLIs print it. */
  partial: string[];
  /** One message for each date that is invalid or threw. */
  failed: string[];
}

const nzToday = () => Temporal.Now.plainDateISO("Pacific/Auckland").toString();

/**
 * The SHA-256 of the bronze file behind each silver partition of a dataset, by date. Every
 * silver row carries `bronze_sha256` (ADR-0005), so silver says which bronze version it holds.
 * The entity mappings carry `inputs_sha256` instead (ADR-0008).
 */
async function silverVersions(
  silverDir: string,
  dataset: PublisherDataset,
): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  const dir = join(silverDir, dataset.table ?? dataset.id);
  // A folder without `data.parquet` is not a partition. A failed first write leaves one.
  const folders = await readdir(dir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const files = folders
    .filter(
      (f) => f.isDirectory() && f.name.startsWith(`${dataset.partitionKey}=`),
    )
    .map((f) => join(dir, f.name, "data.parquet"))
    .filter((file) => existsSync(file));
  if (files.length === 0) return versions;
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    const reader = await connection.runAndReadAll(
      `SELECT DISTINCT
         regexp_extract(filename, '${dataset.partitionKey}=(\\d{4}-\\d{2}-\\d{2})', 1) AS date,
         ${dataset.versionColumn ?? "bronze_sha256"} AS version
       FROM read_parquet([${files.map(lit).join(", ")}], filename = true)`,
    );
    for (const row of reader.getRowObjectsJson() as Array<{
      date: string;
      version: string;
    }>)
      versions.set(row.date, row.version);
  } finally {
    connection.closeSync();
  }
  return versions;
}

/**
 * Publish every dataset, in registry order. A date is published when its silver partition is
 * missing or holds an older bronze version than the manifest names. A run with nothing new writes nothing.
 * A failing dataset or date does not stop the others.
 */
export async function runPublish(
  options: RunOptions,
): Promise<DatasetSummary[]> {
  const { bronzeDir, silverDir, range } = options;
  const summaries: DatasetSummary[] = [];
  for (const dataset of options.registry ?? datasets) {
    if (options.only && !options.only.includes(dataset.id)) continue;
    const summary: DatasetSummary = {
      id: dataset.id,
      published: 0,
      upToDate: 0,
      missing: 0,
      partial: [],
      failed: [],
    };
    summaries.push(summary);
    try {
      const wanted = dataset.wantedVersions
        ? await dataset.wantedVersions(silverDir)
        : await bronzeVersions(bronzeDir, dataset.id);
      const held = options.force
        ? new Map<string, string>()
        : await silverVersions(silverDir, dataset);
      const dates = [...wanted.keys()]
        .filter((d) => !range || (d >= range.from && d <= range.to))
        .sort();
      for (const date of dates) {
        if (held.get(date) === wanted.get(date)) {
          summary.upToDate++;
          continue;
        }
        try {
          const result = await dataset.publish({ bronzeDir, silverDir, date });
          if (result.status === "missing") summary.missing++;
          else if (result.status === "invalid")
            summary.failed.push(`${date}: INVALID ${result.errors.join("; ")}`);
          else {
            summary.published++;
            if (result.status === "partial")
              summary.partial.push(
                `${date}: PARTIAL ${result.rows} rows, missing periods ${result.missingPeriods.join(",")}`,
              );
          }
        } catch (error) {
          summary.failed.push(`${date}: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      summary.failed.push((error as Error).message);
    }
  }
  return summaries;
}

export const hasFailures = (summaries: DatasetSummary[]) =>
  summaries.some((s) => s.failed.length > 0);

export function printSummary(summaries: DatasetSummary[]): void {
  for (const s of summaries) {
    console.log(
      `${s.id}: published ${s.published}, up to date ${s.upToDate}, no data ${s.missing}${s.failed.length > 0 ? `, FAILED ${s.failed.length}` : ""}`,
    );
    for (const line of s.partial) console.log(`  ${s.id}: ${line}`);
    for (const message of s.failed) console.error(`  ${s.id}: ${message}`);
  }
  const failed = summaries.filter((s) => s.failed.length > 0);
  if (failed.length > 0)
    console.error(`Failed datasets: ${failed.map((s) => s.id).join(", ")}`);
}

export const USAGE = `Usage: publisher [--from YYYY-MM-DD --to YYYY-MM-DD] [--dataset ID]... [--force]

With no range, each dataset publishes every date that is new or whose bronze file changed.
With --from and --to, only dates in that range are considered (--from alone ends today; --to
alone is not allowed). --force publishes the selected dates again even when they are up to date.
Datasets: ${datasets.map((d) => d.id).join(", ")}`;

/** Parse the command line. Throws a RangeError or TypeError for bad input. */
export function parseRunArgs(
  args: string[],
  today: string = nzToday(),
  registry: PublisherDataset[] = datasets,
) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      dataset: { type: "string", multiple: true },
      force: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.to !== undefined && values.from === undefined)
    throw new TypeError("--to needs --from");
  for (const id of values.dataset ?? []) {
    if (!registry.some((d) => d.id === id))
      throw new TypeError(`Unknown dataset ${id}`);
  }
  let range: RunOptions["range"];
  if (values.from !== undefined) {
    // PlainDate.from throws a RangeError for a bad date.
    const from = Temporal.PlainDate.from(values.from).toString();
    const to = Temporal.PlainDate.from(values.to ?? today).toString();
    if (from > to) throw new RangeError(`--from ${from} is after --to ${to}`);
    range = { from, to };
  }
  return {
    help: values.help === true,
    force: values.force === true,
    range,
    only: values.dataset,
  };
}

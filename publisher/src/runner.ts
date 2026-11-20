import { parseArgs } from "node:util";
import { datasets, type PublisherDataset } from "./datasets.ts";
import { bronzeVersions, partitionVersions } from "./silver/common.ts";
import {
  completenessKey,
  fillHeldCompleteness,
  loadCompleteness,
  recordCompleteness,
  saveCompleteness,
} from "./silver/completeness.ts";

export interface RunOptions {
  bronzeDir: string;
  silverDir: string;
  /** Where gold tables are written (ADR-0011). Silver datasets do not use it. */
  goldDir: string;
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

const isGold = (dataset: PublisherDataset) =>
  dataset.partitionRoot !== undefined;

/**
 * Publish every dataset, in registry order (silver first, then gold). A date is published when its
 * partition is missing or holds a different input version than wanted: the newest bronze
 * version for silver, the silver fingerprint for gold (ADR-0011). Completeness rows are silver
 * only (ADR-0010). Gold gets the in-memory completeness rows of this run. A run that publishes nothing, and already has a completeness row for each
 * skipped silver date, writes nothing. A failing dataset or date does not stop the others.
 */
export async function runPublish(
  options: RunOptions,
): Promise<DatasetSummary[]> {
  const { bronzeDir, silverDir, goldDir, range } = options;
  const completeness = await loadCompleteness(silverDir);
  const processedAt = new Date().toISOString();
  let dirty = false;
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
        ? await dataset.wantedVersions(silverDir, completeness)
        : await bronzeVersions(bronzeDir, dataset.id);
      const held = options.force
        ? new Map<string, string>()
        : await partitionVersions(
            dataset.partitionRoot?.({ silverDir, goldDir }) ?? silverDir,
            dataset.table ?? dataset.id,
            dataset.partitionKey,
            dataset.versionColumn ?? "bronze_sha256",
          );
      const dates = [...wanted.keys()]
        .filter((d) => !range || (d >= range.from && d <= range.to))
        .sort();
      const skipped: string[] = [];
      for (const date of dates) {
        if (held.get(date) === wanted.get(date)) {
          summary.upToDate++;
          if (
            !isGold(dataset) &&
            !completeness.has(completenessKey(dataset.id, date))
          )
            skipped.push(date);
          continue;
        }
        try {
          const result = await dataset.publish({
            bronzeDir,
            silverDir,
            goldDir,
            completeness,
            date,
          });
          switch (result.status) {
            case "missing":
              summary.missing++;
              break;
            case "invalid":
              summary.failed.push(
                `${date}: INVALID ${result.errors.join("; ")}`,
              );
              break;
            case "complete":
              summary.published++;
              break;
            case "partial":
              summary.published++;
              summary.partial.push(
                `${date}: PARTIAL ${result.rows} rows, ${
                  result.missingPeriods.length > 0
                    ? `missing periods ${result.missingPeriods.join(",")}`
                    : "an input is not complete"
                }`,
              );
              break;
            default: {
              const unreachable: never = result;
              throw new Error(
                `Unknown publish status: ${JSON.stringify(unreachable)}`,
              );
            }
          }
          if (!isGold(dataset)) {
            recordCompleteness(
              completeness,
              dataset,
              wanted.get(date),
              result,
              processedAt,
            );
            dirty = true;
          }
        } catch (error) {
          summary.failed.push(`${date}: ${(error as Error).message}`);
        }
      }
      if (skipped.length > 0) {
        await fillHeldCompleteness(
          completeness,
          dataset,
          silverDir,
          skipped,
          wanted,
          processedAt,
        );
        dirty = true;
      }
    } catch (error) {
      summary.failed.push((error as Error).message);
    }
    // Save after each dataset, so a crashed run keeps the rows of the datasets that finished.
    // Gold reads the in-memory rows, not this file.
    if (dirty) {
      await saveCompleteness(silverDir, completeness);
      dirty = false;
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
       publisher status

With no range, each dataset publishes every date that is new or whose bronze file changed.
With --from and --to, only dates in that range are considered (--from alone ends today; --to
alone is not allowed). --force publishes the selected dates again even when they are up to date.
publisher status prints the latest complete trading date for each dataset.
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

import { parseArgs } from "node:util";
import { readManifest } from "./archive.ts";
import { type CollectorDataset, type DateRange, datasets } from "./datasets.ts";

export interface RunOptions {
  bronzeDir: string;
  /** Both set: collect this range. Neither set: default mode. */
  range?: { from: string; to: string };
  /** Dataset IDs to run. Default: all. */
  only?: string[];
  registry?: CollectorDataset[];
  /** The run date in NZ. Default: today. */
  today?: string;
  /** Overrides for tests. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface DatasetSummary {
  id: string;
  ranges: DateRange[];
  new: number;
  changed: number;
  unchanged: number;
  notListed: number;
  failed: string[];
}

const nzToday = () => Temporal.Now.plainDateISO("Pacific/Auckland").toString();

/** Collect every dataset. A failing dataset does not stop the others. */
export async function runCollect(
  options: RunOptions,
): Promise<DatasetSummary[]> {
  const registry = options.registry ?? datasets;
  const today = options.today ?? nzToday();
  const yesterday = Temporal.PlainDate.from(today)
    .subtract({ days: 1 })
    .toString();
  const manifest = await readManifest(options.bronzeDir);

  const summaries: DatasetSummary[] = [];
  for (const dataset of registry) {
    if (options.only && !options.only.includes(dataset.id)) continue;
    const held = new Set(
      manifest
        .filter((r) => r.dataset === dataset.id)
        .flatMap((r) => r.trading_dates),
    );
    const ranges = options.range
      ? [options.range]
      : dataset.defaultRanges(held, yesterday, today);
    const summary: DatasetSummary = {
      id: dataset.id,
      ranges,
      new: 0,
      changed: 0,
      unchanged: 0,
      notListed: 0,
      failed: [],
    };
    for (const { from, to } of ranges) {
      try {
        const result = await dataset.collect({
          bronzeDir: options.bronzeDir,
          from,
          to,
          today,
          baseUrl: options.baseUrl,
          fetch: options.fetch,
        });
        for (const record of result.records) summary[record.status]++;
        summary.notListed += result.notListed;
        summary.failed.push(...result.failed);
      } catch (error) {
        summary.failed.push(`${from}..${to}: ${(error as Error).message}`);
      }
    }
    summaries.push(summary);
  }
  return summaries;
}

export const hasFailures = (summaries: DatasetSummary[]) =>
  summaries.some((s) => s.failed.length > 0);

export function printSummary(summaries: DatasetSummary[]): void {
  for (const s of summaries) {
    console.log(
      `${s.id} ${s.ranges.map((r) => `${r.from}..${r.to}`).join(", ")}: new ${s.new}, changed ${s.changed}, unchanged ${s.unchanged}, not listed ${s.notListed}${s.failed.length > 0 ? `, FAILED ${s.failed.length}` : ""}`,
    );
    for (const message of s.failed) console.error(`  ${s.id}: ${message}`);
  }
  const failed = summaries.filter((s) => s.failed.length > 0);
  if (failed.length > 0)
    console.error(`Failed datasets: ${failed.map((s) => s.id).join(", ")}`);
}

export const USAGE = `Usage: collector [--from YYYY-MM-DD --to YYYY-MM-DD] [--dataset ID]...

With no range, each dataset collects since its last run plus a trailing window. The first run
of a dataset backfills 12 months. With --from and --to, every selected dataset collects that
range (--to alone is not allowed; --from alone ends yesterday). The fleet file ignores the range.
Datasets: ${datasets.map((d) => d.id).join(", ")}`;

/** Parse the command line. Throws a RangeError or TypeError for bad input. */
export function parseRunArgs(
  args: string[],
  today: string = nzToday(),
  registry: CollectorDataset[] = datasets,
) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      dataset: { type: "string", multiple: true },
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
    const yesterday = Temporal.PlainDate.from(today)
      .subtract({ days: 1 })
      .toString();
    // PlainDate.from throws a RangeError for a bad date.
    const from = Temporal.PlainDate.from(values.from).toString();
    const to = Temporal.PlainDate.from(values.to ?? yesterday).toString();
    if (from > to) throw new RangeError(`--from ${from} is after --to ${to}`);
    range = { from, to };
  }
  return { help: values.help === true, range, only: values.dataset };
}

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { PublisherDataset } from "../datasets.ts";
import type { DatasetSummary } from "../runner.ts";
import { partitionVersions } from "../silver/common.ts";
import {
  type CompletenessView,
  latestCompleteDates,
} from "../silver/completeness.ts";
import { periodsInTradingDate, periodToUtc } from "../trading-time.ts";
import {
  assertSiteDay,
  assertSiteIndex,
  SITE_CONTRACT_VERSION,
  SITE_EXPORT_ID,
  type SiteDay,
  type SiteIndex,
  type SiteIndexDay,
} from "./contract.ts";
import {
  datasetStatus,
  type Section,
  sectionDatasets,
} from "./export-common.ts";
import { buildEpisodes, EPISODES_SECTION } from "./export-episodes.ts";
import { buildGeneration, GENERATION_SECTION } from "./export-generation.ts";
import { buildNodalMap, NODAL_MAP_SECTION } from "./export-nodal-map.ts";
import { buildPrices, PRICES_SECTION } from "./export-prices.ts";
import { buildReserves, RESERVES_SECTION } from "./export-reserves.ts";
import { buildSankey, SANKEY_SECTION } from "./export-sankey.ts";
import { round } from "./gold-read.ts";

export { round };

/**
 * Bump by hand when the export logic changes. It is part of `export_sha256`, so every day is
 * rebuilt (ADR-0014).
 */
export const EXPORT_VERSION = 7;

const SECTIONS: readonly Section[] = [
  GENERATION_SECTION,
  PRICES_SECTION,
  SANKEY_SECTION,
  EPISODES_SECTION,
  RESERVES_SECTION,
  NODAL_MAP_SECTION,
];

/** Every silver dataset that a section reads, sorted. */
const DATASET_IDS = [...new Set(SECTIONS.flatMap(sectionDatasets))].sort();

/** The period axis of a date. It exists even when gold has no rows. */
function periodAxis(date: string) {
  return Array.from({ length: periodsInTradingDate(date) }, (_, i) => ({
    period: i + 1,
    start_utc: periodToUtc(date, i + 1).eventStartUtc.toString(),
  }));
}

/**
 * One site day from the gold tables of a date and this run's completeness rows. Opens one
 * in-memory DuckDB connection and reads only the sentinel and the tables of each section.
 */
export async function buildSiteDay(options: {
  goldDir: string;
  date: string;
  completeness: CompletenessView;
  /** Silver root. Coordinates for the nodal map are joined from it (ADR-0023). */
  silverDir?: string;
}): Promise<SiteDay> {
  const { goldDir, date, completeness } = options;
  const silverDir = options.silverDir ?? join(goldDir, "..", "silver");
  const periods = periodAxis(date);
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    const generation = await buildGeneration(
      connection,
      goldDir,
      date,
      completeness,
      periods,
    );
    const prices = await buildPrices(
      connection,
      goldDir,
      date,
      completeness,
      periods,
    );
    const sankey = await buildSankey(connection, goldDir, date, completeness);
    const episodes = await buildEpisodes(
      connection,
      goldDir,
      date,
      completeness,
    );
    const reserves = await buildReserves(
      connection,
      goldDir,
      date,
      completeness,
      periods,
    );
    const nodalMap = await buildNodalMap(
      connection,
      goldDir,
      silverDir,
      date,
      completeness,
      periods,
    );
    const datasets = Object.fromEntries(
      DATASET_IDS.map((id) => [id, datasetStatus(completeness, id, date)]),
    );
    return {
      contract_version: SITE_CONTRACT_VERSION,
      trading_date: date,
      periods,
      // Sankey follows the HVDC month lag, so it does not take part in `complete` (ADR-0014).
      // Reserves are optional and do not take part either.
      complete: generation.state === "complete" && prices.state === "complete",
      datasets,
      generation,
      prices,
      reserves,
      sankey,
      episodes,
      nodal_map: nodalMap,
    };
  } finally {
    connection.closeSync();
  }
}

/**
 * The held version that a build of `date` would write. It reads the same values as the day
 * file, so a changed input or status changes it (ADR-0014).
 */
function wantedExportHash(
  date: string,
  versions: ReadonlyArray<string | undefined>,
  completeness: CompletenessView,
): string {
  const lines = [
    `export_version ${EXPORT_VERSION}`,
    `contract ${SITE_CONTRACT_VERSION}`,
    ...SECTIONS.map((section, i) => `${section.name} ${versions[i] ?? "none"}`),
    ...DATASET_IDS.map(
      (id) =>
        `dataset ${id} ${JSON.stringify(datasetStatus(completeness, id, date))}`,
    ),
  ];
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** Write JSON through a temporary file, so a reader never sees a partial file. */
async function writeJson(path: string, value: unknown): Promise<string> {
  const text = `${JSON.stringify(value)}\n`;
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  try {
    await writeFile(temp, text);
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
  return text;
}

/**
 * The index entries that the last run wrote. A missing or unreadable index means none, so the
 * export rebuilds every day. A corrupt index does not block the export.
 */
async function readHeldIndex(path: string): Promise<Map<string, SiteIndexDay>> {
  const held = new Map<string, SiteIndexDay>();
  if (!existsSync(path)) return held;
  try {
    const index: unknown = JSON.parse(await readFile(path, "utf8"));
    assertSiteIndex(index);
    for (const day of index.days) held.set(day.date, day);
  } catch {
    // Treated as no held entries. The index is rewritten below.
  }
  return held;
}

/**
 * Publish one site day file for each gold trading date, and the index (ADR-0014).
 *
 * A day is rebuilt when it has no held index entry or no day file, always. Otherwise it is
 * rebuilt when its date is in `range` (or there is no range) and `force` is set or its held
 * version differs from the wanted one. A day outside `range` is never rebuilt for a changed
 * input, but it stays in the index. A day whose rebuild throws keeps its previous entry, and
 * is reported in `failed`. The index is written last, and only when its bytes change.
 */
export async function exportSite(options: {
  goldDir: string;
  completeness: CompletenessView;
  registry: readonly PublisherDataset[];
  range?: { from: string; to: string };
  force?: boolean;
  silverDir?: string;
}): Promise<DatasetSummary> {
  const { goldDir, completeness, registry, range, force } = options;
  const silverDir = options.silverDir ?? join(goldDir, "..", "silver");
  const summary: DatasetSummary = {
    id: SITE_EXPORT_ID,
    published: 0,
    upToDate: 0,
    missing: 0,
    partial: [],
    failed: [],
  };
  const siteDir = join(goldDir, "site");
  const indexPath = join(siteDir, "index.json");
  const versions = await Promise.all(
    SECTIONS.map((section) =>
      partitionVersions(
        goldDir,
        section.sentinel,
        "trading_date",
        "inputs_sha256",
      ),
    ),
  );
  const dates = [...new Set(versions.flatMap((v) => [...v.keys()]))].sort();
  if (dates.length === 0 && !existsSync(indexPath)) return summary;

  const held = await readHeldIndex(indexPath);
  // Dates are visited in ascending order, so the map is in index order.
  const days = new Map<string, SiteIndexDay>();
  for (const date of dates) {
    const wanted = wantedExportHash(
      date,
      versions.map((v) => v.get(date)),
      completeness,
    );
    const previous = held.get(date);
    const inRange = !range || (date >= range.from && date <= range.to);
    const dayFile = join(siteDir, "days", `${date}.json`);
    const rebuild =
      !previous ||
      !existsSync(dayFile) ||
      (inRange && (force === true || previous.export_sha256 !== wanted));
    if (previous && !rebuild) {
      days.set(date, previous);
      summary.upToDate++;
      continue;
    }
    try {
      const day = await buildSiteDay({
        goldDir,
        silverDir,
        date,
        completeness,
      });
      assertSiteDay(day);
      await writeJson(dayFile, day);
      days.set(date, {
        date,
        path: `days/${date}.json`,
        complete: day.complete,
        sections: {
          generation: day.generation.state,
          prices: day.prices.state,
          sankey: day.sankey?.state ?? "missing",
          episodes: day.episodes?.state ?? "missing",
          reserves: day.reserves?.state ?? "missing",
          nodal_map: day.nodal_map?.state ?? "missing",
        },
        export_sha256: wanted,
      });
      summary.published++;
    } catch (error) {
      summary.failed.push(`${date}: ${(error as Error).message}`);
      if (previous) days.set(date, previous);
    }
  }

  const entries = [...days.values()];
  const latest = latestCompleteDates(completeness);
  const latestSection = (
    name:
      | "generation"
      | "prices"
      | "sankey"
      | "episodes"
      | "reserves"
      | "nodal_map",
  ) =>
    entries.filter((day) => day.sections[name] === "complete").at(-1)?.date ??
    null;
  const index: SiteIndex = {
    contract_version: SITE_CONTRACT_VERSION,
    days: entries,
    latest_complete: Object.fromEntries(
      registry
        .filter((dataset) => dataset.partitionRoot === undefined)
        .map((dataset) => [dataset.id, latest.get(dataset.id) ?? null]),
    ),
    latest_complete_sections: {
      generation: latestSection("generation"),
      prices: latestSection("prices"),
      sankey: latestSection("sankey"),
      episodes: latestSection("episodes"),
      reserves: latestSection("reserves"),
      nodal_map: latestSection("nodal_map"),
    },
  };
  assertSiteIndex(index);
  const text = `${JSON.stringify(index)}\n`;
  const onDisk = existsSync(indexPath)
    ? await readFile(indexPath, "utf8")
    : undefined;
  if (onDisk !== text) await writeJson(indexPath, index);
  return summary;
}

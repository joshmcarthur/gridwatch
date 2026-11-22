import { access, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readManifest } from "../collector/src/archive.ts";
import { dataPaths } from "../collector/src/data-root.ts";
import { BACKFILL_MONTHS } from "../collector/src/datasets.ts";
import {
  hasFailures as collectFailed,
  printSummary as printCollect,
  runCollect,
} from "../collector/src/runner.ts";
import {
  printSummary as printPublish,
  hasFailures as publishFailed,
  runPublish,
} from "../publisher/src/runner.ts";
import { astroBuild, buildAndSwap } from "../site/publish.ts";

// docker compose up -d
// Runs collect, publish and site build in cycles. It seeds the site with the latest days, then
// fills older days back to the 12-month window, then updates every 6 hours. The site is the
// `site` service, which serves site-out/current.

export const SEED_DAYS = 7;
export const FILL_DAYS = 30;
const INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
/** The dataset whose earliest date says how far back the fill has reached. */
const PRIMARY_DATASET = "dispatch_energy_prices";

export interface Range {
  from: string;
  to: string;
}

/**
 * The next range to collect, or null when the 12-month window is filled.
 * `before` is the earliest date already covered, or null when nothing is covered yet.
 * With nothing covered, the range is the latest SEED_DAYS days. After that, each range is the
 * FILL_DAYS days before `before`, cut off at the start of the window.
 */
export function nextRange(today: string, before: string | null): Range | null {
  const now = Temporal.PlainDate.from(today);
  if (before === null) {
    const yesterday = now.subtract({ days: 1 });
    return {
      from: yesterday.subtract({ days: SEED_DAYS - 1 }).toString(),
      to: yesterday.toString(),
    };
  }
  const windowStart = now.subtract({ months: BACKFILL_MONTHS });
  const to = Temporal.PlainDate.from(before).subtract({ days: 1 });
  if (Temporal.PlainDate.compare(to, windowStart) < 0) return null;
  const from = to.subtract({ days: FILL_DAYS - 1 });
  return {
    from: (Temporal.PlainDate.compare(from, windowStart) < 0
      ? windowStart
      : from
    ).toString(),
    to: to.toString(),
  };
}

const log = (message: string) =>
  console.log(`${new Date().toISOString()} updater: ${message}`);

const nzToday = () => Temporal.Now.plainDateISO("Pacific/Auckland").toString();

async function earliestHeld(bronzeDir: string): Promise<string | null> {
  const dates = (await readManifest(bronzeDir))
    .filter((record) => record.dataset === PRIMARY_DATASET)
    .flatMap((record) => record.trading_dates)
    .sort();
  return dates[0] ?? null;
}

/**
 * A stopped build leaves its lock folder, and the next build on that slot would then fail.
 * Only one updater runs against a site-out volume, so any lock found at startup is stale.
 */
async function clearStaleLocks(outRoot: string): Promise<void> {
  const releasesDir = join(outRoot, "releases");
  const names = await readdir(releasesDir).catch(() => [] as string[]);
  for (const name of names.filter((n) => n.endsWith(".lock"))) {
    await rm(join(releasesDir, name), { recursive: true, force: true });
  }
}

/** Until the first build, serve a page that says the site is on its way. */
async function ensurePlaceholder(outRoot: string): Promise<void> {
  const live = await access(join(outRoot, "current", "index.html")).then(
    () => true,
    () => false,
  );
  if (live) return;
  await buildAndSwap({
    outRoot,
    build: (outDir) =>
      writeFile(
        join(outDir, "index.html"),
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Gridwatch NZ</title></head><body><h1>Gridwatch NZ</h1><p>The first pages are on their way. This takes a few minutes. Reload this page soon.</p></body></html>\n`,
      ),
  });
}

async function main(): Promise<void> {
  const { bronze, silver, gold } = dataPaths();
  const outRoot = fileURLToPath(new URL("../site-out", import.meta.url));
  await clearStaleLocks(outRoot);
  await ensurePlaceholder(outRoot);

  // Build on the first cycle even with no new data, so a new image shows its new pages.
  let needsBuild = true;
  // The start of the last range collected. It stops the fill from repeating a range that
  // holds no files, because the source did not publish those dates.
  let cursor: string | null = null;

  for (;;) {
    try {
      const held = await earliestHeld(bronze);
      const before = [held, cursor].filter((d) => d !== null).sort()[0] ?? null;
      const range = nextRange(nzToday(), before);
      log(
        range
          ? `collecting ${range.from}..${range.to}`
          : "collecting recent days and gaps",
      );
      const collected = await runCollect({
        bronzeDir: bronze,
        ...(range && { range }),
      });
      printCollect(collected);
      const published = await runPublish({
        bronzeDir: bronze,
        silverDir: silver,
        goldDir: gold,
        ...(range && { range }),
      });
      printPublish(published);
      if (collectFailed(collected) || publishFailed(published)) {
        log("some days failed. The next cycle tries them again.");
      }
      if (range) cursor = range.from;
      if (published.some((summary) => summary.published > 0)) needsBuild = true;
      if (needsBuild) {
        log("building the site");
        await buildAndSwap({ build: astroBuild, outRoot });
        needsBuild = false;
        log("site published");
      }
      // A range cycle goes straight on to the next one. A steady cycle waits.
      if (!range) await sleep(INTERVAL_MS);
    } catch (error) {
      log(`cycle failed: ${(error as Error).message}. Retrying in 10 minutes.`);
      await sleep(RETRY_MS);
    }
  }
}

if (import.meta.main) {
  // As PID 1 in a container, Node ignores SIGTERM unless it has a handler.
  process.on("SIGTERM", () => process.exit(0));
  await main();
}

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSiteDay,
  assertSiteIndex,
  type SiteDay,
  type SiteEpisode,
  type SiteEvent,
  type SiteIndex,
} from "@gridwatch/publisher/site-contract";
import fixtureIndex from "../../fixtures/index.json";

const fixtureDays = import.meta.glob("../../fixtures/days/*.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;

function defaultDataRoot(): string {
  return fileURLToPath(new URL("../../../data", import.meta.url));
}

function goldSiteDir(): string | null {
  const dataRoot = process.env.DATA_ROOT ?? defaultDataRoot();
  const goldIndex = resolve(dataRoot, "gold/site/index.json");
  if (existsSync(goldIndex)) return resolve(dataRoot, "gold/site");
  if (process.env.SITE_REQUIRE_GOLD === "1") {
    throw new Error(
      `SITE_REQUIRE_GOLD=1 but ${goldIndex} is missing. Run the publisher first.`,
    );
  }
  return null;
}

function fixtureDay(relativePath: string): unknown {
  const parsed = fixtureDays[`../../fixtures/${relativePath}`];
  if (parsed === undefined) {
    throw new Error(`No fixture for ${relativePath}`);
  }
  return parsed;
}

export function loadSiteIndex(): SiteIndex {
  const goldDir = goldSiteDir();
  const parsed: unknown = goldDir
    ? JSON.parse(readFileSync(resolve(goldDir, "index.json"), "utf8"))
    : fixtureIndex;
  assertSiteIndex(parsed);
  return parsed;
}

export function loadSiteDay(date: string, index = loadSiteIndex()): SiteDay {
  const entry = index.days.find((day) => day.date === date);
  if (!entry) throw new Error(`No site day ${date} in the index`);
  const goldDir = goldSiteDir();
  const parsed: unknown = goldDir
    ? JSON.parse(readFileSync(resolve(goldDir, entry.path), "utf8"))
    : fixtureDay(entry.path);
  assertSiteDay(parsed);
  if (parsed.trading_date !== date) {
    throw new Error(
      `Day file ${entry.path} is ${parsed.trading_date}, not ${date}`,
    );
  }
  return parsed;
}

const dayCache = new Map<string, SiteDay>();

/** `loadSiteDay` once per exported file, for pages that read many earlier days. */
export function loadSiteDayCached(
  date: string,
  index = loadSiteIndex(),
): SiteDay {
  const entry = index.days.find((day) => day.date === date);
  const key = entry ? `${entry.path}:${entry.export_sha256}` : date;
  const hit = dayCache.get(key);
  if (hit) return hit;
  const day = loadSiteDay(date, index);
  dayCache.set(key, day);
  return day;
}

/** Load a day when it is in the index. Missing dates return null; they do not fall back. */
export function loadSiteDayIfPresent(
  date: string,
  index = loadSiteIndex(),
): SiteDay | null {
  if (!index.days.some((day) => day.date === date)) return null;
  return loadSiteDay(date, index);
}

/** Newest site events across the latest days. */
export function recentEvents(
  index: SiteIndex,
  loadDay: (date: string) => SiteDay = (date) => loadSiteDay(date, index),
  limit = 8,
): Array<{ date: string; event: SiteEvent }> {
  const found: Array<{ date: string; event: SiteEvent }> = [];
  for (const entry of [...index.days].reverse()) {
    const day = loadDay(entry.date);
    for (const event of day.events?.items ?? []) {
      found.push({ date: entry.date, event });
      if (found.length >= limit) return found;
    }
  }
  return found;
}

/** Newest detected episodes across the latest days, highest severity first per day. */
export function recentEpisodes(
  index: SiteIndex,
  loadDay: (date: string) => SiteDay = (date) => loadSiteDay(date, index),
  limit = 8,
): Array<{ date: string; episode: SiteEpisode }> {
  const found: Array<{ date: string; episode: SiteEpisode }> = [];
  for (const entry of [...index.days].reverse()) {
    const day = loadDay(entry.date);
    const items = day.episodes?.items ?? [];
    for (const episode of items) {
      found.push({ date: entry.date, episode });
      if (found.length >= limit) return found;
    }
  }
  return found;
}

export function formatTradingDate(date: string): string {
  return Temporal.PlainDate.from(date).toLocaleString("en-NZ", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

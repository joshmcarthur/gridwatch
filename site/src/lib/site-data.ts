import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSiteDay,
  assertSiteIndex,
  type SiteDay,
  type SiteEpisode,
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

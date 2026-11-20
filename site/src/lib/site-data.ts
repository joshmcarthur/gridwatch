import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SiteIndex } from "@gridwatch/publisher/site-contract";
import fixtureIndex from "../../fixtures/index.json";

function repoRoot(): string {
  const cwd = process.cwd();
  if (
    existsSync(resolve(cwd, "site")) &&
    existsSync(resolve(cwd, "collector"))
  ) {
    return cwd;
  }
  return resolve(cwd, "..");
}

export function loadSiteIndex(): SiteIndex {
  const dataRoot = process.env.DATA_ROOT ?? resolve(repoRoot(), "data");
  const goldIndex = resolve(dataRoot, "gold/site/index.json");
  if (existsSync(goldIndex)) {
    const parsed: unknown = JSON.parse(readFileSync(goldIndex, "utf8"));
    return parsed as SiteIndex;
  }
  return fixtureIndex as SiteIndex;
}

export function formatTradingDate(date: string): string {
  const parts = date.split("-");
  if (parts.length !== 3) return date;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!year || !month || !day) return date;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-NZ", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

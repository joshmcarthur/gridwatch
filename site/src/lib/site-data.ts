import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSiteIndex,
  type SiteIndex,
} from "@gridwatch/publisher/site-contract";
import fixtureIndex from "../../fixtures/index.json";

function defaultDataRoot(): string {
  return fileURLToPath(new URL("../../../data", import.meta.url));
}

export function loadSiteIndex(): SiteIndex {
  const dataRoot = process.env.DATA_ROOT ?? defaultDataRoot();
  const goldIndex = resolve(dataRoot, "gold/site/index.json");
  const parsed: unknown = existsSync(goldIndex)
    ? JSON.parse(readFileSync(goldIndex, "utf8"))
    : fixtureIndex;
  assertSiteIndex(parsed);
  return parsed;
}

export function formatTradingDate(date: string): string {
  return Temporal.PlainDate.from(date).toLocaleString("en-NZ", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

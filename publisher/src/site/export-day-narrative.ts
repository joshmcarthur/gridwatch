import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkDayBudget,
  checkDayText,
  type DayPackage,
} from "../gold/day-narrative.ts";
import { warnNarrativeCheck } from "../gold/narrative.ts";
import {
  checkWeekBudget,
  checkWeekText,
  type WeekPackage,
} from "../gold/week-narrative.ts";
import type { SiteDayNarrative, SiteWeekNarrative } from "./contract.ts";

const readJson = (path: string): unknown =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown) : null;

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/**
 * The day write-up for the site file (ADR-0031), or null. Over-budget text stays off the
 * page. A failed number check warns and still publishes (ADR-0030).
 */
export function readDayNarrative(
  goldDir: string,
  date: string,
): SiteDayNarrative | null {
  const record = readJson(join(goldDir, "narratives", date, "day.json")) as {
    text?: unknown;
    model?: unknown;
    generated_at?: unknown;
  } | null;
  const pkg = readJson(
    join(goldDir, "evidence", date, "day.json"),
  ) as DayPackage | null;
  const text = asString(record?.text);
  if (!record || !pkg || !text) return null;
  if (!checkDayBudget(text).ok) return null;
  warnNarrativeCheck(checkDayText(text, pkg), `day write-up check ${date}`);
  return {
    text,
    model: asString(record.model) ?? "",
    generated_at: asString(record.generated_at) ?? "",
    moments: (pkg.moments ?? []).map((moment) => ({
      title: moment.title,
      when: moment.when,
    })),
    cable: pkg.totals?.cable != null,
    reserve: pkg.reserve != null,
    incomplete: pkg.incomplete === true,
  };
}

/**
 * The "This week" paragraph for the index, when one was written for the week that ends on
 * `latest`. A paragraph for an older week is not shown. Over-budget text stays off the page.
 */
export function readWeekNarrative(
  goldDir: string,
  latest: string | undefined,
): SiteWeekNarrative | null {
  if (!latest) return null;
  const record = readJson(
    join(goldDir, "narratives", "week", `${latest}.json`),
  ) as { text?: unknown; model?: unknown; generated_at?: unknown } | null;
  const pkg = readJson(
    join(goldDir, "evidence", "week", `${latest}.json`),
  ) as WeekPackage | null;
  const text = asString(record?.text);
  if (!record || !pkg || !text) return null;
  if (!checkWeekBudget(text).ok) return null;
  warnNarrativeCheck(
    checkWeekText(text, pkg),
    `week paragraph check ${latest}`,
  );
  return {
    text,
    model: asString(record.model) ?? "",
    generated_at: asString(record.generated_at) ?? "",
    from: pkg.from,
    to: pkg.to,
    incomplete_days: (pkg.days ?? [])
      .filter((day) => day.incomplete)
      .map((day) => day.date),
  };
}

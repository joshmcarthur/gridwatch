import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  buildDayPackage,
  checkDayBudget,
  checkDayText,
  generateDayNarrative,
} from "../gold/day-narrative.ts";
import {
  type CompleteNarrative,
  warnNarrativeCheck,
} from "../gold/narrative.ts";
import type { CompletenessView } from "../silver/completeness.ts";
import { buildSiteDay } from "./export.ts";

/** Without a range, only the latest days get a write-up, so a first run stays cheap. */
export const DAY_NARRATIVE_RECENT_DAYS = 7;

/** Where the day's package and write-up live, beside the event files (ADR-0027). */
export const dayEvidenceFile = (goldDir: string, date: string) =>
  join(goldDir, "evidence", date, "day.json");
export const dayNarrativeFile = (goldDir: string, date: string) =>
  join(goldDir, "narratives", date, "day.json");

async function writeJsonAtomic(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(`${path}.tmp`, body);
    await rename(`${path}.tmp`, path);
  } finally {
    await rm(`${path}.tmp`, { force: true });
  }
}

function generationDates(
  goldDir: string,
  range?: { from: string; to: string },
): string[] {
  const root = join(goldDir, "generation_by_fuel_day");
  if (!existsSync(root)) return [];
  const prefix = "trading_date=";
  const dates = readdirSync(root)
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();
  if (range)
    return dates.filter((date) => date >= range.from && date <= range.to);
  return dates.slice(-DAY_NARRATIVE_RECENT_DAYS);
}

export interface NarrateDaysResult {
  written: number;
  skipped: number;
  failed: string[];
}

/**
 * Write a package and a write-up for each day (ADR-0031). Skips a day whose write-up exists
 * unless `force` is set, and a day without prices or generation. Over-budget text is kept
 * on disk so it is not paid for again; the export leaves it off the page.
 */
export async function narrateDays(options: {
  goldDir: string;
  silverDir: string;
  completeness: CompletenessView;
  range?: { from: string; to: string };
  force: boolean;
  complete: CompleteNarrative;
  model: string;
  now?: Date;
}): Promise<NarrateDaysResult> {
  const now = options.now ?? new Date();
  const result: NarrateDaysResult = { written: 0, skipped: 0, failed: [] };
  for (const date of generationDates(options.goldDir, options.range)) {
    const path = dayNarrativeFile(options.goldDir, date);
    if (!options.force && existsSync(path)) {
      result.skipped += 1;
      continue;
    }
    try {
      const day = await buildSiteDay({
        goldDir: options.goldDir,
        silverDir: options.silverDir,
        date,
        completeness: options.completeness,
      });
      if (
        day.prices.state === "missing" ||
        day.generation.state === "missing"
      ) {
        result.skipped += 1;
        continue;
      }
      const pkg = buildDayPackage(day);
      const bytes = `${JSON.stringify(pkg, null, 2)}\n`;
      await writeJsonAtomic(dayEvidenceFile(options.goldDir, date), bytes);
      const record = await generateDayNarrative(pkg, {
        complete: options.complete,
        model: options.model,
        now,
        packageId: createHash("sha256").update(bytes).digest("hex"),
      });
      warnNarrativeCheck(
        checkDayText(record.text, pkg),
        `day write-up check ${date}`,
      );
      const budget = checkDayBudget(record.text);
      if (!budget.ok) {
        console.warn(
          `day write-up ${date} is over budget (${budget.sentences} sentences, ${budget.words} words, ${budget.numbers} numbers) and will not be published`,
        );
      }
      await writeJsonAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
      result.written += 1;
    } catch (error) {
      result.failed.push(`${date}: ${(error as Error).message}`);
    }
  }
  return result;
}

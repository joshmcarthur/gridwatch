import type { SiteDay } from "../site/contract.ts";
import { dayBeats } from "../story/day-beats.ts";
import { TYPE_LABELS } from "../story/episode-copy.ts";
import { FUEL_LABELS, type StackFuel } from "../story/generation-mix.ts";
import { clockLabeller12, zonedAt } from "../story/period-clock.ts";
import { cents, checkDayBudget, parseDayText } from "./day-narrative.ts";
import {
  type CompleteNarrative,
  checkText,
  type NarrativeCheck,
  withSiteCopy,
} from "./narrative.ts";

/**
 * The "This week" paragraph on the homepage (ADR-0031): the same budget as a day write-up,
 * from a package that cuts each of the last seven days to a few figures.
 */

export const WEEK_PROMPT_VERSION = 1;
export const WEEK_DAYS = 7;

export interface WeekPackage {
  from: string;
  to: string;
  days: Array<{
    date: string;
    weekday: string;
    headline: string | null;
    incomplete: boolean;
    /** The three largest fuels, as a percent of the day's generation. */
    fuel_shares: Array<{ fuel: string; percent: number }>;
    otahuhu_average_cents: number | null;
    benmore_average_cents: number | null;
    /** Ōtāhuhu's highest half-hour among the day's price peaks. */
    highest: { title: string; at: string; cents: number } | null;
    unusual: string[];
  }>;
}

export interface WeekNarrativeRecord {
  schema_version: number;
  prompt_version: number;
  package_id: string;
  from: string;
  to: string;
  model: string;
  generated_at: string;
  text: string;
}

const averageCents = (day: SiteDay, poc: string): number | null => {
  const mean = day.prices.nodes.find((node) => node.point_of_connection === poc)
    ?.daily.mean_price;
  return mean === null || mean === undefined ? null : cents(mean);
};

function fuelShares(day: SiteDay): WeekPackage["days"][number]["fuel_shares"] {
  if (day.generation.state === "missing") return [];
  const byFuel = new Map<string, number>();
  for (const row of day.generation.daily) {
    if (row.fuel === "battery") continue;
    byFuel.set(row.fuel, (byFuel.get(row.fuel) ?? 0) + row.megawatt_hours);
  }
  const total = [...byFuel.values()].reduce((sum, value) => sum + value, 0);
  if (total <= 0) return [];
  return [...byFuel.entries()]
    .map(([fuel, value]) => ({
      fuel: FUEL_LABELS[fuel as StackFuel] ?? fuel,
      percent: Math.round((value / total) * 100),
    }))
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 3);
}

function weekDay(day: SiteDay): WeekPackage["days"][number] {
  const story = dayBeats(day);
  const label = clockLabeller12(day);
  const ota = day.prices.nodes.find(
    (node) => node.point_of_connection === "OTA2201",
  );
  let highest: WeekPackage["days"][number]["highest"] = null;
  let highestPrice = Number.NEGATIVE_INFINITY;
  for (const beat of story.beats.filter((item) => item.rule === "price_peak")) {
    const index = day.periods.findIndex((item) => item.period === beat.at);
    const price = ota?.price[index] ?? null;
    const period = day.periods[index];
    if (price !== null && period && price > highestPrice) {
      highestPrice = price;
      highest = {
        title: beat.title,
        at: label(zonedAt(period.start_utc)),
        cents: cents(price),
      };
    }
  }
  const types = new Set(
    (day.episodes?.items ?? []).flatMap((episode) => episode.observation_types),
  );
  return {
    date: day.trading_date,
    weekday: Temporal.PlainDate.from(day.trading_date).toLocaleString("en-NZ", {
      weekday: "long",
    }),
    headline: story.headline,
    incomplete: !day.complete,
    fuel_shares: fuelShares(day),
    otahuhu_average_cents: averageCents(day, "OTA2201"),
    benmore_average_cents: averageCents(day, "BEN2201"),
    highest,
    unusual: [...types].flatMap((type) => {
      const words = TYPE_LABELS[type];
      return words ? [words] : [];
    }),
  };
}

/** The package for the week ending on the last of `days` (ascending, up to seven). */
export function buildWeekPackage(days: SiteDay[]): WeekPackage {
  return {
    from: days[0]?.trading_date ?? "",
    to: days.at(-1)?.trading_date ?? "",
    days: days.map(weekDay),
  };
}

const WEEK_INSTRUCTIONS = `You write the "This week" paragraph on the Gridwatch homepage, for a curious non-specialist.

You receive the last seven days as JSON, each cut to a few figures. Use only what that JSON contains. Do not invent numbers, days, places or causes. Copy figures as the JSON gives them. Do not mention the JSON, data, files or figures as such. If a day's files are incomplete, do not lean on that day.

Length is strict:
- At most 2 sentences and about 40 words.
- At most 3 numbers. A clock time counts as a number.

Describe how the week moved: what changed from the start of the week to the end, and the one day or stretch that stood out. Give at most one cause, hedged in one short clause. Do not end with a sentence that says the figures cannot show why. Use weekday names, not dates.

Prices are cents per kWh, written like 3.1c or 17c. Name places (Ōtāhuhu, Benmore), never "the North" or "the South" for a price. Write in plain sentences, not a run of short statements.

This sample is style only. Copy a figure from it only when the same figure is in this JSON:

{"text":"The week began windy, with Ōtāhuhu averaging under 4c per kWh. As wind's share fell from 18% to 4%, prices there roughly doubled, and reserve prices in the North Island stood out mid-week."}

Reply with JSON only, no markdown, in this shape:
{"text":"..."}`;

let cachedWeekPrompt: string | undefined;

export const weekSystemPrompt = (): string => {
  cachedWeekPrompt ??= withSiteCopy(WEEK_INSTRUCTIONS);
  return cachedWeekPrompt;
};

export function checkWeekText(text: string, pkg: WeekPackage): NarrativeCheck {
  return checkText(text, pkg);
}

export { checkDayBudget as checkWeekBudget };

export async function generateWeekNarrative(
  pkg: WeekPackage,
  options: {
    complete: CompleteNarrative;
    model: string;
    now: Date;
    packageId: string;
  },
): Promise<WeekNarrativeRecord> {
  const text = parseDayText(
    await options.complete({
      system: weekSystemPrompt(),
      user: JSON.stringify(pkg),
      model: options.model,
    }),
  );
  return {
    schema_version: 1,
    prompt_version: WEEK_PROMPT_VERSION,
    package_id: options.packageId,
    from: pkg.from,
    to: pkg.to,
    model: options.model,
    generated_at: options.now.toISOString().replace(/\.000Z$/, "Z"),
    text,
  };
}

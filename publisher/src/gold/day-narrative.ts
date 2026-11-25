import type { SiteDay } from "../site/contract.ts";
import { dayBeats } from "../story/day-beats.ts";
import { FUEL_LABELS, type StackFuel } from "../story/generation-mix.ts";
import { clockLabeller12, zonedAt } from "../story/period-clock.ts";
import {
  CLOCK_TOKEN,
  type CompleteNarrative,
  checkText,
  type NarrativeCheck,
  NUMBER_TOKEN,
  withSiteCopy,
} from "./narrative.ts";

/**
 * Day write-ups (ADR-0031): two short sentences under a day's headline, written by a model
 * from a package built from the day's beats. Same machinery as event narratives (ADR-0027):
 * the model sees only the package, `checkText` compares every number with it, and a failed
 * check warns but still publishes (ADR-0030).
 */

export const DAY_SCHEMA_VERSION = 1;
export const DAY_PROMPT_VERSION = 1;

/** The length budget. Text over it is not published, and the page keeps its lede. */
export const DAY_BUDGET = { sentences: 2, words: 50, numbers: 3 } as const;

const PLACES = [
  ["OTA2201", "Ōtāhuhu"],
  ["HAY2201", "Haywards"],
  ["BEN2201", "Benmore"],
] as const;

export interface DayPackage {
  trading_date: string;
  /** For the model to avoid repeating, not to restate. */
  headline: string | null;
  incomplete: boolean;
  totals: {
    generated_megawatt_hours: number | null;
    cable: {
      sender: "South Island" | "North Island";
      direction: "north" | "south";
      sent_megawatt_hours: number;
      arrived_megawatt_hours: number | null;
    } | null;
  };
  fuel_shares: Array<{ fuel: string; percent: number }>;
  moments: Array<{
    title: string;
    when: string;
    /** The half-hour the moment points at. */
    at: string;
    text: string;
    fuels: string[];
    /** Every number in `text`, so the check accepts the moment's own figures. */
    figures: number[];
    /** Half-hour wholesale prices at `at`, in cents per kWh and $/MWh. */
    prices: Array<{ place: string; cents: number; dollars_per_mwh: number }>;
  }>;
  /** The highest half-hour of North Island reserve, when an episode had high reserve prices. */
  reserve: { at: string; cents: number; dollars_per_mwh: number } | null;
}

export interface DayNarrativeRecord {
  schema_version: number;
  prompt_version: number;
  package_id: string;
  trading_date: string;
  model: string;
  generated_at: string;
  text: string;
}

/** Cents per kWh as the site prints them: one decimal under 10c, whole cents above. */
export const cents = (dollarsPerMwh: number): number => {
  const value = dollarsPerMwh / 10;
  return Math.abs(value) < 10 ? Math.round(value * 10) / 10 : Math.round(value);
};

const round = (value: number, places = 0): number => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

/** Numbers in a sentence, with clock times left out. */
export function numbersIn(text: string): number[] {
  const masked = text.replace(new RegExp(CLOCK_TOKEN, "gi"), (span) =>
    " ".repeat(span.length),
  );
  return [...masked.matchAll(new RegExp(NUMBER_TOKEN, "g"))]
    .map((match) =>
      Number((match[0] ?? "").replace(/[$,]/g, "").replace(/c$/, "")),
    )
    .filter((value) => Number.isFinite(value));
}

function priceAt(day: SiteDay, poc: string, index: number): number | null {
  const node = day.prices.nodes.find(
    (item) => item.point_of_connection === poc,
  );
  return node?.price[index] ?? null;
}

function cable(day: SiteDay): DayPackage["totals"]["cable"] {
  const islands = day.sankey?.islands ?? [];
  const sender = islands.find(
    (island) => (island.hvdc_import_megawatt_hours ?? 0) < 0,
  );
  const sent = sender?.hvdc_import_megawatt_hours ?? null;
  if (!sender || sent === null) return null;
  const arrived =
    islands.find((island) => island !== sender)?.hvdc_import_megawatt_hours ??
    null;
  return {
    sender: sender.island === "SI" ? "South Island" : "North Island",
    direction: sender.island === "SI" ? "north" : "south",
    sent_megawatt_hours: round(-sent),
    arrived_megawatt_hours:
      arrived !== null && arrived > 0 ? round(arrived) : null,
  };
}

function fuelShares(day: SiteDay): DayPackage["fuel_shares"] {
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
    .filter((share) => share.percent > 0)
    .sort((a, b) => b.percent - a.percent);
}

function reserve(
  day: SiteDay,
  label: (index: number) => string,
): DayPackage["reserve"] {
  const high = (day.episodes?.items ?? []).some((episode) =>
    episode.observation_types.includes("reserve_price_high"),
  );
  if (!high || !day.reserves || day.reserves.state === "missing") return null;
  let best: { index: number; price: number } | null = null;
  for (const item of day.reserves.classes) {
    if (item.island !== "NI") continue;
    (item.price ?? []).forEach((price, index) => {
      if (price !== null && (best === null || price > best.price)) {
        best = { index, price };
      }
    });
  }
  if (best === null) return null;
  const { index, price } = best as { index: number; price: number };
  return {
    at: label(index),
    cents: cents(price),
    dollars_per_mwh: round(price, 2),
  };
}

/**
 * The package a day write-up is written from: the day's beats with the half-hour figures
 * they point at, the totals, each fuel's share and, on a high-reserve day, the reserve peak.
 * Half-hour figures only: a dispatch maximum is not a half-hour price.
 */
export function buildDayPackage(day: SiteDay): DayPackage {
  const story = dayBeats(day);
  const labeller = clockLabeller12(day);
  const label = (index: number) => {
    const period = day.periods[index];
    return period ? labeller(zonedAt(period.start_utc)) : "";
  };
  const generated =
    day.generation.state === "missing" || day.generation.totals === null
      ? null
      : round(day.generation.totals.primary_megawatt_hours);
  return {
    trading_date: day.trading_date,
    headline: story.headline,
    incomplete: !day.complete,
    totals: { generated_megawatt_hours: generated, cable: cable(day) },
    fuel_shares: fuelShares(day),
    moments: story.beats.map((beat) => {
      const index = day.periods.findIndex((item) => item.period === beat.at);
      return {
        title: beat.title,
        when: beat.when,
        at: label(index),
        text: beat.text,
        fuels: beat.fuels.map((fuel) => FUEL_LABELS[fuel] ?? fuel),
        figures: numbersIn(beat.text),
        prices: PLACES.flatMap(([poc, place]) => {
          const price = priceAt(day, poc, index);
          return price === null
            ? []
            : [
                {
                  place,
                  cents: cents(price),
                  dollars_per_mwh: round(price, 2),
                },
              ];
        }),
      };
    }),
    reserve: reserve(day, label),
  };
}

const DAY_INSTRUCTIONS = `You write the short write-up under the headline of a Gridwatch day page, for a curious non-specialist.

You receive one day's figures as JSON. Use only what that JSON contains. Do not invent numbers, times, places or causes that the JSON cannot support. Copy figures as the JSON gives them. Do not mention the JSON, data, files or figures as such.

Length is strict:
- At most 2 sentences and about 40 words.
- At most 3 numbers. A clock time counts as a number.

Pick the one or two things that matter most that day. The page's moments, map and charts carry the rest, so do not list them. Do not repeat the headline in the JSON. Give at most one cause, hedged in one short clause ("which may point to ..."). Do not end with a sentence that says the figures cannot show why.

Prices are cents per kWh, written like 330c or 6.8c. Name places (Ōtāhuhu, Haywards, Benmore), never "the North" or "the South" for a price. Generation may be per island. Write in plain sentences, not a run of short statements.

These samples are style only. Copy a figure from them only when the same figure is in this JSON:

{"text":"Ōtāhuhu spiked twice, reaching 330c per kWh at 5:30pm while Benmore stayed far lower. Reserve in the North Island cost 215c at the same time, which may point to spare capacity running short."}

{"text":"Geothermal output dropped by about 310 MW in the morning and stayed down, which may have left Ōtāhuhu more exposed when it reached 17c per kWh at 8:30pm. Benmore was cheaper than Ōtāhuhu all day."}

Reply with JSON only, no markdown, in this shape:
{"text":"..."}`;

let cachedDayPrompt: string | undefined;

export const daySystemPrompt = (): string => {
  cachedDayPrompt ??= withSiteCopy(DAY_INSTRUCTIONS);
  return cachedDayPrompt;
};

export function parseDayText(text: string): string {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("day write-up is not JSON");
  }
  const value = (parsed as { text?: unknown } | null)?.text;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("day write-up missing text");
  }
  return value.trim();
}

export interface BudgetCheck {
  ok: boolean;
  sentences: number;
  words: number;
  numbers: number;
}

/** Sentences, words and numbers (clock times included) against `DAY_BUDGET`. */
export function checkDayBudget(text: string): BudgetCheck {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .filter((part) => part.trim() !== "").length;
  const words = text.split(/\s+/).filter((word) => word !== "").length;
  const clocks = [...text.matchAll(new RegExp(CLOCK_TOKEN, "gi"))].length;
  const numbers = numbersIn(text).length + clocks;
  return {
    ok:
      sentences <= DAY_BUDGET.sentences &&
      words <= DAY_BUDGET.words &&
      numbers <= DAY_BUDGET.numbers,
    sentences,
    words,
    numbers,
  };
}

export function checkDayText(text: string, pkg: DayPackage): NarrativeCheck {
  return checkText(text, pkg);
}

export async function generateDayNarrative(
  pkg: DayPackage,
  options: {
    complete: CompleteNarrative;
    model: string;
    now: Date;
    packageId: string;
  },
): Promise<DayNarrativeRecord> {
  const text = parseDayText(
    await options.complete({
      system: daySystemPrompt(),
      user: JSON.stringify(pkg),
      model: options.model,
    }),
  );
  return {
    schema_version: DAY_SCHEMA_VERSION,
    prompt_version: DAY_PROMPT_VERSION,
    package_id: options.packageId,
    trading_date: pkg.trading_date,
    model: options.model,
    generated_at: options.now.toISOString().replace(/\.000Z$/, "Z"),
    text,
  };
}

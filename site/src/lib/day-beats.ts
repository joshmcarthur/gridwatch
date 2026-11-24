import type { SiteDay } from "@gridwatch/publisher/site-contract";
import { episodeHeadline } from "./episode-copy.ts";
import {
  FUEL_LABELS,
  type GenerationMix,
  generationMix,
  type StackFuel,
} from "./generation-mix.ts";
import { clockLabeller12, zonedAt } from "./period-clock.ts";
import { centsPerKwh } from "./price-regions.ts";

export { centsPerKwh };

/**
 * A day's story as beats (ADR-0029). Every sentence comes from the day file by a fixed rule.
 * No sentence states a cause: explainers and the LLM narratives do that.
 */

export const OTAHUHU = "OTA2201";
export const HAYWARDS = "HAY2201";
export const BENMORE = "BEN2201";
export const REFERENCE_PLACES = [OTAHUHU, HAYWARDS, BENMORE] as const;

const PLACE: Record<string, string> = {
  [OTAHUHU]: "Ōtāhuhu",
  [HAYWARDS]: "Haywards",
  [BENMORE]: "Benmore",
};

export type BeatRule =
  | "price_peak"
  | "price_low"
  | "fuel_high"
  | "step_change"
  | "episode"
  | "cable";

export interface Beat {
  rule: BeatRule;
  title: string;
  /** First trading period in the window. */
  from: number;
  /** Last trading period in the window (inclusive). */
  to: number;
  /** The trading period the beat points at: a peak, a low, a high or a step. */
  at: number;
  /** Clock range for the window, for example `5:00pm to 8:30pm`, or `All day`. */
  when: string;
  fuels: StackFuel[];
  /** Points of connection the beat is about. */
  places: string[];
  text: string;
  /** Episodes joined to this beat. */
  episodeIds: string[];
  /** The site's line for each episode joined to this beat, shown under the text. */
  flags: string[];
  link: { href: string; label: string } | null;
}

export interface DayStory {
  /** Null when the day has neither prices nor generation. */
  headline: string | null;
  lede: string | null;
  beats: Beat[];
}

/** Rule thresholds (ADR-0029). */
export const BEAT_THRESHOLDS = {
  peakShareOfTop: 0.4,
  peakTimesMedian: 3,
  peakMinGapPeriods: 8,
  peakWindowMaxPeriods: 8,
  fuelMoveMegawatts: 50,
  fuelHighShare: 0.1,
  stepMegawatts: 150,
  stepKept: 0.8,
  spikeTimesMedian: 10,
  gapDollarsPerMwh: 30,
} as const;

const whole = new Intl.NumberFormat("en-NZ", { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat("en-NZ", {
  style: "percent",
  maximumFractionDigits: 0,
});

function megawatts(value: number): string {
  return `${whole.format(Math.round(value / 10) * 10)} MW`;
}

function joinAnd(parts: string[]): string {
  if (parts.length < 2) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function present(series: Array<number | null>): number[] {
  return series.filter((value): value is number => value !== null);
}

interface Clocks {
  start: (index: number) => string;
  end: (index: number) => string;
  hour: (index: number) => number;
  when: (from: number, to: number) => string;
}

function clocksFor(day: Pick<SiteDay, "periods">): Clocks {
  const label = clockLabeller12(day);
  const zoned = (index: number) => {
    const period = day.periods[index];
    if (!period) throw new Error(`No period at index ${index}`);
    return zonedAt(period.start_utc);
  };
  const start = (index: number) => label(zoned(index));
  const end = (index: number) =>
    index + 1 < day.periods.length
      ? start(index + 1)
      : label(zoned(index).add({ minutes: 30 }));
  return {
    start,
    end,
    hour: (index) => zoned(index).hour,
    when: (from, to) =>
      from === 0 && to === day.periods.length - 1
        ? "All day"
        : `${start(from)} to ${end(to)}`,
  };
}

function partOfDay(hour: number): string {
  if (hour < 6) return "Overnight";
  if (hour < 12) return "Morning";
  if (hour < 17) return "Afternoon";
  return "Evening";
}

function priceSeries(day: SiteDay, poc: string): Array<number | null> | null {
  if (day.prices.state === "missing") return null;
  const node = day.prices.nodes.find((n) => n.point_of_connection === poc);
  return node ? node.price : null;
}

function fuelSeries(mix: GenerationMix, fuel: StackFuel): Array<number | null> {
  return mix.points.map((point) =>
    point.kind === "gap" ? null : point.megawatts[fuel],
  );
}

function primarySeries(mix: GenerationMix): Array<number | null> {
  return mix.points.map((point) =>
    point.kind === "gap" ? null : point.primary,
  );
}

/** Index of the largest present value, or -1. */
function indexOfMax(series: Array<number | null>): number {
  let best = -1;
  series.forEach((value, index) => {
    if (value === null) return;
    const current = best === -1 ? null : series[best];
    if (current === null || current === undefined || value > current) {
      best = index;
    }
  });
  return best;
}

/** Fuels that moved by at least the threshold between two periods, largest first, at most three. */
function fuelMoves(
  mix: GenerationMix | null,
  from: number,
  to: number,
): Array<{ fuel: StackFuel; change: number }> {
  if (!mix) return [];
  const moves: Array<{ fuel: StackFuel; change: number }> = [];
  for (const layer of mix.layers) {
    const series = fuelSeries(mix, layer.fuel);
    const before = series[from];
    const after = series[to];
    if (before === null || before === undefined) continue;
    if (after === null || after === undefined) continue;
    const change = after - before;
    if (Math.abs(change) >= BEAT_THRESHOLDS.fuelMoveMegawatts) {
      moves.push({ fuel: layer.fuel, change });
    }
  }
  return moves
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
    .slice(0, 3);
}

function fuelWord(fuel: StackFuel): string {
  return FUEL_LABELS[fuel].toLowerCase();
}

/** "hydro rose by 830 MW and gas by 120 MW, while solar fell by 230 MW" */
function movesSentence(
  moves: Array<{ fuel: StackFuel; change: number }>,
): string | null {
  const list = (items: typeof moves, verb: string) =>
    joinAnd(
      items.map(
        (move, at) =>
          `${fuelWord(move.fuel)}${at === 0 ? ` ${verb}` : ""} by ${megawatts(Math.abs(move.change))}`,
      ),
    );
  const up = moves.filter((move) => move.change > 0);
  const down = moves.filter((move) => move.change < 0);
  if (up.length > 0 && down.length > 0) {
    return `${list(up, "rose")}, while ${list(down, "fell")}`;
  }
  if (up.length > 0) return list(up, "rose");
  if (down.length > 0) return list(down, "fell");
  return null;
}

function beat(
  clocks: Clocks,
  fields: Omit<
    Beat,
    "from" | "to" | "at" | "when" | "episodeIds" | "flags" | "link"
  > & {
    fromIndex: number;
    toIndex: number;
    atIndex: number;
    link?: Beat["link"];
  },
  periodOf: (index: number) => number,
): Beat {
  const { fromIndex, toIndex, atIndex, link, ...rest } = fields;
  return {
    ...rest,
    from: periodOf(fromIndex),
    to: periodOf(toIndex),
    at: periodOf(atIndex),
    when: clocks.when(fromIndex, toIndex),
    episodeIds: [],
    flags: [],
    link: link ?? null,
  };
}

/** The day's headline, lede and beats. Missing sections skip the rules that need them. */
export function dayBeats(day: SiteDay): DayStory {
  const count = day.periods.length;
  if (count === 0) return { headline: null, lede: null, beats: [] };
  const clocks = clocksFor(day);
  const periodOf = (index: number) => day.periods[index]?.period ?? index + 1;
  const indexOf = (period: number) =>
    day.periods.findIndex((item) => item.period === period);
  const ota = priceSeries(day, OTAHUHU);
  const ben = priceSeries(day, BENMORE);
  const mix = generationMix(day);
  const total = mix ? primarySeries(mix) : null;
  const beats: Beat[] = [];
  const t = BEAT_THRESHOLDS;

  // price_peak
  const peaks: number[] = [];
  if (ota && present(ota).length > 0) {
    const values = present(ota);
    const top = Math.max(...values);
    const floor = Math.min(
      t.peakShareOfTop * top,
      t.peakTimesMedian * median(values),
    );
    const order = ota
      .map((value, index) => ({ value, index }))
      .filter(
        (item): item is { value: number; index: number } => item.value !== null,
      )
      .sort((a, b) => b.value - a.value);
    for (const item of order) {
      if (item.value < floor || item.value <= 0) break;
      if (peaks.every((p) => Math.abs(p - item.index) >= t.peakMinGapPeriods)) {
        peaks.push(item.index);
      }
      if (peaks.length === 2) break;
    }
    for (const pk of peaks) {
      const peak = ota[pk] ?? 0;
      const above = (index: number) => {
        const value = ota[index];
        return value !== null && value !== undefined && value >= peak / 2;
      };
      let a = pk;
      let b = pk;
      while (a > 0 && above(a - 1) && pk - a < t.peakWindowMaxPeriods) a--;
      while (b < count - 1 && above(b + 1) && b - pk < t.peakWindowMaxPeriods)
        b++;
      const ref = Math.max(0, a - 4);
      const moves = fuelMoves(mix, ref, pk);
      const benAt = ben?.[pk];
      const parts = [
        benAt !== null && benAt !== undefined
          ? `Ōtāhuhu peaked at ${centsPerKwh(peak)} per kWh at ${clocks.start(pk)}, while Benmore was ${centsPerKwh(benAt)}.`
          : `Ōtāhuhu peaked at ${centsPerKwh(peak)} per kWh at ${clocks.start(pk)}.`,
      ];
      const moved = movesSentence(moves);
      if (moved) {
        parts.push(`Between ${clocks.start(ref)} and the peak, ${moved}.`);
      }
      beats.push(
        beat(
          clocks,
          {
            rule: "price_peak",
            atIndex: pk,
            title: `${partOfDay(clocks.hour(pk))} price peak`,
            fromIndex: a,
            toIndex: b,
            fuels: moves.map((move) => move.fuel),
            places: [OTAHUHU, BENMORE],
            text: parts.join(" "),
          },
          periodOf,
        ),
      );
    }
  }

  // price_low
  let low: { poc: string; index: number; value: number } | null = null;
  for (const poc of REFERENCE_PLACES) {
    const series = priceSeries(day, poc);
    series?.forEach((value, index) => {
      if (value === null) return;
      if (low === null || value < low.value) low = { poc, index, value };
    });
  }
  const cheapest = low as { poc: string; index: number; value: number } | null;
  if (
    cheapest !== null &&
    !beats.some(
      (b) =>
        periodOf(cheapest.index) >= b.from && periodOf(cheapest.index) <= b.to,
    )
  ) {
    const atHigh: StackFuel[] = [];
    if (mix) {
      for (const fuel of ["wind", "solar"] as const) {
        const series = fuelSeries(mix, fuel);
        const value = series[cheapest.index];
        const top = Math.max(...present(series), 0);
        if (
          value !== null &&
          value !== undefined &&
          top > 0 &&
          value >= 0.9 * top
        ) {
          atHigh.push(fuel);
        }
      }
    }
    const otaAt = ota?.[cheapest.index];
    const compare =
      cheapest.poc !== OTAHUHU && otaAt !== null && otaAt !== undefined
        ? `, when Ōtāhuhu was ${centsPerKwh(otaAt)}`
        : "";
    const parts = [
      `The cheapest half-hour was ${clocks.start(cheapest.index)} at ${PLACE[cheapest.poc]}, ${centsPerKwh(cheapest.value)} per kWh${compare}.`,
    ];
    if (atHigh.length > 0) {
      parts.push(
        `${joinAnd(atHigh.map((fuel) => FUEL_LABELS[fuel]))} was close to its peak for the day.`,
      );
    }
    beats.push(
      beat(
        clocks,
        {
          rule: "price_low",
          atIndex: cheapest.index,
          title: "Cheapest moment",
          fromIndex: Math.max(0, cheapest.index - 2),
          toIndex: Math.min(count - 1, cheapest.index + 2),
          fuels: atHigh,
          places: [...new Set([cheapest.poc, OTAHUHU])],
          text: parts.join(" "),
        },
        periodOf,
      ),
    );
  }

  // fuel_high
  if (mix && total) {
    for (const fuel of ["wind", "solar"] as const) {
      if (!mix.layers.some((layer) => layer.fuel === fuel)) continue;
      const series = fuelSeries(mix, fuel);
      const i = indexOfMax(series);
      const value = series[i];
      const all = total[i];
      if (value === null || value === undefined || !all) continue;
      const share = value / all;
      if (share < t.fuelHighShare) continue;
      const near = (index: number) => {
        const v = series[index];
        return v !== null && v !== undefined && v >= 0.75 * value;
      };
      let a = i;
      let b = i;
      while (a > 0 && near(a - 1)) a--;
      while (b < count - 1 && near(b + 1)) b++;
      const otaAt = ota?.[i];
      const benAt = ben?.[i];
      const prices =
        otaAt !== null &&
        otaAt !== undefined &&
        benAt !== null &&
        benAt !== undefined
          ? `, when Ōtāhuhu was ${centsPerKwh(otaAt)} per kWh and Benmore ${centsPerKwh(benAt)}`
          : "";
      const parts = [
        `${FUEL_LABELS[fuel]} peaked at ${clocks.start(i)} with ${megawatts(value)}, ${percent.format(share)} of everything generated${prices}.`,
      ];
      beats.push(
        beat(
          clocks,
          {
            rule: "fuel_high",
            atIndex: i,
            title: `${FUEL_LABELS[fuel]} at its highest`,
            fromIndex: a,
            toIndex: b,
            fuels: [fuel],
            places: [OTAHUHU, BENMORE],
            text: parts.join(" "),
          },
          periodOf,
        ),
      );
    }
  }

  // step_change
  if (mix?.layers.some((layer) => layer.fuel === "geothermal")) {
    const series = fuelSeries(mix, "geothermal");
    let best: { at: number; change: number } | null = null;
    for (let at = 4; at <= count - 4; at++) {
      const before = series.slice(at - 4, at);
      const after = series.slice(at, at + 4);
      const rest = series.slice(at);
      if ([...before, ...after, ...rest].some((value) => value === null)) {
        continue;
      }
      const base = mean(present(before));
      const change = mean(present(after)) - base;
      const kept = mean(present(rest)) - base;
      if (
        Math.abs(change) >= t.stepMegawatts &&
        Math.abs(kept) >= t.stepKept * Math.abs(change) &&
        Math.sign(kept) === Math.sign(change) &&
        (best === null || Math.abs(change) > Math.abs(best.change))
      ) {
        best = { at, change };
      }
    }
    if (best) {
      const down = best.change < 0;
      beats.push(
        beat(
          clocks,
          {
            rule: "step_change",
            atIndex: best.at,
            title: `Geothermal ${down ? "dropped" : "rose"}`,
            fromIndex: Math.max(0, best.at - 2),
            toIndex: Math.min(count - 1, best.at + 1),
            fuels: ["geothermal"],
            places: [],
            text: `Geothermal output ${down ? "dropped" : "jumped"} by about ${megawatts(Math.abs(best.change))} around ${clocks.start(best.at)} and stayed ${down ? "down" : "up"} for the rest of the day. The files show the change, but not what caused it.`,
          },
          periodOf,
        ),
      );
    }
  }

  // episode
  const episodes =
    day.episodes && day.episodes.state !== "missing" ? day.episodes.items : [];
  for (const episode of episodes) {
    const line = episodeHeadline(episode, day);
    const host = beats.find(
      (b) =>
        b.rule === "price_peak" &&
        episode.start_trading_period <= b.to &&
        episode.end_trading_period >= b.from,
    );
    if (host) {
      host.flags.push(line);
      host.episodeIds.push(episode.episode_id);
      continue;
    }
    const fromIndex = indexOf(episode.start_trading_period);
    const toIndex = indexOf(episode.end_trading_period);
    if (fromIndex === -1 || toIndex === -1) continue;
    const added = beat(
      clocks,
      {
        rule: "episode",
        atIndex: fromIndex,
        title: "Unusual stretch",
        fromIndex,
        toIndex,
        fuels: [],
        places: [OTAHUHU, BENMORE],
        text: line,
      },
      periodOf,
    );
    added.episodeIds.push(episode.episode_id);
    beats.push(added);
  }

  // Written-up events (ADR-0027): the beat that overlaps an event's window links to it.
  for (const event of day.events?.items ?? []) {
    const host =
      beats.find(
        (b) =>
          b.rule === "price_peak" &&
          event.start_trading_period <= b.to &&
          event.end_trading_period >= b.from,
      ) ??
      beats.find(
        (b) =>
          event.start_trading_period <= b.to &&
          event.end_trading_period >= b.from,
      );
    if (host && host.link === null) {
      host.link = {
        href: `#event-${event.episode_id}`,
        label: "Read the write-up of this stretch",
      };
    }
  }

  // cable
  const south = day.sankey?.islands.find((island) => island.island === "SI");
  let cheaperLine: string | null = null;
  if (ota && ben) {
    let cheaper = 0;
    let compared = 0;
    ota.forEach((value, index) => {
      const other = ben[index];
      if (value === null || other === null || other === undefined) return;
      compared += 1;
      if (other < value) cheaper += 1;
    });
    if (compared > 0) {
      cheaperLine =
        cheaper === compared
          ? "Benmore was cheaper than Ōtāhuhu all day."
          : `Benmore was cheaper than Ōtāhuhu in ${cheaper} of ${compared} half-hours.`;
    }
  }
  const sent = south?.hvdc_import_megawatt_hours;
  if (
    south &&
    south.generation_megawatt_hours !== null &&
    south.load_megawatt_hours !== null &&
    sent !== null &&
    sent !== undefined
  ) {
    const parts = [
      `The South Island made ${whole.format(south.generation_megawatt_hours)} MWh against an estimated load of ${whole.format(south.load_megawatt_hours)} MWh, and the cable carried ${whole.format(Math.abs(sent))} MWh ${sent <= 0 ? "north" : "south"}.`,
    ];
    if (cheaperLine) parts.push(cheaperLine);
    beats.push(
      beat(
        clocks,
        {
          rule: "cable",
          atIndex: 0,
          title: "The cable",
          fromIndex: 0,
          toIndex: count - 1,
          fuels: [],
          places: [OTAHUHU, BENMORE],
          text: parts.join(" "),
          link: {
            href: "/explainers/hvdc-link/",
            label: "Why prices can differ between places: the Cook Strait link",
          },
        },
        periodOf,
      ),
    );
  }

  beats.sort(
    (a, b) =>
      Number(a.rule === "cable") - Number(b.rule === "cable") ||
      a.from - b.from,
  );

  // Headline and lede.
  let topFuel: { label: string; share: number } | null = null;
  if (mix && total) {
    const sumAll = present(total).reduce((sum, value) => sum + value, 0);
    for (const layer of mix.layers) {
      const sum = present(fuelSeries(mix, layer.fuel)).reduce(
        (acc, value) => acc + value,
        0,
      );
      if (sumAll > 0 && (topFuel === null || sum / sumAll > topFuel.share)) {
        topFuel = { label: layer.label, share: sum / sumAll };
      }
    }
  }
  const fuelClause = topFuel
    ? `${topFuel.label} made ${percent.format(topFuel.share)} of the day's electricity`
    : null;
  const otaValues = ota ? present(ota) : [];
  const benValues = ben ? present(ben) : [];
  const first = peaks[0];
  const firstPrice = first === undefined ? null : (ota?.[first] ?? null);
  let headline: string | null = fuelClause;
  let spike = false;
  if (otaValues.length > 0) {
    const top = Math.max(...otaValues);
    const gap = benValues.length > 0 ? mean(otaValues) - mean(benValues) : 0;
    if (first !== undefined && top >= t.spikeTimesMedian * median(otaValues)) {
      headline = `Ōtāhuhu hit ${centsPerKwh(top)} per kWh at ${clocks.start(first)}`;
      spike = true;
    } else if (gap >= t.gapDollarsPerMwh) {
      headline = `Power averaged ${centsPerKwh(mean(benValues))} per kWh at Benmore and ${centsPerKwh(mean(otaValues))} at Ōtāhuhu`;
    } else if (headline === null) {
      headline = `Power averaged ${centsPerKwh(mean(otaValues))} per kWh at Ōtāhuhu`;
    }
  }
  // The headline already gives a spike's peak, so the lede doesn't repeat it.
  const peakClause =
    !spike && first !== undefined && firstPrice !== null
      ? `prices at Ōtāhuhu peaked at ${centsPerKwh(firstPrice)} per kWh at ${clocks.start(first)}`
      : null;
  const opening =
    fuelClause && peakClause
      ? `${fuelClause}, and ${peakClause}.`
      : fuelClause
        ? `${fuelClause}.`
        : peakClause
          ? `${peakClause.charAt(0).toUpperCase()}${peakClause.slice(1)}.`
          : null;
  const lede = [opening, cheaperLine]
    .filter((part): part is string => part !== null)
    .join(" ");

  return { headline, lede: lede === "" ? null : lede, beats };
}

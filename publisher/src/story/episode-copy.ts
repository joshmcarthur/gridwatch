import type {
  Island,
  SiteDay,
  SiteEpisode,
  SiteEpisodeHighlight,
} from "../site/contract.ts";
import { clockLabeller12, zonedAt } from "./period-clock.ts";
import { centsPerKwh, placeName } from "./price-regions.ts";

export const TYPE_LABELS: Record<string, string> = {
  price_high: "high wholesale prices",
  price_low: "low wholesale prices",
  reserve_price_high: "high reserve prices",
  reserve_price_low: "low reserve prices",
  separation_high: "wholesale prices far apart",
  separation_low: "wholesale prices unusually close",
  generation_low: "a drop in generation",
  generation_high: "a rise in generation",
  demand_high: "high electricity use",
  demand_low: "low electricity use",
};

const KNOWN_TYPES = [
  "price_high",
  "price_low",
  "reserve_price_high",
  "reserve_price_low",
  "separation_high",
  "separation_low",
] as const;

type KnownType = (typeof KNOWN_TYPES)[number];

const asKnown = (type: string): KnownType | null => {
  for (const known of KNOWN_TYPES) if (known === type) return known;
  return null;
};

const islandName = (island: Island): string => {
  switch (island) {
    case "NI":
      return "the North Island";
    case "SI":
      return "the South Island";
    default: {
      const unreachable: never = island;
      return unreachable;
    }
  }
};

const islandBare = (island: Island): string =>
  islandName(island).replace(/^the /, "");

const joinAnd = (parts: string[]): string => {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
};

const typeLabel = (type: string): string =>
  TYPE_LABELS[type] ?? type.replaceAll("_", " ");

const cents = (dollarsPerMwh: number): string =>
  `${centsPerKwh(dollarsPerMwh)} per kWh`;

const recently = (dollarsPerMwh: number): string =>
  `compared with about ${centsPerKwh(dollarsPerMwh)} on recent days`;

const pricePlace = (highlight: SiteEpisodeHighlight): string | null =>
  highlight.point_of_connection === null
    ? null
    : placeName(highlight.point_of_connection);

const pairPlaces = (
  highlight: SiteEpisodeHighlight,
): [string, string] | null => {
  if (highlight.pair_from === null || highlight.pair_to === null) return null;
  return [placeName(highlight.pair_from), placeName(highlight.pair_to)];
};

const priceReached = (
  highlight: SiteEpisodeHighlight,
  verb: "reached" | "fell to",
): string | null => {
  const place = pricePlace(highlight);
  if (place === null) return null;
  return `wholesale prices at ${place} ${verb} ${cents(highlight.measured_value)}, ${recently(highlight.baseline_value)}`;
};

const reserveReached = (
  highlight: SiteEpisodeHighlight,
  verb: "reached" | "fell to",
): string => {
  const where =
    highlight.island === null ? "" : `${islandBare(highlight.island)} `;
  return `${where}reserve prices ${verb} ${cents(highlight.measured_value)}, ${recently(highlight.baseline_value)}`;
};

const spreadReached = (
  highlight: SiteEpisodeHighlight,
  kind: "high" | "low",
): string | null => {
  const pair = pairPlaces(highlight);
  if (pair === null) return null;
  const [from, to] = pair;
  if (kind === "high") {
    return `wholesale prices at ${from} and ${to} were ${cents(highlight.measured_value)} apart, ${recently(highlight.baseline_value)}`;
  }
  return `wholesale prices at ${from} and ${to} were only ${cents(highlight.measured_value)} apart, ${recently(highlight.baseline_value)}`;
};

const factFromHighlight = (highlight: SiteEpisodeHighlight): string | null => {
  const known = asKnown(highlight.observation_type);
  if (known === null) return null;
  switch (known) {
    case "price_high":
      return priceReached(highlight, "reached");
    case "price_low":
      return priceReached(highlight, "fell to");
    case "reserve_price_high":
      return reserveReached(highlight, "reached");
    case "reserve_price_low":
      return reserveReached(highlight, "fell to");
    case "separation_high":
      return spreadReached(highlight, "high");
    case "separation_low":
      return spreadReached(highlight, "low");
    default: {
      const unreachable: never = known;
      return unreachable;
    }
  }
};

/** One sentence per fact, so a busy stretch does not become one long run-on. */
const joinFacts = (facts: string[]): string =>
  facts
    .map((fact, index) =>
      index === 0 ? fact : `${fact.charAt(0).toUpperCase()}${fact.slice(1)}`,
    )
    .join(". ");

const fallbackBody = (
  episode: Pick<SiteEpisode, "observation_types" | "islands">,
): string => {
  const facts = joinAnd(episode.observation_types.map(typeLabel));
  const where =
    episode.islands.length === 0
      ? ""
      : ` on ${joinAnd(episode.islands.map(islandName))}`;
  if (facts === "") return `an unusual stretch was detected${where}`;
  return `${facts}${where}`;
};

const fromTo = (
  episode: Pick<SiteEpisode, "start_utc" | "end_utc">,
  day: Pick<SiteDay, "periods">,
): string => {
  const range = episodeClockRange(episode, day);
  const [start, end] = range.split("–");
  if (start === undefined || end === undefined) return `From ${range}`;
  return `From ${start} to ${end}`;
};

/**
 * Sentences for a detected episode: clock window, size, place. Wholesale prices
 * are what generators and retailers paid each other, not a household bill. Reserve
 * prices are the cost of backup generation kept ready if something trips.
 */
export function episodeHeadline(
  episode: Pick<
    SiteEpisode,
    | "observation_types"
    | "islands"
    | "member_count"
    | "start_utc"
    | "end_utc"
    | "highlights"
  >,
  day: Pick<SiteDay, "periods">,
): string {
  const facts = (episode.highlights ?? []).flatMap((highlight) => {
    const fact = factFromHighlight(highlight);
    return fact === null ? [] : [fact];
  });
  const body = facts.length > 0 ? joinFacts(facts) : fallbackBody(episode);
  return `${fromTo(episode, day)}, ${body}.`;
}

/** Inclusive start to exclusive end, as `3:00pm–5:30pm`. */
export function episodeClockRange(
  episode: Pick<SiteEpisode, "start_utc" | "end_utc">,
  day: Pick<SiteDay, "periods">,
): string {
  const label = clockLabeller12(day);
  const start = label(zonedAt(episode.start_utc));
  const end = label(zonedAt(episode.end_utc));
  return `${start}–${end}`;
}

/** Links from an episode line to the chart section that shows it. */
export function episodeEvidenceLinks(
  episode: Pick<SiteEpisode, "observation_types">,
): Array<{ label: string; href: string }> {
  const types = episode.observation_types;
  const links: Array<{ label: string; href: string }> = [];
  if (
    types.some(
      (type) => type.startsWith("price_") || type.startsWith("separation_"),
    )
  ) {
    links.push({
      label: "See wholesale prices for this stretch.",
      href: "#wholesale-prices",
    });
  }
  if (types.some((type) => type.startsWith("reserve_price_"))) {
    links.push({
      label: "See reserve prices for this stretch.",
      href: "#reserve-prices",
    });
  }
  return links;
}

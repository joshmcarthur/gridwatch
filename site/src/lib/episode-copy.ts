import type {
  Island,
  SiteDay,
  SiteEpisode,
} from "@gridwatch/publisher/site-contract";
import { clockLabeller12, zonedAt } from "./period-clock.ts";

const TYPE_LABELS: Record<string, string> = {
  price_high: "high wholesale prices",
  price_low: "low wholesale prices",
  reserve_price_high: "high reserve prices",
  reserve_price_low: "low reserve prices",
  separation_high: "a large regional price gap",
  separation_low: "a large regional price gap",
  generation_low: "a drop in generation",
  generation_high: "a rise in generation",
  demand_high: "high grid load",
  demand_low: "low grid load",
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

const joinAnd = (parts: string[]): string => {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
};

const typeLabel = (type: string): string =>
  TYPE_LABELS[type] ?? type.replaceAll("_", " ");

/**
 * One sentence for a detected episode. Wholesale prices are what generators and
 * retailers paid each other, not a household bill. Reserve prices are the cost of
 * backup generation kept ready if something trips.
 */
export function episodeHeadline(
  episode: Pick<SiteEpisode, "observation_types" | "islands" | "member_count">,
): string {
  const facts = joinAnd(episode.observation_types.map(typeLabel));
  const where =
    episode.islands.length === 0
      ? ""
      : ` on ${joinAnd(episode.islands.map(islandName))}`;
  if (facts === "") return `An unusual stretch showed up${where}.`;
  const body = `${facts.charAt(0).toUpperCase()}${facts.slice(1)}`;
  const verb =
    episode.member_count > 1 || episode.observation_types.length > 1
      ? "overlapped"
      : "showed up";
  return `${body} ${verb}${where}.`;
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

/** Links from an episode line to the evidence on the same page. Reserve episodes link to the reserve chart. */
export function episodeEvidenceLinks(
  episode: Pick<SiteEpisode, "observation_types">,
): Array<{ label: string; href: string }> {
  const reserve = episode.observation_types.some((type) =>
    type.startsWith("reserve_price_"),
  );
  return reserve
    ? [
        {
          label: "See the reserve prices for this day.",
          href: "#reserve-prices",
        },
      ]
    : [];
}

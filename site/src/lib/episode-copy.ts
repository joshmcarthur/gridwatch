import type { Island, SiteEpisode } from "@gridwatch/publisher/site-contract";

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

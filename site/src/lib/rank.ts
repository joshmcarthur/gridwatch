export const MIN_HISTORY_DAYS = 30;
export const MAX_HISTORY_DAYS = 365;

export type RankBand = "low" | "usual" | "high" | "highest";

export type Rank =
  | { kind: "unknown"; reason: "not_enough_days" }
  | { kind: "ranked"; percentile: number; band: RankBand };

/**
 * Rank `value` against earlier complete days. Uses the most recent 365 of those
 * days. Needs 30. Percentile is the share of those days that are at or below
 * `value`. Bands: below 25% low, 25–75% usual, 75–95% high, 95%+ highest.
 */
export function rankAgainstHistory(value: number, earlier: number[]): Rank {
  if (earlier.length < MIN_HISTORY_DAYS) {
    return { kind: "unknown", reason: "not_enough_days" };
  }
  const window = earlier.slice(-MAX_HISTORY_DAYS);
  const atOrBelow = window.filter((sample) => sample <= value).length;
  const percentile = atOrBelow / window.length;
  return { kind: "ranked", percentile, band: bandOf(percentile) };
}

function bandOf(percentile: number): RankBand {
  if (percentile < 0.25) return "low";
  if (percentile < 0.75) return "usual";
  if (percentile < 0.95) return "high";
  return "highest";
}

export function bandPhrase(band: RankBand): string {
  switch (band) {
    case "low":
      return "lower than most days in the past year";
    case "usual":
      return "about usual";
    case "high":
      return "higher than most days in the past year";
    case "highest":
      return "one of the highest days in the past year";
    default: {
      const unreachable: never = band;
      return unreachable;
    }
  }
}

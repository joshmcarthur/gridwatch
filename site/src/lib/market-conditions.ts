export type PriceMetricSource = {
  prices: {
    nodes: Array<{ daily: { mean_price: number | null } }>;
    spreads: Array<{
      from: string;
      to: string;
      spread: Array<number | null>;
    }>;
  };
};

export type GenerationMetricSource = {
  generation: {
    totals: {
      primary_megawatt_hours: number;
      battery_megawatt_hours: number;
    } | null;
    daily: Array<{ fuel: string; megawatt_hours: number }>;
  };
};

export type ReservesMetricSource = {
  reserves?: {
    daily: Array<{ mean_price: number | null }>;
  };
};

const HAY = "HAY2201";
const BEN = "BEN2201";
const THERMAL = new Set(["gas", "coal_gas"]);

const meanOf = (values: number[]): number | null => {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

/** Mean of the reference-node daily means. Null when none have a mean. */
export function meanWholesalePrice(day: PriceMetricSource): number | null {
  return meanOf(
    day.prices.nodes.flatMap((node) =>
      node.daily.mean_price === null ? [] : [node.daily.mean_price],
    ),
  );
}

/**
 * Gas plus coal_gas as a share of primary generation. Batteries are not in the
 * denominator. Null when primary energy is missing or zero.
 */
export function gasCoalShare(day: GenerationMetricSource): number | null {
  const primary = day.generation.totals?.primary_megawatt_hours;
  if (primary === undefined || primary <= 0) return null;
  const thermal = day.generation.daily
    .filter((row) => THERMAL.has(row.fuel))
    .reduce((sum, row) => sum + row.megawatt_hours, 0);
  return thermal / primary;
}

/**
 * Mean absolute Haywards–Benmore spread. Null when the pair is missing or every
 * period is null.
 */
export function hayBenAbsSpread(day: PriceMetricSource): number | null {
  const pair = day.prices.spreads.find(
    (spread) => spread.from === HAY && spread.to === BEN,
  );
  if (!pair) return null;
  return meanOf(
    pair.spread.flatMap((value) => (value === null ? [] : [Math.abs(value)])),
  );
}

/** Highest class-island daily mean reserve price. Null when none exist. */
export function peakReservePrice(day: ReservesMetricSource): number | null {
  const means = (day.reserves?.daily ?? []).flatMap((row) =>
    row.mean_price === null ? [] : [row.mean_price],
  );
  if (means.length === 0) return null;
  return Math.max(...means);
}

import type { ManifestRecord } from "./archive.ts";
import { collectClearedOffers } from "./electricity-authority/cleared-offers.ts";
import { collectDispatchEnergyPrices } from "./electricity-authority/dispatch-energy-prices.ts";
import { collectDispatchReservePrices } from "./electricity-authority/dispatch-reserve-prices.ts";
import { collectGenerationFleet } from "./electricity-authority/generation-fleet.ts";
import { collectGenerationMd } from "./electricity-authority/generation-md.ts";
import { collectNetworkSupplyPoints } from "./electricity-authority/network-supply-points.ts";
import { collectNodalPricesAndVolumes } from "./electricity-authority/nodal-prices-and-volumes.ts";

/** The default backfill reaches this many months before the run date (owner decision on #13). */
export const BACKFILL_MONTHS = 12;
/** Every run fetches this many days again. The source rewrites recent files (docs/sources.md). */
export const TRAILING_DAYS = 5;
/**
 * Monthly files are rewritten weeks after they appear (ADR-0007). A run fetches the months
 * from this many months before the run month.
 */
export const MONTHLY_REFRESH_MONTHS = 2;

export interface CollectContext {
  bronzeDir: string;
  /** First date of the range, `YYYY-MM-DD`. */
  from: string;
  /** Last date of the range, `YYYY-MM-DD`. */
  to: string;
  /** The run date in NZ, `YYYY-MM-DD`. */
  today: string;
  /** Overrides for tests. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface CollectOutcome {
  records: ManifestRecord[];
  /** Dates or months in the range that the source does not list. This is not a failure. */
  notListed: number;
  /** One message for each file that failed. */
  failed: string[];
}

export interface CollectorDataset {
  /** The dataset ID. It is the same in the manifest and the bronze folder. */
  id: string;
  /**
   * First date of the default range. `last` is the newest trading date in the manifest for
   * this dataset, or undefined on the first run. `to` is yesterday in NZ.
   */
  defaultFrom(last: string | undefined, to: string, today: string): string;
  collect(context: CollectContext): Promise<CollectOutcome>;
}

const backfillStart = (today: string) =>
  Temporal.PlainDate.from(today)
    .subtract({ months: BACKFILL_MONTHS })
    .toString();

const earlier = (a: string, b: string) => (a < b ? a : b);

/** Daily files and snapshots: the last five days, or everything since the last run if older. */
function dailyFrom(last: string | undefined, to: string, today: string) {
  if (!last) return backfillStart(today);
  const trailing = Temporal.PlainDate.from(to)
    .subtract({ days: TRAILING_DAYS - 1 })
    .toString();
  return earlier(last, trailing);
}

/** Monthly files: the first day of the oldest month to refresh. */
function monthlyFrom(last: string | undefined, _to: string, today: string) {
  if (!last) return backfillStart(today);
  const settled = Temporal.PlainDate.from(today)
    .subtract({ months: MONTHLY_REFRESH_MONTHS })
    .toString();
  return `${earlier(last, settled).slice(0, 7)}-01`;
}

/** Adapt a dated collector result. `missing` and `failed` use dates or months as labels. */
function outcome(result: {
  records: ManifestRecord[];
  missing?: string[];
  failed: Array<{ date?: string; month?: string; error: string }>;
}): CollectOutcome {
  return {
    records: result.records,
    notListed: result.missing?.length ?? 0,
    failed: result.failed.map((f) => `${f.date ?? f.month}: ${f.error}`),
  };
}

/**
 * The datasets the runner collects. A new dataset adds one entry here and one in
 * `publisher/src/datasets.ts`.
 */
export const datasets: CollectorDataset[] = [
  {
    id: "dispatch_energy_prices",
    defaultFrom: dailyFrom,
    collect: (context) => collectDispatchEnergyPrices(context).then(outcome),
  },
  {
    id: "dispatch_reserve_prices",
    defaultFrom: dailyFrom,
    collect: (context) => collectDispatchReservePrices(context).then(outcome),
  },
  {
    id: "nodal_prices_and_volumes",
    defaultFrom: dailyFrom,
    collect: (context) => collectNodalPricesAndVolumes(context).then(outcome),
  },
  {
    id: "cleared_offers",
    defaultFrom: dailyFrom,
    collect: (context) => collectClearedOffers(context).then(outcome),
  },
  {
    id: "generation_md",
    defaultFrom: monthlyFrom,
    collect: (context) => collectGenerationMd(context).then(outcome),
  },
  {
    id: "network_supply_points",
    defaultFrom: dailyFrom,
    collect: (context) => collectNetworkSupplyPoints(context).then(outcome),
  },
  {
    // One current file with no dates. It ignores the range and is labelled with the run date.
    id: "generation_fleet",
    defaultFrom: (_last, to) => to,
    collect: async ({ today, ...context }) => ({
      records: [await collectGenerationFleet({ ...context, date: today })],
      notListed: 0,
      failed: [],
    }),
  },
];

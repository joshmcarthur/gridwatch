import type { ManifestRecord } from "./archive.ts";
import { eachDate } from "./date-range.ts";
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

export interface DateRange {
  from: string;
  to: string;
}

export interface CollectorDataset {
  /** The dataset ID. It is the same in the manifest and the bronze folder. */
  id: string;
  /**
   * The ranges the default mode collects. `held` is every trading date the manifest lists
   * for this dataset. `to` is yesterday in NZ. The ranges are sorted and do not overlap.
   */
  defaultRanges(
    held: ReadonlySet<string>,
    to: string,
    today: string,
  ): DateRange[];
  collect(context: CollectContext): Promise<CollectOutcome>;
}

const backfillStart = (today: string) =>
  Temporal.PlainDate.from(today)
    .subtract({ months: BACKFILL_MONTHS })
    .toString();

export const earlier = (a: string, b: string) => (a < b ? a : b);

/** Sorted, unique dates to contiguous ranges. */
function toRanges(dates: string[]): DateRange[] {
  const ranges: DateRange[] = [];
  for (const date of [...new Set(dates)].sort()) {
    const last = ranges.at(-1);
    if (
      last &&
      Temporal.PlainDate.from(last.to).add({ days: 1 }).toString() === date
    )
      last.to = date;
    else ranges.push({ from: date, to: date });
  }
  return ranges;
}

/**
 * Daily files and snapshots: the trailing 5 days, and every date of the 12-month window that
 * has no manifest record. A failed day, or a gap from a short targeted run, is fetched again.
 * A date the source never published costs one folder listing, because unlisted dates are
 * counted and not fetched.
 */
function dailyRanges(held: ReadonlySet<string>, to: string, today: string) {
  const wanted = eachDate(backfillStart(today), to).filter((d) => !held.has(d));
  const trailingStart = Temporal.PlainDate.from(to)
    .subtract({ days: TRAILING_DAYS - 1 })
    .toString();
  wanted.push(...eachDate(trailingStart, to));
  return toRanges(wanted);
}

/**
 * Monthly files: the run month and the 2 months before it, and every month of the 12-month
 * window that has no manifest record. A range covers whole months, up to `to`.
 */
function monthlyRanges(held: ReadonlySet<string>, to: string, today: string) {
  const heldMonths = new Set([...held].map((d) => d.slice(0, 7)));
  const lastMonth = to.slice(0, 7);
  const refreshFrom = Temporal.PlainDate.from(today)
    .subtract({ months: MONTHLY_REFRESH_MONTHS })
    .toString()
    .slice(0, 7);
  const wanted: string[] = [];
  for (
    let month = Temporal.PlainYearMonth.from(backfillStart(today).slice(0, 7));
    month.toString() <= lastMonth;
    month = month.add({ months: 1 })
  ) {
    const text = month.toString();
    if (!heldMonths.has(text) || text >= refreshFrom) wanted.push(text);
  }
  const ranges: DateRange[] = [];
  for (const month of wanted) {
    const last = ranges.at(-1);
    const next = Temporal.PlainYearMonth.from(month);
    if (last && last.to.slice(0, 7) === next.subtract({ months: 1 }).toString())
      last.to = earlier(`${month}-${next.daysInMonth}`, to);
    else
      ranges.push({
        from: `${month}-01`,
        to: earlier(`${month}-${next.daysInMonth}`, to),
      });
  }
  return ranges;
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
    defaultRanges: dailyRanges,
    collect: (context) => collectDispatchEnergyPrices(context).then(outcome),
  },
  {
    id: "dispatch_reserve_prices",
    defaultRanges: dailyRanges,
    collect: (context) => collectDispatchReservePrices(context).then(outcome),
  },
  {
    id: "nodal_prices_and_volumes",
    defaultRanges: dailyRanges,
    collect: (context) => collectNodalPricesAndVolumes(context).then(outcome),
  },
  {
    id: "cleared_offers",
    defaultRanges: dailyRanges,
    collect: (context) => collectClearedOffers(context).then(outcome),
  },
  {
    id: "generation_md",
    defaultRanges: monthlyRanges,
    collect: (context) => collectGenerationMd(context).then(outcome),
  },
  {
    id: "network_supply_points",
    defaultRanges: dailyRanges,
    collect: (context) => collectNetworkSupplyPoints(context).then(outcome),
  },
  {
    // One current file with no dates. It ignores the range and is labelled with the run date.
    id: "generation_fleet",
    defaultRanges: (_held, to) => [{ from: to, to }],
    collect: async ({ today, ...context }) => ({
      records: [await collectGenerationFleet({ ...context, date: today })],
      notListed: 0,
      failed: [],
    }),
  },
];

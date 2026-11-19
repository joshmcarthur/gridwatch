/**
 * NZ trading-day time model. See docs/adr/0003-time-column-naming.md.
 *
 * A trading date is a calendar date in Pacific/Auckland. Trading period 1 starts at
 * local midnight. Each period lasts 30 real minutes, so a day has 48 periods, or 46
 * (DST starts) or 50 (DST ends).
 */

export const TRADING_ZONE = "Pacific/Auckland";
export const PERIOD_MS = 30 * 60 * 1000;
export const DISPATCH_INTERVAL_MS = 5 * 60 * 1000;

export interface TradingPeriod {
  /** NZ calendar date, `YYYY-MM-DD`. */
  tradingDate: string;
  /** 1-based period number within the trading date. */
  tradingPeriod: number;
}

export interface PeriodSpan {
  /** Event start (inclusive). */
  eventStartUtc: Date;
  /** Event end (exclusive). */
  eventEndUtc: Date;
}

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TRADING_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Wall-clock parts of an instant in NZ time. */
function nzParts(instant: Date) {
  const p: Record<string, number> = {};
  for (const { type, value } of formatter.formatToParts(instant)) {
    if (type !== "literal") p[type] = Number(value);
  }
  return p as Record<
    "year" | "month" | "day" | "hour" | "minute" | "second",
    number
  >;
}

function pad(n: number, width = 2) {
  return String(n).padStart(width, "0");
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(tradingDate: string) {
  const m = DATE_RE.exec(tradingDate);
  if (!m)
    throw new RangeError(
      `Invalid trading date "${tradingDate}": expected YYYY-MM-DD`,
    );
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new RangeError(
      `Invalid trading date "${tradingDate}": no such calendar date`,
    );
  }
  return { year, month, day };
}

/** The UTC instant of local midnight at the start of a trading date. */
function midnightUtc(tradingDate: string): Date {
  const { year, month, day } = parseDate(tradingDate);
  const wallAsUtc = Date.UTC(year, month - 1, day);
  // NZ offsets are +12:00 or +13:00. DST changes happen at 02:00/03:00, never at midnight.
  for (const offsetHours of [13, 12]) {
    const candidate = new Date(wallAsUtc - offsetHours * 3_600_000);
    const p = nzParts(candidate);
    if (
      p.year === year &&
      p.month === month &&
      p.day === day &&
      p.hour === 0 &&
      p.minute === 0
    ) {
      return candidate;
    }
  }
  throw new Error(`Cannot resolve local midnight for ${tradingDate}`);
}

function nextDate(tradingDate: string): string {
  const { year, month, day } = parseDate(tradingDate);
  const d = new Date(Date.UTC(year, month - 1, day + 1));
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Number of trading periods on a trading date: 48, 46 or 50. */
export function periodsInTradingDate(tradingDate: string): number {
  const ms =
    midnightUtc(nextDate(tradingDate)).getTime() -
    midnightUtc(tradingDate).getTime();
  return ms / PERIOD_MS;
}

/** UTC start and end of a trading period. Throws if the period is not on that date. */
export function periodToUtc(
  tradingDate: string,
  tradingPeriod: number,
): PeriodSpan {
  const count = periodsInTradingDate(tradingDate);
  if (
    !Number.isInteger(tradingPeriod) ||
    tradingPeriod < 1 ||
    tradingPeriod > count
  ) {
    throw new RangeError(
      `Invalid trading period ${tradingPeriod} for ${tradingDate}: expected an integer from 1 to ${count}`,
    );
  }
  const start =
    midnightUtc(tradingDate).getTime() + (tradingPeriod - 1) * PERIOD_MS;
  return {
    eventStartUtc: new Date(start),
    eventEndUtc: new Date(start + PERIOD_MS),
  };
}

/** The trading date and period that contain a UTC instant. */
export function utcToPeriod(instant: Date): TradingPeriod {
  if (Number.isNaN(instant.getTime())) throw new RangeError("Invalid instant");
  const p = nzParts(instant);
  const tradingDate = `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
  const elapsed = instant.getTime() - midnightUtc(tradingDate).getTime();
  return { tradingDate, tradingPeriod: Math.floor(elapsed / PERIOD_MS) + 1 };
}

/**
 * Map a 5-minute dispatch interval to UTC and to its containing trading period.
 * `intervalStart` is the first instant of the interval. Intervals align with
 * period boundaries, so each one lies inside exactly one period.
 */
export function dispatchIntervalToUtc(
  intervalStart: Date,
): PeriodSpan & TradingPeriod {
  if (intervalStart.getTime() % DISPATCH_INTERVAL_MS !== 0) {
    throw new RangeError(
      `${intervalStart.toISOString()} is not on a 5-minute boundary`,
    );
  }
  return {
    eventStartUtc: intervalStart,
    eventEndUtc: new Date(intervalStart.getTime() + DISPATCH_INTERVAL_MS),
    ...utcToPeriod(intervalStart),
  };
}

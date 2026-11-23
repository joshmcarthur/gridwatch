/**
 * NZ trading-day time model. See docs/adr/0003-time-column-naming.md.
 *
 * A trading date is a calendar date in Pacific/Auckland. Trading period 1 starts at
 * local midnight. Each period lasts 30 real minutes, so a day has 48 periods, or 46
 * (DST starts) or 50 (DST ends). UTC instants are `Temporal.Instant` values: they are
 * exact and immutable. Convert with `new Date(instant.epochMilliseconds)` where a
 * `Date` is needed.
 */

const TRADING_ZONE = "Pacific/Auckland";
const PERIOD_MINUTES = 30;
const DISPATCH_INTERVAL_MS = 5 * 60 * 1000;

interface TradingPeriod {
  /** NZ calendar date, `YYYY-MM-DD`. */
  tradingDate: string;
  /** 1-based period number within the trading date. */
  tradingPeriod: number;
}

interface PeriodSpan {
  /** Event start (inclusive). */
  eventStartUtc: Temporal.Instant;
  /** Event end (exclusive). */
  eventEndUtc: Temporal.Instant;
}

/** Local midnight at the start of a trading date. */
function dayStart(tradingDate: string): Temporal.ZonedDateTime {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDate)) {
    throw new RangeError(
      `Invalid trading date "${tradingDate}": expected YYYY-MM-DD`,
    );
  }
  return Temporal.PlainDate.from(tradingDate).toZonedDateTime(TRADING_ZONE);
}

/** Number of trading periods on a trading date: 48, 46 or 50. */
export function periodsInTradingDate(tradingDate: string): number {
  return periodsPerDay(dayStart(tradingDate));
}

function periodsPerDay(start: Temporal.ZonedDateTime): number {
  return (start.hoursInDay * 60) / PERIOD_MINUTES;
}

/** 12-hour NZ clock for public sentences, for example `5:30pm`. */
export function clockText12(instant: Temporal.Instant): string {
  const zoned = instant.toZonedDateTimeISO(TRADING_ZONE);
  const hour12 = zoned.hour % 12 === 0 ? 12 : zoned.hour % 12;
  const minute = String(zoned.minute).padStart(2, "0");
  const suffix = zoned.hour < 12 ? "am" : "pm";
  return `${hour12}:${minute}${suffix}`;
}

/** Inclusive start to exclusive end of a trading period, as `5:30pm–6:00pm`. */
export function periodClockRange(
  tradingDate: string,
  tradingPeriod: number,
): string {
  const { eventStartUtc, eventEndUtc } = periodToUtc(
    tradingDate,
    tradingPeriod,
  );
  return `${clockText12(eventStartUtc)}–${clockText12(eventEndUtc)}`;
}

/** UTC start and end of a trading period. Throws if the period is not on that date. */
export function periodToUtc(
  tradingDate: string,
  tradingPeriod: number,
): PeriodSpan {
  const start = dayStart(tradingDate);
  const count = periodsPerDay(start);
  if (
    !Number.isInteger(tradingPeriod) ||
    tradingPeriod < 1 ||
    tradingPeriod > count
  ) {
    throw new RangeError(
      `Invalid trading period ${tradingPeriod} for ${tradingDate}: expected an integer from 1 to ${count}`,
    );
  }
  const eventStartUtc = start
    .toInstant()
    .add({ minutes: (tradingPeriod - 1) * PERIOD_MINUTES });
  return {
    eventStartUtc,
    eventEndUtc: eventStartUtc.add({ minutes: PERIOD_MINUTES }),
  };
}

/** The trading date and period that contain a UTC instant. */
export function utcToPeriod(instant: Temporal.Instant): TradingPeriod {
  const local = instant.toZonedDateTimeISO(TRADING_ZONE);
  const { minutes } = local.since(local.startOfDay(), {
    largestUnit: "minutes",
  });
  return {
    tradingDate: local.toPlainDate().toString(),
    tradingPeriod: Math.floor(minutes / PERIOD_MINUTES) + 1,
  };
}

/**
 * Map a 5-minute dispatch interval to UTC and to its containing trading period.
 * `intervalStart` is the first instant of the interval. Intervals align with
 * period boundaries, so each one lies inside exactly one period.
 */
export function dispatchIntervalToUtc(
  intervalStart: Temporal.Instant,
): PeriodSpan & TradingPeriod {
  if (intervalStart.epochMilliseconds % DISPATCH_INTERVAL_MS !== 0) {
    throw new RangeError(
      `${intervalStart.toString()} is not on a 5-minute boundary`,
    );
  }
  return {
    eventStartUtc: intervalStart,
    eventEndUtc: intervalStart.add({ minutes: 5 }),
    ...utcToPeriod(intervalStart),
  };
}

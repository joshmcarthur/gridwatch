import type { SiteDay } from "@gridwatch/publisher/site-contract";

export const ZONE = "Pacific/Auckland";

export function zonedAt(startUtc: string): Temporal.ZonedDateTime {
  return Temporal.Instant.from(startUtc).toZonedDateTimeISO(ZONE);
}

/**
 * Clock labels for one day. A clock time that occurs twice (the repeated hour on the day
 * daylight saving ends) gets NZDT or NZST, so the two rows have different labels.
 */
export function clockLabeller(
  day: SiteDay,
): (zoned: Temporal.ZonedDateTime) => string {
  const counts = new Map<string, number>();
  for (const period of day.periods) {
    const clock = clockText(zonedAt(period.start_utc));
    counts.set(clock, (counts.get(clock) ?? 0) + 1);
  }
  return (zoned) => {
    const clock = clockText(zoned);
    if ((counts.get(clock) ?? 0) < 2) return clock;
    return `${clock} ${zoned.offset === "+13:00" ? "NZDT" : "NZST"}`;
  };
}

export function clockText(zoned: Temporal.ZonedDateTime): string {
  return `${String(zoned.hour).padStart(2, "0")}:${String(zoned.minute).padStart(2, "0")}`;
}

/** Every third local hour, as two digits, for a time axis. */
export function timeTicks(day: SiteDay): Array<{ at: Date; label: string }> {
  const ticks: Array<{ at: Date; label: string }> = [];
  for (const period of day.periods) {
    const zoned = zonedAt(period.start_utc);
    if (zoned.minute !== 0 || zoned.hour % 3 !== 0) continue;
    ticks.push({
      at: new Date(period.start_utc),
      label: String(zoned.hour).padStart(2, "0"),
    });
  }
  return ticks;
}

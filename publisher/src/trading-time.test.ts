import { describe, expect, test } from "vitest";
import {
  clockText12,
  dispatchIntervalToUtc,
  periodClockRange,
  periodsInTradingDate,
  periodToUtc,
  utcToPeriod,
} from "./trading-time.ts";

// DST starts last Sunday of September (46 periods), ends first Sunday of April (50).
const days = [
  { date: "2025-06-15", periods: 48, label: "normal day 2025" },
  { date: "2026-11-19", periods: 48, label: "normal day 2026" },
  { date: "2025-09-28", periods: 46, label: "DST start 2025" },
  { date: "2026-09-27", periods: 46, label: "DST start 2026" },
  { date: "2025-04-06", periods: 50, label: "DST end 2025" },
  { date: "2026-04-05", periods: 50, label: "DST end 2026" },
];

describe.each(days)("$label ($date)", ({ date, periods }) => {
  test("period count", () => {
    expect(periodsInTradingDate(date)).toBe(periods);
  });

  test("round trip for every period, contiguous, 30 minutes each", () => {
    let previousEnd: Temporal.Instant | undefined;
    for (let p = 1; p <= periods; p++) {
      const { eventStartUtc, eventEndUtc } = periodToUtc(date, p);
      expect(
        eventEndUtc.epochMilliseconds - eventStartUtc.epochMilliseconds,
      ).toBe(30 * 60_000);
      if (previousEnd)
        expect(eventStartUtc.epochMilliseconds).toBe(
          previousEnd.epochMilliseconds,
        );
      previousEnd = eventEndUtc;
      expect(utcToPeriod(eventStartUtc)).toEqual({
        tradingDate: date,
        tradingPeriod: p,
      });
      expect(utcToPeriod(eventEndUtc.subtract({ milliseconds: 1 }))).toEqual({
        tradingDate: date,
        tradingPeriod: p,
      });
    }
    // The next instant belongs to the next trading date, period 1.
    const next = utcToPeriod(previousEnd as Temporal.Instant);
    expect(next.tradingPeriod).toBe(1);
    expect(next.tradingDate).not.toBe(date);
  });

  test("period beyond the last throws", () => {
    expect(() => periodToUtc(date, periods + 1)).toThrow(
      /Invalid trading period/,
    );
  });
});

test("period 36 on 27 July 2026 is 5:30pm–6:00pm", () => {
  expect(periodClockRange("2026-07-27", 36)).toBe("5:30pm–6:00pm");
  expect(clockText12(periodToUtc("2026-07-27", 36).eventStartUtc)).toBe(
    "5:30pm",
  );
});

test("period 1 starts at NZ midnight", () => {
  expect(periodToUtc("2026-11-19", 1).eventStartUtc.toString()).toBe(
    "2026-11-18T11:00:00Z",
  );
  expect(periodToUtc("2025-06-15", 1).eventStartUtc.toString()).toBe(
    "2025-06-14T12:00:00Z",
  );
});

test("DST start 2026-09-27: 02:00 NZST jumps to 03:00 NZDT, 46 periods", () => {
  expect(periodToUtc("2026-09-27", 1).eventStartUtc.toString()).toBe(
    "2026-09-26T12:00:00Z",
  );
  expect(periodToUtc("2026-09-27", 4).eventEndUtc.toString()).toBe(
    "2026-09-26T14:00:00Z",
  );
  expect(periodToUtc("2026-09-27", 46).eventEndUtc.toString()).toBe(
    "2026-09-27T11:00:00Z",
  );
});

test("DST end 2026-04-05: the 02:00 hour repeats at two distinct periods", () => {
  // Midnight is +13:00 = 11:00Z. 02:00 NZDT = 13:00Z. The repeated 02:00 NZST = 14:00Z.
  const first = periodToUtc("2026-04-05", 5).eventStartUtc;
  const second = periodToUtc("2026-04-05", 7).eventStartUtc;
  expect(first.toString()).toBe("2026-04-04T13:00:00Z");
  expect(second.toString()).toBe("2026-04-04T14:00:00Z");
  expect(periodToUtc("2026-04-05", 50).eventEndUtc.toString()).toBe(
    "2026-04-05T12:00:00Z",
  );
});

test("DST end 2025-04-06: the 02:00 hour repeats at two distinct periods", () => {
  expect(periodToUtc("2025-04-06", 5).eventStartUtc.toString()).toBe(
    "2025-04-05T13:00:00Z",
  );
  expect(periodToUtc("2025-04-06", 7).eventStartUtc.toString()).toBe(
    "2025-04-05T14:00:00Z",
  );
});

test("invalid period throws a clear error", () => {
  expect(() => periodToUtc("2026-11-19", 49)).toThrow(
    "Invalid trading period 49 for 2026-11-19: expected an integer from 1 to 48",
  );
  expect(() => periodToUtc("2026-09-27", 47)).toThrow(/from 1 to 46/);
  expect(() => periodToUtc("2026-11-19", 0)).toThrow(/Invalid trading period/);
  expect(() => periodToUtc("2026-11-19", 1.5)).toThrow(
    /Invalid trading period/,
  );
});

test("invalid trading date throws", () => {
  expect(() => periodsInTradingDate("2026-02-30")).toThrow(RangeError);
  expect(() => periodsInTradingDate("19/11/2026")).toThrow(
    /expected YYYY-MM-DD/,
  );
});

describe("5-minute dispatch intervals", () => {
  test("DST start: 03:00 NZDT is period 5", () => {
    expect(
      dispatchIntervalToUtc(Temporal.Instant.from("2026-09-26T14:00:00Z")),
    ).toMatchObject({
      tradingDate: "2026-09-27",
      tradingPeriod: 5,
    });
  });

  test("map to the containing trading period", () => {
    expect(
      dispatchIntervalToUtc(Temporal.Instant.from("2026-11-18T11:00:00Z")),
    ).toMatchObject({
      tradingDate: "2026-11-19",
      tradingPeriod: 1,
    });
    expect(
      dispatchIntervalToUtc(Temporal.Instant.from("2026-11-18T11:25:00Z")),
    ).toMatchObject({
      tradingPeriod: 1,
    });
    const next = dispatchIntervalToUtc(
      Temporal.Instant.from("2026-11-18T11:30:00Z"),
    );
    expect(next).toMatchObject({ tradingPeriod: 2 });
    expect(next.eventEndUtc.toString()).toBe("2026-11-18T11:35:00Z");
  });

  test("every 5-minute slot of the DST-end day maps to its period", () => {
    const midnight = periodToUtc("2026-04-05", 1).eventStartUtc
      .epochMilliseconds;
    for (let i = 0; i < 50 * 6; i++) {
      const r = dispatchIntervalToUtc(
        Temporal.Instant.fromEpochMilliseconds(midnight + i * 5 * 60_000),
      );
      expect(r.tradingDate).toBe("2026-04-05");
      expect(r.tradingPeriod).toBe(Math.floor(i / 6) + 1);
    }
  });

  test("rejects off-boundary instants", () => {
    expect(() =>
      dispatchIntervalToUtc(Temporal.Instant.from("2026-11-18T11:01:00Z")),
    ).toThrow(/5-minute boundary/);
  });
});

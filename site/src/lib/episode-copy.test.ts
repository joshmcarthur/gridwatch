import { expect, test } from "vitest";
import {
  episodeClockRange,
  episodeEvidenceLinks,
  episodeHeadline,
} from "./episode-copy.ts";

test("a scarcity-shaped episode names prices, reserves and the North Island", () => {
  expect(
    episodeHeadline({
      observation_types: ["price_high", "reserve_price_high"],
      islands: ["NI"],
      member_count: 2,
    }),
  ).toBe(
    "High wholesale prices and high reserve prices overlapped on the North Island.",
  );
});

test("two islands are named; a singleton does not say overlapped; empty types still make a sentence", () => {
  expect(
    episodeHeadline({
      observation_types: ["separation_high"],
      islands: ["NI", "SI"],
      member_count: 2,
    }),
  ).toBe(
    "A large regional price gap overlapped on the North Island and the South Island.",
  );
  expect(
    episodeHeadline({
      observation_types: ["price_high"],
      islands: ["SI"],
      member_count: 1,
    }),
  ).toBe("High wholesale prices showed up on the South Island.");
  expect(
    episodeHeadline({ observation_types: [], islands: [], member_count: 0 }),
  ).toBe("An unusual stretch showed up.");
});

test("episode times are a 12-hour clock range, not trading period numbers", () => {
  const day = {
    periods: [
      { period: 1, start_utc: "2026-05-31T12:00:00Z" },
      { period: 2, start_utc: "2026-05-31T12:30:00Z" },
      { period: 33, start_utc: "2026-06-01T04:00:00Z" },
      { period: 38, start_utc: "2026-06-01T06:30:00Z" },
    ],
  };
  expect(
    episodeClockRange(
      { start_utc: "2026-06-01T04:00:00Z", end_utc: "2026-06-01T06:30:00Z" },
      day,
    ),
  ).toBe("4:00pm–6:30pm");
  expect(
    episodeClockRange(
      { start_utc: "2026-05-31T12:00:00Z", end_utc: "2026-05-31T12:30:00Z" },
      day,
    ),
  ).toBe("12:00am–12:30am");
});

// Catches: a reserve episode with no way to the chart, or a link on episodes that have no reserve chart.
test("only reserve episodes link to the reserve prices", () => {
  expect(
    episodeEvidenceLinks({
      observation_types: ["price_high", "reserve_price_high"],
    }),
  ).toEqual([
    { label: "See the reserve prices for this day.", href: "#reserve-prices" },
  ]);
  expect(
    episodeEvidenceLinks({ observation_types: ["reserve_price_low"] }),
  ).toHaveLength(1);
  expect(episodeEvidenceLinks({ observation_types: ["price_high"] })).toEqual(
    [],
  );
});

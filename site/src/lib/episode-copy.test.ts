import type { SiteEpisodeHighlight } from "@gridwatch/publisher/site-contract";
import { expect, test } from "vitest";
import {
  episodeClockRange,
  episodeEvidenceLinks,
  episodeHeadline,
} from "./episode-copy.ts";

const day = {
  periods: [
    { period: 1, start_utc: "2026-05-31T12:00:00Z" },
    { period: 2, start_utc: "2026-05-31T12:30:00Z" },
    { period: 33, start_utc: "2026-06-01T04:00:00Z" },
    { period: 38, start_utc: "2026-06-01T06:30:00Z" },
  ],
};

const highlight = (
  rest: Partial<SiteEpisodeHighlight> &
    Pick<SiteEpisodeHighlight, "observation_type" | "measured_value">,
): SiteEpisodeHighlight => ({
  point_of_connection: null,
  pair_from: null,
  pair_to: null,
  island: null,
  baseline_value: 0,
  ...rest,
});

test("a scarcity episode names the peak, the place, the time and backup prices", () => {
  expect(
    episodeHeadline(
      {
        observation_types: ["price_high", "reserve_price_high"],
        islands: ["NI"],
        member_count: 2,
        start_utc: "2026-06-01T04:00:00Z",
        end_utc: "2026-06-01T06:30:00Z",
        highlights: [
          highlight({
            observation_type: "price_high",
            point_of_connection: "OTA2201",
            island: "NI",
            measured_value: 3296,
            baseline_value: 150,
          }),
          highlight({
            observation_type: "reserve_price_high",
            island: "NI",
            measured_value: 2154,
            baseline_value: 12,
          }),
        ],
      },
      day,
    ),
  ).toBe(
    "From 4:00pm to 6:30pm, wholesale prices at Ōtāhuhu reached $3,296 per megawatt-hour, above the recent typical level of about $150, at the same time as North Island backup prices reached $2,154 per megawatt-hour, above the recent typical level of about $12.",
  );
});

test("a singleton price high does not say at the same time", () => {
  expect(
    episodeHeadline(
      {
        observation_types: ["price_high"],
        islands: ["SI"],
        member_count: 1,
        start_utc: "2026-06-01T04:00:00Z",
        end_utc: "2026-06-01T06:30:00Z",
        highlights: [
          highlight({
            observation_type: "price_high",
            point_of_connection: "BEN2201",
            island: "SI",
            measured_value: 80,
            baseline_value: 40,
          }),
        ],
      },
      day,
    ),
  ).toBe(
    "From 4:00pm to 6:30pm, wholesale prices at Benmore reached $80 per megawatt-hour, above the recent typical level of about $40.",
  );
});

test("a price-gap episode names both places", () => {
  expect(
    episodeHeadline(
      {
        observation_types: ["separation_high"],
        islands: ["NI", "SI"],
        member_count: 1,
        start_utc: "2026-06-01T04:00:00Z",
        end_utc: "2026-06-01T06:30:00Z",
        highlights: [
          highlight({
            observation_type: "separation_high",
            pair_from: "OTA2201",
            pair_to: "BEN2201",
            measured_value: 2725,
            baseline_value: 80,
          }),
        ],
      },
      day,
    ),
  ).toBe(
    "From 4:00pm to 6:30pm, wholesale prices at Ōtāhuhu and Benmore were $2,725 apart, above the recent typical gap of about $80.",
  );
});

test("without highlights the line still has time, place and no detector jargon", () => {
  expect(
    episodeHeadline(
      {
        observation_types: ["price_high"],
        islands: ["SI"],
        member_count: 1,
        start_utc: "2026-06-01T04:00:00Z",
        end_utc: "2026-06-01T06:30:00Z",
      },
      day,
    ),
  ).toBe("From 4:00pm to 6:30pm, high wholesale prices on the South Island.");
  expect(
    episodeHeadline(
      {
        observation_types: [],
        islands: [],
        member_count: 0,
        start_utc: "2026-06-01T04:00:00Z",
        end_utc: "2026-06-01T06:30:00Z",
      },
      day,
    ),
  ).toBe("From 4:00pm to 6:30pm, an unusual stretch was detected.");
  const fallback = episodeHeadline(
    {
      observation_types: ["demand_high", "separation_high"],
      islands: ["NI"],
      member_count: 2,
      start_utc: "2026-06-01T04:00:00Z",
      end_utc: "2026-06-01T06:30:00Z",
    },
    day,
  );
  expect(fallback).not.toMatch(/overlapped|grid load|regional price gap/i);
  expect(fallback).toContain("high electricity use");
  expect(fallback).toContain("wholesale prices far apart");
});

test("episode times are a 12-hour clock range, not trading period numbers", () => {
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

test("price and reserve episodes each link to their chart; price-only does not link reserve", () => {
  expect(
    episodeEvidenceLinks({
      observation_types: ["price_high", "reserve_price_high"],
    }),
  ).toEqual([
    {
      label: "See wholesale prices for this stretch.",
      href: "#wholesale-prices",
    },
    {
      label: "See backup prices for this stretch.",
      href: "#reserve-prices",
    },
  ]);
  expect(
    episodeEvidenceLinks({ observation_types: ["separation_low"] }),
  ).toEqual([
    {
      label: "See wholesale prices for this stretch.",
      href: "#wholesale-prices",
    },
  ]);
  expect(
    episodeEvidenceLinks({ observation_types: ["reserve_price_low"] }),
  ).toHaveLength(1);
  expect(episodeEvidenceLinks({ observation_types: ["price_high"] })).toEqual([
    {
      label: "See wholesale prices for this stretch.",
      href: "#wholesale-prices",
    },
  ]);
});

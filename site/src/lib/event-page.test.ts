import { expect, test } from "vitest";
import {
  claimDomId,
  claimLabelForSite,
  confidenceWord,
  eventPath,
  eventWindowChart,
  formatClaimValue,
  groupClaims,
  reviewWord,
  sourceTableWords,
} from "./event-page.ts";

test("eventPath nests under the daily page", () => {
  expect(eventPath("2026-07-27", "abc")).toBe("/2026/07/27/events/abc/");
});

test("claimLabelForSite drops banned acronyms", () => {
  expect(claimLabelForSite("SIR reserve price, NI, period 36")).toBe(
    "60-second reserve price, North Island, period 36",
  );
  expect(claimLabelForSite("FIR reserve price, SI, period 1")).toBe(
    "6-second reserve price, South Island, period 1",
  );
  expect(
    claimLabelForSite(
      "Period price at OTA2201, period 36 (time-weighted mean)",
    ),
  ).toBe("Period price at Ōtāhuhu, period 36 (time-weighted mean)");
});

test("confidenceWord covers every level", () => {
  expect(confidenceWord("confirmed")).toBe("Confirmed");
  expect(confidenceWord("strong_evidence")).toBe("Strong evidence");
  expect(confidenceWord("possible_explanation")).toBe("Possible explanation");
});

test("reviewWord is the visible ADR-0022 label", () => {
  expect(reviewWord("unreviewed")).toBe("Unreviewed");
  expect(reviewWord("reviewed")).toBe("Reviewed");
});

test("claimDomId sanitises dots", () => {
  expect(claimDomId("price.OTA2201.p36")).toBe("claim-price-OTA2201-p36");
  expect(claimDomId("reserve.SIR.NI.p36")).toBe("claim-reserve-60s-north-p36");
});

test("sourceTableWords maps known tables and falls back", () => {
  expect(sourceTableWords("price_periods")).toBe("wholesale period prices");
  expect(sourceTableWords("dispatch_energy_prices")).toBe(
    "dispatch energy prices",
  );
  expect(sourceTableWords("reserve_by_class_island_period")).toBe(
    "daily reserve prices",
  );
  expect(sourceTableWords("price_spreads")).toBe("period price spreads");
});

test("formatClaimValue uses dollars for $/MWh", () => {
  expect(formatClaimValue(3296.04, "$/MWh")).toBe("$3,296.04");
  expect(formatClaimValue(true, "")).toBe("Yes");
  expect(formatClaimValue("north", "")).toBe("north");
});

test("groupClaims uses site headings and skips empty groups", () => {
  const grouped = groupClaims([
    {
      id: "reserve.SIR.NI.p36",
      label: "SIR",
      value: 1,
      unit: "$/MWh",
      confidence: "confirmed",
      source_kind: "gold",
      source_table: "reserve_by_class_island_period",
      source_path: "gold",
    },
    {
      id: "price.OTA2201.p36",
      label: "OTA",
      value: 2,
      unit: "$/MWh",
      confidence: "confirmed",
      source_kind: "gold",
      source_table: "price_periods",
      source_path: "gold",
    },
  ]);
  expect(grouped.map((group) => group.heading)).toEqual([
    "Wholesale prices",
    "Reserve prices",
  ]);
});

test("eventWindowChart draws the three places and North Island 60-second reserve", () => {
  const chart = eventWindowChart(
    {
      episode_id: "abc",
      review_status: "unreviewed",
      observation_types: ["price_high"],
      islands: ["NI"],
      member_count: 1,
      severity: 1,
      start_utc: "2026-07-27T05:30:00Z",
      end_utc: "2026-07-27T07:00:00Z",
      start_trading_period: 36,
      end_trading_period: 38,
      claims: [],
      window: {
        periods: [36, 37],
        start_utc: ["2026-07-27T05:30:00Z", "2026-07-27T06:00:00Z"],
        prices: [
          { point_of_connection: "OTA2201", price: [3296.04, 1311.29] },
          { point_of_connection: "HAY2201", price: [2853.43, 1133.28] },
          { point_of_connection: "BEN2201", price: [571.46, 258.1] },
        ],
        reserves: [
          {
            reserve_class: "SIR",
            island: "NI",
            price: [2154.45, 835.13],
          },
        ],
      },
      limits: [],
      daily_page: "/2026/07/27/",
    },
    {
      periods: [
        { period: 36, start_utc: "2026-07-27T05:30:00Z" },
        { period: 37, start_utc: "2026-07-27T06:00:00Z" },
      ],
    },
  );
  expect(chart.pricePlot.lines.map((line) => line.id)).toEqual([
    "OTA2201",
    "HAY2201",
    "BEN2201",
  ]);
  expect(chart.reservePlot?.title).toMatch(/60-second/);
  expect(chart.caption).not.toMatch(/\bperiod\b/i);
  expect(chart.rows[0]?.join(" ")).toContain("$3,296.04");
});

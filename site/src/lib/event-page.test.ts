import type { SiteEvent } from "@gridwatch/publisher/site-contract";
import { expect, test } from "vitest";
import {
  claimAnchor,
  eventHeadline,
  eventPath,
  eventPathsForIndex,
  findEvent,
  linkClaims,
  recentEvents,
  requireCheckedEvent,
} from "./event-page.ts";
import { loadSiteDay, loadSiteIndex } from "./site-data.ts";

const event: SiteEvent = {
  episode_id: "394f75a3bfa948a3",
  review_status: "unreviewed",
  observation_types: ["price_high", "reserve_price_high"],
  islands: ["NI"],
  start_utc: "2026-07-27T05:30:00Z",
  end_utc: "2026-07-27T07:30:00Z",
  start_trading_period: 36,
  end_trading_period: 39,
  package_id: "fixture-27-july-2026",
  what_happened:
    "On 27 July 2026, the wholesale price at Ōtāhuhu reached $3,296.04/MWh. Haywards was $2,853.43. Benmore was $571.46. See /2026/07/27/.",
  why: "Confirmed: North Island reserve cost $2,154.45/MWh while the South Island reserve cost $0. Possible explanation: the North Island was short of backup while power was still moving north.",
  what_it_means:
    "The evening shows how prices in the North Island and the South Island can pull apart. The Ōtāhuhu–Benmore spread was $2,724.58/MWh.",
  claims: [
    {
      id: "price.OTA2201.p36",
      label: "Ōtāhuhu wholesale price",
      value: 3296.04,
      unit: "$/MWh",
      confidence: "confirmed",
      source_kind: "gold",
      source_path: "gold/price_periods/trading_date=2026-07-27/data.parquet",
    },
    {
      id: "reserve.SIR.SI.p36",
      label: "South Island reserve price",
      value: 0,
      unit: "$/MWh",
      confidence: "confirmed",
      source_kind: "gold",
      source_path:
        "gold/reserve_by_class_island_period/trading_date=2026-07-27/data.parquet",
    },
  ],
  daily_page: "/2026/07/27/",
  window: {
    periods: [36],
    start_utc: ["2026-07-27T05:30:00Z"],
    prices: [{ point_of_connection: "OTA2201", price: [3296.04] }],
    reserves: [{ reserve_class: "SIR", island: "NI", price: [2154.45] }],
  },
};

test("eventPath nests the event under the daily page", () => {
  expect(eventPath("2026-07-27", "394f75a3bfa948a3")).toBe(
    "/2026/07/27/events/394f75a3bfa948a3/",
  );
});

test("eventHeadline reuses the episode sentence", () => {
  const day = loadSiteDay("2026-07-27");
  expect(eventHeadline(event, day)).toMatch(/high wholesale prices/i);
});

test("requireCheckedEvent accepts the 27 July fixture", () => {
  const day = loadSiteDay("2026-07-27");
  const published = findEvent(day, "394f75a3bfa948a3");
  expect(() => requireCheckedEvent(published)).not.toThrow();
});

test("eventPathsForIndex includes the 27 July event", () => {
  const index = loadSiteIndex();
  const paths = eventPathsForIndex(index, (date) => loadSiteDay(date, index));
  expect(paths).toContainEqual({
    params: {
      year: "2026",
      month: "07",
      day: "27",
      id: "394f75a3bfa948a3",
    },
  });
});

test("recentEvents lists the 27 July write-up first among fixtures", () => {
  const index = loadSiteIndex();
  const listed = recentEvents(index, (date) => loadSiteDay(date, index));
  expect(listed[0]?.date).toBe("2026-07-27");
  expect(listed[0]?.event.episode_id).toBe("394f75a3bfa948a3");
});

test("requireCheckedEvent throws when a number is not in the claims", () => {
  expect(() =>
    requireCheckedEvent({
      ...event,
      what_happened: "Otahuhu hit $9,999/MWh.",
    }),
  ).toThrow(/checkNarrative/);
});

test("claimAnchor drops island and reserve jargon from html ids", () => {
  expect(claimAnchor("reserve.SIR.NI.p36")).toBe(
    "claim-reserve.sixty-second.north.p36",
  );
  expect(claimAnchor("reserve.SIR.SI.p36")).toBe(
    "claim-reserve.sixty-second.south.p36",
  );
});

test("linkClaims wraps money in a claim anchor and does not link a stray zero", () => {
  const html = linkClaims(event.what_happened, event);
  expect(html).toContain(`href="#${claimAnchor("price.OTA2201.p36")}"`);
  expect(html).toContain(">$3,296.04</a>");
  expect(html).toContain('href="/2026/07/27/"');
  const why = linkClaims(event.why, event);
  expect(why).toContain(`href="#${claimAnchor("reserve.SIR.SI.p36")}"`);
  expect(why).not.toContain("SIR");
  expect(why).not.toContain(".NI.");
  expect(why).not.toContain(".SI.");
});

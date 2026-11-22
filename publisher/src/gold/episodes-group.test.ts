import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { periodToUtc } from "../trading-time.ts";
import {
  episodeIdOf,
  type GroupingObservation,
  groupingIsland,
  groupObservations,
  JOIN_RULES,
} from "./episodes-group.ts";

const DAY = "2026-11-11";

const span = (startPeriod: number, endPeriod: number) => ({
  start_trading_period: startPeriod,
  end_trading_period: endPeriod,
  event_start_utc: periodToUtc(DAY, startPeriod).eventStartUtc.toString(),
  event_end_utc: periodToUtc(DAY, endPeriod).eventEndUtc.toString(),
});

const obs = (
  id: string,
  type: string,
  startPeriod: number,
  endPeriod: number,
  extra: Partial<GroupingObservation> = {},
): GroupingObservation => ({
  observation_id: id,
  observation_type: type,
  trading_date: DAY,
  ...span(startPeriod, endPeriod),
  subject_type: "point_of_connection",
  subject_id: "OTA2201",
  island: "NI",
  plant_id: null,
  measured_value: 100,
  severity: 1.5,
  inputs_complete: true,
  ...extra,
});

test("JOIN_RULES keep a stable set of ids", () => {
  expect(JOIN_RULES.map((rule) => rule.id)).toEqual([
    "price_high_price_high_adjacent_island",
    "reserve_price_high_reserve_price_high_adjacent_island",
    "price_high_reserve_price_high_adjacent_island",
    "generation_low_generation_low_adjacent_subject",
    "generation_low_price_high_overlap_island",
    "generation_low_reserve_price_high_overlap_island",
    "separation_high_price_high_adjacent_island",
    "demand_high_price_high_overlap_island",
    "price_low_price_low_adjacent_island",
  ]);
});

test("two overlapping NI price_high rows form one episode; NI and SI form two", () => {
  const niA = obs("a", "price_high", 10, 12);
  const niB = obs("b", "price_high", 11, 14, { subject_id: "HAY2201" });
  const si = obs("c", "price_high", 10, 12, {
    subject_id: "BEN2201",
    island: "SI",
  });
  const grouped = groupObservations([niA, niB, si]);
  expect(grouped).toHaveLength(2);
  const ni = grouped.find(
    (e) => e.islands.length === 1 && e.islands[0] === "NI",
  );
  const south = grouped.find((e) => e.islands[0] === "SI");
  expect(ni?.member_observation_ids).toEqual(["a", "b"]);
  expect(south?.member_observation_ids).toEqual(["c"]);
  expect(ni?.grouping_reason).toBe(
    '{"rules":["price_high_price_high_adjacent_island"]}',
  );
  expect(south?.grouping_reason).toBe('{"rules":["singleton"]}');
});

test("price_high and reserve_price_high join at a 2-period gap and split at 3", () => {
  const price = obs("p", "price_high", 10, 12);
  const near = obs("r2", "reserve_price_high", 15, 16, {
    subject_type: "reserve_class",
    subject_id: "FIR|NI",
  });
  const far = obs("r3", "reserve_price_high", 16, 17, {
    subject_type: "reserve_class",
    subject_id: "FIR|NI",
  });
  // period 12 ends, 15 starts: gap is periods 13-14 = 60 minutes (2 periods).
  expect(groupObservations([price, near])).toHaveLength(1);
  expect(groupObservations([price, far])).toHaveLength(2);
});

test("generation_low joins price_high on overlap only, same island", () => {
  const price = obs("p", "price_high", 10, 14);
  const overlapLow = obs("g", "generation_low", 12, 13, {
    subject_type: "plant",
    subject_id: "HLY/huntly_1_4",
    plant_id: "HLY/huntly_1_4",
  });
  const adjacentLow = obs("g2", "generation_low", 15, 16, {
    subject_type: "plant",
    subject_id: "HLY/huntly_1_4",
    plant_id: "HLY/huntly_1_4",
  });
  expect(groupObservations([price, overlapLow])).toHaveLength(1);
  expect(groupObservations([price, adjacentLow])).toHaveLength(2);
});

test("price_high and price_low on the same island stay two episodes", () => {
  const high = obs("h", "price_high", 10, 12);
  const low = obs("l", "price_low", 10, 12);
  expect(groupObservations([high, low])).toHaveLength(2);
});

test("a singleton is an episode with grouping_reason singleton", () => {
  const [episode] = groupObservations([obs("only", "price_high", 20, 22)]);
  expect(episode?.member_count).toBe(1);
  expect(episode?.grouping_reason).toBe('{"rules":["singleton"]}');
  expect(episode?.episode_id).toBe(episodeIdOf("only"));
});

test("OTA-HAY pair is always NI; HAY-BEN follows the dearer node", () => {
  expect(
    groupingIsland(
      obs("x", "separation_high", 10, 12, {
        subject_type: "point_of_connection_pair",
        subject_id: "OTA2201-HAY2201",
        island: null,
        measured_value: -50,
      }),
    ),
  ).toBe("NI");
  expect(
    groupingIsland(
      obs("y", "separation_high", 10, 12, {
        subject_type: "point_of_connection_pair",
        subject_id: "HAY2201-BEN2201",
        island: null,
        measured_value: 80,
      }),
    ),
  ).toBe("NI");
  expect(
    groupingIsland(
      obs("z", "separation_high", 10, 12, {
        subject_type: "point_of_connection_pair",
        subject_id: "HAY2201-BEN2201",
        island: null,
        measured_value: -80,
      }),
    ),
  ).toBe("SI");
});

test("a #21-shaped NI scarcity set is one episode; an extra SI price_high stays out", () => {
  const price = obs("p", "price_high", 35, 40);
  const reserve = obs("r", "reserve_price_high", 35, 40, {
    subject_type: "reserve_class",
    subject_id: "SIR|NI",
    severity: 170,
  });
  const gen = obs("g", "generation_low", 36, 38, {
    subject_type: "plant",
    subject_id: "TWC/te_uku",
    plant_id: "TWC/te_uku",
  });
  const sep = obs("s", "separation_high", 35, 39, {
    subject_type: "point_of_connection_pair",
    subject_id: "HAY2201-BEN2201",
    island: null,
    measured_value: 200,
  });
  const si = obs("south", "price_high", 35, 40, {
    subject_id: "BEN2201",
    island: "SI",
  });
  const grouped = groupObservations([price, reserve, gen, sep, si]);
  expect(grouped).toHaveLength(2);
  const ni = grouped.find((e) => e.member_count === 4);
  expect(ni?.observation_types).toEqual([
    "generation_low",
    "price_high",
    "reserve_price_high",
    "separation_high",
  ]);
  expect(ni?.severity).toBe(170);
  expect(ni?.islands).toEqual(["NI"]);
  expect(
    grouped.find((e) => e.member_observation_ids.includes("south"))
      ?.member_count,
  ).toBe(1);
});

test("episode_id is the first 16 hex characters of SHA-256 of the seed observation id", () => {
  expect(episodeIdOf("abc")).toBe(
    createHash("sha256").update("abc").digest("hex").slice(0, 16),
  );
});

test("a 60-minute UTC gap joins on a DST day; period arithmetic is not used", () => {
  const dst = "2026-09-27";
  const withUtc = (
    id: string,
    start: string,
    end: string,
    period: number,
  ): GroupingObservation => ({
    ...obs(id, "price_high", period, period),
    trading_date: dst,
    event_start_utc: start,
    event_end_utc: end,
  });
  // Spring-forward: clocks skip 02:00. These two runs sit either side of the
  // skip, 60 minutes of real time apart, more than two period numbers apart.
  const before = withUtc(
    "before",
    "2026-09-26T13:00:00Z",
    "2026-09-26T13:30:00Z",
    3,
  );
  const after = withUtc(
    "after",
    "2026-09-26T14:30:00Z",
    "2026-09-26T15:00:00Z",
    6,
  );
  expect(groupObservations([before, after])).toHaveLength(1);
  const tooFar = withUtc(
    "far",
    "2026-09-26T14:31:00Z",
    "2026-09-26T15:00:00Z",
    6,
  );
  expect(groupObservations([before, tooFar])).toHaveLength(2);
});

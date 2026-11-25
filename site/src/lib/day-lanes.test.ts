import { expect, test } from "vitest";
import {
  generationLaneSentence,
  isSqueezed,
  LANE_CAP,
  type Lane,
  laneIndexAt,
  laneScale,
  laneSvg,
  priceLaneSentence,
  tooltipRows,
} from "./day-lanes.ts";

const priceLane = (values: Array<number | null>): Lane => ({
  id: "price",
  name: "Price",
  sentence: "",
  unit: "price",
  stacked: false,
  series: [{ key: "OTA2201", label: "Ōtāhuhu", colour: "teal", values }],
  gap: null,
  extra: [],
});

test("a price lane squeezes the scale above 40c and keeps the spike's top", () => {
  const lane = priceLane([50, 3300, 120]);
  expect(isSqueezed(lane)).toBe(true);
  const scale = laneScale(lane);
  expect(scale.height).toBe(86);
  // 0 to 40c fills the lower 65% of the plot; the top value reaches the top.
  expect(scale.y(0)).toBeCloseTo(82);
  expect(scale.y(LANE_CAP)).toBeCloseTo(6 + 76 * 0.35);
  expect(scale.y(3300)).toBeCloseTo(6);
  expect(scale.ticks.map((tick) => tick.value)).toEqual([0, 200, 400, 3300]);
  expect(scale.ticks.find((tick) => tick.dashed)?.value).toBe(400);
});

test("a lane under 40c keeps a plain scale and has no squeeze band", () => {
  const lane = priceLane([50, 170, 120]);
  expect(isSqueezed(lane)).toBe(false);
  expect(laneScale(lane).ticks.map((tick) => tick.value)).toEqual([
    0, 100, 200,
  ]);
  expect(laneSvg(lane, [], 1)).not.toContain("lane-squeeze");
});

test("the price sentence follows the peaks and names Benmore's high", () => {
  expect(priceLaneSentence([50, 3300], [40, 570], [7, 17])).toBe(
    "Ōtāhuhu rose in the morning and again in the evening, while Benmore reached 57c.",
  );
  expect(priceLaneSentence([50, 170], [10, 43], [20])).toBe(
    "Ōtāhuhu was highest in the evening, while Benmore stayed under 5c.",
  );
  expect(priceLaneSentence([50, 170], [], [])).toBe(
    "Ōtāhuhu stayed between 5.0c and 17c.",
  );
});

test("the generation sentence gives the lowest and highest half-hour", () => {
  expect(
    generationLaneSentence([4292, null, 7212], ["2:30am", "3:00am", "8:00am"]),
  ).toBe("It ran from 4,292 MW at 2:30am to 7,212 MW at 8:00am.");
});

test("a stacked tooltip lists fuels largest first, then the totals", () => {
  const lane: Lane = {
    id: "generation",
    name: "Generation",
    sentence: "",
    unit: "megawatts",
    stacked: true,
    series: [
      { key: "hydro", label: "Hydro", colour: "blue", values: [100] },
      { key: "gas", label: "Gas", colour: "grey", values: [300] },
      { key: "wind", label: "Wind", colour: "green", values: [0.4] },
    ],
    gap: null,
    extra: [{ key: "total", label: "Total", colour: "", values: [400.4] }],
  };
  expect(tooltipRows(lane, 0).map((row) => row.label)).toEqual([
    "Gas",
    "Hydro",
    "Total",
  ]);
});

test("a point on the lane maps to its half-hour, and the tick column clamps", () => {
  expect(laneIndexAt(0, 48)).toBe(0);
  expect(laneIndexAt(0.5, 48)).toBe(27);
  expect(laneIndexAt(0.99, 48)).toBe(47);
});

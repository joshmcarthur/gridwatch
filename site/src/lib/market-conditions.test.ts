import { expect, test } from "vitest";
import {
  gasCoalShare,
  hayBenAbsSpread,
  meanWholesalePrice,
  peakReservePrice,
} from "./market-conditions.ts";

test("mean wholesale price averages the reference-node daily means", () => {
  expect(
    meanWholesalePrice({
      prices: {
        nodes: [
          { daily: { mean_price: 40 } },
          { daily: { mean_price: 50 } },
          { daily: { mean_price: 60 } },
        ],
        spreads: [],
      },
    }),
  ).toBe(50);
});

test("mean wholesale price skips nodes with no daily mean", () => {
  expect(
    meanWholesalePrice({
      prices: {
        nodes: [{ daily: { mean_price: null } }, { daily: { mean_price: 80 } }],
        spreads: [],
      },
    }),
  ).toBe(80);
});

test("mean wholesale price is null when no node has a mean", () => {
  expect(
    meanWholesalePrice({
      prices: { nodes: [{ daily: { mean_price: null } }], spreads: [] },
    }),
  ).toBeNull();
});

test("gas and coal share is of primary generation, not batteries", () => {
  expect(
    gasCoalShare({
      generation: {
        totals: {
          primary_megawatt_hours: 100,
          battery_megawatt_hours: 20,
        },
        daily: [
          { fuel: "hydro", megawatt_hours: 60 },
          { fuel: "gas", megawatt_hours: 25 },
          { fuel: "coal_gas", megawatt_hours: 15 },
          { fuel: "battery", megawatt_hours: 20 },
        ],
      },
    }),
  ).toBe(0.4);
});

test("gas and coal share is null when primary generation is missing or zero", () => {
  expect(
    gasCoalShare({
      generation: { totals: null, daily: [] },
    }),
  ).toBeNull();
  expect(
    gasCoalShare({
      generation: {
        totals: { primary_megawatt_hours: 0, battery_megawatt_hours: 0 },
        daily: [],
      },
    }),
  ).toBeNull();
});

test("Haywards–Benmore gap is the mean absolute spread", () => {
  expect(
    hayBenAbsSpread({
      prices: {
        nodes: [],
        spreads: [
          { from: "OTA2201", to: "HAY2201", spread: [5, -5] },
          { from: "HAY2201", to: "BEN2201", spread: [10, -4, null] },
        ],
      },
    }),
  ).toBe(7);
});

test("Haywards–Benmore gap is null when the pair is missing", () => {
  expect(
    hayBenAbsSpread({
      prices: {
        nodes: [],
        spreads: [{ from: "OTA2201", to: "HAY2201", spread: [1] }],
      },
    }),
  ).toBeNull();
});

test("peak reserve price is the highest class-island daily mean", () => {
  expect(
    peakReservePrice({
      reserves: {
        daily: [
          { mean_price: 0.5 },
          { mean_price: 12 },
          { mean_price: null },
          { mean_price: 3 },
        ],
      },
    }),
  ).toBe(12);
});

test("peak reserve price is null when the section is missing", () => {
  expect(peakReservePrice({})).toBeNull();
  expect(peakReservePrice({ reserves: { daily: [] } })).toBeNull();
});

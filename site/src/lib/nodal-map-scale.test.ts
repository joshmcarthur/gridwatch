import { expect, test } from "vitest";
import {
  formatPrice,
  islandLabel,
  isOutlier,
  MISSING_FILL,
  type NodalMapRow,
  periodSummary,
  priceBandFill,
  sortRows,
} from "./nodal-map-scale.ts";

test("islandLabel spells out NI and SI", () => {
  expect(islandLabel("NI")).toBe("North Island");
  expect(islandLabel("SI")).toBe("South Island");
  expect(islandLabel(null)).toBe("");
});

test("formatPrice uses two decimal places and a no-data label", () => {
  expect(formatPrice(81)).toBe("81.00");
  expect(formatPrice(null)).toBe("No data");
});

test("priceBandFill is grey when missing and uses fixed bands in cents per kWh", () => {
  expect(priceBandFill(null)).toBe(MISSING_FILL);
  expect(priceBandFill(-5)).toBe("#4fa89a");
  expect(priceBandFill(29.99)).toBe("#4fa89a");
  expect(priceBandFill(30)).toBe("#9fb3ae");
  expect(priceBandFill(80)).toBe("#e0a23a");
  expect(priceBandFill(200)).toBe("#c8553d");
  expect(priceBandFill(3296)).toBe("#c8553d");
});

test("periodSummary says the clock and the range in cents per kWh", () => {
  const view = {
    periods: [{ period: 1, time: "7:00pm" }],
    min: [9],
    max: [150],
  };
  expect(periodSummary(view, 1)).toBe(
    "At 7:00pm, wholesale prices on the grid ranged from 0.9c to 15c per kWh.",
  );
  expect(periodSummary({ ...view, min: [null] }, 1)).toBe(
    "At 7:00pm, wholesale prices for this half-hour are missing.",
  );
});

test("isOutlier is outside p05–p95, never for a missing price", () => {
  expect(isOutlier(1, 10, 90)).toBe(true);
  expect(isOutlier(95, 10, 90)).toBe(true);
  expect(isOutlier(50, 10, 90)).toBe(false);
  expect(isOutlier(null, 10, 90)).toBe(false);
  expect(isOutlier(1, null, 90)).toBe(false);
});

const rows: NodalMapRow[] = [
  {
    point_of_connection: "HAY2201",
    location: "",
    island: "North Island",
    price: 50,
    outlier: true,
    proxy: false,
  },
  {
    point_of_connection: "ALB0331",
    location: "On the map",
    island: "North Island",
    price: 90,
    outlier: false,
    proxy: false,
  },
  {
    point_of_connection: "ABY0111",
    location: "On the map",
    island: "South Island",
    price: null,
    outlier: false,
    proxy: true,
  },
];

test("sortRows by price puts missing last", () => {
  expect(
    sortRows(rows, "price", "asc").map((row) => row.point_of_connection),
  ).toEqual(["HAY2201", "ALB0331", "ABY0111"]);
  expect(
    sortRows(rows, "price", "desc").map((row) => row.point_of_connection),
  ).toEqual(["ALB0331", "HAY2201", "ABY0111"]);
});

test("sortRows by place, location, island and outlier", () => {
  expect(
    sortRows(rows, "point_of_connection", "asc").map(
      (row) => row.point_of_connection,
    ),
  ).toEqual(["ABY0111", "ALB0331", "HAY2201"]);
  expect(
    sortRows(rows, "location", "desc").map((row) => row.point_of_connection),
  ).toEqual(["ALB0331", "ABY0111", "HAY2201"]);
  expect(
    sortRows(rows, "outlier", "desc").map((row) => row.point_of_connection),
  ).toEqual(["HAY2201", "ALB0331", "ABY0111"]);
});

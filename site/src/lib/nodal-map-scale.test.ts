import { expect, test } from "vitest";
import {
  formatPrice,
  islandLabel,
  isOutlier,
  MISSING_FILL,
  type NodalMapRow,
  priceFill,
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

test("priceFill is missing grey when any input is null, mid when min equals max", () => {
  expect(priceFill(null, 0, 10)).toBe(MISSING_FILL);
  expect(priceFill(5, null, 10)).toBe(MISSING_FILL);
  expect(priceFill(5, 10, 10)).toBe("#f2b544");
});

test("priceFill runs from teal through gold to amber", () => {
  expect(priceFill(0, 0, 100)).toBe("#1f6f78");
  expect(priceFill(50, 0, 100)).toBe("#f2b544");
  expect(priceFill(100, 0, 100)).toBe("#b7791f");
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

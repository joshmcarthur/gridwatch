import { resolve } from "node:path";
import { expect, test } from "vitest";
import { dataPaths } from "./data-root.ts";

test("dataPaths defaults to ./data", () => {
  expect(dataPaths({}).bronze).toBe(resolve("data", "bronze"));
});

test("dataPaths honours DATA_ROOT", () => {
  const paths = dataPaths({ DATA_ROOT: "/tmp/gw" });
  expect([paths.bronze, paths.silver, paths.gold]).toEqual([
    "/tmp/gw/bronze",
    "/tmp/gw/silver",
    "/tmp/gw/gold",
  ]);
});

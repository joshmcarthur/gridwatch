import { expect, test } from "vitest";
import { nextRange } from "./main.ts";

const today = "2026-11-22";

test("with nothing covered, the range is the latest 7 days", () => {
  expect(nextRange(today, null)).toEqual({
    from: "2026-11-15",
    to: "2026-11-21",
  });
});

test("after that, the range is the 30 days before the earliest covered date", () => {
  expect(nextRange(today, "2026-11-15")).toEqual({
    from: "2026-10-16",
    to: "2026-11-14",
  });
});

test("the last range stops at the start of the 12-month window", () => {
  expect(nextRange(today, "2025-12-10")).toEqual({
    from: "2025-11-22",
    to: "2025-12-09",
  });
});

test("there is no range once the window is covered", () => {
  expect(nextRange(today, "2025-11-22")).toBeNull();
  expect(nextRange(today, "2025-01-01")).toBeNull();
});

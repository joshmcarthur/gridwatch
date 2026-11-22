import { expect, test } from "vitest";
import { coveredFrom, nextRange } from "./main.ts";

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

test("coveredFrom is the start of the unbroken run that ends at the newest date", () => {
  expect(coveredFrom([])).toBeNull();
  expect(coveredFrom(["2026-11-19", "2026-11-21", "2026-11-20"])).toBe(
    "2026-11-19",
  );
});

test("coveredFrom does not skip a hole left by a range that stopped part way", () => {
  // The range 2026-09-16..2026-10-15 stopped after two days. Its oldest days are held.
  const held = ["2026-09-16", "2026-09-17", "2026-10-16", "2026-10-17"];
  expect(coveredFrom(held)).toBe("2026-10-16");
  expect(nextRange(today, coveredFrom(held))).toEqual({
    from: "2026-09-16",
    to: "2026-10-15",
  });
});

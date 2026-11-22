import { expect, test } from "vitest";
import { pageTitle } from "./page-title.ts";

test("home stays the site name", () => {
  expect(pageTitle("Gridwatch NZ")).toBe("Gridwatch NZ");
});

test("short page names get the site suffix", () => {
  expect(pageTitle("About")).toBe("About · Gridwatch NZ");
  expect(pageTitle("How we do this")).toBe("How we do this · Gridwatch NZ");
  expect(pageTitle("Terms")).toBe("Terms · Gridwatch NZ");
});

test("titles that already include the site name are left alone", () => {
  expect(pageTitle("Sunday, 27 September 2026 · Gridwatch NZ")).toBe(
    "Sunday, 27 September 2026 · Gridwatch NZ",
  );
  expect(pageTitle("Price map · Gridwatch NZ")).toBe(
    "Price map · Gridwatch NZ",
  );
});

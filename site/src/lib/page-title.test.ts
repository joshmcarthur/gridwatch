import { expect, test } from "vitest";
import { pageTitle } from "./page-title.ts";

test("home stays the site name", () => {
  expect(pageTitle("Gridwatch NZ")).toBe("Gridwatch NZ");
});

test("every other page name gets the site suffix", () => {
  expect(pageTitle("About")).toBe("About · Gridwatch NZ");
  expect(pageTitle("How we do this")).toBe("How we do this · Gridwatch NZ");
  expect(pageTitle("Terms")).toBe("Terms · Gridwatch NZ");
  expect(pageTitle("Explainers")).toBe("Explainers · Gridwatch NZ");
  expect(pageTitle("Price map")).toBe("Price map · Gridwatch NZ");
  expect(pageTitle("Sunday, 27 September 2026")).toBe(
    "Sunday, 27 September 2026 · Gridwatch NZ",
  );
  expect(pageTitle("Price map · Sunday, 27 September 2026")).toBe(
    "Price map · Sunday, 27 September 2026 · Gridwatch NZ",
  );
});

import {
  assertSiteDay,
  type SiteDay,
} from "@gridwatch/publisher/site-contract";
import { expect, test } from "vitest";
import fixtureJson from "../../fixtures/days/2026-09-27.json";
import { generationMix, generationMixSummary } from "@gridwatch/publisher/story/generation-mix.ts";
import {
  mixBatterySvg,
  mixComparePayload,
  mixStackSvg,
} from "./generation-mix-chart.ts";

const fixtureUnknown: unknown = fixtureJson;
assertSiteDay(fixtureUnknown);
const fixture: SiteDay = fixtureUnknown;

test("mixStackSvg labels the SVG for compare without clashing daily ids", () => {
  const mix = generationMix(fixture);
  if (!mix) throw new Error("fixture mix");
  const svg = mixStackSvg(mix, {
    id: "generation-mix-compare",
    title: "Generation mix by fuel",
    summary: generationMixSummary(mix),
  });
  expect(svg).toContain("generation-mix-compare-title");
  expect(svg).not.toContain("generation-mix-chart-title");
  expect(svg).toContain('role="img"');
});

test("mixBatterySvg uses the compare id prefix", () => {
  const mix = generationMix(fixture);
  if (!mix) throw new Error("fixture mix");
  const svg = mixBatterySvg(mix, {
    id: "generation-battery-compare",
    title: "Battery (stored power)",
    summary: "Batteries sent stored power.",
  });
  expect(svg).toContain("generation-battery-compare-title");
  expect(svg).not.toContain("generation-battery-chart-title");
});

test("mixComparePayload is missing when generation is missing", () => {
  const payload = mixComparePayload({
    ...fixture,
    generation: { ...fixture.generation, state: "missing", series: [] },
  });
  expect(payload).toEqual({ date: fixture.trading_date, missing: true });
});

test("mixComparePayload carries both SVGs for a complete day", () => {
  const payload = mixComparePayload(fixture);
  expect(payload.missing).toBe(false);
  if (payload.missing) throw new Error("expected mix");
  expect(payload.date).toBe("2026-09-27");
  expect(payload.title).toMatch(/27 September 2026/);
  expect(payload.stackSvg).toContain("generation-mix-compare-title");
  expect(payload.batterySvg).toContain("generation-battery-compare-title");
  expect(payload.summary.length).toBeGreaterThan(0);
});

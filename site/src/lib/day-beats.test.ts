import type { SiteDay } from "@gridwatch/publisher/site-contract";
import { expect, test } from "vitest";
import july27 from "../../fixtures/days/2026-07-27.json";
import september26 from "../../fixtures/days/2026-09-26.json";
import september27 from "../../fixtures/days/2026-09-27.json";
import october29 from "../../fixtures/days/2026-10-29.json";
import { centsPerKwh, dayBeats } from "./day-beats.ts";

const fixture = (day: unknown): SiteDay =>
  structuredClone(day) as unknown as SiteDay;

test("centsPerKwh uses one decimal place under 10c and whole cents above", () => {
  expect(centsPerKwh(3)).toBe("0.3c");
  expect(centsPerKwh(69)).toBe("6.9c");
  expect(centsPerKwh(100)).toBe("10c");
  expect(centsPerKwh(3296.04)).toBe("330c");
});

test("a spike day leads with the peak and joins its episode to the peak beat", () => {
  const day = fixture(july27);
  const story = dayBeats(day);
  expect(story.headline).toBe("Ōtāhuhu reached 330c per kWh at 5:30pm");
  const evening = story.beats.find((b) => b.title === "Evening price peak");
  expect(evening?.text).toContain(
    "Ōtāhuhu reached 330c per kWh at 5:30pm, while Benmore was 57c.",
  );
  const episode = day.episodes?.items.find(
    (e) => e.start_trading_period === 35,
  );
  expect(episode).toBeDefined();
  expect(evening?.episodeIds).toContain(episode?.episode_id);
  expect(evening?.text).toContain("From 5:00pm to 8:30pm,");
});

test("a windy day gets a wind beat with its share of generation", () => {
  const story = dayBeats(fixture(september26));
  const wind = story.beats.find((b) => b.rule === "fuel_high");
  expect(wind?.title).toBe("Wind at its highest");
  expect(wind?.text).toContain("23% of all generation");
  expect(wind?.fuels).toEqual(["wind"]);
});

test("the cable beat comes last and counts half-hours on a 46-period day", () => {
  const story = dayBeats(fixture(september27));
  const cable = story.beats.at(-1);
  expect(cable?.rule).toBe("cable");
  expect(cable?.when).toBe("All day");
  expect(cable?.text).toContain("in 44 of 46 half-hours");
  expect(cable?.link?.href).toBe("/explainers/hvdc-link/");
});

test("a window that ends at the last period ends at 12:00am, not noon", () => {
  const story = dayBeats(fixture(october29));
  const wind = story.beats.find((b) => b.rule === "fuel_high");
  expect(wind?.when).toMatch(/to 12:00am$/);
});

test("a lasting geothermal drop gets a step_change beat", () => {
  const day = fixture(october29);
  for (const row of day.generation.series) {
    if (row.fuel !== "geothermal") continue;
    row.megawatt_hours = row.megawatt_hours.map((value, index) =>
      index >= 20 && value !== null ? value - 100 : value,
    );
  }
  const step = dayBeats(day).beats.find((b) => b.rule === "step_change");
  expect(step?.title).toBe("Geothermal dropped");
  // 200 MW injected, plus the fixture's own small drift.
  expect(step?.text).toMatch(/fell by about 2\d0 MW around 10:00am/);
});

test("missing generation still gives price beats and a price headline", () => {
  const day = fixture(september27);
  day.generation = { ...day.generation, state: "missing", series: [] };
  const story = dayBeats(day);
  expect(story.beats.some((b) => b.rule === "price_peak")).toBe(true);
  expect(story.beats.some((b) => b.rule === "fuel_high")).toBe(false);
  expect(story.headline).toBe("Benmore averaged 2.0c per kWh, Ōtāhuhu 7.3c");
});

test("no beat states a cause", () => {
  for (const day of [july27, september26, september27, october29]) {
    for (const b of dayBeats(fixture(day)).beats) {
      expect(b.text).not.toMatch(/\b(because|due to|likely|caused)\b/i);
    }
  }
});

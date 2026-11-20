import {
  assertSiteDay,
  type GenerationSection,
  type SiteDay,
} from "@gridwatch/publisher/site-contract";
import { expect, test } from "vitest";
import fixtureJson from "../../fixtures/days/2026-09-27.json";
import {
  BATTERY_HEADER,
  generationMix,
  generationMixSummary,
  generationMixTable,
} from "./generation-mix.ts";

const fixtureUnknown: unknown = fixtureJson;
assertSiteDay(fixtureUnknown);
const fixture: SiteDay = fixtureUnknown;

const HALF_HOUR_MS = 30 * 60 * 1000;

function periodsFrom(startUtc: string, count: number) {
  const start = Date.parse(startUtc);
  return Array.from({ length: count }, (_, index) => ({
    period: index + 1,
    start_utc: new Date(start + index * HALF_HOUR_MS)
      .toISOString()
      .replace(".000Z", "Z"),
  }));
}

function dayWith(
  startUtc: string,
  count: number,
  generation: Partial<GenerationSection>,
): SiteDay {
  return {
    ...fixture,
    periods: periodsFrom(startUtc, count),
    generation: { ...fixture.generation, ...generation },
  };
}

/** Local midnight on the DST-start day (NZST, +12) is 12:00 UTC the day before. */
const DST_START_DAY = "2026-09-26T12:00:00Z";
/** Local midnight on the DST-end day (NZDT, +13) is 11:00 UTC the day before. */
const DST_END_DAY = "2026-04-04T11:00:00Z";
/** Local midnight on an ordinary winter day (NZST, +12). */
const WINTER_DAY = "2026-05-31T12:00:00Z";

function cells(count: number, set: Record<number, number | null>) {
  return Array.from({ length: count }, (_, index) =>
    index in set ? set[index] : 0,
  );
}

test("fixture period 1 splits hydro and wind into average MW", () => {
  const mix = generationMix(fixture);
  if (!mix) throw new Error("expected a mix");
  const first = mix.points[0];
  if (!first) throw new Error("expected a first period");
  expect(mix.layers.map((layer) => layer.label)).toEqual([
    "Hydro",
    "Wind",
    "Solar",
  ]);
  expect(first.megawatts.hydro).toBeCloseTo(16.66, 3);
  expect(first.megawatts.wind).toBeCloseTo(136.226, 3);
  expect(first.primary).toBeCloseTo(152.886, 3);
  expect(first.title).toContain("Wind 136.2 MW (89.1%)");
});

test("battery is shown apart and is not in the primary total", () => {
  const mix = generationMix(fixture);
  if (!mix) throw new Error("expected a mix");
  const period15 = mix.points[14];
  if (!period15) throw new Error("expected period 15");
  expect(period15.battery).toBeCloseTo(10.288, 3);
  expect(period15.primary).toBeCloseTo(79.848, 3);
  expect(mix.layers.map((layer) => layer.label)).not.toContain("Battery");
});

test("hydro average over the day matches the daily summary", () => {
  const mix = generationMix(fixture);
  if (!mix) throw new Error("expected a mix");
  const hydroDaily = fixture.generation.daily.find(
    (row) => row.fuel === "hydro",
  );
  if (!hydroDaily) throw new Error("expected a hydro daily row");
  const total = mix.points.reduce(
    (sum, point) => sum + (point.megawatts.hydro ?? 0),
    0,
  );
  expect(total / mix.points.length).toBeCloseTo(
    hydroDaily.average_megawatts,
    2,
  );
});

test("two islands are summed, and a null in one island keeps the other", () => {
  const count = 46;
  const day = dayWith(DST_START_DAY, count, {
    missing_periods: [4],
    series: [
      {
        fuel: "hydro",
        island: "NI",
        megawatt_hours: cells(count, { 0: 1, 1: 1, 2: null, 3: null }),
      },
      {
        fuel: "hydro",
        island: "SI",
        megawatt_hours: cells(count, { 0: null, 1: 3, 2: null, 3: null }),
      },
      {
        fuel: "unmapped",
        island: null,
        megawatt_hours: cells(count, { 0: 5 }),
      },
      {
        fuel: "battery",
        island: null,
        megawatt_hours: cells(count, { 0: 1 }),
      },
    ],
  });
  const mix = generationMix(day);
  if (!mix) throw new Error("expected a mix");
  const [first, second, third, gap] = mix.points;
  if (!first || !second || !third || !gap) throw new Error("expected periods");

  expect(first.megawatts.hydro).toBeCloseTo(2, 6);
  expect(second.megawatts.hydro).toBeCloseTo(8, 6);
  expect(first.incomplete).toBe(false);

  expect(third.megawatts.hydro).toBe(0);
  expect(third.incomplete).toBe(true);

  expect(gap.gap).toBe(true);
  expect(gap.megawatts.hydro).toBeNull();
  expect(gap.primary).toBeNull();
  expect(gap.incomplete).toBe(false);

  expect(first.primary).toBeCloseTo(12, 6);
  expect(first.battery).toBeCloseTo(2, 6);
});

test("unmapped is a stacked layer and counts in the primary total", () => {
  const count = 46;
  const day = dayWith(DST_START_DAY, count, {
    series: [
      {
        fuel: "unmapped",
        island: null,
        megawatt_hours: cells(count, { 0: 4 }),
      },
    ],
  });
  const mix = generationMix(day);
  if (!mix) throw new Error("expected a mix");
  expect(mix.layers).toEqual([
    { fuel: "unmapped", label: "Not yet matched to a plant" },
  ]);
  expect(mix.points[0]?.primary).toBeCloseTo(8, 6);
});

test("a fuel that is all zero is dropped from the stack", () => {
  const count = 46;
  const day = dayWith(DST_START_DAY, count, {
    series: [
      { fuel: "gas", island: null, megawatt_hours: cells(count, {}) },
      { fuel: "solar", island: null, megawatt_hours: cells(count, { 5: 2 }) },
    ],
  });
  const mix = generationMix(day);
  if (!mix) throw new Error("expected a mix");
  expect(mix.layers.map((layer) => layer.fuel)).toEqual(["solar"]);
});

test("a 46-period day has 46 points and starts at 00:00", () => {
  const mix = generationMix(fixture);
  if (!mix) throw new Error("expected a mix");
  expect(mix.points).toHaveLength(46);
  expect(mix.points[0]?.time).toBe("00:00");
  expect(mix.ticks.map((tick) => tick.label)).toEqual([
    "00",
    "03",
    "06",
    "09",
    "12",
    "15",
    "18",
    "21",
  ]);
});

test("a 50-period day has 50 points and its repeated-hour labels differ", () => {
  const mix = generationMix(dayWith(DST_END_DAY, 50, {}));
  if (!mix) throw new Error("expected a mix");
  expect(mix.points).toHaveLength(50);
  const repeated = mix.points.filter((point) => point.time.startsWith("02:00"));
  expect(repeated).toHaveLength(2);
  expect(repeated[0]?.time).not.toBe(repeated[1]?.time);
  expect(repeated.map((point) => point.time)).toEqual([
    "02:00 NZDT",
    "02:00 NZST",
  ]);
});

test("a 48-period day ends at 23:30", () => {
  const mix = generationMix(dayWith(WINTER_DAY, 48, {}));
  if (!mix) throw new Error("expected a mix");
  expect(mix.points).toHaveLength(48);
  expect(mix.points.at(-1)?.time).toBe("23:30");
});

test("a missing generation section has no mix", () => {
  const day = dayWith(DST_START_DAY, 46, { state: "missing", series: [] });
  expect(generationMix(day)).toBeNull();
});

test("a day with only battery has no layers, and its share text is empty", () => {
  const count = 46;
  const day = dayWith(DST_START_DAY, count, {
    series: [
      { fuel: "battery", island: null, megawatt_hours: cells(count, { 0: 1 }) },
    ],
  });
  const mix = generationMix(day);
  if (!mix) throw new Error("expected a mix");
  expect(mix.layers).toEqual([]);
  const table = generationMixTable(mix);
  expect(table.headers.at(-1)).toBe(BATTERY_HEADER);
  expect(table.rows[0]?.[1]).toBe("0.0 MW");
  expect(table.rows[0]?.join(" ")).not.toMatch(/%/);
});

test("the table has a battery column and share text in each cell", () => {
  const mix = generationMix(fixture);
  if (!mix) throw new Error("expected a mix");
  const table = generationMixTable(mix);
  expect(table.headers).toEqual([
    "Time",
    "Hydro",
    "Wind",
    "Solar",
    "Primary total",
    BATTERY_HEADER,
  ]);
  expect(table.rows).toHaveLength(46);
  expect(table.rows[0]).toEqual([
    "00:00",
    "16.7 MW (10.9%)",
    "136.2 MW (89.1%)",
    "0.0 MW (0.0%)",
    "152.9 MW",
    expect.stringMatching(/MW$/),
  ]);
});

test("the summary names the largest fuel by average MW and its share", () => {
  const mix = generationMix(fixture);
  if (!mix) throw new Error("expected a mix");
  expect(generationMixSummary(mix)).toBe(
    "Wind made the most, about 119 megawatts on average, 80% of the day's primary generation.",
  );
});

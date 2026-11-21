import {
  assertSiteDay,
  type SiteDay,
} from "@gridwatch/publisher/site-contract";
import { expect, test } from "vitest";
import fixtureJson from "../../fixtures/days/2026-09-27.json";
import {
  coverageSentence,
  defaultPeriod,
  MAP_HEIGHT,
  MAP_WIDTH,
  nodalMapView,
  periodSummary,
  renderMapSvg,
  rowsForPeriod,
} from "./nodal-map.ts";

const fixtureUnknown: unknown = fixtureJson;
assertSiteDay(fixtureUnknown);
const fixture: SiteDay = fixtureUnknown;

const HALF_HOUR_MS = 30 * 60 * 1000;

function copy(): SiteDay {
  return structuredClone(fixture);
}

function nuls(count: number): Array<number | null> {
  return Array.from({ length: count }, () => null);
}

function nums(count: number, value: number): Array<number | null> {
  return Array.from({ length: count }, () => value);
}

function withMap(
  day: SiteDay,
  options: {
    periods?: number;
    min?: Array<number | null>;
    max?: Array<number | null>;
    p05?: Array<number | null>;
    p95?: Array<number | null>;
    pocs?: SiteDay["nodal_map"] extends infer T
      ? T extends { pocs: infer P }
        ? P
        : never
      : never;
    unlocated?: NonNullable<SiteDay["nodal_map"]>["unlocated"];
    state?: NonNullable<SiteDay["nodal_map"]>["state"];
  } = {},
): SiteDay {
  const count = options.periods ?? day.periods.length;
  const start = Date.parse(day.periods[0]?.start_utc ?? "2026-09-26T12:00:00Z");
  day.periods = Array.from({ length: count }, (_, index) => ({
    period: index + 1,
    start_utc: new Date(start + index * HALF_HOUR_MS)
      .toISOString()
      .replace(".000Z", "Z"),
  }));
  const pad = (
    values: Array<number | null> | undefined,
    fill: number | null,
  ): Array<number | null> =>
    Array.from({ length: count }, (_, i) => values?.[i] ?? fill);
  day.prices.distribution.min = pad(options.min, 40);
  day.prices.distribution.max = pad(options.max, 100);
  day.prices.distribution.p05 = pad(options.p05, 45);
  day.prices.distribution.p95 = pad(options.p95, 90);
  day.nodal_map = {
    state: options.state ?? "complete",
    missing_periods: [],
    analysis_version: 2,
    inputs_sha256: "sha",
    silver_tables: ["dispatch_energy_prices", "entity_points_of_connection"],
    gold_tables: ["nodal_price_periods"],
    datasets: ["dispatch_energy_prices", "entity_mappings"],
    pocs: options.pocs ?? [
      {
        point_of_connection: "ALB0331",
        latitude: -36.739,
        longitude: 174.69,
        island: "NI",
        price: pad([80, 200], 80),
        proxy_periods: [],
      },
    ],
    unlocated: options.unlocated ?? [
      {
        point_of_connection: "HAY2201",
        island: "NI",
        price: pad([50], 50),
        proxy_periods: [1],
      },
    ],
  };
  return day;
}

test("defaultPeriod is the slice with the widest min–max, else 1", () => {
  const day = withMap(copy(), {
    min: [10, 0, 40],
    max: [20, 80, 50],
  });
  expect(defaultPeriod(day)).toBe(2);
  const flat = withMap(copy(), {
    min: nuls(46),
    max: nuls(46),
  });
  expect(defaultPeriod(flat)).toBe(1);
});

test("nodalMapView is null when the section is missing", () => {
  const day = copy();
  day.nodal_map = {
    state: "missing",
    missing_periods: [],
    analysis_version: null,
    inputs_sha256: null,
    silver_tables: ["dispatch_energy_prices", "entity_points_of_connection"],
    gold_tables: ["nodal_price_periods"],
    datasets: ["dispatch_energy_prices", "entity_mappings"],
    pocs: [],
    unlocated: [],
  };
  expect(nodalMapView(day)).toBeNull();
  day.nodal_map = undefined;
  expect(nodalMapView(day)).toBeNull();
});

test("the view projects only located POCs and keeps unlocated for the table", () => {
  const view = nodalMapView(withMap(copy()));
  if (!view) throw new Error("expected a map view");
  expect(view.pocs).toHaveLength(1);
  expect(view.pocs[0]?.point_of_connection).toBe("ALB0331");
  expect(view.pocs[0]?.cx).toBeGreaterThan(0);
  expect(view.pocs[0]?.cx).toBeLessThan(MAP_WIDTH);
  expect(view.pocs[0]?.cy).toBeGreaterThan(0);
  expect(view.pocs[0]?.cy).toBeLessThan(MAP_HEIGHT);
  expect(view.unlocated.map((row) => row.point_of_connection)).toEqual([
    "HAY2201",
  ]);
  expect(view.plotted).toBe(1);
  expect(view.priced).toBe(2);
  expect(view.landPaths.length).toBeGreaterThan(0);
});

test("a 48-period day keeps 48 slots on the slider axis and in each price array", () => {
  const view = nodalMapView(withMap(copy(), { periods: 48 }));
  if (!view) throw new Error("expected a map view");
  expect(view.periods).toHaveLength(48);
  expect(view.pocs[0]?.price).toHaveLength(48);
  expect(view.unlocated[0]?.price).toHaveLength(48);
  expect(view.min).toHaveLength(48);
  expect(rowsForPeriod(view, 48)).toHaveLength(2);
});

test("a 50-period day keeps 50 slots", () => {
  const view = nodalMapView(withMap(copy(), { periods: 50 }));
  if (!view) throw new Error("expected a map view");
  expect(view.periods).toHaveLength(50);
  expect(view.pocs[0]?.price).toHaveLength(50);
});

test("rowsForPeriod flags outliers and proxy prices, and blanks unlocated", () => {
  const view = nodalMapView(
    withMap(copy(), {
      p05: nums(46, 40),
      p95: nums(46, 90),
      pocs: [
        {
          point_of_connection: "ALB0331",
          latitude: -36.739,
          longitude: 174.69,
          island: "NI",
          price: [200, ...nuls(45)],
          proxy_periods: [],
        },
      ],
    }),
  );
  if (!view) throw new Error("expected a map view");
  const rows = rowsForPeriod(view, 1);
  expect(rows[0]).toMatchObject({
    point_of_connection: "ALB0331",
    location: "On the map",
    island: "North Island",
    price: 200,
    outlier: true,
    proxy: false,
  });
  expect(rows[1]).toMatchObject({
    point_of_connection: "HAY2201",
    location: "",
    island: "North Island",
    price: 50,
    outlier: false,
    proxy: true,
  });
});

test("the SVG is a labelled figure with a titled circle per located POC", () => {
  const view = nodalMapView(withMap(copy()));
  if (!view) throw new Error("expected a map view");
  const svg = renderMapSvg(view, 1, {
    id: "nodal-map-chart",
    title: "Wholesale prices at named places on the New Zealand grid",
    summary: periodSummary(view, 1),
  });
  expect(svg).toContain('role="img"');
  expect(svg).toContain("nodal-map-chart-title");
  expect(svg).toContain('data-poc="ALB0331"');
  expect(svg).not.toContain("HAY2201");
  expect(svg).toContain("<title>ALB0331, 80.00 dollars per megawatt-hour");
});

test("coverageSentence says when places have no coordinates", () => {
  const view = nodalMapView(withMap(copy()));
  if (!view) throw new Error("expected a map view");
  expect(coverageSentence(view)).toContain("1 of 2 named places");
  expect(coverageSentence(view)).toContain("Haywards and Benmore");
  const empty = nodalMapView(
    withMap(copy(), {
      pocs: [],
      unlocated: [
        {
          point_of_connection: "HAY2201",
          island: "NI",
          price: nums(46, 50),
          proxy_periods: [],
        },
      ],
    }),
  );
  if (!empty) throw new Error("expected a map view");
  expect(coverageSentence(empty)).toContain("None of the 1 named places");
});

test("the committed fixture day plots only POCs that have coordinates", () => {
  const view = nodalMapView(fixture);
  if (!view) throw new Error("expected the fixture map");
  expect(view.periods).toHaveLength(46);
  expect(view.pocs.map((poc) => poc.point_of_connection).sort()).toEqual([
    "ABY0111",
    "AKL0331",
    "ALB0331",
  ]);
  expect(view.unlocated.map((poc) => poc.point_of_connection).sort()).toEqual([
    "BEN2201",
    "HAY2201",
    "OTA2201",
  ]);
  expect(view.pocs.every((poc) => poc.price.length === 46)).toBe(true);
});

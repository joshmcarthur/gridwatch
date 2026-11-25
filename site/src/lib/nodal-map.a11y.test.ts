import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const builtMap = fileURLToPath(
  new URL("../../dist/2026/09/27/map/index.html", import.meta.url),
);
const builtLatest = fileURLToPath(
  new URL("../../dist/prices/map/index.html", import.meta.url),
);
const builtDaily = fileURLToPath(
  new URL("../../dist/2026/09/27/index.html", import.meta.url),
);

test.skipIf(!existsSync(builtDaily))(
  "the daily page carries the price map with a labelled SVG, beats and a table",
  () => {
    const html = readFileSync(builtDaily, "utf8");
    expect(html).toContain('id="map"');
    expect(html).toContain('aria-label="Wholesale prices on the map"');
    expect(html).not.toContain("The day on the map");
    expect(html).toContain('role="img"');
    expect(html).toContain(
      'aria-labelledby="nodal-map-chart-title nodal-map-chart-summary"',
    );
    expect(html).toContain('id="nodal-map-table"');
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html).toContain('type="range"');
    expect(html).toContain('aria-valuetext="');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="Moments in the day"');
    expect(html).toContain('id="nodal-play"');
    expect(html).toContain('data-lane="price"');
    expect(html).toContain('data-lane="generation"');
    // 27 September has a stretch of high reserve prices, so the reserve lane shows.
    expect(html).toContain('data-lane="reserve"');
    expect(html).toContain("Through the day");
    expect(html).toContain('role="status"');
    expect(html).toMatch(/Use the left and right arrow keys/);
    expect(html).toContain("ALB0331");
    expect(html).toContain("no coordinates");
    expect(html).toContain("LINZ Data Service");
    expect(html).toContain("data-sort");
    expect(html).not.toMatch(/Trading period \d/);
    expect(html).not.toMatch(/\bNI\b/);
    expect(html).not.toMatch(/\bSI\b/);
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  },
);

test.skipIf(!existsSync(builtMap))(
  "the old map URL sends readers to the day page's map",
  () => {
    const html = readFileSync(builtMap, "utf8");
    expect(html).toContain('content="0; url=/2026/09/27/#map"');
    expect(html).toContain('href="/2026/09/27/#map"');
  },
);

test.skipIf(!existsSync(builtLatest))(
  "prices/map sends readers to the latest complete prices day",
  () => {
    const html = readFileSync(builtLatest, "utf8");
    expect(html).toContain("29 October 2026");
    expect(html).toContain('href="/2026/10/29/#map"');
  },
);

const builtQuiet = fileURLToPath(
  new URL("../../dist/2026/09/26/index.html", import.meta.url),
);

test.skipIf(!existsSync(builtQuiet))(
  "a day without high reserve prices has no reserve lane",
  () => {
    const html = readFileSync(builtQuiet, "utf8");
    expect(html).toContain('data-lane="price"');
    expect(html).not.toContain('data-lane="reserve"');
    expect(html).not.toContain("Through the day");
  },
);

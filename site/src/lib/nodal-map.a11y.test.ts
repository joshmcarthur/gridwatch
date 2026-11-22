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

test.skipIf(!existsSync(builtMap))(
  "built map page has a labelled SVG, a table, and no unlabeled jargon",
  () => {
    const html = readFileSync(builtMap, "utf8");
    expect(html).toContain('lang="en-NZ"');
    expect(html).toContain("<h1");
    expect(html).toContain("<main");
    expect(html).toContain('aria-labelledby="nodal-map"');
    expect(html).toContain('role="img"');
    expect(html).toContain(
      'aria-labelledby="nodal-map-chart-title nodal-map-chart-summary"',
    );
    expect(html).toContain('id="nodal-map-table"');
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html).toContain('type="range"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("ALB0331");
    expect(html).toContain("HAY2201");
    expect(html).toContain("no coordinates");
    expect(html).toContain("LINZ Data Service");
    expect(html).toContain("data-sort");
    expect(html).not.toMatch(/\bEMI\b/);
    expect(html).not.toMatch(/\bEA\b/);
    expect(html).not.toMatch(/\bNI\b/);
    expect(html).not.toMatch(/\bSI\b/);
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  },
);

test.skipIf(!existsSync(builtLatest))(
  "prices/map is the latest complete prices day",
  () => {
    const html = readFileSync(builtLatest, "utf8");
    expect(html).toContain("29 October 2026");
    expect(html).toContain("/2026/10/29/map/");
    expect(html).toContain('id="nodal-map-table"');
  },
);

test.skipIf(!existsSync(builtDaily))(
  "the daily page links to that day's map",
  () => {
    const html = readFileSync(builtDaily, "utf8");
    expect(html).toContain("/2026/09/27/map/");
    expect(html).toMatch(/Map of wholesale prices at each named place/);
  },
);

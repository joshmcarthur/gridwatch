import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const explainerPage = fileURLToPath(
  new URL("../../dist/explainers/nodal-pricing/index.html", import.meta.url),
);
const listingPage = fileURLToPath(
  new URL("../../dist/explainers/index.html", import.meta.url),
);

test.skipIf(!existsSync(listingPage))(
  "built explainer listing links the nodal-pricing page",
  () => {
    const html = readFileSync(listingPage, "utf8");
    expect(html).toContain('lang="en-NZ"');
    expect(html).toContain("<h1");
    expect(html).toContain("<main");
    expect(html).toContain('href="/explainers/nodal-pricing/"');
    expect(html).toContain('href="/explainers/"');
    expect(html).toMatch(/Monday, 27 July 2026/);
    expect(html).not.toMatch(/\bobservatory\b/i);
    expect(html).not.toMatch(/\bEMI\b/);
  },
);

test.skipIf(!existsSync(explainerPage))(
  "built nodal-pricing explainer has five sections and the daily-page link",
  () => {
    const html = readFileSync(explainerPage, "utf8");
    expect(html).toContain('lang="en-NZ"');
    expect(html).toContain("<h1");
    expect(html).toContain("<main");
    expect(html).toContain('aria-labelledby="simple-explanation"');
    expect(html).toContain('aria-labelledby="a-more-technical-explanation"');
    expect(html).toContain('aria-labelledby="visual"');
    expect(html).toContain('aria-labelledby="historical-example"');
    expect(html).toContain(
      'aria-labelledby="links-to-gridwatch-data-and-events"',
    );
    expect(html).toContain("$3,296.04");
    expect(html).toContain("$2,853.43");
    expect(html).toContain("$571.46");
    expect(html).toContain('href="/2026/07/27/"');
    expect(html).toContain('href="/explainers/"');
    expect(html).toMatch(/household bill/);
    expect(html).toMatch(/megawatt-hour/);
    expect(html).not.toMatch(/\bobservatory\b/i);
    expect(html).not.toMatch(/\bEMI\b/);
    expect(html).not.toMatch(/\bEA\b/);
    expect(html).not.toMatch(/\bNI\b/);
    expect(html).not.toMatch(/\bSI\b/);
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  },
);

test.skipIf(!existsSync(explainerPage))(
  "built nodal-pricing visual reuses PriceChart for 27 July",
  () => {
    const html = readFileSync(explainerPage, "utf8");
    expect(html).toContain('id="price-chart-title"');
    expect(html).toContain(
      'aria-labelledby="price-chart-title price-chart-summary"',
    );
    expect(html).toContain(
      'aria-labelledby="price-spread-chart-title price-spread-chart-summary"',
    );
    expect(html).toContain("OTA2201");
    expect(html).not.toMatch(/when that day is published here/);
  },
);

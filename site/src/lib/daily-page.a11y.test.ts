import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const builtPage = fileURLToPath(
  new URL("../../dist/2026/09/27/index.html", import.meta.url),
);

test.skipIf(!existsSync(builtPage))(
  "built daily page has landmarks and no unlabeled jargon",
  () => {
    const html = readFileSync(builtPage, "utf8");
    expect(html).toContain('lang="en-NZ"');
    expect(html).toContain("<h1");
    expect(html).toContain("<main");
    expect(html).toContain('aria-label="Other days"');
    expect(html).toContain('aria-labelledby="completeness-heading"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toMatch(/\bEMI\b/);
    expect(html).not.toMatch(/\bEA\b/);
    expect(html).not.toMatch(/\bNI\b/);
    expect(html).not.toMatch(/\bSI\b/);
    expect(html).toMatch(/wholesale prices/i);
    expect(html).toMatch(/household bill/);
    expect(html).toMatch(/megawatt-hours/);
    expect(html).toMatch(/kilowatt-hours/);
    expect(html).toContain('aria-labelledby="generation-mix"');
    expect(html).toMatch(/<figure[\s>]/);
    expect(html).toContain('role="img"');
    expect(html).toContain(
      'aria-labelledby="generation-mix-chart-title generation-mix-chart-summary"',
    );
    expect(html).toContain("<figcaption");
    expect(html).toMatch(/<table[\s>]/);
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html).toMatch(/Average megawatts \(MW\)/);
    expect(html).toMatch(/Electricity Authority generation data/);
    expect(html).toContain("Show the numbers as a table");
  },
);

test.skipIf(!existsSync(builtPage))(
  "built daily page labels both price charts and keeps ids unique",
  () => {
    const html = readFileSync(builtPage, "utf8");
    expect(html).toContain('aria-labelledby="wholesale-prices"');
    expect(html).toMatch(
      /<h2 id="wholesale-prices"[^>]*>What it sold for<\/h2>/,
    );
    expect(html).toContain(
      'aria-labelledby="price-chart-title price-chart-summary"',
    );
    expect(html).toContain(
      'aria-labelledby="price-spread-chart-title price-spread-chart-summary"',
    );
    expect(html).toContain("$/MWh");
    expect(html).toContain("OTA2201");
    expect(html).toContain("HAY2201");
    expect(html).toContain("BEN2201");
    expect(html).toContain("Electricity Authority dispatch energy prices");
    expect(html.match(/role="img"/g)?.length).toBe(3);
    expect(html).toContain('aria-labelledby="energy-flow"');
    expect(html).toMatch(/not published yet/i);
    expect(html).toMatch(/does not guess/i);
    expect(html).not.toMatch(/not drawn yet/i);
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  },
);

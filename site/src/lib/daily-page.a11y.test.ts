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

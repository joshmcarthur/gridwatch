import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const builtPage = fileURLToPath(
  new URL("../../dist/index.html", import.meta.url),
);

test.skipIf(!existsSync(builtPage))(
  "built homepage leads with the latest day, four condition cards, and no banned copy",
  () => {
    const html = readFileSync(builtPage, "utf8");
    expect(html).toContain('lang="en-NZ"');
    expect(html).toContain("<main");
    expect(html).toContain("<h1");
    expect(html).toContain('aria-labelledby="latest-heading"');
    expect(html).toContain('aria-labelledby="conditions-heading"');
    expect(html).toContain('aria-labelledby="recent-days-heading"');
    expect(html).toContain('aria-labelledby="recent-episodes-heading"');
    expect(html).toContain('id="prices-heading"');
    expect(html).toContain('id="supply-heading"');
    expect(html).toContain('id="reserves-heading"');
    expect(html).toContain('id="regional-heading"');
    expect(html).toContain('aria-labelledby="prices-heading"');
    expect(html).toContain('aria-labelledby="supply-heading"');
    expect(html).toContain('aria-labelledby="reserves-heading"');
    expect(html).toContain('aria-labelledby="regional-heading"');
    expect(html).toMatch(/Latest market update/);
    expect(html).toMatch(/Market conditions/);
    expect(html).toMatch(/no single market score/);
    expect(html).toMatch(/wholesale prices/i);
    expect(html).toMatch(/household bill/);
    expect(html).toContain('role="img"');
    expect(html).toContain("latest-price-spark-title");
    expect(html).not.toMatch(/observatory/i);
    expect(html).not.toMatch(/placeholder homepage/i);
    expect(html).not.toMatch(/\bEMI\b/);
    expect(html).not.toMatch(/\bEA\b/);
    expect(html).not.toMatch(/\bNI\b/);
    expect(html).not.toMatch(/\bSI\b/);
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  },
);

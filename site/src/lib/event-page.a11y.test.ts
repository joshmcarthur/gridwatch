import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const builtPage = fileURLToPath(
  new URL(
    "../../dist/2026/07/27/events/394f75a3bfa948a3/index.html",
    import.meta.url,
  ),
);

test.skipIf(!existsSync(builtPage))(
  "built event page shows the narrative, confidence, and claim links",
  () => {
    const html = readFileSync(builtPage, "utf8");
    expect(html).toContain('lang="en-NZ"');
    expect(html).toContain("<main");
    expect(html).toContain("<h1");
    expect(html).toMatch(/Unreviewed/);
    expect(html).toContain('id="what-happened"');
    expect(html).toContain('id="why"');
    expect(html).toContain('id="what-it-means"');
    expect(html).toContain('id="confidence-heading"');
    expect(html).toContain("Confirmed");
    expect(html).toContain("Strong evidence");
    expect(html).toContain("Possible explanation");
    expect(html).toContain('id="claim-price.OTA2201.p36"');
    expect(html).toContain('href="#claim-price.OTA2201.p36"');
    expect(html).toContain("$3,296.04");
    expect(html).toContain('href="/2026/07/27/"');
    expect(html).toMatch(/How sure is this\?/);
    expect(html).toContain('id="event-price-chart-title"');
    expect(html).not.toMatch(/\bEMI\b/);
    expect(html).not.toMatch(/\bEA\b/);
    expect(html).not.toMatch(/\bNI\b/);
    expect(html).not.toMatch(/\bSI\b/);
    expect(html).not.toMatch(/\bFIR\b/);
    expect(html).not.toMatch(/\bSIR\b/);
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  },
);

const dailyPage = fileURLToPath(
  new URL("../../dist/2026/07/27/index.html", import.meta.url),
);

test.skipIf(!existsSync(dailyPage))(
  "built 27 July daily page lists the event",
  () => {
    const html = readFileSync(dailyPage, "utf8");
    expect(html).toContain('id="day-events"');
    expect(html).toContain('href="/2026/07/27/events/394f75a3bfa948a3/"');
  },
);

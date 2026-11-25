import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const builtPage = fileURLToPath(
  new URL("../../dist/index.html", import.meta.url),
);

test.skipIf(!existsSync(builtPage))(
  "built homepage has the accepted layout and no banned copy",
  () => {
    const html = readFileSync(builtPage, "utf8");
    expect(html).toContain('lang="en-NZ"');
    expect(html).toContain("<main");
    expect(html).toContain('aria-labelledby="latest-heading"');
    expect(html).toContain('aria-labelledby="conditions-heading"');
    expect(html).toContain('aria-labelledby="recent-days-heading"');
    // The latest day's story leads, with a still map at its main moment.
    expect(html).toMatch(/<h2 id="latest-heading"[^>]*>[^<]+<\/h2>/);
    // The latest day's write-up by AI leads, in place of the list of moments (ADR-0031).
    expect(html).not.toContain('aria-label="Moments in the day"');
    expect(html).toContain(
      "Benmore was cheaper than Ōtāhuhu all day, and hydro made most",
    );
    expect(html).toMatch(/>See the whole day<\/a>/);
    expect(html).toContain('id="home-map"');
    expect(html.indexOf('id="latest-heading"')).toBeLessThan(
      html.indexOf('id="about-heading"'),
    );
    expect(html).not.toMatch(/Incomplete\./);
    expect(html).toMatch(
      /<h2 id="conditions-heading"[^>]*>Market conditions<\/h2>/,
    );
    expect(html).toMatch(/<h2 id="recent-days-heading"[^>]*>Recent days<\/h2>/);
    expect(html).toContain("Wholesale prices");
    expect(html).not.toMatch(/<h3[^>]*>Supply<\/h3>/);
    expect(html).toContain(
      "At Ōtāhuhu, Haywards and Benmore, wholesale prices averaged",
    );
    expect(html).toContain("Reserves");
    expect(html).toContain("Regional price differences");
    expect(html).toContain("Gas and coal");
    expect(html).toMatch(/Sun, 27 Sept/);
    expect(html).toContain('href="/2026/09/27/"');
    expect(html).not.toMatch(/observatory/i);
    expect(html).toMatch(
      /<ol class="days-inline[^"]*" aria-label="Days this week"/,
    );
    expect(html).toMatch(/<h3[^>]*>This week<\/h3>/);
    expect(html).toContain(
      "Benmore stayed cheaper than Ōtāhuhu all week, and hydro made most",
    );
    expect(html).toContain(
      "The days from 23 to 29 October: each day&#39;s headline",
    );
    expect(html).toContain(
      "Some files for 25 October are incomplete, and the model was told so.",
    );
    expect((html.match(/Written by AI<\/p>/g) ?? []).length).toBe(2);
    expect(html).not.toMatch(/trading day|grouped readings|dataset/i);
    expect(html).not.toMatch(/placeholder homepage/i);
    expect(html).not.toMatch(/green\/amber\/red/);
    expect(html).not.toMatch(/composite score/);
    expect(html).not.toMatch(/\bEMI\b/);
    expect(html).not.toMatch(/\bEA\b/);
    expect(html).not.toMatch(/\bNI\b/);
    expect(html).not.toMatch(/\bSI\b/);
    expect(html).not.toMatch(/\bFIR\b/);
    expect(html).not.toMatch(/\bSIR\b/);
    expect(html).toMatch(/household bill/);
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(html).toMatch(/spare generating capacity/);
    expect(html).not.toMatch(/backup generation/);
    expect(html).toMatch(/Recently detected/);
    expect(html).toMatch(
      /<h2 id="recent-events-heading"[^>]*>Recent events<\/h2>/,
    );
    expect(html).toContain("/2026/07/27/#event-394f75a3bfa948a3");
    expect(html).not.toMatch(/overlapped|grid load|regional price gap/i);
  },
);

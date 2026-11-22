import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const EPISODE_ID = "394f75a3bfa948a3";
const eventPage = fileURLToPath(
  new URL(
    `../../dist/2026/07/27/events/${EPISODE_ID}/index.html`,
    import.meta.url,
  ),
);
const dailyPage = fileURLToPath(
  new URL("../../dist/2026/07/27/index.html", import.meta.url),
);

test.skipIf(!existsSync(eventPage))(
  "built #21 event page lists claims, confidence, and window charts",
  () => {
    const html = readFileSync(eventPage, "utf8");
    expect(html).toContain('lang="en-NZ"');
    expect(html).toContain("<main");
    expect(html).toContain("Unreviewed");
    expect(html).toContain("Confirmed");
    expect(html).toContain("Strong evidence");
    expect(html).toContain("Possible explanation");
    expect(html).toContain('id="claim-price-OTA2201-p36"');
    expect(html).toContain("$3,296.04");
    expect(html).toContain("Haywards");
    expect(html).toContain("Benmore");
    expect(html).toContain("Ōtāhuhu");
    expect(html).toContain('role="img"');
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html).toContain('href="/2026/07/27/"');
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

test.skipIf(!existsSync(dailyPage))(
  "built 27 July daily page lists the event above What stood out",
  () => {
    const html = readFileSync(dailyPage, "utf8");
    expect(html).toContain('id="events-on-this-day"');
    expect(html).toContain("Events on this day");
    expect(html).toContain("Unreviewed");
    expect(html).toContain(`href="/2026/07/27/events/${EPISODE_ID}/"`);
    expect(html.indexOf('id="events-on-this-day"')).toBeLessThan(
      html.indexOf('id="detected-episodes"'),
    );
  },
);

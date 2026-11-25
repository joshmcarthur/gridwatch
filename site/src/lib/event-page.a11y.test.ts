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
  "the old event URL sends readers to the write-up on the day page",
  () => {
    const html = readFileSync(builtPage, "utf8");
    expect(html).toContain(
      'content="0; url=/2026/07/27/#event-394f75a3bfa948a3"',
    );
    expect(html).toContain('href="/2026/07/27/#event-394f75a3bfa948a3"');
  },
);

const dailyPage = fileURLToPath(
  new URL("../../dist/2026/07/27/index.html", import.meta.url),
);

test.skipIf(!existsSync(dailyPage))(
  "the 27 July daily page carries the write-up, confidence, and claim links",
  () => {
    const html = readFileSync(dailyPage, "utf8");
    const scope = "394f75a3bfa948a3";
    // The event write-up sits in a closed disclosure; the day write-up links to it.
    expect(html).not.toContain('id="day-events"');
    expect(html).toMatch(/<details class="slot event-more"/);
    expect(html).toContain("What happened in the evening");
    expect(html).toMatch(
      new RegExp(
        `<a href="#event-${scope}"[^>]*>Read the full write-up of the evening</a>`,
      ),
    );
    expect(html).toContain(`id="event-${scope}"`);
    expect(html).toMatch(/Written by AI ·/);
    expect(html).not.toMatch(/Unreviewed/);
    expect(html).toContain("What this was written from");
    expect(html).toContain('href="/how/#ai"');
    expect(html).toContain(`id="event-${scope}-what"`);
    expect(html).toContain(`id="event-${scope}-why"`);
    expect(html).toContain(`id="event-${scope}-means"`);
    expect(html).toContain("Confirmed");
    expect(html).toContain("Strong evidence");
    expect(html).toContain("Possible explanation");
    expect(html).toContain(`id="claim-${scope}-price.OTA2201.p36"`);
    expect(html).toContain(`href="#claim-${scope}-price.OTA2201.p36"`);
    expect(html).toContain("$3,296.04");
    expect(html).toContain(`id="event-${scope}-price-chart-title"`);
    // The beat for this stretch links to the write-up.
    expect(html).toContain(`href="#event-${scope}"`);
    expect(html).not.toMatch(/\bFIR\b/);
    expect(html).not.toMatch(/\bSIR\b/);
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  },
);

test.skipIf(!existsSync(dailyPage))(
  "the 27 July day write-up replaces the lede, labelled with what it was written from",
  () => {
    const html = readFileSync(dailyPage, "utf8");
    expect(html).toMatch(/<p class="label"[^>]*>Written by AI<\/p>/);
    expect(html).toContain(
      "Ōtāhuhu spiked twice, reaching 330c per kWh at 5:30pm",
    );
    expect(html).not.toContain("Hydro made 69% of the day");
    expect(html).toContain("What this was written from");
    expect(html).toContain(
      "The day&#39;s moments: Morning price peak (7:30am to 8:00am)",
    );
    expect(html).toContain("A program checked every number");
  },
);

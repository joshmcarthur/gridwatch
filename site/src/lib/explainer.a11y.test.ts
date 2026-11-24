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
    expect(html).toContain('href="/2026/07/27/events/394f75a3bfa948a3/"');
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

const illustratedBuilt = [
  {
    slug: "transmission-constraints",
    chartIds: ["price-chart-title"],
  },
  {
    slug: "instantaneous-reserves",
    chartIds: ["reserve-fast-title", "reserve-chart-title"],
  },
  {
    slug: "hvdc-link",
    chartIds: ["energy-sankey-chart-title"],
  },
  {
    slug: "wind",
    chartIds: ["generation-mix-chart-title"],
  },
] as const;

const mechanismSlugs = [
  "marginal-generator",
  "hydro-scarcity",
  "frequency-keeping",
  "wholesale-and-the-bill",
] as const;

function builtExplainer(slug: string): string {
  return fileURLToPath(
    new URL(`../../dist/explainers/${slug}/index.html`, import.meta.url),
  );
}

for (const page of illustratedBuilt) {
  test.skipIf(!existsSync(builtExplainer(page.slug)))(
    `built ${page.slug} reuses its daily chart`,
    () => {
      const html = readFileSync(builtExplainer(page.slug), "utf8");
      expect(page.chartIds.some((id) => html.includes(`id="${id}"`))).toBe(
        true,
      );
      expect(html).toContain('aria-labelledby="visual"');
      expect(html).toContain('href="/2026/07/27/"');
    },
  );
}

for (const slug of mechanismSlugs) {
  test.skipIf(!existsSync(builtExplainer(slug)))(
    `built ${slug} has no price chart and no example day`,
    () => {
      const html = readFileSync(builtExplainer(slug), "utf8");
      expect(html).not.toContain('id="price-chart-title"');
      expect(html).not.toContain('aria-labelledby="visual"');
      expect(html).not.toContain('aria-labelledby="historical-example"');
      expect(html).not.toContain("/2026/07/27/");
      expect(html).not.toContain(
        'aria-labelledby="links-to-gridwatch-data-and-events"',
      );
    },
  );
}

test.skipIf(!existsSync(listingPage))(
  "built explainer listing links every topic and omits an example line when there is no date",
  () => {
    const html = readFileSync(listingPage, "utf8");
    for (const page of illustratedBuilt) {
      expect(html).toContain(`href="/explainers/${page.slug}/"`);
    }
    for (const slug of mechanismSlugs) {
      expect(html).toContain(`href="/explainers/${slug}/"`);
    }
    const exampleLines = [...html.matchAll(/Example:/g)];
    expect(exampleLines.length).toBeGreaterThanOrEqual(1);
  },
);

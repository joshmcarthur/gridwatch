import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { EXPLAINER_HEADINGS, splitExplainerHtml } from "./explainer.ts";

const nodalPricing = readFileSync(
  fileURLToPath(
    new URL("../content/explainers/nodal-pricing.md", import.meta.url),
  ),
  "utf8",
);

const nodalBody = nodalPricing.replace(/^---[\s\S]*?---\s*/, "");

const headings = EXPLAINER_HEADINGS.map((text) => ({
  depth: 2,
  slug: text.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-"),
  text,
}));
const html = EXPLAINER_HEADINGS.map(
  (text, index) => `<h2 id="s${index}">${text}</h2>\n<p>Body ${index}.</p>\n`,
).join("");

test("splitExplainerHtml returns the five brief sections in order", () => {
  const sections = splitExplainerHtml(html, headings);
  expect(sections.map((section) => section.heading)).toEqual([
    ...EXPLAINER_HEADINGS,
  ]);
  expect(sections[2]?.html).toContain("Body 2.");
  expect(sections[2]?.html).not.toContain("Body 3.");
  expect(sections[0]?.id).toBe("simple-explanation");
});

test("splitExplainerHtml throws when a required heading is missing", () => {
  expect(() => splitExplainerHtml(html, headings.slice(0, 1))).toThrow(
    /required headings/,
  );
});

function htmlFor(names: readonly string[]): {
  html: string;
  headings: { depth: number; slug: string; text: string }[];
} {
  return {
    html: names
      .map(
        (text, index) =>
          `<h2 id="s${index}">${text}</h2>\n<p>Body ${index}.</p>\n`,
      )
      .join(""),
    headings: names.map((text) => ({
      depth: 2,
      slug: text.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-"),
      text,
    })),
  };
}

test("splitExplainerHtml allows omitting Visual, Historical example, and Links", () => {
  const { html: mechanismHtml, headings: mechanismHeadings } = htmlFor([
    "Simple explanation",
    "A more technical explanation",
  ]);
  const sections = splitExplainerHtml(mechanismHtml, mechanismHeadings);
  expect(sections.map((section) => section.heading)).toEqual([
    "Simple explanation",
    "A more technical explanation",
  ]);
});

test("splitExplainerHtml allows Visual without Historical example", () => {
  const { html: visualHtml, headings: visualHeadings } = htmlFor([
    "Simple explanation",
    "A more technical explanation",
    "Visual",
    "Links to Gridwatch data and events",
  ]);
  const sections = splitExplainerHtml(visualHtml, visualHeadings);
  expect(sections.map((section) => section.heading)).toEqual([
    "Simple explanation",
    "A more technical explanation",
    "Visual",
    "Links to Gridwatch data and events",
  ]);
});

test("splitExplainerHtml allows Historical example without Visual", () => {
  const { html: exampleHtml, headings: exampleHeadings } = htmlFor([
    "Simple explanation",
    "A more technical explanation",
    "Historical example",
    "Links to Gridwatch data and events",
  ]);
  const sections = splitExplainerHtml(exampleHtml, exampleHeadings);
  expect(sections.map((section) => section.heading)).toEqual([
    "Simple explanation",
    "A more technical explanation",
    "Historical example",
    "Links to Gridwatch data and events",
  ]);
});

test("splitExplainerHtml throws when optional headings are out of order", () => {
  const { html: swapped, headings: swappedHeadings } = htmlFor([
    "Simple explanation",
    "A more technical explanation",
    "Historical example",
    "Visual",
    "Links to Gridwatch data and events",
  ]);
  expect(() => splitExplainerHtml(swapped, swappedHeadings)).toThrow(
    /must appear in this order/,
  );
});

test("nodal pricing quotes 5:30pm from the reconstruction and links the daily page", () => {
  expect(nodalPricing).toMatch(/chart: price/);
  expect(nodalPricing).toMatch(/example_date: "2026-07-27"/);
  expect(nodalBody).toContain("$3,296.04");
  expect(nodalBody).toContain("$2,853.43");
  expect(nodalBody).toContain("$571.46");
  expect(nodalBody).toContain("$2,281.97");
  expect(nodalBody).toContain("$442.61");
  expect(nodalBody).toContain("$2,724.58");
  expect(nodalBody).toContain("/2026/07/27/");
  expect(nodalBody).toContain("5:30pm to 6:00pm");
});

test("nodal pricing copy follows site-copy.md", () => {
  expect(nodalBody).not.toMatch(/\bobservatory\b/i);
  expect(nodalBody).not.toMatch(/\bwe\b/i);
  expect(nodalBody).not.toMatch(/(?:^|[.!?]\s+)I\s/);
  expect(nodalBody).not.toMatch(/\bEMI\b/);
  expect(nodalBody).not.toMatch(/\bEA\b/);
  expect(nodalBody).not.toMatch(/\bNI\b/);
  expect(nodalBody).not.toMatch(/\bSI\b/);
  expect(nodalBody).not.toMatch(/Huntly/);
  expect(nodalBody).not.toMatch(/\$21,000/);
  expect(nodalBody).not.toMatch(/\bthis site\b/i);
  expect(nodalBody).not.toMatch(/\bdear(?:er|est)?\b/i);
  expect(nodalBody).not.toMatch(/trading period/i);
  expect(nodalBody).not.toMatch(/\b[A-Z]{3}\d{4}\b/);
  expect(nodalBody).not.toMatch(/\b\d{2}:\d{2}\b/);
  expect(nodalBody).toMatch(/wholesale price/);
  expect(nodalBody).toMatch(/household bill/);
  expect(nodalBody).toMatch(/point of connection/);
  expect(nodalBody).toMatch(/high-voltage direct current \(HVDC\)/);
  expect(nodalBody).toMatch(/megawatt-hour/);
});

function readExplainer(slug: string): { raw: string; body: string } {
  const raw = readFileSync(
    fileURLToPath(new URL(`../content/explainers/${slug}.md`, import.meta.url)),
    "utf8",
  );
  return { raw, body: raw.replace(/^---[\s\S]*?---\s*/, "") };
}

function expectBannedTokens(body: string) {
  expect(body).not.toMatch(/\bobservatory\b/i);
  expect(body).not.toMatch(/\bwe\b/i);
  expect(body).not.toMatch(/(?:^|[.!?]\s+)I\s/);
  expect(body).not.toMatch(/\bEMI\b/);
  expect(body).not.toMatch(/\bEA\b/);
  expect(body).not.toMatch(/\bNI\b/);
  expect(body).not.toMatch(/\bSI\b/);
  expect(body).not.toMatch(/\$21,000/);
  expect(body).not.toMatch(/1,170/);
  expect(body).not.toMatch(/83%/);
  expect(body).not.toMatch(/\bthis site\b/i);
  expect(body).not.toMatch(/\bdear(?:er|est)?\b/i);
  expect(body).not.toMatch(/trading period/i);
  expect(body).not.toMatch(/\b\d{2}:\d{2}\b/);
}

const illustrated = [
  {
    slug: "transmission-constraints",
    chart: "price",
    figures: ["$2,281.97", "$442.61"],
  },
  {
    slug: "instantaneous-reserves",
    chart: "reserve",
    figures: ["$2,154.45", "$49.93"],
  },
  {
    slug: "hvdc-link",
    chart: "sankey",
    figures: ["21,493.034", "895.5", "1,098.0", "966.4"],
  },
  {
    slug: "wind",
    chart: "generation",
    figures: ["186.5", "91.1", "289.3", "150.0", "69.3"],
  },
] as const;

const mechanism = [
  "marginal-generator",
  "hydro-scarcity",
  "frequency-keeping",
  "wholesale-and-the-bill",
] as const;

const illustratedDiagrams = {
  "transmission-constraints": "When a line is full, prices come apart",
  "instantaneous-reserves": "What instantaneous reserve is for",
  "hvdc-link": "How the Cook Strait link carries power",
  wind: "When the wind drops, other stations run",
} as const;

for (const page of illustrated) {
  test(`${page.slug} uses the 27 July chart and gold figures`, () => {
    const { raw, body } = readExplainer(page.slug);
    expect(raw).toMatch(new RegExp(`chart: ${page.chart}`));
    expect(raw).toMatch(/example_date: "2026-07-27"/);
    expect(body).toContain("## Visual");
    expect(body).toContain('<figure class="diagram">');
    expect(body).toContain(illustratedDiagrams[page.slug]);
    expect(body).toContain("## Historical example");
    expect(body).toContain("## Links to Gridwatch data and events");
    expect(body).not.toMatch(/The daily page for \[Monday 27 July 2026\]/);
    expect(body).toContain("/2026/07/27/");
    expect(body).toContain("/2026/07/27/#event-394f75a3bfa948a3");
    for (const figure of page.figures) {
      expect(body).toContain(figure);
    }
    expectBannedTokens(body);
  });
}

for (const slug of mechanism) {
  test(`${slug} explains the mechanism without inventing a day`, () => {
    const { raw, body } = readExplainer(slug);
    expect(raw).not.toMatch(/chart:/);
    expect(raw).not.toMatch(/example_date:/);
    expect(body).not.toContain("## Visual");
    expect(body).not.toContain("## Historical example");
    expect(body).not.toContain("## Links to Gridwatch data and events");
    expect(body).not.toContain("2026-07-27");
    expect(body).not.toContain("/2026/07/27/");
    expectBannedTokens(body);
  });
}

test("frequency keeping points at reserves, not a stand-in price", () => {
  const { body } = readExplainer("frequency-keeping");
  expect(body).toContain("/explainers/instantaneous-reserves/");
});

test("wholesale and the bill points at About", () => {
  const { body } = readExplainer("wholesale-and-the-bill");
  expect(body).toContain("/about/#wholesale");
});

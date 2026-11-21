import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  EXPLAINER_HEADINGS,
  explainerHeadingId,
  renderExplainerMarkdown,
  splitExplainerBody,
} from "./explainer.ts";

const nodalPricing = readFileSync(
  fileURLToPath(
    new URL("../content/explainers/nodal-pricing.md", import.meta.url),
  ),
  "utf8",
);

const nodalBody = nodalPricing.replace(/^---[\s\S]*?---\s*/, "");

test("explainerHeadingId slugifies the five brief headings", () => {
  expect(EXPLAINER_HEADINGS.map(explainerHeadingId)).toEqual([
    "simple-explanation",
    "a-more-technical-explanation",
    "visual",
    "historical-example",
    "links-to-gridwatch-data-and-events",
  ]);
});

test("splitExplainerBody requires the five headings in order", () => {
  const sections = splitExplainerBody(nodalBody);
  expect(sections.map((section) => section.heading)).toEqual([
    ...EXPLAINER_HEADINGS,
  ]);
  expect(sections[2]?.markdown).toMatch(/Haywards–Benmore spread/);
});

test("splitExplainerBody throws when a heading is missing", () => {
  expect(() => splitExplainerBody("## Simple explanation\n\nHello.\n")).toThrow(
    /must be exactly/,
  );
});

test("renderExplainerMarkdown turns paragraphs, lists, links and code into HTML", () => {
  const html = renderExplainerMarkdown(
    "A node is a place.\n\n- `OTA2201`, Ōtāhuhu\n- [Monday 27 July 2026](/2026/07/27/)\n\nSee **prices**.",
  );
  expect(html).toContain("<p>A node is a place.</p>");
  expect(html).toContain("<ul>");
  expect(html).toContain("<code>OTA2201</code>");
  expect(html).toContain('<a href="/2026/07/27/">Monday 27 July 2026</a>');
  expect(html).toContain("<strong>prices</strong>");
  expect(html).toContain("Ōtāhuhu");
});

test("renderExplainerMarkdown escapes HTML and drops javascript hrefs", () => {
  const html = renderExplainerMarkdown(
    'Use <b>bold</b> & "quotes".\n\n[x](javascript:alert(1))',
  );
  expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
  expect(html).toContain("&amp;");
  expect(html).toContain("&quot;quotes&quot;");
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain("[x](javascript:alert(1))");
  expect(html).not.toContain("<b>");
});

test("nodal pricing quotes period 36 from the reconstruction and links the daily page", () => {
  expect(nodalPricing).toMatch(/example_date: "2026-07-27"/);
  expect(nodalBody).toContain("$3,296.04");
  expect(nodalBody).toContain("$2,853.43");
  expect(nodalBody).toContain("$571.46");
  expect(nodalBody).toContain("$2,281.97");
  expect(nodalBody).toContain("$442.61");
  expect(nodalBody).toContain("$2,724.58");
  expect(nodalBody).toContain("/2026/07/27/");
  expect(nodalBody).toMatch(/trading period 36/);
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
  expect(nodalBody).toMatch(/wholesale price/);
  expect(nodalBody).toMatch(/household bill/);
  expect(nodalBody).toMatch(/point of connection/);
  expect(nodalBody).toMatch(/high-voltage direct current \(HVDC\)/);
  expect(nodalBody).toMatch(/megawatt-hour/);
});

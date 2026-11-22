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

test("splitExplainerHtml throws when a heading is missing", () => {
  expect(() => splitExplainerHtml(html, headings.slice(0, 1))).toThrow(
    /must be exactly/,
  );
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

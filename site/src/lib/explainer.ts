/** Brief §10 section headings, in order. Every explainer Markdown file uses these `h2`s. */
export const EXPLAINER_HEADINGS = [
  "Simple explanation",
  "A more technical explanation",
  "Visual",
  "Historical example",
  "Links to Gridwatch data and events",
] as const;

export type ExplainerHeading = (typeof EXPLAINER_HEADINGS)[number];

export const VISUAL_HEADING: ExplainerHeading = "Visual";

export interface ExplainerSection {
  heading: ExplainerHeading;
  id: string;
  html: string;
}

interface RenderedHeading {
  depth: number;
  slug: string;
  text: string;
}

/**
 * Split Astro's rendered explainer HTML into the five brief §10 sections. Throws if
 * the `h2`s are missing, extra, or out of order, so a bad file fails the build.
 */
export function splitExplainerHtml(
  html: string,
  headings: readonly RenderedHeading[],
): ExplainerSection[] {
  const h2s = headings.filter((heading) => heading.depth === 2);
  const got = h2s.map((heading) => heading.text);
  if (
    got.length !== EXPLAINER_HEADINGS.length ||
    got.some((text, index) => text !== EXPLAINER_HEADINGS[index])
  ) {
    throw new Error(
      `Explainer sections must be exactly: ${EXPLAINER_HEADINGS.join(", ")}. Got: ${got.join(", ") || "(none)"}`,
    );
  }
  const chunks = html.split(/(?=<h2[ >])/).filter((chunk) => chunk.trim());
  return EXPLAINER_HEADINGS.map((heading, index) => ({
    heading,
    id: h2s[index]?.slug ?? "",
    html: chunks[index] ?? "",
  }));
}

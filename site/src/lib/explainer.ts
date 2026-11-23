/** Brief §10 section headings, in order. Optional headings may be omitted. */
export const EXPLAINER_HEADINGS = [
  "Simple explanation",
  "A more technical explanation",
  "Visual",
  "Historical example",
  "Links to Gridwatch data and events",
] as const;

export type ExplainerHeading = (typeof EXPLAINER_HEADINGS)[number];

export const REQUIRED_EXPLAINER_HEADINGS = [
  "Simple explanation",
  "A more technical explanation",
  "Links to Gridwatch data and events",
] as const;

export const VISUAL_HEADING: ExplainerHeading = "Visual";

export const EXPLAINER_CHARTS = [
  "price",
  "reserve",
  "generation",
  "sankey",
] as const;

export type ExplainerChart = (typeof EXPLAINER_CHARTS)[number];

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

const HEADING_SET = new Set<string>(EXPLAINER_HEADINGS);

function isExplainerHeading(text: string): text is ExplainerHeading {
  return HEADING_SET.has(text);
}

function headingsInAllowedOrder(got: readonly string[]): boolean {
  let index = 0;
  for (const heading of EXPLAINER_HEADINGS) {
    if (got[index] === heading) index += 1;
  }
  return index === got.length;
}

/**
 * Split Astro's rendered explainer HTML into brief §10 sections. Visual and
 * Historical example may be absent. Throws if required headings are missing,
 * extra, or out of order, so a bad file fails the build.
 */
export function splitExplainerHtml(
  html: string,
  headings: readonly RenderedHeading[],
): ExplainerSection[] {
  const h2s = headings.filter((heading) => heading.depth === 2);
  const got = h2s.map((heading) => heading.text);
  const missingRequired = REQUIRED_EXPLAINER_HEADINGS.filter(
    (heading) => !got.includes(heading),
  );
  if (missingRequired.length > 0) {
    throw new Error(
      `Explainer required headings missing: ${missingRequired.join(", ")}. Got: ${got.join(", ") || "(none)"}`,
    );
  }
  if (
    got.some((text) => !isExplainerHeading(text)) ||
    !headingsInAllowedOrder(got)
  ) {
    throw new Error(
      `Explainer headings must appear in this order: ${EXPLAINER_HEADINGS.join(", ")}. Got: ${got.join(", ") || "(none)"}`,
    );
  }
  const chunks = html.split(/(?=<h2[ >])/).filter((chunk) => chunk.trim());
  return got.map((text, index) => ({
    heading: text as ExplainerHeading,
    id: h2s[index]?.slug ?? "",
    html: chunks[index] ?? "",
  }));
}

export function explainerChartFallbackLead(kind: ExplainerChart): string {
  switch (kind) {
    case "price":
      return "The same price and spread charts sit on";
    case "reserve":
      return "The same reserve chart sits on";
    case "generation":
      return "The same generation mix chart sits on";
    case "sankey":
      return "The same energy-balance chart sits on";
    default: {
      const _never: never = kind;
      throw new Error(`Unknown explainer chart: ${_never}`);
    }
  }
}

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
  markdown: string;
}

export function explainerHeadingId(heading: string): string {
  return heading
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

/**
 * Split an explainer body into the five brief §10 sections. Throws if the headings
 * are missing, extra, or out of order, so a bad file fails the build.
 */
export function splitExplainerBody(body: string): ExplainerSection[] {
  const lines = body.replaceAll("\r\n", "\n").trim().split("\n");
  const raw: Array<{ heading: string; lines: string[] }> = [];
  let current: { heading: string; lines: string[] } | null = null;

  for (const line of lines) {
    const match = /^## (.+)$/.exec(line);
    if (match?.[1] !== undefined) {
      if (current) raw.push(current);
      current = { heading: match[1].trim(), lines: [] };
      continue;
    }
    if (!current) {
      if (line.trim() === "") continue;
      throw new Error(
        `Explainer body must start with ## ${EXPLAINER_HEADINGS[0]}`,
      );
    }
    current.lines.push(line);
  }
  if (current) raw.push(current);

  const got = raw.map((section) => section.heading);
  if (
    got.length !== EXPLAINER_HEADINGS.length ||
    got.some((heading, index) => heading !== EXPLAINER_HEADINGS[index])
  ) {
    throw new Error(
      `Explainer sections must be exactly: ${EXPLAINER_HEADINGS.join(", ")}. Got: ${got.join(", ") || "(none)"}`,
    );
  }

  return raw.map((section, index) => {
    const heading = EXPLAINER_HEADINGS[index];
    if (heading === undefined) {
      throw new Error("Explainer section index is out of range");
    }
    return {
      heading,
      id: explainerHeadingId(heading),
      markdown: section.lines.join("\n").trim(),
    };
  });
}

/** Markdown subset for explainer bodies: paragraphs, lists, links, code, bold. */
export function renderExplainerMarkdown(markdown: string): string {
  return splitBlocks(markdown)
    .map((block) => renderBlock(block))
    .join("");
}

function splitBlocks(markdown: string): string[] {
  const lines = markdown.replaceAll("\r\n", "\n").trim().split("\n");
  const blocks: string[] = [];
  let buf: string[] = [];
  let inList = false;

  const flush = (): void => {
    if (buf.length === 0) return;
    blocks.push(buf.join("\n"));
    buf = [];
  };

  for (const line of lines) {
    const listItem = /^[-*] /.test(line);
    if (line.trim() === "") {
      flush();
      inList = false;
      continue;
    }
    if (listItem) {
      if (!inList) flush();
      inList = true;
      buf.push(line);
      continue;
    }
    if (inList) {
      flush();
      inList = false;
    }
    buf.push(line);
  }
  flush();
  return blocks;
}

function renderBlock(block: string): string {
  const lines = block.split("\n");
  if (lines.length > 0 && lines.every((line) => /^[-*] /.test(line))) {
    const items = lines
      .map((line) => `<li>${renderInline(line.slice(2))}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  }
  return `<p>${renderInline(lines.join(" "))}</p>`;
}

function renderInline(text: string): string {
  const parts: string[] = [];
  const token = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  for (const match of text.matchAll(token)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(escapeHtml(text.slice(last, index)));
    if (match[1] !== undefined) {
      parts.push(`<strong>${escapeHtml(match[1])}</strong>`);
    } else if (match[2] !== undefined) {
      parts.push(`<code>${escapeHtml(match[2])}</code>`);
    } else {
      const label = match[3] ?? "";
      const href = match[4] ?? "";
      if (isSafeHref(href)) {
        parts.push(`<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`);
      } else {
        parts.push(escapeHtml(match[0]));
      }
    }
    last = index + match[0].length;
  }
  if (last < text.length) parts.push(escapeHtml(text.slice(last)));
  return parts.join("");
}

function isSafeHref(href: string): boolean {
  return (
    href.startsWith("/") ||
    href.startsWith("https://") ||
    href.startsWith("http://") ||
    href.startsWith("#")
  );
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

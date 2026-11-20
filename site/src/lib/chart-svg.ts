import * as Plot from "@observablehq/plot";
import { parseHTML } from "linkedom";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface ChartLabels {
  /** Prefix for the ids. The title gets `<id>-title` and the summary `<id>-summary`. */
  id: string;
  title: string;
  summary: string;
}

/** The size and text shared by every daily-page chart (ADR-0017). A chart can override any of it. */
export const CHART_FRAME: Plot.PlotOptions = {
  width: 330,
  height: 260,
  marginLeft: 56,
  marginBottom: 36,
  style: { fontSize: "14px" },
};

/**
 * Plot runs here, at build time, and returns static SVG. No client script (ADR-0017).
 * The SVG gets a title and a summary, labelled by aria-labelledby.
 */
export function renderPlot(
  options: Plot.PlotOptions,
  labels: ChartLabels,
): string {
  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  const plot = Plot.plot({
    ...CHART_FRAME,
    ...options,
    document: document as unknown as Document,
  }) as unknown as SVGSVGElement;

  const title = document.createElementNS(SVG_NS, "title");
  title.setAttribute("id", `${labels.id}-title`);
  title.textContent = labels.title;
  const desc = document.createElementNS(SVG_NS, "desc");
  desc.setAttribute("id", `${labels.id}-summary`);
  desc.textContent = labels.summary;
  plot.insertBefore(desc, plot.firstChild);
  plot.insertBefore(title, desc);
  plot.setAttribute("role", "img");
  plot.setAttribute(
    "aria-labelledby",
    `${labels.id}-title ${labels.id}-summary`,
  );
  return plot.outerHTML;
}

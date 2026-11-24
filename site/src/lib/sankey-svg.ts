import type { FuelCategory } from "@gridwatch/publisher/site-contract";
import { parseHTML } from "linkedom";
import {
  type EnergySankey,
  fuelFromNodeId,
  type SankeyNode,
} from "./sankey.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const WIDTH = 480;
const HEIGHT = 380;
const NODE_WIDTH = 16;
const PAD = 12;
const GAP = 8;
const LABEL = 12;
const MIN_NODE = 6;

const FUEL_COLOUR: Record<Exclude<FuelCategory, "battery">, string> = {
  hydro: "var(--color-fuel-hydro)",
  geothermal: "var(--color-fuel-geothermal)",
  wind: "var(--color-fuel-wind)",
  solar: "var(--color-fuel-solar)",
  gas: "var(--color-fuel-gas)",
  coal_gas: "var(--color-fuel-coal-gas)",
  other: "var(--color-fuel-other)",
  unmapped: "var(--color-fuel-unmapped)",
};

interface Box {
  node: SankeyNode;
  x: number;
  y: number;
  height: number;
  fill: string;
  flow: number;
}

/** Static SVG for the daily energy Sankey. No client script (ADR-0017). */
export function renderSankeySvg(chart: EnergySankey): string {
  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  const boxes = layout(chart);
  const byId = new Map(boxes.map((box) => [box.node.id, box]));
  const sourceUsed = new Map<string, number>();
  const targetUsed = new Map<string, number>();

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("viewBox", `0 0 ${WIDTH} ${HEIGHT}`);
  svg.setAttribute("width", String(WIDTH));
  svg.setAttribute("height", String(HEIGHT));
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-labelledby",
    "energy-sankey-chart-title energy-sankey-chart-summary",
  );
  svg.setAttribute("style", "font-size:14px");

  const title = document.createElementNS(SVG_NS, "title");
  title.setAttribute("id", "energy-sankey-chart-title");
  title.textContent = "National energy balance";
  const desc = document.createElementNS(SVG_NS, "desc");
  desc.setAttribute("id", "energy-sankey-chart-summary");
  desc.textContent =
    "Each island's generation by fuel, the inter-island cable as a hop between them, estimated load, losses, and residual.";
  svg.append(title, desc);

  for (const link of chart.links) {
    const from = byId.get(link.source);
    const to = byId.get(link.target);
    if (!from || !to) continue;
    const scale = from.height / Math.max(from.flow, 1e-9);
    const thickness = Math.max(1.5, link.megawattHours * scale);
    const path = document.createElementNS(SVG_NS, "path");
    if (from.x === to.x) {
      const downward = to.y > from.y;
      const y1 = downward ? from.y + from.height : from.y;
      const y2 = downward ? to.y : to.y + to.height;
      const xMid = from.x + NODE_WIDTH / 2;
      const left = xMid - thickness / 2;
      const right = xMid + thickness / 2;
      const midY = (y1 + y2) / 2;
      path.setAttribute(
        "d",
        `M${left},${y1} C${left},${midY} ${left},${midY} ${left},${y2} L${right},${y2} C${right},${midY} ${right},${midY} ${right},${y1} Z`,
      );
    } else {
      const backward = to.x < from.x;
      const y1 =
        from.y + (sourceUsed.get(edgeKey(from.node.id, backward)) ?? 0);
      const y2 = to.y + (targetUsed.get(edgeKey(to.node.id, !backward)) ?? 0);
      sourceUsed.set(
        edgeKey(from.node.id, backward),
        (sourceUsed.get(edgeKey(from.node.id, backward)) ?? 0) + thickness,
      );
      targetUsed.set(
        edgeKey(to.node.id, !backward),
        (targetUsed.get(edgeKey(to.node.id, !backward)) ?? 0) + thickness,
      );
      const x1 = backward ? from.x : from.x + NODE_WIDTH;
      const x2 = backward ? to.x + NODE_WIDTH : to.x;
      const mid = (x1 + x2) / 2;
      path.setAttribute(
        "d",
        `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2} L${x2},${y2 + thickness} C${mid},${y2 + thickness} ${mid},${y1 + thickness} ${x1},${y1 + thickness} Z`,
      );
    }
    path.setAttribute("fill", from.fill);
    path.setAttribute("fill-opacity", "0.35");
    const tip = document.createElementNS(SVG_NS, "title");
    tip.textContent = `${from.node.label} → ${to.node.label}: ${formatMwh(link.megawattHours)} MWh`;
    path.append(tip);
    svg.append(path);
  }

  for (const box of boxes) {
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("data-id", svgNodeId(box.node.id));
    rect.setAttribute("x", String(box.x));
    rect.setAttribute("y", String(box.y));
    rect.setAttribute("width", String(NODE_WIDTH));
    rect.setAttribute("height", String(Math.max(box.height, MIN_NODE)));
    rect.setAttribute("fill", box.fill);
    rect.setAttribute("stroke", "var(--color-card)");
    rect.setAttribute("stroke-width", "1");
    const tip = document.createElementNS(SVG_NS, "title");
    tip.textContent = `${box.node.label}: ${formatMwh(box.node.megawattHours)} MWh`;
    rect.append(tip);
    svg.append(rect);
  }

  for (const box of boxes) {
    const text = document.createElementNS(SVG_NS, "text");
    const atRight = labelToTheRight(box.node.kind);
    text.setAttribute(
      "x",
      String(atRight ? box.x + NODE_WIDTH + 5 : box.x - 5),
    );
    text.setAttribute(
      "y",
      String(box.y + Math.max(box.height, MIN_NODE) / 2 + 4),
    );
    text.setAttribute("text-anchor", atRight ? "start" : "end");
    text.setAttribute("fill", "var(--color-ink)");
    text.setAttribute("stroke", "var(--color-card)");
    text.setAttribute("stroke-width", "3");
    text.setAttribute("paint-order", "stroke");
    text.setAttribute("font-size", String(LABEL));
    text.textContent = displayLabel(box.node);
    svg.append(text);
  }

  return svg.outerHTML;
}

const SHARED_LEGEND_LABEL: Partial<Record<SankeyNode["kind"], string>> = {
  load: "Estimated load",
  residual: "Residual",
};

/** One legend entry per drawn band colour, in column order. */
export function sankeyLegend(
  chart: EnergySankey,
): Array<{ label: string; colour: string }> {
  const entries = new Map<string, string>();
  for (const node of chart.nodes) {
    const label = SHARED_LEGEND_LABEL[node.kind] ?? node.label;
    if (!entries.has(label)) entries.set(label, nodeFill(node));
  }
  return [...entries].map(([label, colour]) => ({ label, colour }));
}

function layout(chart: EnergySankey): Box[] {
  const flowOf = flowMap(chart);
  const niFuels = chart.nodes.filter(
    (node) =>
      (node.kind === "fuel" || node.kind === "battery") &&
      node.id.endsWith(":NI"),
  );
  const siFuels = chart.nodes.filter(
    (node) =>
      (node.kind === "fuel" || node.kind === "battery") &&
      node.id.endsWith(":SI"),
  );
  const islands = chart.nodes.filter((node) => node.kind === "island");
  const hvdc = chart.nodes.find((node) => node.kind === "hvdc");
  const losses = chart.nodes.find((node) => node.kind === "losses");
  const niSinks = chart.nodes.filter(
    (node) =>
      (node.kind === "load" || node.kind === "residual") &&
      node.id.endsWith(":NI") &&
      node.megawattHours >= 0,
  );
  const siSinks = chart.nodes.filter(
    (node) =>
      (node.kind === "load" || node.kind === "residual") &&
      node.id.endsWith(":SI") &&
      node.megawattHours >= 0,
  );
  const niFuelColumn = [
    ...chart.nodes.filter(
      (node) =>
        node.kind === "residual" &&
        node.id.endsWith(":NI") &&
        node.megawattHours < 0,
    ),
    ...niFuels,
  ];
  const siFuelColumn = [
    ...chart.nodes.filter(
      (node) =>
        node.kind === "residual" &&
        node.id.endsWith(":SI") &&
        node.megawattHours < 0,
    ),
    ...siFuels,
  ];

  const inner = HEIGHT - PAD * 2;
  const ni = islands.find((node) => node.id.endsWith(":NI"));
  const si = islands.find((node) => node.id.endsWith(":SI"));
  const niIslandFlow = ni ? (flowOf.get(ni.id) ?? 0) : 0;
  const siIslandFlow = si ? (flowOf.get(si.id) ?? 0) : 0;
  const hvdcFlow = hvdc ? (flowOf.get(hvdc.id) ?? 0) : 0;
  const lossFlow = losses ? (flowOf.get(losses.id) ?? 0) : 0;
  const niSinkFlow = sumFlow(niSinks, flowOf);
  const siSinkFlow = sumFlow(siSinks, flowOf);
  const middleCount = (ni ? 1 : 0) + (hvdc ? 1 : 0) + (si ? 1 : 0);
  const fuelGaps =
    Math.max(0, niFuelColumn.length - 1) * GAP +
    Math.max(0, siFuelColumn.length - 1) * GAP +
    GAP;
  const islandGaps = Math.max(0, middleCount - 1) * GAP;
  const sinkGaps =
    Math.max(0, niSinks.length - 1) * GAP +
    Math.max(0, siSinks.length - 1) * GAP +
    (losses ? GAP : 0) +
    GAP;
  const usable = inner - Math.max(fuelGaps, islandGaps, sinkGaps);
  const scale =
    usable /
    Math.max(
      sumFlow(niFuelColumn, flowOf) + sumFlow(siFuelColumn, flowOf),
      niIslandFlow + siIslandFlow + hvdcFlow,
      niSinkFlow + siSinkFlow + lossFlow,
      1,
    );

  const xs = [78, 186, 372];
  const boxes: Box[] = [];
  const niHeight = ni ? Math.max(MIN_NODE, niIslandFlow * scale) : 0;
  const siHeight = si ? Math.max(MIN_NODE, siIslandFlow * scale) : 0;
  const hvdcHeight = hvdc ? Math.max(MIN_NODE, hvdcFlow * scale) : 0;
  const islandBlock = niHeight + siHeight + hvdcHeight + islandGaps;
  let islandY = PAD + Math.max(0, (inner - islandBlock) / 2);
  if (ni) {
    boxes.push(boxOf(ni, xs[1] ?? PAD, islandY, niHeight, flowOf));
    islandY += niHeight + GAP;
  }
  const hvdcY = islandY;
  if (hvdc) {
    boxes.push(boxOf(hvdc, xs[1] ?? PAD, hvdcY, hvdcHeight, flowOf));
    islandY += hvdcHeight + GAP;
  }
  if (si) {
    boxes.push(boxOf(si, xs[1] ?? PAD, islandY, siHeight, flowOf));
  }

  const niStart = ni
    ? (boxes.find((item) => item.node.id === ni.id)?.y ?? PAD)
    : PAD;
  const siStart = si
    ? (boxes.find((item) => item.node.id === si.id)?.y ?? PAD)
    : PAD;
  stackColumn(boxes, niFuelColumn, xs[0] ?? PAD, niStart, scale, flowOf);
  stackColumn(boxes, siFuelColumn, xs[0] ?? PAD, siStart, scale, flowOf);
  stackColumn(boxes, niSinks, xs[2] ?? PAD, niStart, scale, flowOf);
  if (losses) {
    boxes.push(
      boxOf(
        losses,
        xs[2] ?? PAD,
        hvdcY,
        Math.max(MIN_NODE, (flowOf.get(losses.id) ?? 0) * scale),
        flowOf,
      ),
    );
  }
  stackColumn(boxes, siSinks, xs[2] ?? PAD, siStart, scale, flowOf);
  return boxes;
}

function stackColumn(
  boxes: Box[],
  nodes: SankeyNode[],
  x: number,
  startY: number,
  scale: number,
  flowOf: Map<string, number>,
): void {
  let y = startY;
  for (const node of nodes) {
    const height = Math.max(MIN_NODE, (flowOf.get(node.id) ?? 0) * scale);
    boxes.push(boxOf(node, x, y, height, flowOf));
    y += height + GAP;
  }
}

function boxOf(
  node: SankeyNode,
  x: number,
  y: number,
  height: number,
  flowOf: Map<string, number>,
): Box {
  return {
    node,
    x,
    y,
    height,
    fill: nodeFill(node),
    flow: flowOf.get(node.id) ?? Math.abs(node.megawattHours),
  };
}

function flowMap(chart: EnergySankey): Map<string, number> {
  const flows = new Map<string, number>();
  for (const node of chart.nodes) {
    const outgoing = chart.links
      .filter((link) => link.source === node.id)
      .reduce((sum, link) => sum + link.megawattHours, 0);
    const incoming = chart.links
      .filter((link) => link.target === node.id)
      .reduce((sum, link) => sum + link.megawattHours, 0);
    flows.set(
      node.id,
      Math.max(Math.abs(node.megawattHours), outgoing, incoming),
    );
  }
  return flows;
}

function sumFlow(nodes: SankeyNode[], flowOf: Map<string, number>): number {
  return nodes.reduce((sum, node) => sum + (flowOf.get(node.id) ?? 0), 0);
}

function labelToTheRight(kind: SankeyNode["kind"]): boolean {
  switch (kind) {
    case "fuel":
    case "battery":
      return false;
    case "island":
    case "hvdc":
    case "load":
    case "residual":
    case "losses":
      return true;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function displayLabel(node: SankeyNode): string {
  switch (node.kind) {
    case "fuel":
      return node.label;
    case "battery":
      return "Battery";
    case "island":
      return node.label;
    case "hvdc":
      return "Cable";
    case "load":
      return "Load";
    case "residual":
      return "Residual";
    case "losses":
      return "Losses";
    default: {
      const _exhaustive: never = node.kind;
      return _exhaustive;
    }
  }
}

function nodeFill(node: SankeyNode): string {
  switch (node.kind) {
    case "fuel": {
      const fuel = fuelFromNodeId(node.id) as Exclude<FuelCategory, "battery">;
      return FUEL_COLOUR[fuel] ?? "var(--color-fuel-other)";
    }
    case "battery":
      return "var(--color-fuel-battery)";
    case "island":
      return node.id.endsWith(":SI")
        ? "var(--color-island-south)"
        : "var(--color-island-north)";
    case "hvdc":
      return "var(--color-brand)";
    case "load":
      return "var(--color-ink-muted)";
    case "residual":
      return "var(--color-caution)";
    case "losses":
      return "var(--color-rule)";
    default: {
      const _exhaustive: never = node.kind;
      return _exhaustive;
    }
  }
}

/** Public SVG ids. The page must not contain the tokens NI or SI. */
export function svgNodeId(id: string): string {
  if (id.endsWith(":NI")) return `${id.slice(0, -3)}:north`;
  if (id.endsWith(":SI")) return `${id.slice(0, -3)}:south`;
  return id;
}

function formatMwh(value: number): string {
  return new Intl.NumberFormat("en-NZ", { maximumFractionDigits: 1 }).format(
    value,
  );
}

function edgeKey(id: string, left: boolean): string {
  return `${id}:${left ? "L" : "R"}`;
}

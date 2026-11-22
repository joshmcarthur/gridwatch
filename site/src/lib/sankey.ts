import type {
  FuelCategory,
  Island,
  SankeyIsland,
  SiteDay,
} from "@gridwatch/publisher/site-contract";
import { STACK_ORDER } from "./generation-mix.ts";

const energyFormat = new Intl.NumberFormat("en-NZ", {
  maximumFractionDigits: 1,
});
const percentFormat = new Intl.NumberFormat("en-NZ", {
  maximumFractionDigits: 1,
});

export type SankeyNodeKind =
  | "fuel"
  | "battery"
  | "island"
  | "hvdc"
  | "load"
  | "residual"
  | "losses";

export interface SankeyNode {
  id: string;
  kind: SankeyNodeKind;
  label: string;
  /** Gold-table value in MWh. Residual keeps its sign. */
  megawattHours: number;
}

export interface SankeyLink {
  source: string;
  target: string;
  megawattHours: number;
}

export interface SankeyGoldIsland {
  island: Island;
  generation: number | null;
  hvdcImport: number | null;
  load: number | null;
  residual: number | null;
  residualPercentOfLoad: number | null;
}

export interface EnergySankey {
  state: "complete" | "incomplete";
  nodes: SankeyNode[];
  links: SankeyLink[];
  islands: SankeyGoldIsland[];
  linkLosses: number | null;
}

const FUEL_LABEL: Record<FuelCategory, string> = {
  hydro: "Hydro",
  geothermal: "Geothermal",
  wind: "Wind",
  solar: "Solar",
  gas: "Gas",
  coal_gas: "Coal/gas",
  other: "Other",
  unmapped: "Not yet matched to a plant",
  battery: "Battery (stored power)",
};

const ISLAND_LABEL: Record<Island, string> = {
  NI: "North Island",
  SI: "South Island",
};

/** Builds the daily Sankey, or null when the section is missing / not built. */
export function energySankey(day: SiteDay): EnergySankey | null {
  const section = day.sankey;
  if (section === undefined || section.state === "missing") return null;

  const islands = section.islands.map(goldIsland);
  const nodes: SankeyNode[] = [];
  const links: SankeyLink[] = [];
  const addNode = (node: SankeyNode) => {
    const existing = nodes.find((candidate) => candidate.id === node.id);
    if (existing) {
      existing.megawattHours += node.megawattHours;
      return;
    }
    nodes.push(node);
  };
  const ensureNode = (node: SankeyNode) => {
    if (nodes.some((candidate) => candidate.id === node.id)) return;
    nodes.push(node);
  };
  const addLink = (source: string, target: string, megawattHours: number) => {
    if (megawattHours <= 0) return;
    const existing = links.find(
      (link) => link.source === source && link.target === target,
    );
    if (existing) {
      existing.megawattHours += megawattHours;
      return;
    }
    links.push({ source, target, megawattHours });
  };

  for (const row of day.generation.daily) {
    if (row.island === null || row.megawatt_hours <= 0) continue;
    const fuelId = nodeId("fuel", row.fuel);
    addNode({
      id: fuelId,
      kind: row.fuel === "battery" ? "battery" : "fuel",
      label: FUEL_LABEL[row.fuel],
      megawattHours: row.megawatt_hours,
    });
    addLink(fuelId, nodeId("island", row.island), row.megawatt_hours);
  }

  for (const island of islands) {
    const islandId = nodeId("island", island.island);
    if (island.generation !== null) {
      ensureNode({
        id: islandId,
        kind: "island",
        label: ISLAND_LABEL[island.island],
        megawattHours: island.generation,
      });
    }
    if (island.load !== null && island.load > 0) {
      const loadId = nodeId("load", island.island);
      ensureNode({
        id: loadId,
        kind: "load",
        label: `${ISLAND_LABEL[island.island]} estimated load`,
        megawattHours: island.load,
      });
      addLink(islandId, loadId, island.load);
    }
    if (island.residual !== null && island.residual !== 0) {
      const residualId = nodeId("residual", island.island);
      ensureNode({
        id: residualId,
        kind: "residual",
        label: `${ISLAND_LABEL[island.island]} residual`,
        megawattHours: island.residual,
      });
      if (island.residual > 0) addLink(islandId, residualId, island.residual);
      else addLink(residualId, islandId, -island.residual);
    }
  }

  const hvdcId = "hvdc";
  let hvdcThroughput = 0;
  for (const island of islands) {
    if (island.hvdcImport === null || island.hvdcImport === 0) continue;
    const islandId = nodeId("island", island.island);
    ensureNode({
      id: islandId,
      kind: "island",
      label: ISLAND_LABEL[island.island],
      megawattHours: island.generation ?? Math.abs(island.hvdcImport),
    });
    if (island.hvdcImport > 0) {
      addLink(hvdcId, islandId, island.hvdcImport);
      hvdcThroughput += island.hvdcImport;
    } else {
      addLink(islandId, hvdcId, -island.hvdcImport);
      hvdcThroughput += -island.hvdcImport;
    }
  }
  const losses = section.link_losses_megawatt_hours;
  if (losses !== null && losses !== 0) {
    ensureNode({
      id: "losses",
      kind: "losses",
      label: "Cable losses",
      megawattHours: losses,
    });
    if (losses > 0) {
      addLink(hvdcId, "losses", losses);
      hvdcThroughput += losses;
    } else {
      addLink("losses", hvdcId, -losses);
      hvdcThroughput += -losses;
    }
  }
  if (hvdcThroughput > 0) {
    ensureNode({
      id: hvdcId,
      kind: "hvdc",
      label: "Inter-island cable",
      megawattHours: hvdcThroughput,
    });
  }

  return {
    state: section.state,
    nodes: orderNodes(nodes),
    links,
    islands,
    linkLosses: losses,
  };
}

export function sankeySummary(chart: EnergySankey): string {
  const residuals = chart.nodes.filter((node) => node.kind === "residual");
  const loads = chart.islands
    .map((island) => island.load)
    .filter((value): value is number => value !== null);
  const loadTotal = loads.reduce((sum, value) => sum + value, 0);
  const residualTotal = chart.islands.reduce(
    (sum, island) => sum + (island.residual ?? 0),
    0,
  );
  const loadText =
    loadTotal > 0
      ? `Estimated load was ${energyFormat.format(loadTotal)} megawatt-hours.`
      : "Estimated load is missing.";
  if (residuals.length === 0) {
    return `${loadText} Generation, the inter-island cable and estimated load balanced for the day.`;
  }
  const share =
    loadTotal > 0
      ? ` ${percentFormat.format((Math.abs(residualTotal) / loadTotal) * 100)} percent of estimated load.`
      : "";
  return `${loadText} A residual of ${energyFormat.format(residualTotal)} megawatt-hours is shown as its own band.${share}`;
}

export function sankeyTable(chart: EnergySankey): {
  headers: string[];
  rows: string[][];
} {
  const headers = [
    "Place",
    "Generation",
    "Cable import",
    "Estimated load",
    "Residual",
    "% of load",
  ];
  const rows = chart.islands.map((island) => [
    ISLAND_LABEL[island.island],
    mwhCell(island.generation),
    mwhCell(island.hvdcImport),
    mwhCell(island.load),
    mwhCell(island.residual),
    island.residualPercentOfLoad === null
      ? "No data"
      : `${percentFormat.format(island.residualPercentOfLoad)}%`,
  ]);
  rows.push(["Cable losses", "—", "—", "—", mwhCell(chart.linkLosses), "—"]);
  return { headers, rows };
}

export function sankeyMissingCopy(): string {
  return "Metered transfer on the inter-island cable (the HVDC link between Benmore and Haywards) is published about a month after the day. This day's energy balance is not published yet. This site does not guess the transfer.";
}

export function nodeId(kind: "fuel", fuel: FuelCategory): string;
export function nodeId(
  kind: "island" | "load" | "residual",
  island: Island,
): string;
export function nodeId(
  kind: "fuel" | "island" | "load" | "residual",
  key: FuelCategory | Island,
): string {
  return `${kind}:${key}`;
}

function goldIsland(row: SankeyIsland): SankeyGoldIsland {
  return {
    island: row.island,
    generation: row.generation_megawatt_hours,
    hvdcImport: row.hvdc_import_megawatt_hours,
    load: row.load_megawatt_hours,
    residual: row.residual_megawatt_hours,
    residualPercentOfLoad: row.residual_percent_of_load,
  };
}

function orderNodes(nodes: SankeyNode[]): SankeyNode[] {
  const fuelOrder = [...STACK_ORDER, "battery"] as const;
  const rank = (node: SankeyNode): number => {
    switch (node.kind) {
      case "fuel":
      case "battery": {
        const fuel = node.id.slice("fuel:".length) as FuelCategory;
        const at = fuelOrder.indexOf(fuel);
        return at < 0 ? 50 : at;
      }
      case "island":
        return 100 + (node.id.endsWith(":SI") ? 1 : 0);
      case "hvdc":
        return 200;
      case "load":
        return 300 + (node.id.endsWith(":SI") ? 1 : 0);
      case "residual":
        return 400 + (node.id.endsWith(":SI") ? 1 : 0);
      case "losses":
        return 500;
      default: {
        const _exhaustive: never = node.kind;
        return _exhaustive;
      }
    }
  };
  return [...nodes].sort((a, b) => rank(a) - rank(b));
}

function mwhCell(value: number | null): string {
  return value === null ? "No data" : energyFormat.format(value);
}

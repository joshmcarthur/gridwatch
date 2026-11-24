import {
  assertSiteDay,
  type FuelCategory,
  type Island,
  type SankeySection,
  type SiteDay,
} from "@gridwatch/publisher/site-contract";
import { expect, test } from "vitest";
import fixtureJson from "../../fixtures/days/2026-09-27.json";
import {
  energySankey,
  nodeId,
  sankeyCaption,
  sankeyMissingCopy,
  sankeySummary,
  sankeyTable,
} from "./sankey.ts";
import { renderSankeySvg, sankeyLegend, svgNodeId } from "./sankey-svg.ts";

const fixtureUnknown: unknown = fixtureJson;
assertSiteDay(fixtureUnknown);
const fixture: SiteDay = fixtureUnknown;

/** The #23 / ADR-0018 base-case gold day table, in MWh. */
const GOLD = {
  NI: {
    generation: 288,
    hvdcImport: 48,
    load: 240,
    residual: 96,
    residualPercent: 40,
  },
  SI: {
    generation: 192,
    hvdcImport: -57.6,
    load: 120,
    residual: 14.4,
    residualPercent: 12,
  },
  losses: 9.6,
};

function missingSankey(): SankeySection {
  return {
    state: "missing",
    missing_periods: [],
    analysis_version: null,
    inputs_sha256: null,
    silver_tables: [],
    gold_tables: [
      "energy_balance_period",
      "energy_balance_day",
      "hvdc_transfer_day",
    ],
    datasets: [],
    islands: [],
    link_losses_megawatt_hours: null,
    inputs_complete: null,
  };
}

function completeSankey(): SankeySection {
  return {
    state: "complete",
    missing_periods: [],
    analysis_version: 1,
    inputs_sha256: "gold",
    silver_tables: [],
    gold_tables: [
      "energy_balance_period",
      "energy_balance_day",
      "hvdc_transfer_day",
    ],
    datasets: [],
    islands: [
      {
        island: "NI",
        generation_megawatt_hours: GOLD.NI.generation,
        hvdc_import_megawatt_hours: GOLD.NI.hvdcImport,
        load_megawatt_hours: GOLD.NI.load,
        residual_megawatt_hours: GOLD.NI.residual,
        residual_percent_of_load: GOLD.NI.residualPercent,
        inputs_complete: true,
      },
      {
        island: "SI",
        generation_megawatt_hours: GOLD.SI.generation,
        hvdc_import_megawatt_hours: GOLD.SI.hvdcImport,
        load_megawatt_hours: GOLD.SI.load,
        residual_megawatt_hours: GOLD.SI.residual,
        residual_percent_of_load: GOLD.SI.residualPercent,
        inputs_complete: true,
      },
    ],
    link_losses_megawatt_hours: GOLD.losses,
    inputs_complete: true,
  };
}

function dayOf(
  sankey: SankeySection,
  fuels: SiteDay["generation"]["daily"] = [],
): SiteDay {
  return {
    ...fixture,
    generation: {
      ...fixture.generation,
      daily: fuels,
    },
    sankey,
  };
}

function fuel(
  category: FuelCategory,
  island: Island,
  megawattHours: number,
): SiteDay["generation"]["daily"][number] {
  return {
    fuel: category,
    island,
    megawatt_hours: megawattHours,
    average_megawatts: megawattHours / 24,
  };
}

test("a missing sankey day has no chart and says the transfer is not published yet", () => {
  expect(energySankey(dayOf(missingSankey()))).toBeNull();
  expect(sankeyMissingCopy()).toMatch(/not published yet/i);
  expect(sankeyMissingCopy()).toMatch(/does not guess/i);
  expect(sankeyMissingCopy()).not.toMatch(/\bNI\b/);
  expect(sankeyMissingCopy()).not.toMatch(/\bSI\b/);
});

test("the fixture day has a complete sankey with both islands", () => {
  const chart = energySankey(fixture);
  if (!chart) throw new Error("expected a sankey");
  expect(chart.state).toBe("complete");
  expect(chart.islands.map((island) => island.island)).toEqual(["NI", "SI"]);
  expect(chart.linkLosses).toBeGreaterThan(0);
});

test("node values match the #23 gold day table", () => {
  const chart = energySankey(
    dayOf(completeSankey(), [
      fuel("hydro", "NI", GOLD.NI.generation),
      fuel("hydro", "SI", GOLD.SI.generation),
    ]),
  );
  if (!chart) throw new Error("expected a sankey");
  expect(chart.state).toBe("complete");
  expect(chart.islands).toEqual([
    {
      island: "NI",
      generation: GOLD.NI.generation,
      hvdcImport: GOLD.NI.hvdcImport,
      load: GOLD.NI.load,
      residual: GOLD.NI.residual,
      residualPercentOfLoad: GOLD.NI.residualPercent,
    },
    {
      island: "SI",
      generation: GOLD.SI.generation,
      hvdcImport: GOLD.SI.hvdcImport,
      load: GOLD.SI.load,
      residual: GOLD.SI.residual,
      residualPercentOfLoad: GOLD.SI.residualPercent,
    },
  ]);
  expect(chart.linkLosses).toBe(GOLD.losses);
  expect(node(chart, nodeId("island", "NI")).megawattHours).toBe(
    GOLD.NI.generation,
  );
  expect(node(chart, nodeId("island", "SI")).megawattHours).toBe(
    GOLD.SI.generation,
  );
  expect(node(chart, nodeId("load", "NI")).megawattHours).toBe(GOLD.NI.load);
  expect(node(chart, nodeId("load", "SI")).megawattHours).toBe(GOLD.SI.load);
  expect(node(chart, nodeId("residual", "NI")).megawattHours).toBe(
    GOLD.NI.residual,
  );
  expect(node(chart, nodeId("residual", "SI")).megawattHours).toBe(
    GOLD.SI.residual,
  );
  expect(node(chart, "losses").megawattHours).toBe(GOLD.losses);
  expect(link(chart, "hvdc", nodeId("island", "NI"))).toBe(GOLD.NI.hvdcImport);
  expect(link(chart, nodeId("island", "SI"), "hvdc")).toBe(-GOLD.SI.hvdcImport);
  expect(link(chart, "hvdc", "losses")).toBe(GOLD.losses);
  expect(link(chart, nodeId("island", "NI"), nodeId("load", "NI"))).toBe(
    GOLD.NI.load,
  );
  expect(link(chart, nodeId("island", "NI"), nodeId("residual", "NI"))).toBe(
    GOLD.NI.residual,
  );
  expect(node(chart, nodeId("fuel", "hydro", "NI")).megawattHours).toBe(
    GOLD.NI.generation,
  );
  expect(node(chart, nodeId("fuel", "hydro", "SI")).megawattHours).toBe(
    GOLD.SI.generation,
  );
  expect(
    link(chart, nodeId("fuel", "hydro", "NI"), nodeId("island", "NI")),
  ).toBe(GOLD.NI.generation);
  expect(
    link(chart, nodeId("fuel", "hydro", "SI"), nodeId("island", "SI")),
  ).toBe(GOLD.SI.generation);
  expect(
    chart.links.find(
      (item) =>
        item.source === nodeId("fuel", "hydro", "SI") &&
        item.target === nodeId("island", "NI"),
    ),
  ).toBeUndefined();
});

test("a southward day reverses the cable hop", () => {
  const southward = completeSankey();
  for (const island of southward.islands) {
    if (island.island === "NI") island.hvdc_import_megawatt_hours = -57.6;
    if (island.island === "SI") island.hvdc_import_megawatt_hours = 48;
  }
  const chart = energySankey(dayOf(southward));
  if (!chart) throw new Error("expected a sankey");
  expect(link(chart, nodeId("island", "NI"), "hvdc")).toBe(57.6);
  expect(link(chart, "hvdc", nodeId("island", "SI"))).toBe(48);
  expect(
    chart.links.find(
      (item) =>
        item.source === "hvdc" && item.target === nodeId("island", "NI"),
    ),
  ).toBeUndefined();
  expect(sankeyCaption(chart)).toMatch(/southward/i);
  expect(sankeySummary(chart)).toMatch(/southward/i);
  expect(sankeyCaption(chart)).not.toMatch(/\bNI\b/);
  expect(sankeySummary(chart)).not.toMatch(/\bSI\b/);
});

test("a non-zero residual is a visible node, and a zero residual is omitted", () => {
  const withResidual = energySankey(dayOf(completeSankey()));
  if (!withResidual) throw new Error("expected a sankey");
  expect(
    withResidual.nodes.some(
      (item) => item.kind === "residual" && item.megawattHours !== 0,
    ),
  ).toBe(true);
  expect(sankeySummary(withResidual)).toMatch(/residual/i);
  expect(sankeySummary(withResidual)).toMatch(/estimated load/i);
  expect(sankeySummary(withResidual)).toMatch(/northward/i);
  expect(sankeySummary(withResidual)).not.toMatch(/\bconsumption\b/i);
  expect(sankeySummary(withResidual)).not.toMatch(/\bNI\b/);
  expect(sankeySummary(withResidual)).not.toMatch(/\bSI\b/);
  expect(sankeyCaption(withResidual)).toMatch(/northward/i);
  expect(sankeyCaption(withResidual)).not.toMatch(/\bNI\b/);
  expect(sankeyCaption(withResidual)).not.toMatch(/\bSI\b/);

  const balanced = completeSankey();
  for (const island of balanced.islands) {
    island.residual_megawatt_hours = 0;
    island.residual_percent_of_load = 0;
  }
  const without = energySankey(dayOf(balanced));
  if (!without) throw new Error("expected a sankey");
  expect(without.nodes.some((item) => item.kind === "residual")).toBe(false);
});

test("battery is its own node, not mixed into primary generation", () => {
  const chart = energySankey(
    dayOf(completeSankey(), [
      fuel("hydro", "NI", 200),
      fuel("wind", "NI", 80),
      fuel("battery", "NI", 8),
      fuel("hydro", "SI", GOLD.SI.generation),
    ]),
  );
  if (!chart) throw new Error("expected a sankey");
  const battery = node(chart, nodeId("fuel", "battery", "NI"));
  expect(battery.kind).toBe("battery");
  expect(battery.label).toMatch(/stored power/i);
  expect(node(chart, nodeId("fuel", "hydro", "NI")).kind).toBe("fuel");
  expect(node(chart, nodeId("fuel", "hydro", "SI")).kind).toBe("fuel");
  expect(
    link(chart, nodeId("fuel", "battery", "NI"), nodeId("island", "NI")),
  ).toBe(8);
});

test("the static SVG labels residual and uses a text alternative", () => {
  const chart = energySankey(dayOf(completeSankey()));
  if (!chart) throw new Error("expected a sankey");
  const svg = renderSankeySvg(chart);
  expect(svg).toContain('role="img"');
  expect(svg).toContain("energy-sankey-chart-title");
  expect(svg).toContain("North Island residual");
  expect(svg).toContain("estimated load");
  expect(svg).toContain("Residual");
  expect(svg).not.toMatch(/\bconsumption\b/i);

  const balanced = completeSankey();
  for (const island of balanced.islands) {
    island.residual_megawatt_hours = 0;
    island.residual_percent_of_load = 0;
  }
  const without = energySankey(dayOf(balanced));
  if (!without) throw new Error("expected a sankey");
  expect(renderSankeySvg(without)).not.toContain("North Island residual");
});

test("the legend has one entry per band colour drawn, including other", () => {
  const chart = energySankey(
    dayOf(completeSankey(), [
      fuel("hydro", "NI", 100),
      fuel("other", "NI", 50),
      fuel("hydro", "SI", 100),
    ]),
  );
  if (!chart) throw new Error("expected a sankey");
  const labels = sankeyLegend(chart).map((item) => item.label);
  expect(labels).toEqual(
    expect.arrayContaining(["Hydro", "Other", "Residual", "Estimated load"]),
  );
  expect(new Set(labels).size).toBe(labels.length);
});

test("the SVG keeps North Island above South Island and hops the cable between them", () => {
  const chart = energySankey(
    dayOf(completeSankey(), [
      fuel("hydro", "NI", GOLD.NI.generation),
      fuel("hydro", "SI", GOLD.SI.generation),
    ]),
  );
  if (!chart) throw new Error("expected a sankey");
  const svg = renderSankeySvg(chart);
  const ni = svgRect(svg, nodeId("island", "NI"));
  const si = svgRect(svg, nodeId("island", "SI"));
  const cable = svgRect(svg, "hvdc");
  const niHydro = svgRect(svg, nodeId("fuel", "hydro", "NI"));
  const siHydro = svgRect(svg, nodeId("fuel", "hydro", "SI"));
  expect(ni.y + ni.height).toBeLessThan(cable.y);
  expect(cable.y + cable.height).toBeLessThan(si.y);
  expect(ni.x).toBe(si.x);
  expect(cable.x).toBe(ni.x);
  expect(niHydro.y + niHydro.height).toBeLessThan(siHydro.y);
  expect(Math.abs(niHydro.y - ni.y)).toBeLessThan(Math.abs(niHydro.y - si.y));
  expect(Math.abs(siHydro.y - si.y)).toBeLessThan(Math.abs(siHydro.y - ni.y));
  expect(svg).not.toMatch(/\bNI\b/);
  expect(svg).not.toMatch(/\bSI\b/);
});

test("the numbers table is the gold day table and does not say consumption", () => {
  const chart = energySankey(dayOf(completeSankey()));
  if (!chart) throw new Error("expected a sankey");
  const table = sankeyTable(chart);
  expect(table.headers.join(" ")).toMatch(/estimated load/i);
  expect(table.headers.join(" ")).not.toMatch(/\bconsumption\b/i);
  expect(table.rows[0]?.[0]).toBe("North Island");
  expect(table.rows[0]?.[1]).toBe("288");
  expect(table.rows[0]?.[2]).toBe("48");
  expect(table.rows[0]?.[3]).toBe("240");
  expect(table.rows[0]?.[4]).toBe("96");
  expect(table.rows[0]?.[5]).toBe("40%");
  expect(table.rows[1]?.[2]).toBe("-57.6");
  expect(table.rows[2]?.[0]).toBe("Cable losses");
  expect(table.rows[2]?.[4]).toBe("9.6");
});

function svgRect(
  svg: string,
  id: string,
): { x: number; y: number; height: number } {
  const tag = [...svg.matchAll(/<rect\b[^>]*>/g)]
    .map((match) => match[0])
    .find((open) => open.includes(`data-id="${svgNodeId(id)}"`));
  if (!tag) throw new Error(`missing rect ${id}`);
  const x = tag.match(/\bx="([^"]+)"/)?.[1];
  const y = tag.match(/\by="([^"]+)"/)?.[1];
  const height = tag.match(/\bheight="([^"]+)"/)?.[1];
  if (x === undefined || y === undefined || height === undefined) {
    throw new Error(`rect ${id} is missing x, y, or height`);
  }
  return { x: Number(x), y: Number(y), height: Number(height) };
}

function node(chart: NonNullable<ReturnType<typeof energySankey>>, id: string) {
  const found = chart.nodes.find((item) => item.id === id);
  if (!found) throw new Error(`missing node ${id}`);
  return found;
}

function link(
  chart: NonNullable<ReturnType<typeof energySankey>>,
  source: string,
  target: string,
): number {
  const found = chart.links.find(
    (item) => item.source === source && item.target === target,
  );
  if (!found) throw new Error(`missing link ${source} → ${target}`);
  return found.megawattHours;
}

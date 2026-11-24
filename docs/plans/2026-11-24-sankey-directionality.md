# Sankey directionality

Thermo-nuclear: Approve. Reuse `energySankey` and `renderSankeySvg`. No new module, gold table, contract field, or dependency.

Spec: [docs/specs/2026-11-24-sankey-directionality-design.md](../specs/2026-11-24-sankey-directionality-design.md).

## Background

Signed HVDC import is already in the graph. National fuel nodes and a cable column to the right of both islands hide net direction. Split fuels by island. Keep North Island above South Island. Draw the cable as a vertical hop in the island column.

## Files

- Modify: [site/src/lib/sankey.ts](../../site/src/lib/sankey.ts) — `nodeId("fuel", fuel, island)`; caption and summary name northward or southward
- Modify: [site/src/lib/sankey-svg.ts](../../site/src/lib/sankey-svg.ts) — three columns; two rows; cable between island bars; vertical ribbons
- Modify: [site/src/lib/sankey.test.ts](../../site/src/lib/sankey.test.ts) — split fuels, hop direction, geography, copy without `NI`/`SI`
- Modify: [site/src/components/EnergySankeyChart.astro](../../site/src/components/EnergySankeyChart.astro) — caption from helper

## Commit boundaries

One slice: graph, layout, copy, tests. Do not commit unless asked.

## Closed Considerations

- Follow-the-cable column swap and South-Island-always-left: rejected in the spec.
- Gross both-way transfer: out of scope.
- Table columns: unchanged (signed cable import stays).

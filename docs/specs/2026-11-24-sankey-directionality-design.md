# Sankey directionality: island rows and net cable hop

- Status: accepted
- Date: 2026-11-24
- Author: Josh McArthur / Gridwatch

## Objective

The daily energy Sankey shows each island's own generation and load, and the day's net Cook Strait transfer as a hop between them, instead of both islands feeding a shared pool.

## Background

Gold already has signed HVDC import per island ([ADR-0018](../adr/0018-energy-balance.md), [ADR-0016](../adr/0016-hvdc-flows.md)). Positive import means the island receives over the link. On a typical northward day the South Island figure is negative (net export) and the North Island figure is positive (net receipt). Link losses equal minus the two imports.

The site chart already turns those signs into links (`island → cable` for export, `cable → island` for import). Two layout choices hide that story:

1. Fuel nodes are national. One Hydro node links to both islands, so generation looks like a shared pool.
2. Both island bars sit in one column, with the cable to their right. North Island import draws backward. Both islands look like they feed in.

Brief §8.1 still holds: this is a set of regional balances, not a trace of electrons from a station to a house.

## Goals

- A reader can see which island generated which fuel.
- A reader can see which way the cable ran for the day (net).
- North Island stays above South Island on every day.
- Gold tables and the site JSON contract stay unchanged.

## Non-goals

- Gross both-way transfer when the link reversed inside the day. The chart stays on daily net.
- Reordering columns so the exporter is always left.
- New gold columns, a contract version bump, or a client-side chart library.
- Changing the accessible table columns.

## Design

### Graph

Built in [`site/src/lib/sankey.ts`](../../site/src/lib/sankey.ts) from `generation.daily` (already keyed by fuel and island) and `sankey.islands`.

- Fuel node id is `fuel:{fuel}:{island}` (battery included). South Island hydro is not mixed with North Island hydro.
- Links: that fuel → that island → that island's estimated load.
- Residual: unchanged. Positive residual leaves the island. Negative residual enters it.
- Cable: still one `hvdc` node. Exporting island → cable → importing island. Losses leave the cable.
- Idle day (both imports zero or null): omit the cable node, as today.
- Missing section: no chart, as today.

### Layout

Drawn in [`site/src/lib/sankey-svg.ts`](../../site/src/lib/sankey-svg.ts). Static SVG ([ADR-0017](../adr/0017-static-svg-charts.md)).

Three columns: fuels | islands and cable | load, residual, losses.

Two rows that do not swap:

- Top: North Island fuels, North Island bar, North Island load (and that island's positive residual).
- Bottom: South Island fuels, South Island bar, South Island load (and that island's positive residual).

The cable sits between the two island bars in the middle column, so net transfer is a vertical hop. On a southward day the hop reverses. Positions stay put. Losses sit on the right, aligned with the cable.

One scale for the whole chart, so a megawatt-hour is the same thickness in both rows. Fuel colours stay the current CSS variables. The legend still has one swatch per fuel colour, not one per island.

### Copy

The figure caption and `sankeySummary` name the day's net direction in words (northward or southward), not `NI` / `SI`. The method note still says the chart is regional balances, not generator-to-consumer flows. The table keeps signed cable import.

The HVDC explainer can keep using this chart. It already describes northward flow on 27 July.

## Alternatives considered

- **Follow the cable (exporter left, importer right).** Flow never draws backward, but island positions swap on a southward day. Rejected: geography must stay put.
- **South Island always left.** Usual days read well; southward days draw backward. Rejected: same geography requirement.
- **Two stacked mini-Sankeys.** Clearer isolation, weaker as one national picture. Rejected.
- **Gross both-way cable bands.** Would need period sums of northward and southward energy, not the day net. Out of scope.

## Tests

Extend [`site/src/lib/sankey.test.ts`](../../site/src/lib/sankey.test.ts):

- Hydro on both islands is two nodes. No link from South Island hydro to North Island.
- Northward gold (#23 base case): South Island → cable → North Island, losses off the cable, no North Island → cable.
- Southward synthetic: the hop reverses.
- Layout: North Island row above South Island; cable between them in Y; cable x matches the island column.
- Legend still one Hydro swatch.
- Missing section unchanged.

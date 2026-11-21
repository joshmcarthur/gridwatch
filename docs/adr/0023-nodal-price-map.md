# ADR-0023: Nodal price map lives on its own page

- Status: Proposed
- Date: 2026-11-21
- Issue: [#49](https://github.com/joshmcarthur/gridwatch/issues/49)

This records a recommendation. It is not accepted. Do not build the map until the owner says go. Do not close #49.

## Context

[#49](https://github.com/joshmcarthur/gridwatch/issues/49) asks for a map of New Zealand with node locations from Mappings and Geospatial ([#7](https://github.com/joshmcarthur/gridwatch/issues/7)), coloured by price for a selected trading period, large differences highlighted, and a period slider. [Brief §8.3](../brief.md) is the product reason: a map makes regional price differences immediately understandable.

The issue's first instruction is to confirm the map is still wanted and where it lives (the daily page, or its own page). The owner is unreachable, so this ADR picks defaults.

What is already true:

- The daily page already holds the generation mix (with a battery panel), the three-node price chart, and the energy-balance Sankey (HVDC). Another figure would make that page denser.
- Gold `price_periods` holds **three** reference nodes (`OTA2201`, `HAY2201`, `BEN2201`) ([ADR-0012](0012-gold-prices.md)). A map of three points is not a nodal map. Gold already computes a period price for **every** priced POC in the `poc_periods` temp table, then throws those rows away after aggregating `price_distribution`.
- The site reads prepared JSON and must not query the lake ([ADR-0014](0014-site-json-contract.md), brief 4.2 and 9.3). Silver `dispatch_energy_prices` is the source of gold prices, not a file the browser may fetch.
- Daily charts render to static SVG at build time. [ADR-0017](0017-static-svg-charts.md) does not allow client JavaScript for those charts. A period slider is the "later interactive feature" that ADR needs a new decision for.
- [ADR-0015](0015-chart-library.md) already notes that Observable Plot is weak for a nodal map.
- NSP coordinates: 374 of 750 **current** POCs in the NSP table have coordinates; 376 have none. Grid-level nodes have none. On a sample dispatch day, 18 of 246 **priced** POCs (including `HAY2201` and `BEN2201`) have no NSP row at all ([sources 3.6](../sources.md#36-mappings-and-geospatial), surprise 7). [ADR-0008](0008-entity-model.md) left a hand-kept location table for those 18 to this issue.

## Decision (defaults)

### 1. Still wanted: yes. Not on the daily page for v1

The map stays in scope. It does **not** go on `/YYYY/MM/DD/` for v1.

**Own page.** Date-scoped URL `/YYYY/MM/DD/map` (example `/2026/11/19/map`). `/prices/map` is an alias of the latest day whose prices section is `complete`. The daily page prices section links to that day's map. The daily page keeps mix, prices, HVDC/Sankey and battery, and does not grow a fifth figure.

A `/map` root with no date is rejected: the site is a daily publication ([ADR-0002](0002-daily-run-data-and-site-hosting.md)), and the map is one day's 46/48/50 periods.

### 2. Coverage: plot only POCs that have coordinates

The map draws a point only when `entity_points_of_connection` has a non-null `latitude` and `longitude` for that POC on that day. The page says so in one sentence. Do **not** invent locations for the 18 grid-level nodes. Do **not** copy a nearby NSP's coordinates from a shared three-letter site code. That is the mapping [sources 3.6](../sources.md#36-mappings-and-geospatial) already refused.

Consequence: `HAY2201` and `BEN2201` (the HVDC terminals on the daily price chart) will not appear as dots. They stay in the accessible table with a blank location. The hand-kept table left open in ADR-0008 is out of scope for v1.

`NetworkRegionShapefiles/` stay unused in v1. They are distribution-network polygons, not a coastline, and a price region has no boundary ([ADR-0012](0012-gold-prices.md)). A later choropleth can pick them up.

### 3. Data: persist `nodal_price_periods`. Do not extend `price_periods`. Do not read silver from the site

Three options were on the table. The smallest path that respects the contracts:

| Option | Why not / why |
| --- | --- |
| Extend gold `price_periods` to every POC | `price_periods` is the gold-prices sentinel, has `price_region`, and feeds spreads, the daily summary, site `prices.nodes`, and the ADR-0019 detectors. Completeness today is "the three reference nodes have a row". Growing it would make almost every period incomplete and would break those consumers. |
| Site reads silver `dispatch_energy_prices` | Forbidden by ADR-0014. Silver is irregular publishes, not a period price. The slider must not fetch EMI from the browser. |
| **Add gold `nodal_price_periods`** | **Chosen.** Gold already builds `poc_periods` (rule B, every POC, every period that has a silver row) inside `publisher/src/gold/prices.ts`. Persist that table. Same module, same rule B, one `ANALYSIS_VERSION` bump. Join WGS84 coordinates from `entity_points_of_connection` at **export** time. Do not store lat/lon on the gold price row: they belong to the mapping snapshot. |

One row per POC per trading period: `point_of_connection`, `trading_period`, period price, min/max, `rows_present`, `has_proxy_price`, the gold stamp columns. No `price_region`. Null price when silver has no row for that POC in that period.

This is the `gold_nodal_prices` option under the gold table naming rule (no `gold_` prefix, [ADR-0011](0011-gold-table-pattern.md)).

### 4. Basemap: LINZ coastline, CC BY 4.0, committed GeoJSON

**Layer.** [NZ Coastlines and Islands Polygons (Topo 1:250k)](https://data.linz.govt.nz/layer/51559-nz-coastlines-and-islands-polygons-topo-1250k/), LINZ Data Service layer 51559. Mean high water. Scale fits a national SVG. The 1:50k layer (51153) is the maintained Topo50 product but is too dense (9,057 polygons) until simplified; the 1:500k layer (51560) is **deprecated**. Clip to the mainland and Rakiura / Stewart Island. The grid does not serve Rēkohu / Chatham or the subantarctic islands; do not draw them.

**Licence.** Creative Commons Attribution 4.0 International, same family as EMI ([LINZ attribution](https://www.linz.govt.nz/products-services/data/licensing-and-using-data/attributing-linz-data)). Required credit, because the file will be adapted (simplified, clipped, projected):

> Contains data sourced from the LINZ Data Service licensed for reuse under CC BY 4.0

Put that sentence on the map page and on Terms. Record it in [sources §5](../sources.md#5-licence-and-attribution).

**How it ships.** Commit a simplified GeoJSON (or TopoJSON) in the site. No tile server. No runtime fetch. Project once at build time. The map page may add a small D3-geo (or equivalent) subset for that projection; do not switch the daily charts off Plot, and do not add ECharts ([ADR-0015](0015-chart-library.md)).

**Rejected.** Natural Earth 1:10m (public domain, [terms](https://www.naturalearthdata.com/about/terms-of-use/)): NZ is too coarse for node dots. OpenStreetMap tiles: ODbL, and a tile server. Mapbox / Google: proprietary.

### 5. Slider: client-side over the day's site JSON

The exporter writes every period of the day (46, 48 or 50) into the site JSON. The slider only recolours the dots already on the page. It does **not** fetch EMI, silver, or gold from the browser.

Scripts off: the page shows one period as a static SVG (default: the period with the largest `price_distribution` range that day, else period 1) plus the sortable table. That keeps the ADR-0017 text alternative. Scripts on: a range input walks the period axis. This page is allowed a small island of client JavaScript for that slider. Daily-page charts stay static.

**Highlight.** A node is "large difference" in a period when its period price is outside that period's p05–p95 in `price_distribution` (already in the day JSON). Draw it with a larger mark. Do not invent a dollar threshold on top.

### 6. ADR-0014: optional additive section

When built, add an optional `nodal_map` section on `SiteDay`, same pattern as `sankey` and `observations`. Absence means "not built". Adding it does **not** bump `SITE_CONTRACT_VERSION`. `EXPORT_VERSION` bumps when the exporter starts writing it.

Columnar, DST-safe, aligned to `periods`:

- `pocs`: `point_of_connection`, `latitude`, `longitude`, `island`. Only POCs with coordinates.
- `price`: one array per POC, length of the period axis, `$/MWh` to 2 decimals, null when missing.
- `proxy_periods` per POC.
- Provenance and `state` as for other sections (`complete` / `incomplete` / `missing`).

Do not grow `prices.nodes`. That array stays the three reference nodes.

The sortable table is the accessible alternative ([#49](https://github.com/joshmcarthur/gridwatch/issues/49) acceptance). It lists every priced POC for the selected period, including unlocated ones, with a blank location.

## Owner questions

Defaults in brackets. Reply only if you want a different default.

1. Still wanted, and on its own page (`/YYYY/MM/DD/map`, `/prices/map` for latest), not on the daily page v1? **[yes]**
2. Plot only POCs with coordinates, say so on the page, and do not invent locations for grid nodes (HAY and BEN stay off the map)? **[yes]**
3. Persist gold `nodal_price_periods` from the existing `poc_periods` temp table; do not extend `price_periods`; do not have the site read silver? **[yes]**
4. LINZ Topo 1:250k coastline, CC BY 4.0, committed GeoJSON, no tile server? **[yes]**
5. Client-side slider over the day's 46/48/50 periods in the site JSON; no EMI fetch; no-JS fallback is one static period plus a table? **[yes]**
6. Optional ADR-0014 section `nodal_map`; do not bump `SITE_CONTRACT_VERSION`? **[yes]**

## Consequences

- The daily page stays a mix / prices / Sankey story. The map is a drill-in.
- Building the map is a later issue: a fifth gold prices table, an optional site-JSON section, a map page, a LINZ extract, and a small client slider. None of that is in this PR.
- `ANALYSIS_VERSION` for gold prices will need a bump when `nodal_price_periods` is added, because the module's output changes.
- The map will never show the two HVDC terminals until someone accepts a location source for grid nodes.
- A later interactive feature on the daily page is still forbidden by ADR-0017. Only this map page gets the slider exception.

## What this PR does not do

Does not build the map. Does not add a gold table, a site-JSON field, a page, or a GeoJSON. Does not close #49.

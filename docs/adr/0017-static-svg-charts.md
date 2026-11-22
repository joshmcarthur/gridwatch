# ADR-0017: Charts render to static SVG at build time

- Status: Accepted
- Date: 2026-11-21

## Context

[ADR-0015](0015-chart-library.md) chose Observable Plot for the daily charts. The site is a static Astro build, and it has no client framework. [#27](https://github.com/joshmcarthur/gridwatch/issues/27) is the first chart. It needs a text alternative and hover values. A chart drawn in the browser would add client JavaScript to every daily page, and it would hide the numbers from a reader with scripts off.

The Landscape design rules for data colour say that battery is storage. It should show below the zero line or in its own panel, never inside primary generation.

## Decision

- Plot draws each chart during `astro build`. It uses a DOM from `linkedom`, and it writes an SVG string into the page. No chart code runs in the browser.
- `@observablehq/plot` and `linkedom` are runtime dependencies of the site. `astro build` runs the chart code, so the build needs them in a production install. There is no fallback renderer. If `linkedom` fails, the build fails.
- Hover values are native SVG `<title>` elements, one per period. The browser shows them as tooltips.
- Each chart has a `<figure>` with a `role="img"` SVG, labelled by a title and a one-sentence summary. A `<details>` element holds the same numbers as a table. The table has a caption paragraph, linked by `aria-labelledby`, and `scope` on each header.
- Fills and the 1px separator stroke use CSS variables from the Landscape tokens. Separators use `var(--color-card)`, so they match the card background.
- Layers are listed in the legend from the top of the stack down. The order matches what a reader sees.
- Area edges are straight lines between periods. A step shape is a possible later change.
- The time axis shows the hour only (`00`, `03`, ...). Its title says "Hour (New Zealand time)". Full times are in the table and in the hover text.
- Sizes: the SVG has a logical width of 330 units and 14px text. On desktop it is capped at 480px wide. Measured on the built page, axis text is about 12px at 375px and about 20px at 1280px. On desktop the SVG scales up to its 480px cap, so its text is larger there than on phones.
- Battery is storage. It is never in the stacked area or the primary total. It has its own panel under the stack ([#92](https://github.com/joshmcarthur/gridwatch/issues/92)), the table's last column, and a caption sentence. That matches the Landscape rule.

## Consequences

- A daily page works with scripts off. The chart and its table are in the HTML.
- The page has no chart JavaScript to load or to keep in step with the data.
- Tooltips use the browser's native tooltip. They appear after a short delay and cannot show rich layout. That is accepted for version 1.
- Each chart adds its SVG to the page HTML. A daily page with many charts grows by that amount.
- Desktop axis text is large (about 20px) because the SVG scales up to its cap. Reducing the cap changes the desktop size, not the phone size.
- Battery is a second SVG in the generation figure, not a band in the stack. A day with no battery discharge still shows the panel (a flat line), so the table column has a matching chart.
- A later interactive feature needs a new decision. This ADR does not allow client JavaScript for charts on the daily page.

## Amendment (#28): price charts

Amended 2026-11-21. The price chart is the second figure on the daily page. These points extend the decisions above. They do not change them.

- **Two SVGs in one figure.** The price chart has two SVGs: period prices, and spreads. Each has its own axes, title and summary (`price-chart-*` and `price-spread-chart-*` ids). The spreads never share an axis with prices. A spread of about 10 would be flat on a price axis near 100. Both SVGs sit in one `ChartFigure`, with one legend, one caption and one numbers table.
- **Shared frame.** `ChartFigure.astro` is the only figure frame. `chart-svg.ts` writes the SVG title, summary and `role="img"`. Styles are scoped to each component. There is no global chart stylesheet, because global table styles would reach every table on the site.
- **Colour and dash for more than one node per island.** North Island is Tarn and South Island is amber. OTA2201 and HAY2201 are both North Island, so both are Tarn. OTA2201 is solid and HAY2201 is dashed. BEN2201 is solid amber. Spread lines use ink, not island colour: HAY-BEN is solid and OTA-HAY is dashed in muted ink.
- **OTA-BEN is not drawn.** It is the sum of the other two spreads. The table and the hover text show it, taken from the contract.
- **Y domain from period prices.** The price axis covers the plotted period prices, with zero included. It does not use `daily.max_price`, which is a raw row price ([ADR-0012](0012-gold-prices.md)). A short spike shows in the highest-price sentence and the table, not as the top of the axis.
- **Gaps.** A null price breaks only its own node line. A valid period whose neighbours are both null gets a dot, because a line draws nothing for a single point. A proxy period gets an open marker.

Consequence: a daily page with prices adds two SVGs. Each figure has one table, so the numbers are not repeated per SVG.

## Amendment (#209): episode clock bands

Amended 2026-11-23. A daily price or spread SVG may draw a static `Plot.rectX` band for each episode whose members are energy prices or spreads. The band uses `start_utc` and exclusive `end_utc`. It is not client JavaScript. Reserve episodes stay unmarked until a per-period reserve chart exists.

## Amendment (#49): nodal map page may use a slider

Amended 2026-11-22. The nodal price map ([ADR-0023](0023-nodal-price-map.md)) is a separate page, not a daily-page chart. These points extend the decisions above for that page only.

- **Static first.** The build writes one SVG for the default period (largest `price_distribution` range, else period 1) and a table of every priced POC. Scripts off, that is the page.
- **Client slider.** A small island of JavaScript on `/YYYY/MM/DD/map` (and `/prices/map`) may recolour the existing dots and re-sort the table as the reader moves a range input. It must not fetch EMI, silver or gold. The payload is the day's site JSON, inlined.
- **No Plot, no tiles.** The coastline is committed GeoJSON. Projection is a small equirectangular fit at build time. Daily-page charts stay Plot, static, no chart JavaScript.

Daily-page charts stay under the original rule: no client JavaScript.

## Amendment (#92): battery panel

Amended 2026-11-21. The generation mix figure now has two SVGs: the primary stack (`generation-mix-chart-*`) and battery (`generation-battery-chart-*`). Battery stays out of `STACK_ORDER` and out of the primary total. The battery SVG is shorter (120 units high against the 260-unit stack). Hover text and the table column still name it stored power. This closes the v1 departure from the Landscape rule.

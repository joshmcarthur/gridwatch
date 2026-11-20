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
- Sizes: the SVG has a logical width of 400 units and 14px text. On desktop it is capped at 480px wide. Measured on the built page, axis text is 9.8px at 375px and 16.8px at 1280px. A 12px phone size would need a logical width near 327 units. That was not chosen, because it makes desktop text larger.
- Battery is in the table's last column and in one caption sentence. It is not drawn in the chart for v1. This departs from the Landscape rule that battery shows below the zero line or in its own panel. The follow-up is [#92](https://github.com/joshmcarthur/gridwatch/issues/92).

## Consequences

- A daily page works with scripts off. The chart and its table are in the HTML.
- The page has no chart JavaScript to load or to keep in step with the data.
- Tooltips use the browser's native tooltip. They appear after a short delay and cannot show rich layout. That is accepted for version 1.
- Each chart adds its SVG to the page HTML. A daily page with many charts grows by that amount.
- Phone axis text is small (9.8px). The table holds the same numbers at full size.
- Battery is not visible in the chart until #92 is done. That departs from the design rule until then.
- A later interactive feature needs a new decision. This ADR does not allow client JavaScript for charts.

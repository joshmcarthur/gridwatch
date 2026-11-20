# ADR-0017: Charts render to static SVG at build time

- Status: Accepted
- Date: 2026-11-21

## Context

[ADR-0015](0015-chart-library.md) chose Observable Plot for the daily charts. The site is a static Astro build, and it has no client framework. [#27](https://github.com/joshmcarthur/gridwatch/issues/27) is the first chart. It needs a text alternative and hover values. A chart drawn in the browser would add client JavaScript to every daily page, and it would hide the numbers from a reader with scripts off.

## Decision

- Plot draws each chart during `astro build`. It uses a DOM from `linkedom`, and it writes an SVG string into the page. No chart code runs in the browser.
- Hover values are native SVG `<title>` elements, one per period. The browser shows them as tooltips.
- Each chart has a `<figure>` with a `role="img"` SVG, labelled by a title and a one-sentence summary. A `<details>` element holds the same numbers as a table, with `scope` on each header.
- Colours come from the Landscape CSS variables. Plot receives the variable names, so one token change updates the chart.
- `linkedom` is a development dependency of the site. The build calls it. If it fails, the build fails. There is no fallback renderer.

## Consequences

- A daily page works with scripts off. The chart and its table are in the HTML.
- The page has no chart JavaScript to load or to keep in step with the data.
- Tooltips use the browser's native tooltip. They appear after a short delay and cannot show rich layout. That is accepted for version 1.
- Each chart adds its SVG to the page HTML. A daily page with many charts grows by that amount.
- A later interactive feature needs a new decision. This ADR does not allow client JavaScript for charts.

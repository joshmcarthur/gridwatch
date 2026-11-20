# ADR-0015: Chart library for the Astro site

- Status: Accepted
- Date: 2026-11-20

## Context

[#25](https://github.com/joshmcarthur/gridwatch/issues/25) needs a chart library that later daily pages reuse. The brief lists D3, Observable Plot or ECharts ([brief §11](../brief.md)). The first charts are a stacked area of generation by fuel ([#27](https://github.com/joshmcarthur/gridwatch/issues/27)) and a line of wholesale prices ([#28](https://github.com/joshmcarthur/gridwatch/issues/28)). A Sankey ([#30](https://github.com/joshmcarthur/gridwatch/issues/30)) and a nodal map ([#49](https://github.com/joshmcarthur/gridwatch/issues/49)) come later. The site is a static Astro build. Charts must stay accessible, and the bundle must stay small.

The Landscape design system already fixes fuel colours, the North/South island pair, 1px white separators on stacked layers, and labels or a legend on every chart. The library must not replace that palette.

## Decision

Use **Observable Plot** for the first charts.

| Need | D3 | Observable Plot | ECharts |
| --- | --- | --- | --- |
| Stacked area and line | Yes, more code | Yes, small API | Yes |
| Sankey | Yes (`d3-sankey`) | No | Yes |
| Nodal map later | Yes | Weak | Yes |
| Static Astro build | Yes | Yes | Yes, heavier |
| Bundle size | Large if you pull lots of modules | Small | Large |
| Accessibility | SVG, you build the text alternative | SVG, same | Canvas by default, weaker |

Plot covers the first two charts with less code than D3 and a much smaller payload than ECharts. It renders SVG, so the page can keep a table or summary as the text alternative. Fuel and island colours stay in CSS variables from the Landscape tokens; Plot only consumes them.

The Sankey is not Plot's job. When [#30](https://github.com/joshmcarthur/gridwatch/issues/30) starts, add `d3-sankey` (or a small D3 subset) for that diagram only. Do not switch the area and line charts to ECharts to get a Sankey.

Do not add the Plot package until a chart issue needs it.

## Consequences

- [#27](https://github.com/joshmcarthur/gridwatch/issues/27) and [#28](https://github.com/joshmcarthur/gridwatch/issues/28) install `@observablehq/plot` and draw SVG.
- [#30](https://github.com/joshmcarthur/gridwatch/issues/30) may add `d3-sankey`. That is an extra dependency, not a change of this decision.
- ECharts is rejected for the default stack: the canvas default fights the Landscape SVG look and the text-alternative rule.

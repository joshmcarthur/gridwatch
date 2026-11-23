# Explainers

Status: **Accepted** (owner, 24 November 2026, Pacific/Auckland). This is not an ADR.

An explainer teaches how a part of the market works ([brief §10](brief.md)). A word that only needs a definition stays in the glossary, on About, or on How. Published words follow [`site-copy.md`](site-copy.md).

This supersedes the docs-only proposal in [#127](https://github.com/joshmcarthur/gridwatch/pull/127). The pages are in the site.

## Accepted defaults

1. **First explainer: nodal pricing**, at `/explainers/nodal-pricing/`.
2. **Structure: brief §10’s sections**, in one Markdown file in an Astro content collection under `site/`. Not a CMS. Visual and Historical example are optional.
3. **A day and a chart only when they show the concept.** Do not attach a neighbouring chart. Do not attach Monday 27 July 2026 when that day does not show the concept.
4. **Charts are existing daily charts** (`PriceChart`, `ReserveChart`, `GenerationMixChart`, `EnergySankeyChart`). No nodal map ([#49](https://github.com/joshmcarthur/gridwatch/issues/49)).
5. **Ship pages that teach the mechanism even when this site has no series for them.**

## Framework

One collection, one file per topic, one page template.

| Piece | Decision |
| --- | --- |
| Files | `site/src/content/explainers/<slug>.md` |
| Route | `/explainers/<slug>/`, with `/explainers/` listing the collection |
| Template | `site/src/pages/explainers/[slug].astro` |
| Data | Optional frontmatter `example_date` and `chart`. The template loads that day's site JSON through the existing contract ([ADR-0014](adr/0014-site-json-contract.md)) and must not query the lake |
| Charts | Static SVG at build time, no client JavaScript ([ADR-0017](adr/0017-static-svg-charts.md)) |
| Copy | Hand-written. Follow [`site-copy.md`](site-copy.md) |
| Nav | Footer link to `/explainers/`. Do not rewrite the homepage ([#29](https://github.com/joshmcarthur/gridwatch/issues/29)) |

Markdown, not MDX, for v1. MDX is only worth adding if a later topic needs a diagram that is not already a daily chart.

Each file uses these `h2` sections, in this order. Visual and Historical example may be absent.

1. **Simple explanation.** What a curious reader needs in a few short paragraphs. First use of every term on the page.
2. **A more technical explanation.** The mechanism, still in site-copy voice. What the data can show, and what it cannot.
3. **Visual.** Only when `chart` is set. A one-sentence caption. The template draws the matching daily chart for `example_date` when that day exists. The prose must still make sense if the figure is missing.
4. **Historical example.** Only when `example_date` is set. What that day shows, in a few numbers, with a link to `/YYYY/MM/DD/`.
5. **Links to Gridwatch data and events.** The daily page and event page when the explainer has that day. Other explainers, About, or How when it does not.

Frontmatter, at minimum: `title`, `description`. `chart` is `price`, `reserve`, `generation`, or `sankey`, and requires `example_date` (`YYYY-MM-DD`). `example_date` may stand alone.

## Topics

| Slug | Day and chart | Why |
| --- | --- | --- |
| `nodal-pricing` | 27 July 2026, `price` | Three reference-node prices and the island spread |
| `transmission-constraints` | 27 July 2026, `price` | The same spread, read as a full line |
| `instantaneous-reserves` | 27 July 2026, `reserve` | North Island slow reserve was dear that evening |
| `hvdc-link` | 27 July 2026, `sankey` | Northward Cook Strait flow sits in the energy balance |
| `wind` | 27 July 2026, `generation` | A low-wind weekday in the mix |
| `marginal-generator` | none | Offer prices are not on this site |
| `hydro-scarcity` | none | No lake level. 27 July had abundant hydro |
| `frequency-keeping` | none | No frequency-keeping price. Reserve is a different product |
| `wholesale-and-the-bill` | none | No retail rates |

Numbers quoted from 27 July must match the reconstruction in [`docs/events/2026-07-27-north-island-evening-scarcity.md`](events/2026-07-27-north-island-evening-scarcity.md). Do not quote report-only figures: lake storage 83%, the 1,170 MW link peak, the weekly wind range, or the $21,000 publish. Do not name a plant as the one that set the price. Do not call that Monday a dry year.

## Fixture-day sample

[`site/fixtures/`](../site/fixtures/) includes Monday 27 July 2026 as a copy of a real publish, plus the Unreviewed event from #42. Explainers that set `chart` for that date inject the matching daily chart. Do not substitute 2026-09-27 (DST start, synthetic reference-node prices) for this example.

- Do **not** commit a 12-month lake so an explainer can chart.
- Do **not** invent a 27 July day file. Refresh the charts by copying a gold export, then keep the event object from this sample.
- Do **not** fail the fixture build when some other `example_date` is absent from the index.
- Quote the evening figures in the Markdown so an illustrated page still reads if that day's file is missing.

## First explainer: nodal pricing

**Slug:** `nodal-pricing`. **URL:** `/explainers/nodal-pricing/`.

The page explains that New Zealand sets a wholesale price at each point of connection (a node), so Auckland, Wellington and the South Island can differ in the same half hour. The three reference nodes already on the daily chart are enough: Ōtāhuhu (`OTA2201`), Haywards (`HAY2201`) and Benmore (`BEN2201`) ([ADR-0012](adr/0012-gold-prices.md), [glossary](glossary.md)). Haywards minus Benmore is the North Island / South Island spread. Ōtāhuhu minus Haywards is the split inside the North Island. Ōtāhuhu minus Benmore is in the table and hover text, not drawn ([ADR-0017](adr/0017-static-svg-charts.md) amendment).

The visual is the same two SVGs the daily page already ships: period prices, then spreads. Reuse `PriceChart`. Do not add a map. Frontmatter: `chart: price`.

### Historical example

Monday 27 July 2026. The explainer links the daily page. It does not redo the [#21](https://github.com/joshmcarthur/gridwatch/issues/21) reconstruction.

Every number quoted from that evening must match the reconstruction (period 36, 17:30–18:00 NZST):

| Node | Period-36 wholesale price |
| --- | ---: |
| Ōtāhuhu (`OTA2201`) | $3,296.04/MWh |
| Haywards (`HAY2201`) | $2,853.43/MWh |
| Benmore (`BEN2201`) | $571.46/MWh |

Do not copy the whole reconstruction into the explainer. Huntly outages, the 85-second $21,000 publish, reserve prices, and SPD cases belong on an event page, not here.

Section 5 of the nodal-pricing page links `/2026/07/27/events/394f75a3bfa948a3/`.

## Out of scope

- No CMS, no new chart library, no client JavaScript.
- No nodal map (#49).
- No lake storage series, offer prices, frequency-keeping series, or retail tariff.
- No reconstruction of #21, and no invented 2026-07-27 site JSON (the visual sample is a copy of a real publish).
- No homepage rewrite (#29).

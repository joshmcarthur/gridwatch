# Explainers: framework and first topic

Status: **Accepted** (owner, 22 November 2026, Pacific/Auckland). This is not an ADR.

Educational copy is linked to a real trading day, not a textbook ([brief §10](brief.md)). Published words follow [`site-copy.md`](site-copy.md).

This supersedes the docs-only proposal in [#127](https://github.com/joshmcarthur/gridwatch/pull/127). The pages are in the site. Do not wait for that pull request to merge.

## Accepted defaults

1. **First explainer: nodal pricing**, at `/explainers/nodal-pricing/`.
2. **Structure: brief §10’s five sections**, in one Markdown file in an Astro content collection under `site/`. Not a CMS.
3. **Historical example: Monday 27 July 2026**, the owner’s [#21](https://github.com/joshmcarthur/gridwatch/issues/21) day. Link `/2026/07/27/`. Do not wait for event pages ([#42](https://github.com/joshmcarthur/gridwatch/issues/42)).
4. **Visual: the existing daily price and spread charts** (`PriceChart`). No nodal map ([#49](https://github.com/joshmcarthur/gridwatch/issues/49)).
5. **Ship the explainer now.** Do not block on #42, #49, or #127.

## Framework

One collection, one file per topic, one page template.

| Piece | Decision |
| --- | --- |
| Files | `site/src/content/explainers/<slug>.md` |
| Route | `/explainers/<slug>/`, with `/explainers/` listing the collection |
| Template | `site/src/pages/explainers/[slug].astro` |
| Data | Frontmatter `example_date`. The template loads that day's site JSON through the existing contract ([ADR-0014](adr/0014-site-json-contract.md)) and must not query the lake |
| Charts | Static SVG at build time, no client JavaScript ([ADR-0017](adr/0017-static-svg-charts.md)) |
| Copy | Hand-written. Follow [`site-copy.md`](site-copy.md) |
| Nav | Footer link to `/explainers/`. Do not rewrite the homepage ([#29](https://github.com/joshmcarthur/gridwatch/issues/29)) |

Markdown, not MDX, for v1. The visual is the daily `PriceChart` for `example_date`, injected by the template when that day is in the site index. MDX is only worth adding if a later topic needs a diagram that is not already a daily chart.

Each file has the same five `h2` sections, in this order:

1. **Simple explanation.** What a curious reader needs in a few short paragraphs. First use of every term on the page.
2. **A more technical explanation.** The mechanism, still in site-copy voice. What the data can show, and what it cannot.
3. **Visual.** A one-sentence caption. The template draws `PriceChart` for `example_date` when that day exists. The prose must still make sense if the figure is missing.
4. **Historical example.** What that day shows, in a few numbers, with a link to `/YYYY/MM/DD/`.
5. **Links to Gridwatch data and events.** The daily page now. An event page later, when #42 has published one that matches. Missing event pages are not a blocker.

Frontmatter, at minimum: `title`, `description`, `example_date` (`YYYY-MM-DD`).

Later topics from brief §10 (marginal generator, hydro scarcity, transmission constraints, reserves, frequency keeping, the HVDC link, wind, wholesale vs the bill) use the same collection. One topic per file. Same five headings. Each points at a real day.

## Fixture-day sample

[`site/fixtures/`](../site/fixtures/) includes Monday 27 July 2026 as a copy of a real publish, plus the Unreviewed event from #42. The nodal-pricing explainer injects `PriceChart` for that date. Do not substitute 2026-09-27 (DST start, synthetic reference-node prices) for this example.

- Do **not** commit a 12-month lake so the explainer can chart.
- Do **not** invent a 27 July day file. Refresh the charts by copying a gold export, then keep the event object from this sample.
- Do **not** fail the fixture build when some other `example_date` is absent from the index.
- Quote the evening figures in the Markdown so the page still reads if that day's file is missing.

## First explainer: nodal pricing

**Slug:** `nodal-pricing`. **URL:** `/explainers/nodal-pricing/`.

The page explains that New Zealand sets a wholesale price at each point of connection (a node), so Auckland, Wellington and the South Island can differ in the same half hour. The three reference nodes already on the daily chart are enough: Ōtāhuhu (`OTA2201`), Haywards (`HAY2201`) and Benmore (`BEN2201`) ([ADR-0012](adr/0012-gold-prices.md), [glossary](glossary.md)). Haywards minus Benmore is the North Island / South Island spread. Ōtāhuhu minus Haywards is the split inside the North Island. Ōtāhuhu minus Benmore is in the table and hover text, not drawn ([ADR-0017](adr/0017-static-svg-charts.md) amendment).

The visual is the same two SVGs the daily page already ships: period prices, then spreads. Reuse `PriceChart`. Do not add a map.

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
- No event pages (#42).
- No reconstruction of #21, and no invented 2026-07-27 site JSON (the visual sample is a copy of a real publish).
- No homepage rewrite (#29).

# Explainers: framework and first topic

Proposed defaults for [#43](https://github.com/joshmcarthur/gridwatch/issues/43). This is not an ADR and it is not implemented. Do not build the pages until the owner says go.

Educational copy is linked to a real trading day, not a textbook ([brief §10](brief.md)). Published words follow [`site-copy.md`](site-copy.md).

## What this environment could see

There is no `data/gold/site/` and no `gold/price_spreads` in this checkout. The only committed daily file is [`site/fixtures/days/2026-09-27.json`](../site/fixtures/days/2026-09-27.json): the DST-start day (46 periods), with synthetic reference-node prices and a flat $10 HAY–BEN spread. That is not a historical example.

[#21](https://github.com/joshmcarthur/gridwatch/issues/21) is still waiting for the owner to pick among three candidates. A prior comment recommended **Monday 27 July 2026** (North Island scarcity, Otāhuhu $3,296 vs Benmore $571.5 at trading period 36). This note does not reconstruct that day.

## Recommended defaults

1. **First explainer: nodal pricing**, as #43 says. Brief §10 lists it first.
2. **Structure: the five brief §10 sections**, in one Markdown file in an Astro content collection under `site/`. Not a CMS.
3. **Historical example: the #21 chosen day**, once the owner picks. Fallback: an ordinary 48-period day already in `gold/site`, not a DST-change date.
4. **Visual: the existing daily price and spread charts** (`PriceChart`), not a nodal map ([#49](https://github.com/joshmcarthur/gridwatch/issues/49)).
5. **Do not wait for event pages** ([#42](https://github.com/joshmcarthur/gridwatch/issues/42)). Link to the daily page.

## Framework

One collection, one file per topic, one page template.

| Piece | Default |
| --- | --- |
| Files | `site/src/content/explainers/<slug>.md` |
| Route | `/explainers/<slug>/`, with `/explainers/` listing the collection |
| Template | `site/src/pages/explainers/[slug].astro` |
| Data | Frontmatter `example_date`. The template loads that day's site JSON through the existing contract ([ADR-0014](adr/0014-site-json-contract.md)) and must not query the lake |
| Charts | Static SVG at build time, no client JavaScript ([ADR-0017](adr/0017-static-svg-charts.md)) |
| Copy | Hand-written. Run through the humanize skill before it ships ([site-copy.md](site-copy.md)) |

Markdown, not MDX, for v1. The visual is always the daily `PriceChart` for `example_date`, injected by the template. MDX is only worth adding if a later topic needs a diagram that is not already a daily chart.

Each file has the same five `h2` sections, in this order:

1. **Simple explanation.** What a curious reader needs in a few short paragraphs. First use of every term on the page.
2. **A more technical explanation.** The mechanism, still in site-copy voice. What the data can show, and what it cannot.
3. **Visual.** A one-sentence caption. The template draws `PriceChart` for `example_date`. The prose must still make sense if the figure is missing.
4. **Historical example.** What that day shows, in numbers from the day's JSON, with a link to `/YYYY/MM/DD/`.
5. **Links to Gridwatch data and events.** The daily page now. An event page later, when #42 has published one that matches. Missing event pages are not a blocker.

Frontmatter, at minimum: `title`, `description`, `example_date` (`YYYY-MM-DD`). If that date is absent from `gold/site/index.json`, or its `prices` section is not `complete`, the build fails. Do not fall back to the 2026-09-27 fixture.

The homepage's "Understanding the market" slot ([brief §9.2](brief.md)) can list the collection when [#29](https://github.com/joshmcarthur/gridwatch/issues/29) lands. Until then, `/explainers/` and a footer link are enough. Do not block on #29.

Later topics from brief §10 (marginal generator, hydro scarcity, transmission constraints, reserves, frequency keeping, the HVDC link, wind, wholesale vs the bill) use the same collection. One topic per file. Same five headings. Each points at a real day.

## First explainer: nodal pricing

**Slug:** `nodal-pricing`. **URL:** `/explainers/nodal-pricing/`.

The page explains that New Zealand sets a wholesale price at each point of connection (a node), so Auckland, Wellington and the South Island can differ in the same half hour. The three reference nodes already on the daily chart are enough: Otāhuhu (`OTA2201`), Haywards (`HAY2201`) and Benmore (`BEN2201`) ([ADR-0012](adr/0012-gold-prices.md), [glossary](glossary.md)). Haywards minus Benmore is the North Island / South Island spread. Otāhuhu minus Haywards is the split inside the North Island. Otāhuhu minus Benmore is in the table and hover text, not drawn ([ADR-0017](adr/0017-static-svg-charts.md) amendment).

The visual is the same two SVGs the daily page already ships: period prices, then spreads. Reuse `PriceChart`. Do not add a map. #49 can come later if a later explainer needs geography.

### Historical example

**Preferred:** the day the owner chooses on #21. That issue is the known-event reconstruction; this explainer only links the daily page for that day. It does not redo the reconstruction.

If the owner picks **27 July 2026**, use it. The public trading-conduct report already records a large island split that evening, which is what a nodal-pricing page needs to point at. Gold export of that date will already produce `/2026/07/27/` ([ADR-0014](adr/0014-site-json-contract.md)).

**Fallback, if #21 is still unset when the owner says go:** the latest trading date in `gold/site/index.json` whose `prices` section is `complete`, that has 48 periods, and that is not a DST-change date. In 2026 those change dates are **5 April** (50 periods) and **27 September** (46 periods). Prefer a day whose HAY–BEN line is visible on the existing spread chart. Do not use the synthetic 27 September fixture.

When #42 later publishes an event that covers the same day, add that URL in section 5 of the same Markdown file. Do not wait for it to ship the explainer.

## Out of scope until go

- No explainer pages, collection, or footer link in this pull request.
- No CMS, no new chart library, no client JavaScript.
- No nodal map (#49).
- No event pages (#42).
- No reconstruction of #21.
- No published copy yet. The first explainer, when built, is site copy and must follow [`site-copy.md`](site-copy.md) (no "I"/"we", explain "node" and "wholesale price" on the page, no "observatory").

## Owner questions

Defaults in brackets. A blank answer means the default.

1. First explainer is nodal pricing? **[Yes]**
2. Five brief §10 sections, one Markdown file in an Astro content collection under `site/`, not a CMS? **[Yes]**
3. Historical example is the #21 chosen day, with fallback the latest complete 48-period gold day (not 5 Apr or 27 Sep 2026)? **[Yes]** If you pick 27 July 2026 on #21, that day is the example.
4. Visual is the existing daily price/spread chart, not a map? **[Yes]**
5. Ship the first explainer linked to the daily page, without waiting for #42? **[Yes]**

I will not build the collection or the nodal-pricing page until you say go.

# ADR-0029: Map-led day stories and the beat model

- Status: Accepted
- Date: 2026-11-24

## Context

Daily pages and the homepage presented the data, but did not tell the day's story. A day page opened with a rank against this site's own history ("one of the highest of the 333 earlier complete days on this site"), then method notes, empty sections and four charts with no sentence about what to look at. The homepage opened with the Electricity Authority files and what data was missing.

A prototype (`design/story-explorations/`) tried three forms on 31 October and 27 July 2026: one aligned timeline, a two-islands price map with a time slider, and an hourly forecast strip. The owner picked the map. An audit of the prototype copy found sentences that went past the data (causes, "demand", a backup price with no time attached). It also found sentences that broke the [site-copy](../site-copy.md) rule against claims about the two islands drawn from the three places. The rules below come from that audit.

The owner asked for no nested pages, because they are hard to find, and asked to keep the LLM narratives ([ADR-0027](0027-llm-narratives.md)). They add an approachable, personal layer to each day.

## Decision

### Beats

A beat is one moment in the day: `{ rule, title, from, to, fuels, places, text }`. `from` and `to` are trading periods. The text, the map and the charts all draw from the same beats. `dayBeats(day)` in `site/src/lib/day-beats.ts` computes them from the day file with fixed rules. No LLM writes a beat.

| Rule | When it fires | Default threshold |
| --- | --- | --- |
| `price_peak` | Up to two Ōtāhuhu peaks, at least 4 hours apart. The window is where the price stays above half the peak, at most 4 hours either side. The text lists the fuels that moved most in the 2 hours before the window. | Each peak is at least 40% of the day's highest or 3 times the day's median. A fuel move is at least 50 MW. |
| `price_low` | The cheapest half-hour at any of the three places, when it is outside every peak window. | – |
| `fuel_high` | Wind or solar at its daily high. | At least 10% of generation in that half-hour. |
| `step_change` | Geothermal moves and stays there for the rest of the day. | 150 MW or more, with at least 80% of the move still present at the end of the day. |
| `episode` | A detected episode ([ADR-0021](0021-episodes.md)). It joins an overlapping price peak, or becomes its own beat. The line is `episodeHeadline`, the same words the day page already used. | – |
| `cable` | South Island generation and estimated load, the MWh sent north, and how many half-hours Benmore was cheaper than Ōtāhuhu. | – |

Beat text states what the files show, and things that happened at the same time. It never states a cause. "Why" is left to the explainers (`/explainers/hvdc-link/` and others) and to the LLM narratives, which are labelled with their review status.

Prices in text name a place (Ōtāhuhu, Benmore), never "the North" or "the South". Generation can be given per island, because the files report it per island.

The headline is one of three fixed sentence shapes. The first that applies wins:

1. A spike: the highest Ōtāhuhu price is at least 10 times the day's median.
2. A gap: Ōtāhuhu averages at least 3c per kWh more than Benmore.
3. Otherwise, the share of the largest fuel.

### Cents per kWh

Wholesale prices in body copy are given in cents per kWh, the unit on a power bill. The $/MWh figure stays in tables and hover text. Under 10c shows one decimal place (`6.9c`). 10c and over shows whole cents (`17c`).

### The day page leads with the map

The day page opens with the beat headline and lede. Next comes the price map: the 220 grid points coloured by their own price, a time slider, beat buttons, each island's generation for the selected half-hour, and the cable. The existing charts follow as evidence.

The map colours use fixed bands in cents per kWh, so a colour means the same thing at every time of day:

| Band | Cents per kWh |
| --- | --- |
| Very cheap | under 3c |
| Usual | 3c to under 8c |
| High | 8c to under 20c |
| Very high | 20c and over |

The large dot for the cheapest and most expensive 5% of places stays.

### No nested pages

The map (`/YYYY/MM/DD/map/`) and event pages (`/YYYY/MM/DD/events/<id>/`) fold into the day page. Their URLs stay as small pages that redirect to the matching section of the day page (`#map`, `#event-<id>`), so old links still work. `/prices/map/` redirects to the latest day's `#map`.

### Narratives stay

An event narrative (what happened, why, what it means, [ADR-0027](0027-llm-narratives.md)) shows on the day page, in the beat for its episode, with its review status ([ADR-0022](0022-editorial-review-and-publish-flow.md)). It is the only place on the page where "why" appears in prose.

## Consequences

- One function owns the story. The text, the map and the charts cannot disagree about when something happened.
- Story text is accurate, but flatter than hand-written prose. A fixed phrase list, or an LLM day narrative written from the beats, can add warmth later without changing the facts.
- The thresholds are defaults. Changing one changes which beats a day gets, and the tests that pin those beats.
- The map shows a daily-average cable flow until the site files carry the half-hourly values. Gold already has `energy_balance_period`.
- Day pages get longer at the top and lose two kinds of subpage. Search results that point at `/map/` or `/events/` land on a redirect.

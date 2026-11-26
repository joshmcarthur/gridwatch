# ADR-0031: Day page layout G, lanes beside the map and short AI write-ups

- Status: Accepted
- Date: 2026-11-25

Amends [ADR-0029](0029-map-led-day-stories.md) ("The day page leads with the map", "Narratives stay" and the half-hourly cable consequence). Builds on [ADR-0030](0030-ai-text-labelled-not-reviewed.md).

## Context

After ADR-0029, a day page had the story at the top, then the map, then four chart sections, a row of stat cards and the day compare. The owner still found it dense and data-first. A prototype session (`design/story-explorations/data-panel.{html,md}`, untracked) tried seven layouts on 27 July and 31 October 2026. The owner picked layout D (big, readable charts), then a slimmer E, then F (lanes beside the map), then G (F with slots for short AI write-ups).

The prototype found four data traps:

- The cable beat used what the South Island sent (18,733 MWh on 31 October). The half-hourly data gives what arrived (17,888 MWh). Both are true, but a page must say which is which.
- `prices.nodes[].daily.max_price` and the reserve `max_price` are the highest single dispatch publish, not the highest half-hour. On 27 July Ōtāhuhu's `max_price` is 2,046c per kWh, and its highest half-hour is 330c.
- The site files carry no half-hourly cable flow, so the map arrow is a daily average.
- The first AI samples ran to four or five sentences. The owner found them "much more verbose than I expected".

## Decision

### Lanes beside the map

Two lanes sit in the right-hand column, under the island bars, as wide as the slider: wholesale price (Ōtāhuhu, Haywards and Benmore) and generation stacked by fuel. They share the slider's time axis, its cursor and the beat shading. One drag moves the map, the island bars and both lane cursors.

- Each lane starts with its name and one sentence from the data. The sentence states no cause.
- Legends are plain series names with the unit given once. Each lane has value ticks.
- Tooltips open on hover, tap and keyboard focus. Prices show c/kWh and $/MWh.
- When a lane has a value above 40c per kWh, the top 35% of the lane shows 40c up to the day's highest half-hour on a squeezed scale. A dashed 40c line, a tick at the top value and a legend item ("Above 40c the scale is squeezed") mark it. The owner chose this on 2026-11-25 over a stretched scale, which flattens every normal half-hour, and a broken axis, which hides the shape of a spike.
- Inside a beat that names fuels (`beat.fuels`), the generation lane, its legend and the island bars dim every other fuel.
- On a phone the two lanes come straight after the slider, and the beats follow them.

Two more lanes show only on days that need them, under the map in "Through the day":

- **Reserve price, North Island**: the higher of fast and slow reserve in each half-hour. It shows when an episode has `reserve_price_high`, or a beat names reserve.
- **Cook Strait cable**: half-hourly flow. It shows when the flow runs south for part of the day, or when a cable beat covers part of the day. The all-day cable beat does not count.

### One totals sentence and one disclosure

The stat cards go. One sentence gives only what the headline and the write-up do not say: the electricity generated, and what the cable sent and what arrived. The cable beat and the cable lane use the same two figures.

The chart sections move into one "The numbers behind this" disclosure. It holds the half-hourly tables, the charts, the plants that generated the most, where the energy went, the South Island reserve price, batteries, the day compare and the method notes ("How to read this"). `PriceChart`, `ReserveChart`, `EnergySankeyChart` and `GenerationMixChart` stay, because the explainers use them.

### Half-hourly cable in the site contract

The publisher adds each island's half-hourly cable flow to the day file, from gold `energy_balance_period`, so the half-hours sum to the day's figures. The field is optional, so the contract version stays 1 and `EXPORT_VERSION` goes up ([ADR-0014](0014-site-json-contract.md)). The map arrow then shows the selected half-hour's flow, not the day's average.

### Day and week write-ups

A day write-up sits under the headline in place of the rule-based lede. The homepage leads with the latest day's write-up and adds an "In the last 7 days" paragraph.

| Slot | Budget |
| --- | --- |
| Day write-up | At most 2 sentences, about 40 words, at most 3 numbers. A clock time counts as a number. |
| In the last 7 days | The same budget. |

Every slot picks the one or two things that matter most, gives at most one hedged cause in one short clause, does not repeat the headline, and ends without a sentence that disclaims the figures.

The model writes from a package, the same way an event narrative does ([ADR-0027](0027-llm-narratives.md)):

- **Day package**: the `dayBeats` output (titles, times, text, fuels, places, episodes), the totals, the fuel shares, and the half-hour prices and reserve prices the beats point to. Never a dispatch maximum.
- **Week package**: the last seven days, each cut to its headline, fuel shares, Ōtāhuhu and Benmore averages, highest beat, episode types and an incomplete-files flag.

`dayBeats` and the helpers it uses (episode copy, fuel labels, clock labels, cents) move from `site/src/lib/` to `publisher/src/story/`, and the site imports them as `@gridwatch/publisher/story/*`. The publisher can then build the day package from the same beats the page shows (owner, 2026-11-25). The write-up step runs after the event narratives, writes `gold/evidence/<date>/day.json` and `gold/narratives/<date>/day.json`, and the export copies the text into the day file as an optional `narrative` field. Without a range it writes the latest 7 days only, so a first run stays cheap.

`checkNarrative` checks every number and clock time against the package. A second check counts sentences, words and numbers. Text over budget is not published, and the rule-based lede shows instead. Text that fails the number check is published with a warning, as for events ([ADR-0030](0030-ai-text-labelled-not-reviewed.md); owner, 2026-11-25).

Each write-up carries the "Written by AI" label and a "What this was written from" disclosure that links to `/how/#ai`.

On an event day the standalone event box goes. The day write-up ends with a link to the full event write-up, which sits in a closed disclosure under the map. The beat's link goes to the same place.

### Homepage

The latest day's write-up leads, beside a smaller still map, with a link to the whole day. Under "Recent days", the "In the last 7 days" paragraph is followed by one row of compact date links. The incomplete-day mark stays.

### Words and colours

- **Reserve, not backup.** Labels and sentences say "reserve". A page glosses it once, as spare generating capacity kept ready in case a plant trips, and links to the glossary.
- **Darker colour tokens** for the price bands and the light fuels (wind, solar, gas, other), so each meets 3:1 against its neighbours (WCAG 2.1 1.4.11). The owner approved this on 2026-11-25. The explainer charts change colour with it.

## Rationale

Lanes beside the map put the slider, the map and the numbers for the selected half-hour on one screen, on desktop and on a phone. Layouts with the lanes below the map pushed them off screen. The conditional lanes keep a normal day to two lanes, instead of five every day. One disclosure keeps every table and chart for readers who want them, without making them the page.

Short, budgeted write-ups give the page one paragraph of warmth without going back to dense text. A package built from the beats keeps the write-up, the map and the lanes in agreement, and the number check plus the budget check are the only automatic guards, since no person reviews the text.

## Consequences

- `daily-page.a11y.test.ts` and `nodal-map.a11y.test.ts` change: section headings move into the disclosure, and the lanes add markup.
- The half-hourly cable and the day write-up are optional fields, so the site contract version stays 1 and `EXPORT_VERSION` goes up for each ([ADR-0014](0014-site-json-contract.md)). Older day files still render, with the day-average arrow and the rule-based lede.
- The publisher needs an LLM key to write day and week text. Without one, or when a write-up fails the budget, the page shows the rule-based lede, as it does today.
- A squeezed lane does not compare heights above 40c with heights below it. The ticks and tooltips give the true values.
- Changing `docs/site-copy.md` changes the narrative system prompt, so `PROMPT_VERSION` goes up with it.

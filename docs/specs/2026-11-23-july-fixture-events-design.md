# 27 July fixture: complete day plus Unreviewed event

Status: accepted for #221. Not an ADR.

## Problem

PR 213 (#42) commits `site/fixtures/days/2026-07-27.json` as a hollow day: generation, prices, reserves, Sankey, episodes and the nodal map are `missing`. Only `events` is complete, so the Unreviewed URL can exist in CI.

PR 220 (#214) commits the same path as a complete copy of a published gold day, with no `events` object.

Those two files collide on merge. #221 is the splice: keep the complete day, keep the event, do not restore the hollow file.

## Approaches

1. **Splice on PR 213 (chosen).** Branch from `origin/issue-42-event-pages`. Copy the 27 July day from `origin/issue-214-july-sample`. Attach the `events` object from the 213 fixture. Update the fixture index and the copy that still calls 27 July hollow.
2. **Stack on PR 211.** Closed as a duplicate of 213. Its base branch is gone from origin. Rejected.
3. **Wait for both merges, then fix on main.** Leaves a window where #42 can restore the hollow file. Rejected.
4. **Re-export the lake with events.** #221 forbids it. The 213 event is a checked fixture, not a live narrative file (#206 / #212). Rejected.

## Design

No publisher change. No new TypeScript module. The site already loads fixture JSON through `loadSiteDay` / `loadSiteIndex` and already renders event pages from `events.items`.

### Day file

`site/fixtures/days/2026-07-27.json`:

- Body: PR 220's complete day (48 periods, complete generation, prices, reserves, Sankey, gold episodes, nodal map, datasets).
- `events`: PR 213's object, unchanged (one item, `episode_id` `394f75a3bfa948a3`, existing claims and evening window).
- `complete`: `true`.
- Write compact JSON (`separators=(',', ':')`) plus a trailing newline, matching the other fixture days. Python `json.dumps` of the 220 day round-trips byte-for-byte; only `events` is added.

Do not invent series, prices, or narrative text. Do not change the event id, claims, or window. Gold episode ids from 220 (`7c9b0af3e9dde791` and siblings) stay; they are not the event id.

### Index

`site/fixtures/index.json`, 27 July entry:

- `complete`: `true`
- `sections`: generation, prices, sankey, episodes, reserves, nodal_map, and events all `complete`
- `export_sha256`: SHA-256 of the new day-file bytes (including the trailing newline)

The hollow 213 file already used a content hash for this path. The September and October days keep their gold exporter hashes because they are unmodified copies. After the splice, 27 July is no longer a gold copy, so a content hash is the honest digest.

`latest_complete` and the other `latest_complete_sections` dates stay on `2026-10-29` (27 July is earlier). Set `latest_complete_sections.events` to `2026-07-27` (only fixture day with events). That matches `export.ts` (`latestSection("events")`).

### Copy

Stop calling 27 July hollow:

- `site/fixtures/README.md` — complete day, evening spike, Unreviewed event
- `site/README.md` — four complete sample days, 27 July includes the event
- `docs/explainers.md` — fixture-day sample, not a gap; event URL is `/2026/07/27/events/394f75a3bfa948a3/`
- `site/src/content/explainers/nodal-pricing.md` — the daily page has that day's charts (drop "when the day's files are on this site")

Refresh rule stays: copy gold, then keep this sample's `events` object. Do not run `UPDATE_SITE_FIXTURES=1` for this directory.

### Tests

- `site/src/lib/site-data.test.ts`: 27 July is complete, 48 periods, Ōtāhuhu period 36 is `$3,296.04`, one Unreviewed event `394f75a3bfa948a3`.
- Existing `event-page.test.ts` paths stay; they already load this day.
- Tighten skip-if-built a11y tests so a fixture build must show PriceChart on the explainer and generation/price charts on `/2026/07/27/` (same checks as PR 220, which this splice makes true on the 213 stack).

## Out of scope

- Lake re-export
- LLM narrative text (#206, #212)
- Merging PR 213 or PR 220
- Changing event prose, claims, or window
- Publisher `EXPORT_VERSION` / contract bump
- Touching the #214 worktree

## Success

Checkout without gold: 27 July daily page charts the day, the Unreviewed event URL still builds, the explainer injects `PriceChart`, and the hollow evening-only file is gone.

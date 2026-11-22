# ADR-0025: Evidence packages for episodes

- Status: Proposed
- Date: 2026-11-22

## Context

A narrative must be built from structured evidence, not from free reading of raw data ([brief §7, §7.2](../brief.md), [#38](https://github.com/joshmcarthur/gridwatch/issues/38)). [#21](https://github.com/joshmcarthur/gridwatch/issues/21) is the hand-made case: its write-up shows which facts an explanation of one episode needs.

An episode is a gold row ([ADR-0021](0021-episodes.md)). That ADR says #38 reads `episodes` and does not write it. This ADR is the shape of the package and the rules of the builder. Code is in `publisher/src/gold/evidence.ts` (types, builder, reference data) and `publisher/src/gold/evidence-claims.ts` (the claim catalogue).

The package gives the editorial flow ([#41](https://github.com/joshmcarthur/gridwatch/issues/41)) and the later narrative work ([#40](https://github.com/joshmcarthur/gridwatch/issues/40)) one file per episode to read. Interpretation is not part of this ADR. The builder writes no prose.

## Decision

### On demand, one JSON file, not a gold table

`npm run build:evidence -- --date YYYY-MM-DD --episode <episode_id>` builds the package and writes `<gold>/evidence/<date>/<episode_id>.json`. The runner does not build it and the site does not read it. The site contract ([ADR-0014](0014-site-json-contract.md)) is unchanged. The file is a derived artefact: the same gold and silver give the same bytes. It has no timestamp.

A gold Parquet table of claims was considered and rejected: a claim is a small tree (value, source, `depends_on`), and the builder reads silver as well as gold. A package for every episode on every run would also cost reads that nobody uses.

### Shape

One object. Types are in `evidence.ts`; `schema_version` and `builder_version` are in the file.

| Key | Content |
| --- | --- |
| `episode` | The `episodes` row. |
| `window` | The trading date, first and last period, and the peak period. |
| `observations` | The member observations of the episode. |
| `related_observations` | Observations that corroborate the episode without being members: fuel-level `generation_low`, plant-level `generation_low`, and NI/SI `demand_high` that overlap the episode span on one of its islands ([ADR-0021](0021-episodes.md), `CORROBORATION_RULES`). Same fields as `observations`. |
| `context` | Series aligned to `window.periods`: reference-node prices (period mean and highest publish), spreads, reserve by class and island, generation by fuel and island, the top plants of the peak period, HVDC, modelled load, modelled energy-balance residual, and the dispatch publishes of the peak period. A period with no row is `null`. |
| `reference` | Plants (name, fuel, island, operator, points of connection, place) and points of connection (description, island, region, place). A field is `null` when no source row matches. |
| `completeness` | One entry for every table that the builder reads: `complete`, `partial`, `missing` or `invalid`. An absent table is `missing`. It is never skipped. |
| `claims` | See below. |
| `limits` | Fixed list: what the lake cannot show, with the issue that adds it (#44 SPD, #45 outages, #46 constraints, #47 hydro storage). |
| `links` | The daily page (`/YYYY/MM/DD/`), the site day file, and the exact gold and silver partitions read. |

Completeness of a gold input: the partition is present and its `inputs_complete` values decide (`complete` when all are true, `partial` when some are false). An empty `price_periods` or generation partition is `partial`, not `complete` (those tables must have rows). Detector observation tables may be empty on a quiet day and stay `complete`. Gold has no `_completeness` row ([ADR-0010](0010-completeness.md)). A silver input with a trading date uses its `_completeness` row, and no row is `missing`. The fleet and the network supply points are snapshots with no row: `complete` when a snapshot exists, using the newest one on or before the date, else the oldest ([ADR-0008](0008-entity-model.md)).

### Window and peak

The window is the episode span, 4 periods before and 2 after, clamped to the periods of the day (46, 48 or 50). The peak period is the period inside the episode with the highest period price at a reference node (ties take the first). Claims about a series are made for the episode's first period and the peak period. If `price_periods` is missing, the peak falls back to the episode's first period, and `completeness` shows the table as `missing`.

Plants are listed from the peak period: the top 10 by average MW, the plants named by the episode, and every North Island plant whose fuel is coal/gas or gas. An episode plant with no row in the peak period is named in `limits`.

### Claims

A claim is `{ id, label, value, unit, source, confidence, depends_on?, note? }`. `source` is `{ kind, table, query_id, period?, subject?, path }`. `query_id` is the name of the builder function that reads the value. It is not SQL. `path` is a partition under the data root, and it is always in `links`.

Ids are stable names, such as `price.OTA2201.p36`, `price_max.OTA2201.p36`, `reserve.SIR.NI.p36`, `dispatch.energy.max_publish.p36`. [#40](https://github.com/joshmcarthur/gridwatch/issues/40) can key on them. A claim whose source table is absent is not written. A claim from a row with `inputs_complete = false` carries a note.

Families: prices (period mean and highest publish), spreads, reserves, dispatch publishes, generation by fuel and plant, HVDC, modelled load and residual, the episode (severity, members), and day-level figures (daily price summary, price distribution, fuel totals, HVDC day total).

The model has three confidence levels, from brief §7.2. **The builder writes only `confirmed`.** A claim is `confirmed` when its value is read from a gold or silver row, or when it is a plain sum, difference or join of confirmed claims named in `depends_on`. Three claims are of the second kind: thermal generation (coal/gas plus gas, North Island), the thermal ramp (the rise from 4 periods before the peak to the peak), and "north dearer than south while the HVDC link carried power north". They state two values side by side and no cause. The type keeps `strong_evidence` and `possible_explanation` so that the editorial flow can add them without a schema change. In this ADR nobody writes them.

Plant absence is never a claim ("no Generation_MD row for Huntly 5" is a gap). HVDC values are 30-minute averages, and the claim notes say so. Load is the real-time dispatch model load, and the residual is the energy-balance residual of [ADR-0018](0018-energy-balance.md), not the system operator residual. Both are labelled.

### Dispatch publishes

For the peak period the package stores the highest dispatch publish: node, time (UTC), price, and seconds to the next publish of that node (or to the period end when there is none). It stores how many nodes publish at or above $20,000 and at or above $10,000 in that period. SIR is stored the same way. The count is over the whole period, not at one instant.

Each node in `EVIDENCE_CONFIG.namedEnergyNodes` also gets its highest peak-period energy publish. The list is Hepburn Road (`HEP0331`). On 27 July 2026 the package has Wellsford at $22,070.66 and Hepburn Road at $21,000 for 85 seconds ([#197](https://github.com/joshmcarthur/gridwatch/issues/197)).

### Check against #21

`publisher/src/gold/fixtures/evidence-27-july.facts.json` lists each fact of the #21 write-up (commit `bb4563c` on PR #133) as a claim, a value in a context series, or a named gap. A test builds a synthetic lake with the write-up numbers and asserts the list. The facts file is the only link to the write-up. The package contains the gold and silver facts. The facts that stay outside it: the SPD scarcity flag, the instantaneous HVDC peak, the operator residuals, outages and notices, hydro storage, weekly wind range, demand forecast error, and the Whirinaki cleared offers.

## Consequences

- One new module, one script, no new dependency, no change to the registry, the contract, `export.ts` or `datasets.ts`.
- A package is only as good as the lake. A day without hydro, load or HVDC gold gives `missing` entries and no claims for them.
- A real lake has no episode for 27 July 2026 until the detectors run on a backfill. The package is proven on a synthetic lake until then. A run on real data needs a hand-written `episodes` row.
- Changing a claim, a rule or a config value needs a `BUILDER_VERSION` bump. Changing the shape needs an `EVIDENCE_SCHEMA_VERSION` bump. `BUILDER_VERSION` is 4 after [#223](https://github.com/joshmcarthur/gridwatch/issues/223) added plant `generation_low` to `related_observations`.

## Owner questions

Each has a default. The default is what the code does now.

1. Who may write `strong_evidence` or `possible_explanation`? Default: nobody in #38. Interpretation belongs to the editorial flow ([#41](https://github.com/joshmcarthur/gridwatch/issues/41)).
2. How do report-only facts (Authority report text) enter a package? Default: deferred. They are named gaps today.
3. Is the dispatch rule above right? Decided: yes. Highest publish of the peak period, period counts at $20,000 and $10,000, and the highest publish of each named energy node (HEP0331). [#197](https://github.com/joshmcarthur/gridwatch/issues/197).
4. Is the claim id scheme right? Default: yes. #40 will key on it, so a change later is costly.
5. Window (4 before, 2 after) and the output path `<gold>/evidence/<date>/<episode_id>.json`, not published? Default: yes.
6. Does the real-lake check block the merge? Default: no, the PR records what was run.
7. Which plants does the package list? Default: top 10 by MW, the episode's plants and North Island thermal plants. A top 10 alone dropped the gas peakers on the real lake.

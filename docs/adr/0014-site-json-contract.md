# ADR-0014: Site JSON contract and export

- Status: Accepted
- Date: 2026-11-20

## Context

The site must read prepared data and must not query the lake ([brief 4.2 and 9.3](../brief.md)). [#24](https://github.com/joshmcarthur/gridwatch/issues/24) defines the file the site reads. The file for one trading day carries generation by fuel, regional prices and spreads, daily summaries, the completeness of each input, and provenance. The site and the publisher must change independently, so the file needs a contract that both sides check. [ADR-0001](0001-typescript-monorepo-and-data-layers.md) keeps the publisher and the site in one repository with no shared package. [ADR-0010](0010-completeness.md) and [ADR-0011](0011-gold-table-pattern.md) define the completeness words and the gold rules that the file reports.

## Decision

- **Layout.** The publisher writes `gold/site/days/YYYY-MM-DD.json` for each gold trading date and `gold/site/index.json` for the list of days. The types live in `publisher/src/site/contract.ts`. The site imports types and the assert helpers through the `exports` entry `@gridwatch/publisher/site-contract`. It does not import exporter or gold code. No shared package.
- **Runtime check.** `assertSiteDay` and `assertSiteIndex` check the shape of every file. They are hand-written, so the contract adds no dependency. The exporter calls `assertSiteDay` before it writes a day, so a bad day fails the run and is not published. The site calls `assertSiteIndex` when it loads the index at build time, so a bad index fails the build.
- **One file per day, columnar.** Arrays hold one value for each period of the day. Every such array has the length of the period axis, which is 46, 48 or 50 (DST-safe). A row object per value would be larger and harder to chart.
- **Sections are always present.** `generation` and `prices` each have a `state`: `complete`, `incomplete` or `missing`. An input with no gold is written as `missing` with empty arrays. It is never left out. Section `state` is `incomplete` when gold says `inputs_complete` is false, or when any input dataset is not `complete` in `_completeness`. The second check does not depend on how gold sets its flag.
- **Missing periods.** Generation lists the periods with no fuel row. Prices list the periods where any reference node has no price. A section can be `incomplete` with no missing periods, for example when the input status is `partial` but every period has data.
- **Datasets.** `datasets` lists each silver dataset that a section reads, with its `_completeness` status, missing periods and provenance. A dataset with no row reads `missing`.
- **Totals (provisional).** `generation.totals` sums the island rows. Battery is reported apart and is not in the primary total. `unmapped` is in the primary total. This follows [ADR-0011](0011-gold-table-pattern.md) while the national-total question is open. The per-island series stay, so a change to the rule edits only `publisher/src/site/export.ts`.
- **Order.** `prices.nodes` follow `REFERENCE_NODES` and `prices.spreads` follow `SPREAD_PAIRS`, north to south. The order does not depend on the order of the gold files.
- **Rounding.** Megawatt-hours and megawatts keep 3 decimals. Prices and spreads keep 2 decimals. Silver holds kWh, so the 3 decimals lose nothing. Units are in the field names, and the price is $/MWh ([ADR-0012](0012-gold-prices.md)).
- **No run timestamps.** A day has no `generated_at` or `processed_at`. A repeat export writes the same bytes.
- **Rebuild.** `export_sha256` in each index entry is the held version. It hashes the export version, the contract version, the gold fingerprint of each section and the full `_completeness` status of each input dataset. A day is rebuilt when its held version differs from the wanted one. `EXPORT_VERSION` in `export.ts` is bumped by hand when the export logic changes, like `ANALYSIS_VERSION`. `--from` and `--to` limit only which days rebuild. The manual rebuild is `publisher --force --dataset site_days`.
- **The index.** It lists every gold trading date, even outside a `--from` and `--to` range. It is written last, through a temporary file and a rename. A day that leaves gold drops out of the index. Its file stays on disk. `latest_complete` gives, for each silver dataset in the registry (partition root not set), the latest trading date whose `_completeness` status is `complete`, or null. Gold datasets are not in it. `latest_complete_sections` gives, for `generation`, `prices`, `sankey` and `episodes`, the latest index day whose section state is `complete`, or null. `sankey` and `episodes` on the index are optional so older files still validate.
- **Extension points.** `reserves`, `sankey`, `observations` and `episodes` are optional. A consumer treats absence as "not built". Adding an optional field is not a breaking change. A breaking change bumps `SITE_CONTRACT_VERSION`, and that rebuilds every day.

### Amendment (#36): detected episodes

Amended 2026-11-21. The exporter writes an `episodes` section on every day. The contract version stays 1. `EXPORT_VERSION` is 3.

- **Shape.** `items` is the day's grouped observations ([ADR-0021](0021-episodes.md)), highest severity first: id, times, member count, observation types, islands, severity. A quiet day is `complete` with an empty list. A day with no gold `episode_days` row is `missing`, never invented.
- **`complete` on the day.** Still generation and prices only.
- **Index.** `sections.episodes` and `latest_complete_sections.episodes` are optional so older files still validate.

### Amendment (#97): energy balance and HVDC transfer

Amended 2026-11-21. The exporter writes a `sankey` section on every day. The contract version stays 1: the field was already an optional extension. `EXPORT_VERSION` is 2.

- **Shape.** Per island (`NI`, then `SI`): generation, HVDC import, grid load (modelled), residual, residual as a percent of load, and `inputs_complete`, in MWh for the day. Link losses sit on the section, not on an island. Residual keeps its sign. Units are in the field names.
- **State.** `missing` when gold has no `energy_balance_period` partition (the HVDC month lag, or any other missing input of the balance). It is never zeros. `incomplete` when gold `inputs_complete` is false. `complete` otherwise. The energy-balance inputs are gold tables, so they have no `_completeness` row of their own.
- **No invented transfer.** HVDC gold without an energy-balance row does not fill the section. The site shows "not published yet".
- **`complete` on the day.** Still generation and prices only. Sankey follows the HVDC month lag, so a recent day can be complete for generation and prices while sankey is `missing`.
- **Provenance.** Each section records `analysis_version`, `inputs_sha256`, `silver_tables` and `gold_tables`. Each dataset records its `bronze_sha256s`.

## Consequences

- The site builds against one file shape, and a contract change shows in the diff of the committed sample day (`site/fixtures/`).
- A gold fix reaches the site only when `ANALYSIS_VERSION` changes, as for the other gold tables.
- The index grows by about 0.2 KB for each day. It is one file, so a long backfill makes it large. If it reaches a few hundred KB, a later issue shards it by year.
- `totals` may change when the national-total question is settled. That change is a rule change in `export.ts`, not a contract change.
- The validator is hand-written. A schema file is a separate decision if the site needs one.
- A day in the last month of the HVDC lag has `sankey.state = missing`. The site must not treat that as zero transfer.

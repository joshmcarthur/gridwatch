# ADR-0018: Energy balance by island

- Status: Accepted
- Date: 2026-11-21

## Context

The Sankey ([#30](https://github.com/joshmcarthur/gridwatch/issues/30)) needs an energy account for each island. The brief says to check the accounting before the chart, and to show any unexplained difference openly ([brief §8.1 and §16](../brief.md)). [#23](https://github.com/joshmcarthur/gridwatch/issues/23) asks for the table. The network is meshed, so the table describes regional energy balances. It does not describe flows from a generator to a consumer.

Three gold tables feed it. `generation_by_fuel_period` is metered generation by island ([ADR-0011](0011-gold-table-pattern.md) generation tables). `hvdc_transfer_period` is metered transfer at the two link terminals ([ADR-0016](0016-hvdc-flows.md)). `grid_load_period` is RTD (real-time dispatch) model load at points of connection, from Nodal Prices and Volumes ([sources 3.3](../sources.md#33-nodal-prices-and-volumes)). No source gives metered consumption. The gold-on-gold join follows [ADR-0011](0011-gold-table-pattern.md).

## Decision

### Tables

`publisher/src/gold/energy-balance.ts`, `ANALYSIS_VERSION = 1`. The sentinel is `energy_balance_period` (key `island`, `trading_period`). `energy_balance_day` has the key `island`, `trading_date`. Each date has one row per island (`NI` and `SI`), and the period table has one row per island and per period.

Inputs: gold `generation_by_fuel_period`, gold `hvdc_transfer_period`, gold `grid_load_period`. The module joins those tables and subtracts. It does not read silver. Grid load is published first, from silver `nodal_prices_and_volumes` and `entity_points_of_connection` (`publisher/src/gold/grid-load.ts`). Registry order is the DAG ([ADR-0011](0011-gold-table-pattern.md)).

| Column | Meaning |
| --- | --- |
| `trading_date`, `trading_period`, `event_start_utc`, `event_end_utc` | As in [ADR-0003](0003-time-column-naming.md). The day table has `trading_date` only. |
| `island` | `NI` or `SI`. |
| `generation_mwh` | Metered Generation_MD energy of the island, all fuels, battery included. Null when the island has no generation row in the period. It is not 0. |
| `hvdc_import_mwh` | Energy that the island receives over the link. `NI` = `north_island_received_mwh`. `SI` = `-south_island_sent_mwh`. The sign is right in both directions. |
| `load_mwh` | Grid load (modelled), from `grid_load_period`. See below. |
| `load_intervals` | How many 5-minute RTD intervals gave the load of the period (0 to 6), from `grid_load_period`. |
| `residual_mwh` | `generation_mwh + hvdc_import_mwh - load_mwh`. Null when any term is null. |
| `residual_pct_of_load` | `residual_mwh / load_mwh` as a percentage. Null when the residual or the load is null or the load is 0. |
| `analysis_version`, `inputs_sha256`, `inputs_complete` | The ADR-0011 stamp. |

The table has no link-loss column and no battery column. The link loss is not a term of an island. With `NI import` and `SI import` as above, the link loss is `-(NI import + SI import)`. It equals `losses_mwh` in `hvdc_transfer_period`. So the NI residual and the SI residual add up to national generation, minus load, minus link losses.

### Load: modelled, not metered

**Grid load (modelled)** is the RTD model load at grid exit points, net of embedded generation behind them, plus dispatchable and battery load. It is not metered consumption. Docs and site copy must not call it "consumption". `grid_load_period` and `grid_load_day` hold it.

- The sum is over all nodal rows of the island: point of connection rows and unit rows. Unit rows carry battery and dispatchable load.
- Each interval uses the latest RTD case: rows with `case_type = 'RTD'`, partitioned by `event_start_utc` (UTC, never local time, because the repeated DST hour shares local times), ordered by `source_run_at` then `case_id`, descending. The case id breaks ties, so the choice is deterministic.
- Period load = the mean of the interval total MW over the intervals that exist for that island, times 0.5 hours. Every trading period is 30 minutes, also on a DST day, so 0.5 is fixed. The source omits about ten intervals a day, so a period is not required to have 6. A period with no interval for the island has null load. It is not 0.
- The island is the `island` of `entity_points_of_connection` only. The nodal `Island` string is not a fallback. Load that has no island, or an island other than `NI` or `SI`, goes to neither row, and sets `inputs_complete = false` on every row of the date in `grid_load_*`. The energy-balance date inherits that flag from the gold load row.

### Residual: never adjusted

The residual is a column. Gold does not adjust, clamp or spread it. These terms stay inside it:

- Transmission losses. Load at grid exit points is measured at the transmission boundary, so the losses between generation and that boundary are not in the load. Distribution losses are inside the load.
- Generation that Generation_MD omits or zero-fills while RTD dispatches it. Classes `omission` and `zero-fill` in the [sources 3.5 coverage table](../sources.md#35-generation_md) (issue [#99](https://github.com/joshmcarthur/gridwatch/issues/99) / PR #101). Gridwatch does not fill them.
- A definition difference between the two sources: the same energy under two point-of-connection codes, or a fuel label that does not match dispatch. Class `definition` in that table. Gold sums by the point of connection of each source, so the island sums are right.
- Embedded generation counted twice. Generation_MD includes embedded plants, and grid-exit load is already net of them.
- A metered-versus-dispatch difference. Class `calibration` in that table. Generation_MD is above RTD at large fully metered stations. The cause is not confirmed. It is a larger term in the residual than any single omission.
- Other unresolved differences. Class `unresolved` in that table.
- The difference between RTD model load and metered generation, which has not been separated from the terms above.

### Completeness

A period row is `inputs_complete` when all of these hold:

- every upstream `generation_by_fuel_period` row of the period has `inputs_complete`, and the `hvdc_transfer_period` and `grid_load_period` rows have it;
- no generation (`generation_by_fuel_period`) is without an island. Such energy goes to neither row and flags every row of the date;
- the residual is not null.

A day term is a sum only when all periods have the term: `CASE WHEN count(term) = <46, 48 or 50> THEN sum(term) END`. A partial sum would give a false residual, so the day residual is built from the day terms. The day `inputs_complete` is true only when every period row of the island is true. A date with no `hvdc_transfer_period` partition is not wanted, and gold writes no row for it. HVDC_Flows has a month lag, so energy balance has the same lag.

## Consequences

- The Sankey can show the residual as its own band, with units and a plain label.
- A reader sees modelled load, so the Sankey must say "modelled". The glossary has entries for **Grid load (modelled)**, **Energy-balance residual** and **HVDC import**.
- The size of the typical and the worst residual is in the comment on [#23](https://github.com/joshmcarthur/gridwatch/issues/23).
- Owner on [#107](https://github.com/joshmcarthur/gridwatch/issues/107) (2026-11-21): the residual is acceptable for a public Sankey when it is its own band and labelled as modelled load, not consumption. Generation_MD omissions stay visible in the residual and in the Sankey note. [#30](https://github.com/joshmcarthur/gridwatch/issues/30) can start.

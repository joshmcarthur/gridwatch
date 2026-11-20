# ADR-0018: Energy balance by island

- Status: Accepted
- Date: 2026-11-21

## Context

The Sankey ([#30](https://github.com/joshmcarthur/gridwatch/issues/30)) needs an energy account for each island. The brief says to check the accounting before the chart, and to show any unexplained difference openly ([brief §8.1 and §16](../brief.md)). [#23](https://github.com/joshmcarthur/gridwatch/issues/23) asks for the table. The network is meshed, so the table describes regional energy balances. It does not describe flows from a generator to a consumer.

Three sources feed it. Generation_MD gives metered generation by unit ([ADR-0007](0007-generation-md-monthly-files.md)). HVDC_Flows gives metered transfer at the two link terminals ([ADR-0016](0016-hvdc-flows.md)). Nodal Prices and Volumes gives RTD (real-time dispatch) load at points of connection ([sources 3.3](../sources.md#33-nodal-prices-and-volumes)). No source gives metered consumption.

## Decision

### Amendment to the gold pattern: gold inputs

[ADR-0011](0011-gold-table-pattern.md) lets a gold table read silver only. This table reads two gold tables, `generation_by_fuel_period` and `hvdc_transfer_period`, so it needs more. A `GoldInput` can set `layer: "gold"`. The fingerprint code then reads the `inputs_sha256` of that table from `goldDir`. A gold input has `versionColumn: "inputs_sha256"` and `completenessDataset: null`. It has no `_completeness` row of its own. Its `inputs_sha256` already holds the `_completeness` status of its own inputs and its `ANALYSIS_VERSION`, so a change upstream rebuilds the chain by itself.

`PublisherDataset.wantedVersions` gets `goldDir` as a third argument. The runner computes `wantedVersions` inside the dataset loop. A gold table at the end of the registry therefore sees the gold that this run has just written. A gold table that reads gold must come after its inputs in the registry.

### Tables

`publisher/src/gold/energy-balance.ts`, `ANALYSIS_VERSION = 1`. The sentinel is `energy_balance_period` (key `island`, `trading_period`). `energy_balance_day` has the key `island`, `trading_date`. Each date has one row per island (`NI` and `SI`).

Inputs: gold `generation_by_fuel_period` (generation by island), gold `hvdc_transfer_period`, silver `nodal_prices_and_volumes` and silver `entity_points_of_connection`.

| Column | Meaning |
| --- | --- |
| `trading_date`, `trading_period`, `event_start_utc`, `event_end_utc` | As in [ADR-0003](0003-time-column-naming.md). The day table has `trading_date` only. |
| `island` | `NI` or `SI`. |
| `generation_mwh` | Metered Generation_MD energy of the island, all fuels, battery included. Null when the island has no generation row in the period. It is not 0. |
| `hvdc_import_mwh` | Energy that the island receives over the link. `NI` = `north_island_received_mwh`. `SI` = `-south_island_sent_mwh`. The sign is right in both directions. |
| `load_mwh` | Modelled grid load, see below. |
| `load_intervals` | How many 5-minute RTD intervals gave the load of the period (0 to 6). |
| `residual_mwh` | `generation_mwh + hvdc_import_mwh - load_mwh`. Null when any term is null. |
| `residual_pct_of_load` | `residual_mwh / load_mwh` as a percentage. Null when the residual or the load is null or the load is 0. |
| `analysis_version`, `inputs_sha256`, `inputs_complete` | The ADR-0011 stamp. |

The table has no link-loss column and no battery column. The link loss is not a term of an island. With `NI import` and `SI import` as above, the link loss is `-(NI import + SI import)`. It equals `losses_mwh` in `hvdc_transfer_period`. So the NI residual and the SI residual add up to national generation, minus load, minus link losses.

### Load: modelled, not metered

**Grid load (modelled)** is the RTD model load at grid exit points, net of embedded generation behind them, plus dispatchable and battery load. It is not metered consumption. Docs and site copy must not call it "consumption".

- The sum is over all nodal rows of the island: point of connection rows and unit rows. Unit rows carry battery and dispatchable load (for example `HLY91`, `GLB99`, `RUK99`, `RHO99`).
- Each interval uses the latest RTD case: rows with `case_type = 'RTD'`, partitioned by `event_start_utc` (UTC, never local time, because the repeated DST hour shares local times), ordered by `source_run_at` then `case_id`, descending. The case id breaks ties, so the choice is deterministic.
- Period load = the mean of the interval total MW over the intervals that exist, times 0.5 hours. Every trading period is 30 minutes, also on a DST day, so 0.5 is fixed. The source omits about ten intervals a day, so a period is not required to have 6. A period with no interval has null load.
- The island is the `island` of `entity_points_of_connection`. When the point of connection is not in that table, the `Island` string of the nodal row maps `North Island` to `NI` and `South Island` to `SI`. Load that still has no island goes to neither row, and sets `inputs_complete = false` on every row of the date.

### Residual: never adjusted

The residual is a column. Gold does not adjust, clamp or spread it. These terms stay inside it:

- AC transmission and distribution losses, which the load figure does not include.
- The difference between RTD model load and metered generation.
- Generation that Generation_MD omits and RTD dispatches (for example Kowhai Park Solar, Glenbrook Steel, Huntly Battery, Huntly 6 and the Glenbrook battery).
- Embedded generation counted twice. Generation_MD includes embedded plants, and grid-exit load is already net of them.

### Completeness

A period row is `inputs_complete` when all of these hold:

- every upstream `generation_by_fuel_period` row of the period has `inputs_complete`, and the `hvdc_transfer_period` row has it;
- the `_completeness` status of `nodal_prices_and_volumes` and of `entity_mappings` is `complete` for the date;
- the period has at least one interval;
- no load is without an island.

A day term is a sum only when all periods have the term: `CASE WHEN count(term) = <46, 48 or 50> THEN sum(term) END`. A partial sum would give a false residual, so the day residual is built from the day terms. The day `inputs_complete` is true only when every period row of the island is true. A date with no `hvdc_transfer_period` partition is not wanted, and gold writes no row for it. HVDC_Flows has a month lag, so energy balance has the same lag.

## Consequences

- The Sankey can show the residual as its own band, with units and a plain label.
- A reader sees modelled load, so the Sankey must say "modelled". The glossary has entries for **Grid load (modelled)**, **Energy-balance residual** and **HVDC import**.
- A gold table can now depend on gold. The registry order is the rule. A circular dependency is not detected.
- The size of the typical and the worst residual is in the comment on [#23](https://github.com/joshmcarthur/gridwatch/issues/23). Whether it is acceptable for a public Sankey is the owner's decision, and #30 waits for it.

# ADR-0016: HVDC transfer from the HVDC_Flows dataset

- Status: Accepted
- Date: 2026-11-21

## Context

Inter-island transfer is a key quantity for regional prices and for the Sankey ([#19](https://github.com/joshmcarthur/gridwatch/issues/19), [#23](https://github.com/joshmcarthur/gridwatch/issues/23)). The initial datasets do not give it. `BEN2201` and `HAY2201` have prices but no volumes in Nodal Prices and Volumes. An island residual (nodal generation minus load) is 60 to 90 MW off the published transfer on the days checked (#19 comment, 20 Nov 2026). The metered source is EMI `Wholesale/Metered_data/HVDC_Flows`, one CSV per month, with half-hour kWh at both HVDC terminals ([sources 3.7](../sources.md#37-hvdc-flows)).

The owner question on adding `HVDC_Flows` to the collector was unanswered when this work started. The overnight loop proceeded on the recorded recommendation (add `HVDC_Flows`, with the monthly shape of Generation_MD). The owner confirms or objects at merge.

## Decision

**Dataset.** The dataset ID is `hvdc_flows`. Files are `Datasets/Wholesale/Metered_data/HVDC_Flows/yyyymm_HVDC_flows.csv`. The collector follows the monthly pattern of [ADR-0007](0007-generation-md-monthly-files.md) with the month lag of Generation_MD. The runner needs no change.

**Silver.** `silver/hvdc_flows/trading_date=YYYY-MM-DD/data.parquet` holds one row per point of connection, flow direction and trading period, in kWh. Validation follows ADR-0007, with these additions: `Unit_Measure` must be `kWh`; `Flow_Direction` must be `X` or `I`; the unit key is (point of connection, flow direction), and a duplicate makes the day invalid. Negative values are kept. Silver keeps any point of connection. Gold reads only the two terminals.

**Flow directions.** `X` is offtake from the AC grid into the link. `I` is injection from the link into the AC grid. This meaning is **inferred** from the data (see the check below), because the file has no legend.

**Gold.** Two tables in the gold pattern of [ADR-0011](0011-gold-table-pattern.md), with `ANALYSIS_VERSION = 1`. The sentinel is `hvdc_transfer_period` (key `trading_period`). `hvdc_transfer_day` has the key `trading_date`. Both read only `hvdc_flows` silver.

The period table has these columns: `benmore_offtake_mwh`, `benmore_injection_mwh`, `haywards_offtake_mwh`, `haywards_injection_mwh` (the metered values, kWh / 1000), `south_island_sent_mwh`, `north_island_received_mwh`, `losses_mwh`, `average_megawatts`, `direction`. The day table has the same energy columns, summed over the day.

**Sign convention.** Positive means northward, measured at Haywards. This matches `W_HVDC_C`, which reports northward flow at Haywards.

- `south_island_sent_mwh` = (Benmore `X` - Benmore `I`) / 1000.
- `north_island_received_mwh` = (Haywards `I` - Haywards `X`) / 1000.
- `losses_mwh` = (Benmore `X` + Haywards `X` - Benmore `I` - Haywards `I`) / 1000.
- `average_megawatts` = north received x 2 for a period. For a day it is north received divided by the hours of the day (periods / 2: 23, 24 or 25). It is signed. A day with a missing period has a null day average, because the hours covered are not known. Its energy columns still sum the periods that exist.
- `direction` is `north` when both nets are above zero, `south` when both are below zero, and `none` otherwise. That covers idle periods and periods where the two ends disagree. The day uses the same rule on the day sums.

**Completeness.** Gold writes rows for incomplete inputs and flags them (ADR-0011). The period table has a row for every expected period (46, 48 or 50). A period that silver lacks has null energies and direction `none`. `inputs_complete` is true only when all of these hold:

1. The `hvdc_flows` `_completeness` status is `complete` for the date (ADR-0010).
2. The silver file has no point of connection other than `BEN2201` and `HAY2201`.
3. The period has all four series (the period row), or every period has them (the day row). `periodsComplete` only checks that a period has some row, so gold uses its own check of the four series.

The result is `partial` when a period lacks a series or a status is not complete. Otherwise it is `complete`.

**Month lag.** Gold exists only for dates that silver has. Gold does not estimate a live value from island residuals. Rejected alternatives: the island residual (60 to 90 MW off), nodal volumes at the HVDC points (`BEN2201` and `HAY2201` have no volume rows in Nodal Prices and Volumes), and `W_HVDC_C` (a report for recent days, not a daily file).

**Site.** This change does not change the site export. [#23](https://github.com/joshmcarthur/gridwatch/issues/23) wires the transfer into the site. The site index fixture gains a `hvdc_flows` key, because the silver registry now lists the dataset.

## Check against published figures

Source: the HVDC_Flows file for October 2026, the same dataset (not an independent source). On 31 Oct 2026 TP1, Benmore `X` is 204.554 MWh and Haywards `I` is 198.323 MWh.

| Quantity | Gold | Published (#19 comment) |
| --- | ---: | ---: |
| Benmore offtake, average MW (`X` x 2) | 409.108 | 409 |
| Haywards injection, average MW (`I` x 2) | 396.646 | 397 |

The 586 MW northward at Haywards on 19 Nov 2026 TP1 (`W_HVDC_C`) is not checked. The November file does not exist yet.

## Consequences

- A reader gets transfer with units and direction, one month after the metered period.
- The direction rule can show `none` during an idle period. A reader should not read `none` as zero flow.
- Losses are the difference between the two ends. Their size depends on the metering, which is not documented here.
- The meaning of `X` and `I` is inferred. If EMI publishes a legend that differs, revisit the sign convention and bump `ANALYSIS_VERSION`.
- Any change to the sign convention or the direction rule is a change to the gold logic. It needs a bump of `ANALYSIS_VERSION`.

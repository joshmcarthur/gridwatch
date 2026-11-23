# Dispatch generation for recent days

- Status: accepted
- Date: 2026-11-23
- Author: Josh McArthur / Gridwatch

## Objective

Recent daily pages show a generation mix the morning after the trading day, from EMI dispatch we already collect, then switch to Generation_MD when that month is published.

## Background

Gold generation reads only Generation_MD. That file lags 10 days to about 6 weeks, so recent daily pages have prices and no mix. The collector already stores Nodal Prices and Volumes, which include unit dispatch megawatts, about 07:08 NZ the next morning. Licence is CC BY 4.0.

Transpower’s live generation page is sourced from EM6 Live. Transpower terms forbid reproducing website material without written consent. em6 real-time generation APIs are paid. Gridwatch will not scrape Transpower and will not buy em6.

The EMI real-time dispatch API is also CC BY 4.0, needs a key, and is a later slice. This work is yesterday-first.

## Goals

- A finished trading day has a fuel mix on the next morning’s site build.
- Metered Generation_MD remains the figure once the monthly file exists.
- The page says when the mix is dispatch, not meters.
- Plant rows on a dispatch day use the same plant IDs as metered days, where a unit can be resolved.

## Non-goals

- Live or same-day generation.
- Transpower or em6 feeds.
- Rebuilding energy balance or the Sankey from dispatch. Those stay on the metered HVDC month lag.
- A second plant-id scheme for units that do not map.

## Constraints

- No new bronze dataset. Dispatch gold reads silver `nodal_prices_and_volumes`.
- Static daily site. No client fetch of EMI.
- Public JSON stays contract version 1, with an optional field.

## Legal

Do not scrape or republish Transpower live widgets. Do not subscribe to em6 for this. EMI nodal files and, later, the EMI real-time dispatch API, are CC BY 4.0 with Electricity Authority attribution already used on the site.

## Dependencies / infrastructure

Gold `generation_by_*` tables stay the grain. Each row gains `source`: `metered` or `dispatch`. When silver `generation_md` exists for the date, gold is metered and ignores nodal. Otherwise gold is dispatch.

Dispatch energy: unit rows of the latest RTD case per 5-minute interval, mean megawatts in the period times 0.5 hours, same case rule as gold load.

Unit to plant:

1. Automatic: the POC and fuel category have exactly one Generation_MD plant.
2. Hand-kept `UNIT_PLANT_OVERRIDES` (`unit_id` → plant id), same pattern as `FUEL_PLANT_OVERRIDES`.
3. Still-unmapped units stay in fuel totals and out of the plant tables.

Site JSON: optional `generation.source`. Absence means metered. A dispatch day with complete nodal can be a complete day. `EXPORT_VERSION` bumps; `SITE_CONTRACT_VERSION` stays 1.

## Alternatives considered

- **Transpower live / em6.** Rejected: no reuse licence; paid API.
- **Cleared Offers instead of nodal.** Rejected: load already uses nodal RTD cases; mix and load then share a model.
- **Parallel dispatch gold tables.** Rejected: energy balance is gated by HVDC, which shares the Generation_MD month lag, so overlay cannot mix dispatch generation with metered transfer.
- **Unit ids as plant ids.** Rejected: day-compare and plant drilldown would break when the month lands.

## Open issues

- Seed rows for `UNIT_PLANT_OVERRIDES` (Huntly 5/6, Matahina, new solar/batteries): take them from the live fleet file against Generation_MD plant keys in the first implementation. Immediate next step: measure the unmapped units after the tighter join, then add override rows only for those.
- EMI real-time dispatch API: later slice, same gold `source=dispatch` path, not this work.

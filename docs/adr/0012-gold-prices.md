# ADR-0012: Gold price tables, reference nodes and aggregation

- Status: Accepted
- Date: 2026-11-20

## Context

[#17](https://github.com/joshmcarthur/gridwatch/issues/17) builds the gold price tables. They answer "why do prices differ between regions?" and feed the price chart and the price-separation detector. They need a small fixed set of reference nodes, and a rule that turns irregularly published dispatch prices into a price for a trading period. The owner decided on [#9](https://github.com/joshmcarthur/gridwatch/issues/9) that dispatch energy prices are the price at a node. For the period rule, the owner chose on 2026-11-20 that a price applies until the next publish (see below). [ADR-0008](0008-entity-model.md) defines region as the NSP network reporting region. The module follows the gold table pattern in [ADR-0011](0011-gold-table-pattern.md): `goldDataset`, `writeGoldTables`, `goldStamp` and `inputFingerprint`.

## Decision

### Reference nodes and price regions

| Price region | Reference node | Island | Why |
| --- | --- | --- | --- |
| `upper_north_island` | `OTA2201` (Ōtāhuhu 220 kV) | NI | The main grid node for Auckland and the upper North Island. |
| `lower_north_island` | `HAY2201` (Haywards 220 kV) | NI | The main node of the lower North Island and the North Island end of the Cook Strait HVDC link. |
| `south_island` | `BEN2201` (Benmore 220 kV) | SI | The main South Island node and the South Island end of the HVDC link. |

All three codes are in the dispatch energy prices file of 2026-11-18, with 288 rows each. The islands in that file are `NI`, `NI` and `SI`. The roles of the nodes (HVDC ends, Auckland) are domain knowledge and not in the source files (inferred).

- **A price region is not an ADR-0008 region.** ADR-0008 regions are distribution network areas (1 to 40). `HAY2201` and `BEN2201` are grid nodes with no NSP row, so they have no network reporting region. A price region is a Gridwatch label for one reference node. It has no boundary. The gold tables carry the label in a `price_region` column next to the POC code (`from_price_region` and `to_price_region` in spreads). The name `region` stays for ADR-0008 regions.
- **The set is a constant in `publisher/src/gold/prices.ts`.** A change to it changes the output, so it needs a bump of `ANALYSIS_VERSION`.

### Price of a node in a period

- **Source.** Silver `dispatch_energy_prices` only. The gap of 2025-09-11 to 2025-10-02 has no silver, so gold has no price for it. There is no fallback to nodal prices yet.
- **A price applies until the next publish (rule B).** The owner decided this on 2026-11-20, for gold only. The dispatch file has no interval key, and an earlier draft snapped each publish time to the nearest 5-minute boundary and kept the latest case per interval. That mis-assigned late publishes: on `HAY2201` on 2026-11-18, the publish at 22:08:03 (period 45) landed on 22:10, and 06:32:23 (period 14) landed on 06:30. This rule replaces the "latest case per interval" rule from [#9](https://github.com/joshmcarthur/gridwatch/issues/9). Silver's `trading_period` is the period a row belongs to (the source assigns it; a row published at 06:29:40 is in period 14). Within one POC and period, gold sorts the rows by `source_published_at`. Each price applies from its publish time to the next row's publish time. The first row applies from the period start and the last until the period end. Prices do not carry over between periods. Publish times are clamped into the period, so rows published before the period start all apply from the period start and a row published after the period end gets zero length. A zero-length row gets no weight but still counts in `min_price`, `max_price` and `rows_present`. Rows sort by publish time, then price. Silver rejects a duplicate (period, publish time, POC) key, so ties do not occur and the order is total.
- **Period price.** The time-weighted mean over the 30 minutes of the period (`event_start_utc` to `event_end_utc`): the sum of each price times its seconds, divided by the seconds covered. A period with at least one row is covered for all 1800 s. Example: `HAY2201`, period 45 on 2026-11-18. Rows at 22:00:49 (71.04), 22:08:03 (71.24), 22:09:51 (51.69), 22:15:52 (40.52), 22:19:47 (36.63) and 22:24:40 (32.59) have weights 483, 108, 361, 235, 293 and 320 s. The period price is 91349.92 / 1800 = 50.75.
- **Daily summary.** `mean_price` is the time-weighted mean over the covered time of the day. Each covered period is 1800 s, so it equals the mean of the period prices that exist, and each period counts once. `min_price` and `max_price` are the lowest and highest published row price, not period prices, so a short spike stays visible. `rows_present` counts the silver rows used.
- **Proxy prices** stay in the data. `price_periods.has_proxy_price` is true when any row in the period is a proxy price.
- **Spreads** are `from - to` for the pairs OTA to HAY, HAY to BEN and OTA to BEN (`SPREAD_PAIRS` in `prices.ts`), on the period prices. A positive spread means the first node is dearer.
- **National distribution.** For each period: the minimum, the 5th, 25th, 50th, 75th and 95th percentile (linear interpolation) and the maximum of the period prices of all POCs that have at least one row in the period, with the POC count.

### Tables

Gold Parquet at `gold/<table>/trading_date=YYYY-MM-DD/data.parquet`. `writeGoldTables` writes every table to a `.tmp` file, then renames them, with the sentinel (`price_periods`) last ([ADR-0011](0011-gold-table-pattern.md)). The `ORDER BY` is total. The module sets `SET threads = 1` because the daily summary sums floating-point values.

| Table | One row per |
| --- | --- |
| `price_periods` | reference node and trading period |
| `price_daily_summary` | reference node |
| `price_spreads` | pair of reference nodes and trading period |
| `price_distribution` | trading period |

Every row has `trading_date`, `analysis_version`, `inputs_sha256` and `inputs_complete`. There is no `processed_at`, so a second run on the same input gives identical bytes ([ADR-0003](0003-time-column-naming.md) amendment). Period tables keep `trading_period`, `event_start_utc` and `event_end_utc`.

- **`analysis_version`** is `ANALYSIS_VERSION` in `prices.ts`. Change it by hand when the logic changes.
- **`inputs_sha256`** is `inputFingerprint` over the analysis version and the silver `dispatch_energy_prices` partition's `bronze_sha256` and its `_completeness` status ([ADR-0011](0011-gold-table-pattern.md)).
- **`inputs_complete`** flags a row. No row is dropped. A node row is complete when the node has at least one silver row in the period. A spread row is complete when both node rows are. A distribution row is complete when at least one POC has a row in the period. It does not mean that every POC has a row, and a proxy price counts as a price. A daily summary is complete when every expected period (46, 48 or 50) is. Every expected period has a row, with null prices when silver has none. This row check is the data rule of gold prices. `inputs_complete` also needs the `_completeness` status of `dispatch_energy_prices` to be `complete` ([ADR-0011](0011-gold-table-pattern.md)). The publish result is `partial` with the incomplete periods, or `complete` when every period has a row. Gold is not a row in `silver/_completeness` ([ADR-0010](0010-completeness.md)).

## Consequences

- A chart can show a region price per period and mark the incomplete ones.
- Three nodes are a coarse view of regions. Separation inside an island is visible only in `price_distribution`.
- Rule B trusts that a publish time is when a price began to apply. A price published late in a period gets little weight, and a long gap between publishes gives the earlier price a long weight. If the source adds an interval key, revisit the rule and bump `ANALYSIS_VERSION`.
- A day that the source revises appears in gold only after the runner sees a new `bronze_sha256`.

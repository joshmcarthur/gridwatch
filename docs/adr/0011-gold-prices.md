# ADR-0011: Gold price tables, reference nodes and aggregation

- Status: Accepted
- Date: 2026-11-20

## Context

[#17](https://github.com/joshmcarthur/gridwatch/issues/17) builds the gold price tables. They answer "why do prices differ between regions?" and feed the price chart and the price-separation detector. They need a small fixed set of reference nodes, and a rule that turns irregular 5-minute dispatch prices into a price for a trading period. The owner decided on [#9](https://github.com/joshmcarthur/gridwatch/issues/9) that dispatch energy prices are the price at a node, and that layers after silver keep only the latest RTD case for each interval. [ADR-0008](0008-entity-model.md) defines region as the NSP network reporting region.

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
- **Latest case.** Silver keeps every publish. Silver has no interval column. Dispatch prices are published at irregular times near the start of the interval they price (for example 00:04:40 for the 00:05 interval; measured on 2026-11-18). The dispatch interval is therefore the 5-minute boundary nearest to the publish time, held inside the period of the row. A re-run about 1.5 to 2.5 minutes after the first run lands on the same boundary (9 such intervals at `HAY2201` on 2026-11-18). Gold keeps the row with the latest `source_published_at` for each POC and interval. A re-run published more than 2.5 minutes after the nominal time can fall on the next boundary. We have not seen this.
- **Period price.** The time-weighted mean of the latest-case interval prices in the period. Every interval lasts 5 minutes, so this equals the mean of the intervals that exist. A missing interval has no weight and is not filled. Each period has 6 expected intervals (30 minutes), also on a DST day.
- **Daily summary.** `mean_price` is the mean of the period prices, so each period counts once. `time_weighted_mean_price` is the mean of the interval prices, so each interval counts once. They differ when a period lacks intervals. `min_price` and `max_price` are the lowest and highest interval price, not period prices, so a short spike stays visible.
- **Proxy prices** stay in the data. `price_periods.has_proxy_price` is true when any interval in the period is a proxy price.
- **Spreads** are `from - to` for the pairs OTA to HAY, HAY to BEN and OTA to BEN (`SPREAD_PAIRS` in `prices.ts`), on the period prices. A positive spread means the first node is dearer.
- **National distribution.** For each period: the minimum, the 5th, 25th, 50th, 75th and 95th percentile (linear interpolation) and the maximum of the period prices of all POCs that have a price, with the POC count.

### Tables

Gold Parquet at `gold/<table>/trading_date=YYYY-MM-DD/data.parquet`. The write is atomic and the `ORDER BY` is total, as in silver.

| Table | One row per |
| --- | --- |
| `price_periods` | reference node and trading period |
| `price_daily_summary` | reference node |
| `price_spreads` | pair of reference nodes and trading period |
| `price_distribution` | trading period |

Every row has `trading_date`, `analysis_version`, `inputs_sha256` and `inputs_complete`. There is no `processed_at`, so a second run on the same input gives identical bytes ([ADR-0003](0003-time-column-naming.md) amendment). Period tables keep `trading_period`, `event_start_utc` and `event_end_utc`.

- **`analysis_version`** is `ANALYSIS_VERSION` in `prices.ts`. Change it by hand when the logic changes.
- **`inputs_sha256`** is a SHA-256 over the `bronze_sha256` values of the silver input partitions (with their paths) and the analysis version. It is modelled on [ADR-0008](0008-entity-model.md).
- **`inputs_complete`** flags a row. No row is dropped. A node row is complete when the period has 6 intervals. A spread row is complete when both node rows are. A distribution row is complete when the period has 6 distinct intervals with a price from any POC. It does not mean that every POC has all 6, and a proxy price counts as a price. A daily summary is complete when every period is. Every expected period has a row, with null prices when silver has none. Silver `_completeness` ([#14](https://github.com/joshmcarthur/gridwatch/issues/14)) does not exist yet. The flag comes from the silver data now, and can move to `_completeness` later.

## Consequences

- A chart can show a region price per period and mark the incomplete ones.
- Three nodes are a coarse view of regions. Separation inside an island is visible only in `price_distribution`.
- The interval rule is an inference from publish times. If the source adds a case or interval column, gold should use it and bump `ANALYSIS_VERSION`.
- A day that the source revises appears in gold only after the runner sees a new `bronze_sha256`.

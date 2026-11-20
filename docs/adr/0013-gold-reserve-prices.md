# ADR-0013: Gold reserve prices by class and island

- Status: Accepted
- Date: 2026-11-20

## Context

[#18](https://github.com/joshmcarthur/gridwatch/issues/18) builds gold tables from Dispatch Reserve Prices silver ([#11](https://github.com/joshmcarthur/gridwatch/issues/11)). They answer "what did FIR and SIR cost on each island?" and feed later reserve charts. Silver is long form: one row per reserve class (`FIR`, `SIR`), island (`NI` or `SI`), trading period and publish time. Publish times are irregular. The median gap for one point of connection is 5 minutes, with 2 to 8 publishes in a period ([sources 3.2](../sources.md#32-dispatch-reserve-prices)). There is no interval column and no `CaseID`. This is the same shape as dispatch energy prices silver.

On 2026-11-20 the owner decided that the rule for gold energy prices ([ADR-0012](0012-gold-prices.md), "rule B") applies to reserve prices too: a published price applies until the next publish within the trading period. An earlier draft of this module snapped each publish to a 5-minute interval and kept the latest case per interval. That rule gave the wrong weight to a price that holds for a large part of a period (see the example below).

## Decision

The module follows the gold table pattern in [ADR-0011](0011-gold-table-pattern.md): `goldDataset`, `writeGoldTables`, `goldStamp`, `inputFingerprint` and `inputsComplete`. Dataset id `gold_reserves`. `ANALYSIS_VERSION` starts at 1.

### Period price

- **Source.** Silver `dispatch_reserve_prices` only. The 2025-09-11 to 2025-10-02 gap has no silver, so gold has no reserve price for it.
- **Grain.** One row per reserve class, island and trading period. The two source points of connection are `HAY2201` (NI) and `BEN2201` (SI). Gold keys on `island`, not on the point of connection. A null island is kept as its own group. No row is dropped.
- **A price applies until the next publish (rule B).** Silver's `trading_period` is the period a row belongs to. Within one reserve class, island and period, rows sort by `source_published_at`, then by price, so the order is total. Each price applies from its publish time to the next row's publish time. The first row applies from the period start and the last until the period end. Both ends are clamped into `[event_start_utc, event_end_utc]`: rows published before the period start apply from the start, and a row published after the period end gets zero length. A zero-length row gets no weight but still counts in `min_price`, `max_price` and `rows_present`. Prices do not carry over between periods. The last row has no next publish time, and DuckDB `least()` and `greatest()` ignore NULL, so the SQL sets its end to the period end explicitly. The SQL has the same shape as the `segments` table of `prices.ts`.
- **Period price.** The time-weighted mean over the 30 minutes: the sum of each price times its seconds, divided by the seconds covered. A period with at least one row is covered for all 1800 s. `min_price` and `max_price` are the lowest and highest published row price in the period. `rows_present` counts the silver rows used.
- **Example.** `HAY2201`, FIR, period 1 on 2026-11-18. Rows at 00:00:13 (1.00), 00:04:40 (1.00), 00:09:50 (0.50), 00:20:13 (0.15) and 00:24:46 (0.15) have weights 280, 310, 623, 273 and 314 s. The period price is 989.55 / 1800 = 0.54975. The 5-minute snap gave 0.56, because the 0.50 price holds for 35% of the period but got 1 of 5 snapped slots.

### One point of connection for each island and class

The real files have one point of connection for each island: `HAY2201` for NI and `BEN2201` for SI. If silver ever has two points of connection for the same class and island, gold does not merge them. `publishReserves` returns `invalid` with one error for each clash, and writes nothing, so earlier partitions stay as they were. A merge rule (for example "keep the later publish") would be tested only on made-up nodes, and it would hide a change in the source. The same check covers a null island. A person then decides how to key the tables.

### Daily summary

- `mean_price` is the time-weighted mean over the covered time of the day. Each covered period is 1800 s, so it equals the mean of the period prices that exist, and each period counts once.
- `min_price` and `max_price` are the lowest and highest published row price of the day, not period prices, so a short spike stays visible.
- `periods_present`, `periods_expected` (46, 48 or 50) and `rows_present` show how much of the day the row covers.
- There is no slot-weighted mean. The earlier `time_weighted_mean_price` is removed.

### Completeness

- A class-island-period is complete when it has at least one silver row. Gold has no period spine (a row for each expected period with null prices), so a period with no row has no row in gold. Every period row has `inputs_complete = true`.
- A daily row is complete when its class and island have a row in every expected period (`periods_present = periods_expected`).
- The publish result is `partial` with the periods that have no row in any class (`inputsComplete()` on the silver file, [ADR-0011](0011-gold-table-pattern.md)), or `complete`, or `missing` when the date has no silver.
- Gold does not read `silver/_completeness` ([ADR-0010](0010-completeness.md)). That is [#77](https://github.com/joshmcarthur/gridwatch/issues/77).

### Tables

Gold Parquet at `gold/<table>/trading_date=YYYY-MM-DD/data.parquet`. `writeGoldTables` writes every table to a `.tmp` file, then renames them, with the sentinel (`reserve_by_class_island_period`) last. The `ORDER BY` is total. The module sets `SET threads = 1` because the daily summary sums floating-point values. There is no `processed_at`, so a second run on the same input gives identical bytes.

| Table | One row per |
| --- | --- |
| `reserve_by_class_island_period` | reserve class, island and trading period that has a row |
| `reserve_by_class_island_day` | reserve class and island |

Every row has `trading_date`, `analysis_version`, `inputs_sha256` and `inputs_complete`. Period rows keep `trading_period`, `event_start_utc` and `event_end_utc` ([ADR-0003](0003-time-column-naming.md)).

## Consequences

- A chart can show FIR and SIR by island per trading period, and mark an incomplete day.
- Gold reserves and gold prices use one rule, so a reserve price and an energy price for the same period have the same weighting.
- Rule B trusts that a publish time is when a price began to apply. A price published late in a period gets little weight, and a long gap between publishes gives the earlier price a long weight. If the source adds an interval or case column, revisit the rule and bump `ANALYSIS_VERSION`.
- A second point of connection on one island stops the date from publishing until a person changes the keys. The runner reports the date as failed.
- A missing period shows as a missing row, not as a null row. A chart has to read the gap from the absent row or from the daily `periods_present`.
- The `segments` SQL is copied from `prices.ts`, not shared, because the partition keys differ.
- Reserve anomaly detection ([#34](https://github.com/joshmcarthur/gridwatch/issues/34)) is out of scope.

# ADR-0013: Gold reserve prices by class and island

- Status: Accepted
- Date: 2026-11-20

## Context

[#18](https://github.com/joshmcarthur/gridwatch/issues/18) builds gold tables from Dispatch Reserve Prices silver ([#11](https://github.com/joshmcarthur/gridwatch/issues/11)). They answer "what did FIR and SIR cost on each island?" and feed later reserve charts. Silver is long form: one row per reserve class (`FIR`, `SIR`), island (`NI` or `SI`), trading period and publish time. Publish times are irregular. The median gap for one point of connection is 5 minutes, with 2 to 8 publishes in a period ([sources 3.2](../sources.md#32-dispatch-reserve-prices)). There is no interval column and no `CaseID`.

Gold generation ([#16](https://github.com/joshmcarthur/gridwatch/issues/16), [ADR-0011](0011-gold-table-pattern.md)) flags completeness from trading-period presence. Gold energy prices ([#17](https://github.com/joshmcarthur/gridwatch/issues/17)) snap irregular publishes to 5-minute intervals, keep the latest case per interval (owner decision on [#9](https://github.com/joshmcarthur/gridwatch/issues/9)), and treat a period as incomplete unless it has 6 intervals. This module has to choose an aggregate for the period price, and a completeness grain.

## Decision

The module follows the gold table pattern in [ADR-0011](0011-gold-table-pattern.md): `goldDataset`, `writeGoldTables`, `goldStamp`, `inputFingerprint` and `inputsComplete`. Dataset id `gold_reserves`. `ANALYSIS_VERSION` starts at 1.

### Period price

- **Source.** Silver `dispatch_reserve_prices` only. The 2025-09-11 to 2025-10-02 gap has no silver, so gold has no reserve price for it.
- **Grain.** One row per reserve class, island and trading period. The two source points of connection are `HAY2201` (NI) and `BEN2201` (SI). Gold keys on `island`, not on the point of connection. Two points of connection on the same island at the same interval keep the later `source_published_at`. A null island is kept as its own group. No row is dropped.
- **Latest case per interval.** The dispatch interval is the 5-minute boundary nearest to `source_published_at`, held inside the period of the row (the same snap as gold energy prices). Gold keeps the latest publish for each reserve class, island and interval. A re-run a few minutes later lands on the same boundary.
- **Period price.** The time-weighted mean of those latest-case interval prices. Every interval lasts 5 minutes, so this equals the mean of the intervals that exist. A missing interval has no weight and is not filled. `min_interval_price` and `max_interval_price` are the lowest and highest of those interval prices.

Interval snap is justified because the source is 5-minute-ish (median gap 5 minutes, about 278 publishes per point of connection per day). Latest-per-period without snap would ignore intra-period re-runs that share an interval.

### Daily summary

`mean_price` is the mean of the period prices, so each period counts once. `time_weighted_mean_price` is the mean of the interval prices, so each interval counts once. They differ when a period lacks intervals. `min_price` and `max_price` are the lowest and highest interval price, not period prices, so a short spike stays visible.

### Completeness

Every row has `inputs_complete` from `inputsComplete()` on the silver file: true only when every expected trading period (46, 48 or 50) has rows. This is the same grain as gold generation ([ADR-0011](0011-gold-table-pattern.md)), not the 6-interval count used for gold energy prices. A period with fewer than 6 intervals is still complete if the period is present in silver. Incomplete rows are written and flagged. Missing periods are not filled with null-price rows. The publish result is `partial` with those missing periods, or `missing` when the date has no silver.

### Tables

Gold Parquet at `gold/<table>/trading_date=YYYY-MM-DD/data.parquet`. `writeGoldTables` writes every table to a `.tmp` file, then renames them, with the sentinel (`reserve_by_class_island_period`) last. The `ORDER BY` is total. The module sets `SET threads = 1` because the daily summary sums floating-point values. There is no `processed_at`.

| Table | One row per |
| --- | --- |
| `reserve_by_class_island_period` | reserve class, island and trading period |
| `reserve_by_class_island_day` | reserve class and island |

Every row has `trading_date`, `analysis_version`, `inputs_sha256` and `inputs_complete`. Period rows keep `trading_period`, `event_start_utc` and `event_end_utc` ([ADR-0003](0003-time-column-naming.md)).

## Consequences

- A chart can show FIR and SIR by island per trading period and mark an incomplete day.
- The interval rule is an inference from publish times. If the source adds a case or interval column, gold should use it and bump `ANALYSIS_VERSION`.
- Completeness does not warn that a period has fewer than 6 intervals. That is accepted: #18 asked for the same completeness rules as #16.
- Gold energy prices is not on `main` at the time of this decision, so this module copies the snap SQL instead of sharing a helper. A later change can extract it.
- Reserve anomaly detection ([#34](https://github.com/joshmcarthur/gridwatch/issues/34)) is out of scope.

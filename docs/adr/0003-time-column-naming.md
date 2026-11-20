# ADR-0003: Trading-day time model and time column names

- Status: Accepted
- Date: 2026-11-20

## Context

NZ market data uses a trading date and a trading period in NZ local time. Daylight saving makes some days 46 or 50 periods long. The brief (section 5.1) names four kinds of time. Every silver and gold table must name them the same way. See `docs/sources.md` for how each dataset expresses time.

## Decision

The module `publisher/src/trading-time.ts` implements the model with `Temporal` and the IANA zone `Pacific/Auckland`. Node 26 enables `Temporal` by default and TypeScript ships the types (`lib: esnext.temporal`), so it needs no dependency or polyfill. UTC instants are `Temporal.Instant` values. They are exact and immutable. Convert to `Date` at the edge if a client needs one.

- A trading date is the NZ calendar date. Period 1 starts at local midnight.
- A period is 30 real minutes. A day has 48 periods, 46 on the DST-start day, 50 on the DST-end day.
- A dispatch interval is 5 minutes. Each interval lies in exactly one period.
- Silver and gold tables use these column names:

| Column                | Kind             | Meaning                                                          |
| --------------------- | ---------------- | ---------------------------------------------------------------- |
| `trading_date`        | source, kept     | NZ trading date, `YYYY-MM-DD`                                    |
| `trading_period`      | source, kept     | 1-based period number                                            |
| `event_start_utc`     | event time       | UTC start of the period or interval, inclusive                   |
| `event_end_utc`       | event time       | UTC end of the period or interval, exclusive                     |
| `source_published_at` | publication time | UTC time the source published the value (for example `PublishDateTime`) |
| `retrieved_at`        | ingestion time   | UTC time the collector downloaded the file                       |
| `processed_at`        | analysis time    | UTC time the publisher wrote the row                             |

- All `*_utc` and `*_at` columns hold UTC instants (Parquet `TIMESTAMP`, UTC).
- `trading_date` stays a local date. It is not an instant.

## Consequences

- The repeated hour on the DST-end day has two distinct UTC instants and distinct periods. No data merges across it.
- The model treats an interval timestamp as the interval start. We have not verified whether `IntervalDateTime` in the nodal and cleared offers files is the start or the end. The dataset issues must check this before they apply the model.
- Dispatch energy prices use an irregular `PublishDateTime` with an NZ offset (see `docs/sources.md` section 3.1). `dispatchIntervalToUtc` does not cover that case, so #6 must not assume it fits.
- Dataset issues apply the model. This ADR only fixes the names and the rules.

## Amendment (2026-11-20, [ADR-0005](0005-dataset-pattern.md))

Silver tables omit `processed_at` so that re-publishing a day gives byte-identical Parquet. Only gold tables use `processed_at`.

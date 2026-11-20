# ADR-0005: Pattern for adding a dataset

- Status: Accepted
- Date: 2026-11-20

## Context

Dispatch energy prices ([#6](https://github.com/joshmcarthur/gridwatch/issues/6)) is the first dataset. Five more follow. Each one must look the same, so a reader can learn one and read all. We chose plain copies over a framework. Each dataset is two short modules. A shared abstraction waits until five copies show what is really common.

## Decision

A dataset has these files. Copy the dispatch energy prices files and change them.

| File | Role |
| --- | --- |
| `collector/src/electricity-authority/<dataset>.ts` | `collect<Dataset>({ bronzeDir, from, to })`. Lists the source prefix, calls `archiveFile` for each file in range, returns the records and the dates the source does not list |
| `collector/src/electricity-authority/<dataset>.cli.ts` | `npm run collect:<dataset> -w collector -- --from D --to D`. Both default to yesterday in NZ |
| `publisher/src/silver/<dataset>.ts` | `publish<Dataset>({ bronzeDir, silverDir, date })`. Reads bronze with DuckDB, validates, writes silver |
| `publisher/src/silver/<dataset>.cli.ts` | `npm run publish:<dataset> -w publisher -- --from D --to D`. Exit code 1 if a day is invalid |
| `*.test.ts` and `publisher/src/silver/fixtures/<dataset>/` | Real trimmed extracts with their source URLs, a normal day and a DST day |

The dataset ID is `snake_case` (`dispatch_energy_prices`). It is the same in the manifest, the bronze folder and the silver folder.

### Rules

- **SQL in DuckDB.** TypeScript builds the SQL and handles files. DuckDB reads the CSV, casts, validates and writes Parquet. Read the CSV with `all_varchar` and use `TRY_CAST`, so that bad values are counted and not thrown.
- **Which bronze file.** The publisher reads `manifest.jsonl` with DuckDB. It takes the newest record that lists the trading date. It does not import collector code.
- **Column names** follow [ADR-0003](0003-time-column-naming.md). Keep source IDs and the source trading date and period. Add `event_start_utc` and `event_end_utc`, and `source_published_at` when the source has a publish time. Use `periodToUtc` for periods. Add `bronze_file_name`, `bronze_sha256` and `retrieved_at` as provenance.
- **No `processed_at` in silver.** ADR-0003 names that column. A silver file with it would change on every run. We keep the file repeatable and leave the column out. Gold may add it if it needs it.
- **Layout.** `silver/<dataset>/trading_date=YYYY-MM-DD/data.parquet`. The publisher writes a `.tmp` file and renames it. An invalid day writes nothing and leaves an older partition as it was.
- **Repeatable.** The same bronze version gives the same Parquet bytes. The `ORDER BY` must be a total order, so it must end with the unique key. Test this with a byte comparison.
- **Validation** returns `ok`, `missing` (no bronze file) or `invalid` (with messages). The run reports invalid days. It does not stop for them.
- **Querying.** `SELECT … FROM read_parquet('data/silver/<dataset>/**/*.parquet', hive_partitioning = true)`. The file also holds `trading_date`, so the query works with or without the option.
- **Dates.** The CLI takes a range. Defaults to yesterday. The backfill runner chooses the range (12 months back from the run date, computed at run time).

### Validation for dispatch energy prices

The source publishes prices at irregular times, about 278 `PublishDateTime` values a day, not 288 regular intervals. A count of 5-minute intervals does not fit. A day is valid when:

1. The file has rows, and every `TradingDate` equals the requested date.
2. Every trading period of the day is present (46, 48 or 50, from `periodsInTradingDate`).
3. The key `(TradingPeriod, PublishDateTime, PointOfConnection)` has no duplicates.
4. Every period, time, point of connection and price parses. A price must be a finite number.

Other datasets pick their own rule from their real data. Write it in this table form in the dataset's module comment.

### Silver columns, dispatch energy prices

`trading_date`, `trading_period`, `event_start_utc`, `event_end_utc` (the period span), `source_published_at`, `point_of_connection`, `island` (null when blank in the source), `is_proxy_price`, `dollars_per_megawatt_hour`, `bronze_file_name`, `bronze_sha256`, `retrieved_at`.

## Consequences

- Five datasets mean five similar files. We accept the duplication. Revisit it when the pattern settles.
- `island` stays null for some points. The entity model issue fills it from the mapping table.
- The first run of a dataset can show days that the source never published (22 days are missing in 2025). They appear as `missing`.
- An invalid day keeps its older partition. A reader cannot tell from the data alone that the newest bronze version failed. The run output is the only signal. A later runner issue can store it.
- `collector/src/archive.ts` had a TypeScript parameter property, which Node cannot run without a build step. We replaced it. `erasableSyntaxOnly` in `tsconfig.base.json` would stop this class of error.

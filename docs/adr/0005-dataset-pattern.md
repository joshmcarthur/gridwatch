# ADR-0005: Pattern for adding a dataset

- Status: Accepted
- Date: 2026-11-20

## Context

Dispatch energy prices ([#6](https://github.com/joshmcarthur/gridwatch/issues/6)) is the first dataset. Five more follow. Each one must look the same, so a reader can learn one and read all. We chose plain functions over a framework. Shared logic lives in one place. Each dataset file keeps only what differs. There is no base class and no registry.

## Decision

### Shared code (do not copy it)

| File | Holds |
| --- | --- |
| `collector/src/archive.ts` | `archiveFile`: download, hash, store, manifest ([ADR-0004](0004-bronze-archive-and-manifest.md)) |
| `collector/src/electricity-authority/blob.ts` | `BLOB` and `listNames`: Azure listing with paging |
| `collector/src/date-range.ts`, `publisher/src/date-range.ts` | `parseDateRange` (CLI `--from`, `--to`, default yesterday in NZ) and `eachDate`. One copy per package, as with `data-root.ts` |
| `publisher/src/silver/common.ts` | `lit`, `PublishResult`, `findBronze`, `writeParquetAtomically` |
| `publisher/src/trading-time.ts` | `periodsInTradingDate`, `periodToUtc` ([ADR-0003](0003-time-column-naming.md)) |

### Dataset files (copy and edit these)

| File | Differs per dataset |
| --- | --- |
| `collector/src/electricity-authority/<dataset>.ts` | `DATASET`, `FOLDER`, `FILE_SUFFIX`, `HUB_URL` |
| `collector/src/electricity-authority/<dataset>.cli.ts` | Names only |
| `publisher/src/silver/<dataset>.ts` | `DATASET`, the SQL casts and the validation |
| `publisher/src/silver/<dataset>.cli.ts` | Names only |
| `*.test.ts` and `publisher/src/silver/fixtures/<dataset>/` | Real trimmed extracts, a normal day and a DST day, with a README that gives the source URLs |

### Rules

- **One file per trading day.** The collector builds the file name from the date (`yyyymmdd` + `FILE_SUFFIX`). Dispatch energy prices, dispatch reserve prices, nodal prices and cleared offers fit. Generation_MD (one file per month) and Mappings (dated snapshots) do not. Their collectors will need their own file selection. They still use `listNames` and `archiveFile`. [ADR-0006](0006-mapping-datasets-snapshots.md) sets the pattern for mappings. [ADR-0007](0007-generation-md-monthly-files.md) sets the pattern for Generation_MD.
- **SQL in DuckDB.** TypeScript builds the SQL and handles files. DuckDB reads the CSV, casts, validates and writes Parquet. Read the CSV with `all_varchar` and use `TRY_CAST`, so bad values are counted and not thrown.
- **Which bronze file.** `findBronze` reads `manifest.jsonl`. It takes the last record that lists the trading date. The publisher does not import collector code. The manifest field names are a contract.
- **Column names** follow ADR-0003. Keep source IDs and the source trading date and period. Add `event_start_utc` and `event_end_utc`, and `source_published_at` when the source has a publish time. Use `periodToUtc` for periods. Add `bronze_file_name`, `bronze_sha256` and `retrieved_at` as provenance.
- **No `processed_at` in silver.** It would change on every run. Silver stays repeatable. ADR-0003 carries a matching amendment. Gold may use `processed_at`.
- **Layout.** `silver/<dataset>/trading_date=YYYY-MM-DD/data.parquet`. `writeParquetAtomically` writes a `.tmp` file and renames it. An invalid day writes nothing and leaves an older partition as it was.
- **Repeatable.** The same bronze version gives the same Parquet bytes. The `ORDER BY` must be a total order, so it must end with the unique key. Test this with a byte comparison.
- **Validation** returns `complete`, `partial` (missing periods listed), `missing` (no bronze file) or `invalid` (with messages). An invalid day writes nothing. A partial day (some expected trading periods have no rows) writes the rows that exist, because the source sometimes omits periods (the owner decided this on #6: "Publish as partial"). The CLI prints `<date>: PARTIAL <rows> rows, missing periods 24,25` and still exits 0. It reports invalid days, finishes the range and exits 1. Silver has no completeness column or sidecar. Completeness tracking ([#14](https://github.com/joshmcarthur/gridwatch/issues/14)) compares expected and actual periods in silver. Check that no row falls outside the expected set. A join can drop such rows without a sign.
- **Collector errors.** A failed day goes in `failed`. The run continues with the next day.
- **Querying.** `SELECT … FROM read_parquet('data/silver/<dataset>/**/*.parquet', hive_partitioning = true)`. The file also holds `trading_date`, so the query works with or without the option.
- **Dates.** The CLI takes a range and defaults to yesterday. The backfill runner picks the range (12 months back from the run date, computed at run time).

### Adding a dataset: checklist

Replace `<dataset>` with the dataset ID in `snake_case` for constants and in `kebab-case` for file names, for example `dispatch_energy_prices` and `dispatch-energy-prices`. The ID is the same in the manifest, the bronze folder and the silver folder.

1. Read `docs/sources.md` for the dataset: folder, file name pattern, columns, quirks, gaps.
2. Download two real files anonymously with `curl`: a normal day and a DST day (27 Sep 2026 has 46 periods, 5 Apr 2026 has 50). Keep the header. Trim rows, but keep every trading period. Save them in `publisher/src/silver/fixtures/<dataset>/` with the original names. Write a `README.md` there with each source URL and how you trimmed the rows. Copy the README from `dispatch-energy-prices`.
3. Copy `collector/src/electricity-authority/dispatch-energy-prices.ts` and `.cli.ts` to the new names. In the `.ts` file change `DATASET`, `FOLDER`, `FILE_SUFFIX` and `HUB_URL`. Change the function name and the import in the `.cli.ts` file. Change nothing else.
4. Copy `collector/src/electricity-authority/dispatch-energy-prices.test.ts` and change the names, folder and file names.
5. Add `"collect:<kebab>": "node src/electricity-authority/<kebab>.cli.ts"` to `collector/package.json`.
6. Copy `publisher/src/silver/dispatch-energy-prices.ts` and `.cli.ts`. Change `DATASET` and the function names. Rewrite the `CREATE TEMP TABLE` casts for the new columns, using the ADR-0003 column names. Rewrite the validation query and its error messages. Write the validation rule in the doc comment above the function. Rewrite the final `SELECT` and keep a total `ORDER BY`.
7. Copy `publisher/src/silver/dispatch-energy-prices.test.ts`. Change the names, the expected row counts and the expected UTC times. Keep these tests: normal day, DST day, identical bytes on a second run, partial day (missing periods are listed and the other rows are written), missing, one invalid case for each validation check, newer bronze version wins, invalid day keeps the older partition.
8. Add `"publish:<kebab>": "node src/silver/<kebab>.cli.ts"` to `publisher/package.json`.
9. Run `npm ci && npm run lint && npm run typecheck && npm test`. Use `npm run format` to fix formatting. On a machine with an older Node, run each command through `mise exec node@26 --`.
10. Run both CLIs for one recent day into a temporary `DATA_ROOT` and compare the row counts with the source file: `DATA_ROOT=$(mktemp -d) npm run collect:<kebab> -w collector` then `npm run publish:<kebab> -w publisher`.

### Validation for dispatch energy prices

The source publishes prices at irregular times, about 278 `PublishDateTime` values a day, not 288 regular intervals. A count of 5-minute intervals does not fit. A day is **invalid** (nothing written) when:

1. The file has no rows, or a row has a `TradingDate` other than the requested date.
2. A row has a trading period outside the range of the day (1 to 46, 48 or 50, from `periodsInTradingDate`).
3. The key `(TradingPeriod, PublishDateTime, PointOfConnection)` has duplicates.
4. A period, time, point of connection or price does not parse, a price is not finite, or `IsProxyPriceFlag` is not `Y` or `N`.

A day is **partial** (written) when one or more periods of the day have no rows. Otherwise it is **complete**.

### Silver columns, dispatch energy prices

`trading_date`, `trading_period`, `event_start_utc`, `event_end_utc` (the period span), `source_published_at`, `point_of_connection`, `island` (null when blank in the source), `is_proxy_price`, `dollars_per_megawatt_hour`, `bronze_file_name`, `bronze_sha256`, `retrieved_at`.

### Validation for nodal prices and volumes

A row is one 5-minute interval of one RTD case for one point of connection and one unit. `IntervalDateTime` is the interval start. The source keeps every case, so an interval can have two. Silver keeps every case too. Layers after silver keep only the latest case (latest `RunDateTime`) for each interval, because Gridwatch wants one snapshot of the day (owner decision on [#9](https://github.com/joshmcarthur/gridwatch/issues/9)). A day is **invalid** (nothing written) when:

1. The file has no rows, or a row has a `TradingDate` other than the requested date.
2. A row has a trading period outside the range of the day.
3. An interval is not on a 5-minute boundary, or lies outside its trading period.
4. The key `(IntervalDateTime, CaseID, PointOfConnectionCode, UnitCode)` has duplicates.
5. A period, time, case ID, point of connection or number does not parse, a number is not finite, or a dead or disconnected flag is not `Y` or `N`.

A day is **partial** (written) when one or more periods of the day have no rows. The unit of completeness is the trading period, as for dispatch energy prices. A period with some missing intervals is not partial, because the source omits about ten intervals on most days. Completeness tracking ([#14](https://github.com/joshmcarthur/gridwatch/issues/14)) can count intervals per period from silver.

### Silver columns, nodal prices and volumes

`trading_date`, `trading_period`, `event_start_utc`, `event_end_utc` (the 5-minute interval), `source_run_at` (`RunDateTime`), `case_type`, `case_id`, `point_of_connection`, `unit_code` and `plant_name` (null on point of connection rows, where the source says `N/A`), `island` (null when blank), `load_megawatts`, `initial_megawatts`, `generation_megawatts`, `location_factor`, `dollars_per_megawatt_hour`, `is_dead`, `is_disconnected`, `bronze_file_name`, `bronze_sha256`, `retrieved_at`. Load and generation stay in separate columns. The data stays at source resolution.

### Validation for dispatch reserve prices

The source has FIR and SIR columns on one row. Silver is long: one row per reserve class, so the checks run on those rows. A day is **invalid** (nothing written) when:

1. The file has no rows, or a row has a `TradingDate` other than the requested date.
2. A row has a trading period outside the range of the day (1 to 46, 48 or 50).
3. The key `(TradingPeriod, PublishDateTime, PointOfConnection, reserve class)` has duplicates. The count is of extra rows, so one repeated source line reports `2 duplicate keys`.
4. A period, time, point of connection or price does not parse, or a price is not finite.
5. `Island` is neither blank, `NI` nor `SI`.

A day is **partial** (written) when one or more periods of the day have no rows. Otherwise it is **complete**. The `rows` count in the result is silver rows, so it is twice the source rows.

### Silver columns, dispatch reserve prices

`trading_date`, `trading_period`, `event_start_utc`, `event_end_utc` (the period span), `source_published_at`, `point_of_connection`, `island` (null when blank in the source), `reserve_class` (`FIR` or `SIR`, the source codes), `dollars_per_megawatt_hour`, `bronze_file_name`, `bronze_sha256`, `retrieved_at`.

### Validation for cleared offers

A row is one 5-minute interval of one RTD case for one point of connection, one unit and one product class. The shape matches nodal prices: `IntervalDateTime` is the interval start, `RunDateTime` is `source_run_at`, and silver keeps every case. Layers after silver keep the latest case for each interval. A day is **invalid** (nothing written) when:

1. The file has no rows, or a row has a `TradingDate` other than the requested date.
2. A row has a trading period outside the range of the day.
3. An interval is not on a 5-minute boundary, or lies outside its trading period.
4. The key `(IntervalDateTime, CaseID, PointOfConnectionCode, UnitCode)` has duplicates.
5. A period, time, case ID, point of connection or number does not parse, a number is not finite, or a dead or disconnected flag is not `Y` or `N`.

A day is **partial** (written) when one or more periods of the day have no rows. The unit of completeness is the trading period, as for dispatch energy prices. A period with some missing intervals is not partial, because the source omits about ten intervals on most days. Completeness tracking ([#14](https://github.com/joshmcarthur/gridwatch/issues/14)) can count intervals per period from silver.

### Silver columns, nodal prices and volumes

`trading_date`, `trading_period`, `event_start_utc`, `event_end_utc` (the 5-minute interval), `source_run_at` (`RunDateTime`), `case_type`, `case_id`, `point_of_connection`, `unit_code` and `plant_name` (null on point of connection rows, where the source says `N/A`), `island` (null when blank), `load_megawatts`, `initial_megawatts`, `generation_megawatts`, `location_factor`, `dollars_per_megawatt_hour`, `is_dead`, `is_disconnected`, `bronze_file_name`, `bronze_sha256`, `retrieved_at`. Load and generation stay in separate columns. The data stays at source resolution.

4. The key `(IntervalDateTime, CaseID, ProductClass, PointOfConnectionCode, UnitCode)` has duplicates.
5. A period, time, case ID, point of connection or participant is blank or does not parse.
6. `ProductClass` is not `Injection` or `Offtake`.
7. A megawatt value is present but is not a finite number. A blank megawatt value is valid and means none cleared.

A day is **partial** (written) when one or more periods of the day have no rows. A period with some missing intervals is not partial, as for nodal prices.

### Silver columns, cleared offers

`trading_date`, `trading_period`, `event_start_utc`, `event_end_utc` (the 5-minute interval), `source_run_at` (`RunDateTime`), `case_type`, `case_id`, `product_class` (as published), `point_of_connection`, `unit_code` and `plant_name` (null when the source says `N/A`), `island` (null when blank), `participant_code`, `cleared_generation_megawatts`, `cleared_fir_megawatts`, `cleared_sir_megawatts` (null when blank, meaning none cleared), `bronze_file_name`, `bronze_sha256`, `retrieved_at`.

The three megawatt columns stay separate, as in the source. Energy and reserve offers stay distinguishable, and one source row stays one silver row. A long form with a product column would turn one source row into up to three, and many would be null. Readers who want a long form can unpivot the three columns in a query.

## Consequences

- Five datasets mean five similar files. The shared parts are in `common.ts`, `blob.ts` and `archive.ts`.
- `island` stays null for some points. The entity model issue fills it from the mapping table.
- The first run of a dataset can show days that the source never published (22 days are missing in 2025). They appear as `missing`.
- An invalid day keeps its older partition. A reader cannot tell from the data alone that the newest bronze version failed. The run output is the only signal. A later runner issue can store it.
- `collector/src/archive.ts` had a TypeScript parameter property, which Node cannot run without a build step. We replaced it and set `erasableSyntaxOnly` in `tsconfig.base.json`, so the type check now catches this class of error.

# ADR-0007: Generation_MD: one monthly file, one silver partition per trading day

- Status: Accepted
- Date: 2026-11-20

## Context

[ADR-0005](0005-dataset-pattern.md) fits datasets with one file per trading day. Generation_MD does not. The source publishes one wide CSV per calendar month, with columns `TP1` to `TP50`. The files lag the metered data. Each file appeared about 10 days after the month ended, and it held every day of its month. The source re-stamps earlier months (`202609` was rewritten on 17 Nov, a week after `202610` appeared). See [#8](https://github.com/joshmcarthur/gridwatch/issues/8) and [`docs/sources.md`](../sources.md) section 3.5.

## Decision

The dataset ID is `generation_md`. It has the same shape as a dataset in ADR-0005. The differences follow.

- **Collector.** `collectGenerationMd` lists the folder and archives each monthly file that overlaps `--from` to `--to`. It still uses `listNames` and `archiveFile`. A month the source does not list goes in `missing` (format `YYYY-MM`). The failed list also uses months. The CLI takes the usual range and defaults to yesterday (ADR-0005). A run for yesterday usually finds yesterday's month unlisted, and the source rewrites older months. The runner ([#13](https://github.com/joshmcarthur/gridwatch/issues/13)) must pass a range that spans every month it wants to refresh.
- **Manifest.** `trading_dates` lists every date of the month, also for a month the source has published only in part. `findBronze` then works for each day without a change. A revised file lists the same dates, so `tradingDatesChangedSince` returns all days of that month. (Changed by [ADR-0009](0009-runner-default-mode.md): the function is removed. The runner finds the same days by comparing the bronze SHA-256 with the one in each silver partition, and a revised month still publishes again every day it lists.) Live files always hold every day of the month. We list all dates as a defence against a month published part way (inferred, not seen).
- **Publisher.** One call publishes one trading date. It reads the whole monthly file and keeps the rows of that date. Each day is its own partition: `silver/generation_md/trading_date=YYYY-MM-DD/data.parquet`. The newest bronze version wins for each day. A revised monthly file replaces every partition of its month the next time the publisher runs for those days. If a revised file drops a date, the older partition stays and the publisher reports `missing` for that date.
- **Long form.** Silver has one row per unit and trading period. A blank cell writes no row, and a blank for some units in a period that others fill makes the day invalid (see below). DuckDB `UNPIVOT` on the `TP<n>` columns does this in SQL. DuckDB matches column names without case, so `Trading_date` and `Trading_Date` both work.
- **Unit key.** `(site_code, point_of_connection, network_code, gen_code)`. These are the source `Site_Code`, `POC_Code`, `Nwk_Code` and `Gen_Code`. One plant can have more than one point of connection. A duplicate key on a day is invalid.
- **Unit of measure.** The source gives kWh. Silver keeps kWh in the column `kilowatt_hours`. Silver does not convert to MWh, because the conversion adds nothing and a division can change the digits. Gold can convert.
- **Source codes.** `fuel_code` and `tech_code` keep the source values. The two vocabularies (`Hydro` and `HYD`, `Wind` and `WIN`, `Solar` and `SOL`, `Geo` and `GEO`) stay as they are. A fuel map belongs to the entity model issue (open question 8 in `docs/sources.md`).
- **Period rules.** A non-empty value outside the periods of the day is invalid. That is TP49 and TP50 on a 48-period day, and TP47 and TP48 on a 46-period day. A normal day uses TP1 to TP48. The DST-end day uses TP1 to TP50.
- **Missing, partial and invalid.**
  - `missing`: no bronze file, or the file has no rows for that date, or every cell of the date is blank. A file that holds only part of a month would give the second case. Live data has none (inferred defence).
  - `partial`: a period is blank for every unit. The rows that exist are written and the missing periods are listed (the owner's decision on #6, ADR-0005).
  - `invalid`: the file has no rows, a trading date does not parse, a unit code is blank, a unit is duplicated, a value is not a finite number, a value lies outside the periods of the day, a `TP<n>` column number does not parse, or a blank cell for some units lies in a period that other units fill. The source writes 0 for no generation, so such a blank is missing data. The message gives the blank count. Live data has no blank in 13 files. A bad date makes every day of that file invalid, because the publisher cannot tell which day the row belongs to.
- **Negative values.** Silver keeps them. A battery could report one. Live data from 12 months has none.
- **Publisher CLI.** It takes the usual range. It counts days with no source data and does not list them. The source lags, so the last days of a range often have none.

## Consequences

- Each day reads the whole monthly file again (about 0.8 MB). A 12 month run reads each file about 30 times. A run takes under a minute.
- A silver reader sees a `kilowatt_hours` value per unit and period. It must join the unit to the fleet table for plant and owner. The entity model issue decides the join key. Both tables hold `point_of_connection`.
- A revised month changes the output of its days only when the publisher runs for them again. The runner issue decides when.

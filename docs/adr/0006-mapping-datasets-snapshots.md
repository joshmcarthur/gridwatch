# ADR-0006: Mapping datasets keep one silver partition per snapshot

- Status: Accepted
- Date: 2026-11-20

## Context

[ADR-0005](0005-dataset-pattern.md) fits datasets with one file per trading day. Mapping data does not fit. The Network Supply Points (NSP) table is published as dated snapshots, not every day. The generation fleet file has no date, and the source overwrites it in place. Both files hold their own history in validity columns. See [#7](https://github.com/joshmcarthur/gridwatch/issues/7) and [`docs/sources.md`](../sources.md) section 3.6.

## Decision

Two datasets land in silver: `network_supply_points` and `generation_fleet`. Each has the same shape as a dataset in ADR-0005. The differences follow.

- **Snapshot date, not trading date.** The manifest field `trading_dates` holds one snapshot date. `findBronze` works without a change. The silver partition is `silver/<dataset>/snapshot_date=YYYY-MM-DD/data.parquet`. The partition holds the whole table of that snapshot.
- **NSP snapshots.** The collector lists the folder and archives every file whose name date lies in `--from` to `--to`, and the newest snapshot before `--from`. Days at the start of the range need that snapshot. It does not report missing dates, because the source does not publish daily. The snapshot date is the date in the file name.
- **Fleet file.** The collector archives the one current file. The CLI labels it with today's NZ date. It has no `--from` or `--to`. Each check appends a manifest record with that date, so the publisher finds the version that was current on that date.
- **Validity ranges.** Silver keeps the source columns. NSP rows have `start_date` and `end_date` with periods. Both ends are inclusive. A blank end date stays null in NSP. Fleet rows have `effective_start_date` and `effective_end_date`. A row is in force when `effective_start_date <= day < effective_end_date` (the end is exclusive). Adjacent operator periods share a date. The fleet source writes 1900-01-01 and 2099-12-31 for "always". We keep those values.
- **Mapping for a day.** Take the newest snapshot with `snapshot_date` on or before the day. Then keep the rows in force on that day. A snapshot can hold rows that start after its own date, for example `AER0011` in the 2026-01-06 snapshot. The row filter handles this. A day before the oldest collected snapshot has no mapping. The NSP collector takes the newest snapshot before `--from`, so a backfill range always has one. The source keeps snapshots from 2026-01-06, so days before that have no mapping.
- **Coordinates.** NSP gives NZTM easting and northing. Silver keeps both and adds WGS84 `latitude` and `longitude` (6 decimals). The conversion is the inverse Krueger series in SQL, because DuckDB needs a downloaded extension for projections. The test compares the result with PROJ (EPSG:2193 to 4326) to 6 decimals. Coordinates stay plain columns. No geometry type.
- **Source IDs.** `nsp`, `point_of_connection` (source `POC code`), `unit_code`, and the fuel and operator codes keep the source values.
- **Dropped columns.** NSP silver omits the flows, SB ICP, balancing code, MEP, responsible participant and the two expiry columns. The initial datasets do not use them. Bronze keeps the original file, so a later issue can add them.
- **No partial status.** A snapshot has no expected periods, so it is `complete`, `missing` or `invalid`. The ADR-0005 tests for a DST day and a partial day do not apply. The validation rules are in the doc comment of each publish function.
- **Publisher CLI.** A range of dates has many dates with no snapshot. The CLI counts them and does not list them.
- **Fleet file is outside the Mappings folder.** The issue asks for plant to fuel and owner. The only public file for this is `Generation/GenerationFleet/Existing/DispatchedGenerationPlant.csv`. It also holds the operator (owner) with dates. Other datasets join to it by point of connection, and by unit code where the file has one.

## Not decided here

The NSP table lacks 18 of the 246 priced POCs. See `docs/sources.md` section 3.6. Silver does not invent an island for them. A rule for unmapped nodes belongs to the entity model issue.

## Consequences

- A reader joins on `point_of_connection` and picks the snapshot and the validity rows. It is more work than a flat table. It keeps history correct.
- Storage grows by one NSP partition per published snapshot. One partition holds about 2,700 rows.
- A change to the fleet file shows up only on the date of the check that stored it. Earlier snapshot dates keep the earlier version.

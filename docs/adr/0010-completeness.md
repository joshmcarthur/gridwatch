# ADR-0010: Completeness is a silver table written from the publish result

- Status: Accepted
- Date: 2026-11-20

## Context

A missing or partial dataset must not become a chart that looks complete. Each dataset and trading date needs a status. The latest data is per dataset, not one global as-of. See [#14](https://github.com/joshmcarthur/gridwatch/issues/14).

Publish already returns `complete`, `partial` (with the missing periods), `missing` or `invalid` ([ADR-0005](0005-dataset-pattern.md)). Invalid and missing both leave no new partition. They differ only in that return value. A later scan of the lake cannot tell them apart.

Dispatch energy and reserve prices have no files for 2025-09-11 to 2025-10-02 ([`docs/sources.md`](../sources.md)). Generation_MD arrives as a monthly file and lags by weeks ([ADR-0007](0007-generation-md-monthly-files.md)). Trading days have 46, 48 or 50 periods ([ADR-0003](0003-time-column-naming.md)). Snapshots and entity mappings do not have trading periods ([ADR-0006](0006-mapping-datasets-snapshots.md), [ADR-0008](0008-entity-model.md)).

Fact tables omit `processed_at` so a repeat publish is byte-identical ([ADR-0003](0003-time-column-naming.md), [ADR-0005](0005-dataset-pattern.md)).

## Decision

The publisher writes `silver/_completeness/data.parquet` from inside `runPublish`. One row per dataset and date. The row is built from the `PublishResult` of that call. The run does not read the silver partition it just wrote.

Columns: `dataset`, `trading_date`, `status`, `expected_period_count`, `actual_period_count`, `missing_periods`, `bronze_sha256s`, `source_published_at`, `processed_at`, `errors`.

- `trading_date` is the date the dataset already uses. For a snapshot that is the snapshot date.
- `status` is `complete`, `partial`, `missing` or `invalid`.
- Period datasets set `countsTradingPeriods` on the registry. `expected_period_count` is `periodsInTradingDate` (46, 48 or 50). `actual_period_count` is the expected count minus the missing periods. A `missing` day has actual 0. An `invalid` day has a null actual count, because the file was not trusted. `missing_periods` lists the holes on a `partial` day.
- Snapshots and entity mappings leave the period columns null. They are not given 48 periods.
- `bronze_sha256s` is the one version the runner compared for that date. Entity mappings store `inputs_sha256` there ([ADR-0008](0008-entity-model.md)).
- `source_published_at` is null. `PublishResult` has no day-level publish time.
- `errors` is the invalid-day messages. Other statuses store an empty list.
- `processed_at` is the time the row was written. This table may change when a row is written. Fact tables still omit `processed_at`.

`invalid` is stored only when publish returns `invalid`. A day with no bronze and no silver has no row. `readCompleteness` returns `missing` for a date with no row. The 22-day price gap is missing. A Generation_MD day before its month file exists is missing. Neither is invalid.

A date the runner skips, because silver already holds the current version, keeps its row, including `processed_at`. If the row is absent, the run fills it from the partition on disk: period counts for a period dataset, `complete` with null period counts otherwise. A run that adds or replaces no row does not rewrite the file.

A date that throws keeps any previous row. The run reports the failure. It does not invent a status.

`publisher status` prints the latest `complete` date for each dataset. A dataset with none prints `none`.

Gold reads this run's rows, in memory. `runPublish` loads the table once at the start and passes a read-only view of the map to each gold `publish` and `wantedVersions`. Silver datasets run before gold, so the view already holds their rows from this run. Gold does not read the file from disk, because the file may be a run behind. `readCompleteness(silverDir, registry, dataset, date)` is the disk read helper. It takes the registry as an argument, because `completeness.ts` must not import `datasets.ts`, which imports gold.

The runner saves the table after each silver dataset, not only at the end. A run that crashes keeps the rows of the datasets that finished. Gold has no rows in this table.

Two runs that overlap, for example a cron run and a backfill, each hold their own copy of the map and each rewrite the whole file. The last writer wins, and the other run's new rows are lost until a later run records them again. A skipped date with no row is filled again, and an `invalid` day is recorded again on its next publish, so the table heals. This is acceptable for a single cron host.

The entity mapping tables have no row in this table: they have no trading periods and no publish status of their own for a day. Gold counts an entity table as `complete` for a date when its partition exists.

## Rationale

A second scan would forget `invalid`, because an invalid day writes nothing and looks like `missing` on disk. The publish result is the only place that still knows.

Keeping a skipped row avoids a new `processed_at` on every cron run. Filling a missing row once lets this table appear for silver that was published before the table existed, without a backfill command.

One Parquet file is enough. The table is small. The status command reads it in one query. A partition per day would make that summary harder and is not needed for repeatable fact data.

Thermo-nuclear plan review: Approve. The row is written from `PublishResult` inside `runPublish`. There is no second runner and no scan of a day just published.

## Consequences

- A reader can see that the newest bronze version failed validation. The fact partition can still be the older complete day ([ADR-0005](0005-dataset-pattern.md)).
- Gold marks an output incomplete when an input day is not `complete` ([ADR-0011](0011-gold-table-pattern.md)). It reads the in-memory rows of the run.
- `source_published_at` stays null until `PublishResult` carries a day-level time.
- Deleting `silver/_completeness/data.parquet` does not republish fact partitions. The next run rebuilds the rows from the partitions it skipped, and from the publish results of the dates it publishes. An `invalid` day is recorded again only when publish returns `invalid`, which the runner already retries ([ADR-0009](0009-runner-default-mode.md)).
- The 22-day gap and a lagged Generation_MD day do not appear as rows. They read as `missing`.

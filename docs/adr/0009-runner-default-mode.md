# ADR-0009: Runner default mode derives its state from the manifest and silver

- Status: Accepted
- Date: 2026-11-20

## Context

[#13](https://github.com/joshmcarthur/gridwatch/issues/13) adds one command to bring `data/` up to date, for the collector and for the publisher. The cron job runs `docker compose run --rm collector` and then `publisher` ([ADR-0002](0002-daily-run-data-and-site-hosting.md)). Both must be idempotent. The source rewrites recent files and rewrites monthly files weeks later ([`docs/sources.md`](../sources.md), [ADR-0007](0007-generation-md-monthly-files.md)). The owner limited the first backfill to 12 months.

## Decision

Each package has a plain array of datasets (`collector/src/datasets.ts`, `publisher/src/datasets.ts`) and a runner (`runner.ts`). A new dataset adds one entry to each array. There is no framework.

### No state file

The runner stores no "last run" value. It derives it.

- **Collector.** The runner reads which trading dates the manifest holds for each dataset. Every check appends a record, so the manifest is the record of what ran. It decides what is missing in the 12-month window.
- **Publisher.** A date needs publishing when its silver partition is missing, or its `bronze_sha256` differs from the SHA-256 of the newest bronze version that lists the date. Every silver row carries `bronze_sha256` ([ADR-0005](0005-dataset-pattern.md)). The runner reads the manifest once for the newest SHA of each date, and reads `bronze_sha256` from the silver partitions with one DuckDB query for each dataset.

The publisher does not call `tradingDatesChangedSince` ([ADR-0004](0004-bronze-archive-and-manifest.md), [ADR-0007](0007-generation-md-monthly-files.md)). That function lived in the collector and needed the time of the last publish. We removed it. ADR-0004 and ADR-0007 keep their text, with a note that points here. A stored time is a second state file. It also loses a day for good when one publish fails after the time moves. Comparing SHA values needs no state, publishes exactly the days whose input changed, and tries an invalid day again on each run. The publisher keeps its own manifest reader (`bronzeVersions` next to `findBronze`), as the manifest field names are the contract between the two packages.

### Collector default range

The default mode collects the 12-month window and the trailing window. It does not keep a "first run" flag. The run date comes from an injected clock, and `to` is yesterday in NZ. The window starts 12 months before the run date. For each dataset the runner collects these date ranges:

| Kind | Datasets | Ranges |
| --- | --- | --- |
| Daily files | dispatch energy prices, dispatch reserve prices, nodal prices and volumes, cleared offers | The trailing 5 days (to - 4 to to), and every date of the window that has no manifest record. Neighbouring dates join into one range |
| Snapshots | network supply points | Same as daily files. Most dates have no snapshot, so this is the whole window on each run. The collector lists the folder once, and every held snapshot returns 304 |
| Monthly files | generation_md | The run month and the 2 months before it (the source rewrites a month weeks after it appears), and every month of the window that has no manifest record. A range covers whole months, up to `to` |
| No dates | generation fleet | One check, labelled with the run date. It ignores the range |

An empty manifest gives the whole window, so the first run is the 12-month backfill. A short targeted run on empty data, such as `collect --from 2026-11-15 --to 2026-11-17`, does not stop the later backfill. A day that failed, or that the collector never reached, is collected again on the next run, inside the window.

A date the source never published (a gap in the source) has no record, so each run asks again. That costs one folder listing, because the collector counts unlisted dates as "not listed" and does not fetch them. A re-fetch of a held file sends a conditional request. An unchanged file returns 304 and stores nothing. A file the source does not list yet (yesterday, or the current month) is "not listed" and is not a failure. A date outside the window is not looked at. `collect --from` covers it.

`collect --from --to` replaces the default ranges for every selected dataset (`--to` needs `--from`; `--from` alone ends yesterday). `--dataset` limits the run and can repeat.

### Publisher range

Default: every date the manifest lists for the dataset. The manifest holds only what the collector fetched, so this is bounded by the backfill. `--from --to` limits the dates (`--from` alone ends today). `--force` publishes the selected dates again, for the case where silver code changed and bronze did not. A date that is up to date is skipped, so a second run writes nothing.

### Failures

A dataset can fail without stopping the others: a thrown error, a failed download, an invalid day, or a publish that throws. Each run prints one line for each dataset, then each failure, then the names of the failed datasets. The publisher also prints a line for each partial day, as the dataset CLIs do (ADR-0005). The exit code is 1 when any dataset failed, 2 for bad arguments.

- A failed download has no manifest record, so the collector tries it again on the next run.
- When the newest bronze version of a date is invalid, the publisher tries that date on every run, and the run exits 1 until the source file is fixed. The older partition stays as it was.
- A date that is `missing` (a bronze file with no data for that date) is checked again on every run. It writes nothing and does not fail the run.

## Consequences

- Deleting a silver partition republishes it on the next run. A folder with no `data.parquet` counts as "not held". Deleting `manifest.jsonl` makes the collector backfill 12 months again, and it downloads every file again, as conditional requests need records.
- An explicit publisher range leaves out the NSP snapshot dated before `--from`. Default mode publishes it.
- The collector asks again for dates the source never published. This is cheap (see above).
- The fleet file gets one silver partition for each run date, even when the file did not change. This follows ADR-0006.
- A row in silver whose `bronze_sha256` equals the manifest is trusted. A hand-edited partition is not detected. Use `--force`.
- `compose.yml` sets `entrypoint`, so arguments after the service name reach the runner. This also means `docker compose up` runs the real job (a backfill on a new data folder), not a no-op.

# ADR-0009: Runner default mode derives its state from the manifest and silver

- Status: Accepted
- Date: 2026-11-20

## Context

[#13](https://github.com/joshmcarthur/gridwatch/issues/13) adds one command to bring `data/` up to date, for the collector and for the publisher. The cron job runs `docker compose run --rm collector` and then `publisher` ([ADR-0002](0002-daily-run-data-and-site-hosting.md)). Both must be idempotent. The source rewrites recent files and rewrites monthly files weeks later ([`docs/sources.md`](../sources.md), [ADR-0007](0007-generation-md-monthly-files.md)). The owner limited the first backfill to 12 months.

## Decision

Each package has a plain array of datasets (`collector/src/datasets.ts`, `publisher/src/datasets.ts`) and a runner (`runner.ts`). A new dataset adds one entry to each array. There is no framework.

### No state file

The runner stores no "last run" value. It derives it.

- **Collector.** "Last run" is the newest trading date for the dataset in `manifest.jsonl`. Every check appends a record, so the manifest is the record of what ran.
- **Publisher.** A date needs publishing when its silver partition is missing, or its `bronze_sha256` differs from the SHA-256 of the newest bronze version that lists the date. Every silver row carries `bronze_sha256` ([ADR-0005](0005-dataset-pattern.md)). The runner reads the manifest once for the newest SHA of each date, and reads `bronze_sha256` from the silver partitions with one DuckDB query for each dataset.

The publisher does not call `tradingDatesChangedSince` ([ADR-0004](0004-bronze-archive-and-manifest.md)). That function lives in the collector and needs the time of the last publish. A stored time is a second state file. It also loses a day for good when one publish fails after the time moves. Comparing SHA values needs no state, publishes exactly the days whose input changed, and tries an invalid day again on each run. The publisher keeps its own manifest reader (`bronzeVersions` next to `findBronze`), as the manifest field names are the contract between the two packages.

### Collector default range

The default range ends yesterday in NZ. The start depends on the kind of dataset. The run date comes from an injected clock.

| Kind | Datasets | First run (empty manifest for the dataset) | Later runs |
| --- | --- | --- | --- |
| Daily files | dispatch energy prices, dispatch reserve prices, nodal prices and volumes | 12 months before the run date | The earlier of the last date held and the trailing 5 days (to - 4). A run fetches 5 days again, or everything since the last date held after an outage |
| Snapshots | network supply points | 12 months before the run date | Same as daily files. The collector also takes the newest snapshot before the start ([ADR-0006](0006-mapping-datasets-snapshots.md)) |
| Monthly files | generation_md | 12 months before the run date (13 monthly files at most) | From the first day of the earlier of: the month of the last date held, and the month 2 months before the run month. The run month and the two before it are checked each run, because the source rewrites a month weeks after it appears |
| No dates | generation fleet | One check, labelled with the run date | The same. It ignores the range |

A re-fetch sends a conditional request. Unchanged files return 304 and store nothing, so the trailing window costs a few requests. A file the source does not list yet (yesterday, or the current month) is counted as "not listed" and is not a failure.

`collect --from --to` replaces the default range for every selected dataset (`--to` needs `--from`; `--from` alone ends yesterday). `--dataset` limits the run and can repeat.

### Publisher range

Default: every date the manifest lists for the dataset. The manifest holds only what the collector fetched, so this is bounded by the backfill. `--from --to` limits the dates (`--from` alone ends today). `--force` publishes the selected dates again, for the case where silver code changed and bronze did not. A date that is up to date is skipped, so a second run writes nothing.

### Failures

A dataset can fail without stopping the others: a thrown error, a failed download, an invalid day, or a publish that throws. Each run prints one line for each dataset, then each failure, then the names of the failed datasets. The exit code is 1 when any dataset failed, 2 for bad arguments. A failed day or file is tried again on the next run, because the manifest or silver still shows the gap.

## Consequences

- Deleting a silver partition republishes it on the next run. Deleting `manifest.jsonl` makes the collector backfill 12 months again (conditional requests do not apply without records, so it downloads again).
- An explicit publisher range leaves out the NSP snapshot dated before `--from`. Default mode publishes it.
- A gap inside the held range (a day the source skipped) is not fetched again. `collect --from` covers it.
- The fleet file gets one silver partition for each run date, even when the file did not change. This follows ADR-0006.
- A row in silver whose `bronze_sha256` equals the manifest is trusted. A hand-edited partition is not detected. Use `--force`.

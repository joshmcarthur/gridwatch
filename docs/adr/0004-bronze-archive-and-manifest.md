# ADR-0004: Bronze archive layout and source manifest

- Status: Accepted
- Date: 2026-11-20

## Context

Bronze is the reproducibility guarantee ([ADR-0001](0001-typescript-monorepo-and-data-layers.md)). The source overwrites files in place and keeps no history. Only Cleared Offers serves `Content-MD5`. The Network Supply Points server keeps only snapshots from 2026-01-06. See [`docs/sources.md`](../sources.md). The collector must keep every version it sees, and the publisher must find the trading days that a new version affects.

## Decision

`collector/src/archive.ts` holds the shared code. Each dataset module calls `archiveFile` with the dataset ID, the source URL and the trading dates the file covers. The archive does not parse dates.

### Layout

```
data/bronze/
  manifest.jsonl
  <dataset>/<sha256>/<original file name>
```

- The file keeps its original name and exact bytes.
- The directory name is the SHA-256 of the content. Each distinct content has its own directory. The collector never overwrites or deletes a version.
- The collector streams a download to `<dataset>/.tmp-<uuid>`, checks `Content-Length`, then renames it into place. An interrupted run leaves no file that looks complete. It also writes no manifest record.

### Manifest

`manifest.jsonl` is append-only. One JSON object per line. Every successful check appends one record, including checks that find no change.

| Field | Meaning |
| --- | --- |
| `dataset` | Dataset ID. Same ID as in the publisher |
| `source_url` | The blob URL that the collector fetched |
| `hub_url` | Optional. The ea.govt.nz "Data & insights" page, because EMI is being retired |
| `file_name` | Original file name |
| `status` | `new` (first version), `changed` (new content), `unchanged` (no new bytes stored) |
| `checked_at` | UTC ISO timestamp of the check |
| `retrieved_at` | UTC ISO timestamp. Present only when this check stored a version (`new` or `changed`) |
| `etag`, `last_modified` | Source headers, or `null` |
| `sha256`, `size` | Of the version this record points to |
| `path` | Path of that version, relative to `data/bronze/` |
| `trading_dates` | `YYYY-MM-DD` dates the file covers. The dataset module supplies them |

### Change detection

1. The collector reads the latest record for the dataset and URL.
2. It sends `If-None-Match` (from `etag`) or else `If-Modified-Since` (from `last_modified`). The source returns 304 for both.
3. On 304, it records `unchanged` and downloads nothing.
4. On 200, it hashes the body. If the SHA-256 equals the latest record, it records `unchanged` with the new headers and keeps the stored version. Otherwise it stores a new version and records `new` or `changed`.

### Finding affected trading days

`tradingDatesChangedSince(bronzeDir, since)` returns the sorted, unique `trading_dates` of records that have `retrieved_at` after `since`. The publisher runner calls it with the time of its last run.

### Retries

The archive retries network errors, truncated bodies, 408, 429 and 5xx up to three times. The delay starts at 500 ms and doubles. Any other status throws.

## Consequences

- Revised files are easy to find, and old versions stay for audit and replay.
- Content addressing stores identical bytes once, even when the source changes only its headers.
- The collector keeps every revision. Disk use grows with the number of revisions. Re-fetching the last five days each run adds a version only when content changes.
- `unchanged` records grow the manifest by one line per check. Compact it later if it becomes large.
- The manifest has one writer at a time. Run the collector for one dataset file at a time.
- Remote storage sync is out of scope. It needs a later decision.

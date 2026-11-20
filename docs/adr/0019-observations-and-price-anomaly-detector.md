# ADR-0019: Observations and the price anomaly detector

- Status: Accepted
- Date: 2026-11-20

## Context

The brief asks for observations: deterministic facts that episodes and explanations are built on (sections 6.1, 6.4 and 12). [#22](https://github.com/joshmcarthur/gridwatch/issues/22) defines the observation shape that every detector shares, and builds the first detector, a price anomaly detector over the three reference nodes of [ADR-0012](0012-gold-prices.md). Detectors [#32](https://github.com/joshmcarthur/gridwatch/issues/32) to [#35](https://github.com/joshmcarthur/gridwatch/issues/35) follow the same rules. Episodes ([#36](https://github.com/joshmcarthur/gridwatch/issues/36)) join observations across trading dates. The tables follow the gold pattern of [ADR-0011](0011-gold-table-pattern.md).

## Decision

### Observation table

Each detector writes one gold table, `observations_<detector_id>`, partitioned by trading date at `gold/observations_<detector_id>/trading_date=YYYY-MM-DD/data.parquet`. A consumer reads all detectors with `read_parquet` over the folders `gold/observations_*`, with `union_by_name = true`.

Every observation table has these columns, in this order:

| Column | Meaning |
| --- | --- |
| `observation_id` | First 16 hex characters of SHA-256 over the detector ID, the observation type, the subject ID and the epoch of `event_start_utc`. The ID does not include the analysis version, so a re-run that finds the same run keeps the ID. |
| `detector_id` | For example `price_anomaly`. |
| `observation_type` | For example `price_high` or `price_low`. |
| `trading_date` | DATE. An observation never crosses a trading date. |
| `start_trading_period`, `end_trading_period`, `period_count` | Period numbers, inclusive, and the count of periods. |
| `event_start_utc`, `event_end_utc` | UTC instants. The end is exclusive ([ADR-0003](0003-time-column-naming.md)). |
| `subject_type`, `subject_id` | The subject kind (`point_of_connection`, `point_of_connection_pair`, `plant`, `fuel_category`, `reserve_class` or `island`) and its canonical ID ([ADR-0008](0008-entity-model.md)). |
| `point_of_connection`, `island`, `region_id`, `plant_id`, `fuel_category`, `reserve_class` | Typed subject columns. Null when they do not apply. A pair subject (#32) leaves `point_of_connection`, `island` and `price_region` null. |
| `price_region` | The [ADR-0012](0012-gold-prices.md) label of a reference node. It is not `region_id`. |
| `measured_value`, `measured_unit` | The extreme of the run: the maximum for a high run, the minimum for a low run. |
| `baseline_value`, `threshold_value`, `baseline_sample_count`, `baseline_window_start`, `baseline_window_end` | The baseline median, the threshold that the run crossed, and the baseline used. |
| `severity` | Unitless. It is 1 at the threshold and larger further out. |
| `parameters` | Canonical JSON of the detector configuration. The same text on every row. |
| `input_tables`, `analysis_version`, `inputs_sha256`, `inputs_complete` | Provenance ([ADR-0011](0011-gold-table-pattern.md)). |

There is no `detector_version` column. A module has one `ANALYSIS_VERSION` constant ([ADR-0011](0011-gold-table-pattern.md)), so a second version column would repeat it.

Each detector also writes a sentinel table with at least one row for each date. The runner reads the held `inputs_sha256` from it. The sentinel keys rows by `subject_id`. The sentinel table of the price detector is `price_anomaly_baselines`. It has one row for each reference node.

The shared kit lives in `publisher/src/gold/observation.ts` (`createRunTables`, the observation schema) and `publisher/src/gold/run-detector.ts` (`publishRunDetector`, `runDetectorDataset`). A detector file keeps only the series SQL, the subjects SQL, the config, the observation-type names and the subject column mapping. Detectors register with `goldDataset`. They are not a separate layer.

### Detector rules for #32 to #35

1. A detector is deterministic. It uses SQL over gold or silver with a total `ORDER BY`, `SET threads = 1`, and no `processed_at`.
2. Parameters live in one object in the module. Any change to the logic or to a value bumps `ANALYSIS_VERSION`. A test pins the hash of the config object.
3. The baseline is historical. It excludes the date under test and rows that are not complete. A detector has a minimum history. A date without enough history writes its sentinel row with `baseline_ready = false` and no observation.
4. A detector never runs silently over incomplete inputs. It writes the observation with `inputs_complete = false`.
5. A detector never skips a day silently. When a node has `baseline_ready = false`, the day result is `partial` with empty `missingPeriods`, so the runner prints it. Sentinel `inputs_complete` describes the input data only. `baseline_ready` is its own flag.
6. An observation lies inside one trading date and has at least one period. Episodes join across dates.
7. Severity is unitless and equals 1 at the threshold. The measured value, the baseline and the threshold are always recorded.
8. Every detector writes a sentinel table with at least one row for each date, and an observation table that may be empty.
9. The fingerprint is `goldDataset`'s `dateFingerprint`. A gold input with `windowDays` includes the `inputs_sha256` of each day in `date-N` … `date` that exists, and omits missing days. `wantedFingerprints` and `inputFingerprint` call the same function. A date is wanted only when the subject date has the gold partition.

### Price anomaly detector

- **Series.** The gold `price_periods` rows of `OTA2201`, `HAY2201` and `BEN2201`, the reference nodes of ADR-0012. The subject type is `point_of_connection`. `price_region` is set. `region_id` is null in version 1. Other points of connection are out of scope. Island comes from a local map in the detector file. `REFERENCE_NODES` stays `{ pointOfConnection, priceRegion }`.
- **Baseline.** The complete period prices of the node on the 28 days before the date. The date under test is not in the baseline. All periods of a day form one set of samples, not one set for each time of day. The baseline needs at least 672 samples (14 days), or `baseline_ready` is false.
- **Thresholds.** The high threshold is the larger of the 99th percentile and the median plus 25 $/MWh. The low threshold is the smaller of the 1st percentile and the median minus 25 $/MWh. A price is a hit when it is strictly above the high threshold or strictly below the low threshold. A null price is never a hit.
- **Runs.** Consecutive period numbers that hit make one run. A run needs at least two periods. A missing period ends a run. There is no gap bridging. Runs are made within one trading date, so a run that crosses midnight is split.
- **Severity.** For a high run, `(measured - median) / (high threshold - median)`. For a low run, `(median - measured) / (median - low threshold)`.
- **Config.** One object, `PRICE_ANOMALY_CONFIG`, in `publisher/src/gold/price-anomaly.ts`. The values are provisional. They are checked against the backfill and changed by a version bump.

| Key | Value | Why |
| --- | --- | --- |
| `baselineWindowDays` | 28 | Four whole weeks. The weekly cycle appears four times. The window is short enough to follow a change of regime. |
| `minBaselinePeriods` | 672 | 14 days of 48 periods. Half the window. |
| `highPercentile` | 0.99 | The example of brief section 6.1. |
| `lowPercentile` | 0.01 | The mirror of the high percentile. |
| `minDeviationFromMedian` | 25 | In a flat regime the percentiles fall on the median. A hit must also differ from the median by this much. |
| `minPeriods` | 2 | One period is a spike in a chart, not an observation. |

- **Fingerprint.** The registry entry is `goldDataset` with a gold input `{ layer: "gold", table: "price_periods", windowDays: config.baselineWindowDays }`. `inputs_sha256` is the same `dateFingerprint` that `wantedFingerprints` uses: the analysis version and the `inputs_sha256` of each `price_periods` day in the window that exists. A revised price day, a day that enters or leaves the window, and a version bump each change the fingerprint. A config change bumps `ANALYSIS_VERSION`.
- **Tables.** `price_anomaly_baselines` (sentinel, one row for each node, keyed by `subject_id`) and `observations_price_anomaly`.
- **Registry.** After `gold_prices`, because the detector reads `price_periods`.

## Alternatives considered

- **One shared `observations` table.** Rejected. The runner reads one sentinel fingerprint for each dataset, and `writeGoldTables` replaces a whole partition. Two detectors in one partition would overwrite each other.
- **A separate `analysis/` layer.** Rejected. Detectors are gold tables that read gold. They use `goldDataset` with a windowed `GoldInput`.
- **A baseline for each time of day.** Rejected. Each cell has about 28 values, which cannot support a 99th percentile.
- **A baseline that includes the current day.** Rejected. A spike would raise its own threshold.
- **Fixed thresholds only.** Rejected. A fixed threshold does not follow a change of regime, which the brief asks for.
- **A separate `detector_version` column.** Rejected. It would repeat `analysis_version`.
- **Bridging gaps between runs.** Rejected. A gap would join two runs with an unflagged period between them.
- **Detection on all points of connection.** Deferred. Issue #22 covers the three reference nodes. Node-level detection is a later issue.
- **Island on `REFERENCE_NODES`.** Rejected. Main's shape is `{ pointOfConnection, priceRegion }`. The detector holds a local map.

## Consequences

- A run that crosses midnight is split at the end of the trading date. If each half has fewer than `minPeriods` periods, the run is never written. For example, periods 48 and 1 form a 2-period run that disappears. Episodes cannot recover it. Version 1 accepts the loss.
- A sustained high-price regime becomes part of the baseline after about 2 weeks, and then stops being flagged. An absolute rule, for example that a negative price is always low, is a later tuning option.
- When the median is below 25 $/MWh, no low observation is possible unless the price is negative. This is the cost of the deviation guard.
- A revised price day rebuilds that day and the next 28 detector days.
- The first 14 days of history have no baseline. The runner prints them as `partial`. A 12-month backfill gives 14 such lines.
- There are no severity bands yet.
- The values are provisional. A change needs a bump of `ANALYSIS_VERSION` and a new pinned hash.
- Backfill counts are pending. The run over the full backfill has not happened. The counts per month, the days with `baseline_ready = false` and the observations with `inputs_complete = false` will be added here after that run.
- Issue #32 is a thin adapter over the same kit. Pair rows null the typed POC, island and price_region columns. They do not overload those columns as the dearer node.

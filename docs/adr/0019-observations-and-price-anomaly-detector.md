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

### Price separation detector

[#32](https://github.com/joshmcarthur/gridwatch/issues/32) adds a second run detector. It is a thin adapter over the same kit. The config object is `PRICE_SEPARATION_CONFIG` in `publisher/src/gold/price-separation.ts`.

- **Series.** The gold `price_spreads` of the three pairs in `SPREAD_PAIRS`: `OTA2201-HAY2201`, `HAY2201-BEN2201` and `OTA2201-BEN2201`. The value is the signed spread, from-node minus to-node. A null spread is never a hit and ends a run.
- **Rule.** The same as for prices, on the spread. The baseline is the complete non-null spreads of the pair on the 28 days before the date. The high threshold is the larger of the 99th percentile and the median plus 100 $/MWh. The low threshold is the smaller of the 1st percentile and the median minus 100 $/MWh. A hit is strictly beyond a threshold. A run is at least 2 consecutive periods inside one trading date.
- **Observation types.** `separation_high` and `separation_low`. They are in the observation ID. Severity is as for prices, and is at least 1.
- **Subject.** The subject type is `point_of_connection_pair`. The subject ID is the pair, in `SPREAD_PAIRS` order, for example `OTA2201-HAY2201`. `point_of_connection`, `island` and `price_region` are null. They do not hold the dearer node.
- **Sign convention.** `measured_value` is the extreme signed spread of the run: the maximum for a high run, the minimum for a low run. A positive value means the from-node was dearer. A negative value means the to-node was dearer.
- **Completeness.** `inputs_complete` is the pair-day: every `price_spreads` row of the pair on the date is complete. A pair with no row on the date is incomplete. `missingPeriods` lists the periods with a null spread. A date with no `price_spreads` partition is `missing`.
- **No cause.** An observation states that two prices differ. It does not state why.
- **Config.** The values are provisional. They are checked against the backfill and changed by a version bump.

| Key | Value | Why |
| --- | --- | --- |
| `baselineWindowDays` | 28 | As for prices. |
| `minBaselinePeriods` | 672 | As for prices. |
| `highPercentile` | 0.99 | As for prices. |
| `lowPercentile` | 0.01 | As for prices. |
| `minDeviationFromMedian` | 100 | A spread is a difference of two prices, so its normal range is wider than that of one price. In a flat regime the percentiles fall on the median, and a hit must also differ from it by this much. |
| `minPeriods` | 2 | As for prices. |

- **Fingerprint.** The registry entry is `goldDataset` with a gold input `{ layer: "gold", table: "price_spreads", windowDays: config.baselineWindowDays }`. `inputs_sha256` is the same `dateFingerprint` that `wantedFingerprints` uses. A revised spread day, a day that enters or leaves the window, and a version bump each change the fingerprint. A config change bumps `ANALYSIS_VERSION`.
- **Tables.** `price_separation_baselines` (sentinel, one row for each pair, keyed by `subject_id`) and `observations_price_separation`.
- **Registry.** After `gold_price_anomaly`, because the detector reads `price_spreads`.

### Reserve price anomaly detector

[#34](https://github.com/joshmcarthur/gridwatch/issues/34) adds a third run detector. It is a thin adapter over the same kit. The config object is `RESERVE_PRICE_ANOMALY_CONFIG` in `publisher/src/gold/reserve-price-anomaly.ts`.

- **Series.** The gold `reserve_by_class_island_period` rows of ADR-0013. The value is `dollars_per_megawatt_hour`. A null price is never a hit and ends a run. The four subjects are FIR/NI, FIR/SI, SIR/NI and SIR/SI.
- **Rule.** The same as for energy prices. The baseline is the complete non-null period prices of that class and island on the 28 days before the date. All periods of a day form one set of samples, not one set for each time of day. Reserve has no solar-style diurnal trap, so the all-periods window is the right one. The high threshold is the larger of the 99th percentile and the median plus 10 $/MWh. The low threshold is the smaller of the 1st percentile and the median minus 10 $/MWh. A hit is strictly beyond a threshold. A run is at least 2 consecutive periods inside one trading date.
- **Observation types.** `reserve_price_high` and `reserve_price_low`. They are in the observation ID. Severity is as for prices, and is at least 1. The measured unit is `$/MWh`.
- **Subject.** The subject type is `reserve_class`. The subject ID is `reserve_class|island`, for example `FIR|NI`. Typed columns `reserve_class` and `island` are filled. `point_of_connection` and `price_region` are null.
- **Completeness.** `inputs_complete` is the class-island-day: every gold reserve row of that subject on the date is complete. A subject with no row on the date is incomplete. `missingPeriods` lists the periods with `rows_present = 0`. A date with no `reserve_by_class_island_period` partition is `missing`.
- **Config.** The values are provisional. They are checked against the backfill and changed by a version bump. `minDeviationFromMedian` is $10, not energy's $25: reserve prices sit at $0 for long stretches (ADR-0013's FIR example is about $0.55), so a $25 floor would hide most genuine spikes, and a $0 floor would flag every $0.01 wiggle when the percentiles sit on the median. $5 was considered; $10 is the more conservative of the two. In a $0-median window the low rule can only fire on a negative price.

| Key | Value | Why |
| --- | --- | --- |
| `baselineWindowDays` | 28 | As for prices. Four whole weeks, all periods in one set. |
| `minBaselinePeriods` | 672 | 14 days of 48 periods. Half the window. |
| `highPercentile` | 0.99 | As for prices. |
| `lowPercentile` | 0.01 | As for prices. |
| `minDeviationFromMedian` | 10 | Reserve is often $0. The floor must be large next to a typical $0–$1 price, and small enough that a security spike still clears it. |
| `minPeriods` | 2 | As for prices. |

- **Fingerprint.** The registry entry is `goldDataset` with a gold input `{ layer: "gold", table: "reserve_by_class_island_period", windowDays: config.baselineWindowDays }`. `inputs_sha256` is the same `dateFingerprint` that `wantedFingerprints` uses. A revised reserve day, a day that enters or leaves the window, and a version bump each change the fingerprint. A config change bumps `ANALYSIS_VERSION`.
- **Tables.** `reserve_price_anomaly_baselines` (sentinel, one row for each class-island, keyed by `subject_id`) and `observations_reserve_price_anomaly`.
- **Registry.** After `gold_reserves` in DAG order, appended with the other detectors, because the detector reads `reserve_by_class_island_period`.

### Generation-change detectors

[#33](https://github.com/joshmcarthur/gridwatch/issues/33) adds two run detectors in `publisher/src/gold/generation-change.ts`. They share one `ANALYSIS_VERSION`. Each has its own observation table (ADR-0019). Both set `baselineByTradingPeriod: true` on the shared kit, which price and reserve detectors leave unset so their config hashes do not change.

The all-periods baseline used for prices is the wrong comparison for generation. Solar, wind and hydro have a strong time-of-day shape. Pooling every period of the 28-day window into one set mixes ordinary nights with midday. A stable daily ramp then looks like a low every morning and a high every evening, and a daytime plant trip can sit inside the pooled low tail (night zeros). ADR-0019 rejected a per-time-of-day baseline for prices because 28 samples cannot support a 99th percentile. Generation still matches time of day: `minBaselinePeriods` is a day-count (14), and a large `minDeviationFromMedian` in MW is the floor that a noisy 14-sample percentile cannot beat.

Percentiles stay 0.99 / 0.01, the same as prices. With 14 to 28 same-period samples the 99th percentile sits near the max of that cell, so a hit is "beyond recent same-period history". Dropping to 0.95 would still sit near the max at n = 14. The MW floor, not the percentile, is what stops a few MW of noise from firing. `minPeriods` is 2. Runs stay inside one trading date. There is no gap bridging.

The kit default is unchanged: omit `baselineByTradingPeriod` and all periods of the window still form one baseline, as for `price_anomaly`, `price_separation` and `reserve_price_anomaly`.

#### Plant generation-change

- **Series.** Gold `generation_by_plant_period`. The value is `average_megawatts`. The subject type is `plant`. `subject_id` is `plant_id`. `plant_id`, `island` and `fuel_category` are filled. `point_of_connection` and `price_region` are null.
- **Size cutoff.** A plant is a subject only when the mean of `average_megawatts` over complete baseline-window rows is at least 30 MW. `subjectsSql` reads the temp table `input`. The cutoff is the plant's typical size, not a one-day spike.
- **Battery.** `fuel_category` `battery` is not a subject. Battery is storage, not primary generation (ADR-0008, ADR-0017).
- **Observation types.** `generation_high` and `generation_low`.
- **Config.** `PLANT_GENERATION_CHANGE_CONFIG`. The values are provisional.

| Key | Value | Why |
| --- | --- | --- |
| `baselineWindowDays` | 28 | Four weeks of the same trading period. |
| `minBaselinePeriods` | 14 | Day-count. Half the window of same-period samples. |
| `highPercentile` | 0.99 | Same as prices. With n ≈ 14 the value sits near the max; the MW floor is the real guard. |
| `lowPercentile` | 0.01 | The mirror of the high percentile. |
| `minDeviationFromMedian` | 30 | MW. A 14-sample percentile must not fire on a few MW of noise. 30 MW is about a small hydro unit, not a rounding wiggle. |
| `minPeriods` | 2 | As for prices. |
| `baselineByTradingPeriod` | true | Compare period 20 to other period 20s, not to nights. |
| `minPlantAverageMw` | 30 | Drop plants whose baseline-window mean is below 30 MW. Recorded in `parameters`. |

- **Tables.** `plant_generation_change_baselines` (sentinel, one row for each plant and trading period of the date) and `observations_plant_generation_change`.
- **Fingerprint.** `goldDataset` with `{ layer: "gold", table: "generation_by_plant_period", windowDays: config.baselineWindowDays }`.

#### Fuel generation-change

- **Series.** Gold `generation_by_fuel_period`. The value is `average_megawatts`. The subject type is `fuel_category`. `subject_id` is `fuel_category|island`, for example `hydro|NI`. `fuel_category` and `island` are filled.
- **No size cutoff.** Island-fuel series are already large aggregates.
- **Skipped.** `battery`, and rows whose `island` is null.
- **Observation types.** `generation_high` and `generation_low`, the same names as the plant detector. `detector_id` and `subject_type` separate them.
- **Config.** `FUEL_GENERATION_CHANGE_CONFIG`. `minDeviationFromMedian` is 100 MW because an island-fuel series is a sum of plants.

| Key | Value | Why |
| --- | --- | --- |
| `baselineWindowDays` | 28 | As for the plant detector. |
| `minBaselinePeriods` | 14 | As for the plant detector. |
| `highPercentile` | 0.99 | As for the plant detector. |
| `lowPercentile` | 0.01 | As for the plant detector. |
| `minDeviationFromMedian` | 100 | MW. An island-fuel move of a few tens of MW is ordinary plant mix; 100 MW is a real shift. |
| `minPeriods` | 2 | As for prices. |
| `baselineByTradingPeriod` | true | As for the plant detector. |

- **Tables.** `fuel_generation_change_baselines` and `observations_fuel_generation_change`.
- **Fingerprint.** `goldDataset` with `{ layer: "gold", table: "generation_by_fuel_period", windowDays: config.baselineWindowDays }`.

#### Registry

After `gold_generation`, because both detectors read generation gold. The entries are appended after the price and reserve detectors. They do not read those tables. Order in the file is append-only so a parallel detector can land in the same list.

A period with no same-period samples in the window (`sample_count = 0`), for example periods 49 and 50 on a DST-end day, is vacuously `baseline_ready`. It cannot hit (thresholds are null). A period with 1 to 13 samples is not ready, and the day is `partial`.

## Alternatives considered

- **One shared `observations` table.** Rejected. The runner reads one sentinel fingerprint for each dataset, and `writeGoldTables` replaces a whole partition. Two detectors in one partition would overwrite each other.
- **A separate `analysis/` layer.** Rejected. Detectors are gold tables that read gold. They use `goldDataset` with a windowed `GoldInput`.
- **A baseline for each time of day.** Rejected. Each cell has about 28 values, which cannot support a 99th percentile.
- **A pooled all-periods baseline for generation.** Rejected for #33. Solar, wind and hydro have a strong daily shape. Pooling puts ordinary nights in the same set as midday, so a stable ramp looks like a low every morning and a daytime trip can hide in the pooled low tail. Generation uses `baselineByTradingPeriod`. The 14-sample cell cannot support a 99th percentile on its own; `minDeviationFromMedian` of 30 MW (plant) or 100 MW (island-fuel) is the floor.
- **A baseline that includes the current day.** Rejected. A spike would raise its own threshold.
- **Fixed thresholds only.** Rejected. A fixed threshold does not follow a change of regime, which the brief asks for.
- **A separate `detector_version` column.** Rejected. It would repeat `analysis_version`.
- **Bridging gaps between runs.** Rejected. A gap would join two runs with an unflagged period between them.
- **Detection on all points of connection.** Deferred. Issue #22 covers the three reference nodes. Node-level detection is a later issue.
- **Island on `REFERENCE_NODES`.** Rejected. Main's shape is `{ pointOfConnection, priceRegion }`. The detector holds a local map.
- **Dearer node in `point_of_connection`, `island` and `price_region`.** Rejected. Pair rows leave those columns null. The sign of `measured_value` records which node was dearer. A zero spread does not write a POC.
- **A time-of-day baseline for reserves.** Rejected. Same reason as for prices: 28 samples cannot support a 99th percentile. Reserve has no solar-style diurnal trap, so the all-periods 28-day window is the right one.
- **`minDeviationFromMedian` of $5 for reserves.** Rejected for v1 in favour of $10, the more conservative of the two suggested floors. A backfill can lower it with a version bump.
- **`subject_type` `island` with the class only in `subject_id`.** Rejected. The series is per class and island. `subject_type` is `reserve_class`; `island` is the typed column.

## Consequences

- A run that crosses midnight is split at the end of the trading date. If each half has fewer than `minPeriods` periods, the run is never written. For example, periods 48 and 1 form a 2-period run that disappears. Episodes cannot recover it. Version 1 accepts the loss.
- A sustained high-price regime becomes part of the baseline after about 2 weeks, and then stops being flagged. An absolute rule, for example that a negative price is always low, is a later tuning option.
- When the median is below 25 $/MWh, no low observation is possible unless the price is negative. This is the cost of the deviation guard.
- A revised price day rebuilds that day and the next 28 detector days.
- The first 14 days of history have no baseline. The runner prints them as `partial`. A 12-month backfill gives 14 such lines.
- There are no severity bands yet.
- The values are provisional. A change needs a bump of `ANALYSIS_VERSION` and a new pinned hash.
- Price anomaly, backfill of 366 days (`gold/price_periods` from 2025-11-20 to 2026-11-20, `analysis_version` 1). 352 observations, all with distinct IDs. 337 days are complete (baseline ready and inputs complete). 29 days are `partial`: 15 have `baseline_ready = false` (2025-11-20 to 2025-12-04, including 2025-12-04 with 624 samples), and 14 later days have incomplete inputs. 2025-11-27 is in the no-baseline set and also has incomplete inputs. November 2025 has no observations, because no baseline is ready. 24 observations on 6 days have `inputs_complete = false` (2026-02-11, 2026-02-12, 2026-03-25, 2026-09-10, 2026-11-04, 2026-11-05).
- By node (high / low): BEN2201 107 / 32, HAY2201 70 / 36, OTA2201 66 / 41.
- By month (high / low): Dec 2025 10 / 0, Jan 10 / 0, Feb 45 / 0 (9 incomplete), Mar 60 / 0 (6 incomplete), Apr 13 / 62, May 7 / 10, Jun 5 / 10, Jul 38 / 0, Aug 8 / 17, Sep 29 / 1 (2 incomplete), Oct 4 / 9, Nov 2026 14 / 0 (7 incomplete).
- Examples: `price_high` on 2026-08-04, periods 40 to 43 (4 periods) — BEN2201 measured $3351.71, median $37.86, threshold $143.25, severity 31.4; OTA2201 $4320.43 / $51.03 / $197.26 / 29.2; HAY2201 $3695.93 / $44.82 / $174.30 / 28.2. `price_low` on 2026-04-09, OTA2201 periods 7 to 9, measured $2.73, median $171.62, threshold $58.55, severity 1.49. DST-adjacent: 2026-09-27 (46 periods) HAY2201 `price_high` periods 34 to 39, measured $245.11, severity 1.46, `inputs_complete` true. 2026-04-05 (50 periods) has no observations.
- The baseline median was below $25 on 357 of 1053 node-days with a baseline, so the low rule is mostly limited to negative prices there. `price_low` severity peaks at 1.49. Thresholds remain usable; no `ANALYSIS_VERSION` bump.
- Price separation, backfill of 365 days. Of the 820 complete pair-periods (3 pairs, 488 distinct periods; complete means `inputs_complete`) with a spread above $100/MWh in size, 818 have a baseline and 356 are hit periods before the minimum-run rule. The other 462 are not hit periods. In 457 of them the 28-day 99th (or 1st) percentile lies beyond the median by more than $100. 15 days have `baseline_ready` false: the first 14 days, and 2025-12-04 with 624 samples. 8 runs fall on pair-days that are not complete, so they have `inputs_complete` false.
- A sustained separation of more than about 2 weeks becomes part of the baseline and stops being flagged. An absolute rule is deferred, as for prices.
- When the reserve-price median is below $10, no `reserve_price_low` observation is possible unless the price is negative. Typical FIR and SIR prices sit at $0, so the low rule will rarely fire until a backfill shows otherwise. An absolute "negative reserve price is always low" rule is deferred, as for energy.
- A revised reserve-price day rebuilds that day and the next 28 detector days.
- Reserve price anomaly, backfill of 366 days (`gold/reserve_by_class_island_period` from 2025-11-20 to 2026-11-20, `analysis_version` 1). 113 observations, all with distinct IDs, all `reserve_price_high`. No `reserve_price_low` rows: typical medians sit near $0, so the $10 floor blocks the low rule unless the price is negative. 337 days are complete (baseline ready and inputs complete). 29 days are `partial`: 15 have `baseline_ready = false` (2025-11-20 to 2025-12-04), and 14 later days have incomplete inputs. November 2025 has no observations, because no baseline is ready. 8 observations on 3 days have `inputs_complete = false` (2026-05-14, 2026-09-10, 2026-11-17).
- By class-island (high only): FIR|NI 50, SIR|NI 40, SIR|SI 12, FIR|SI 11.
- By month (high): Dec 2025 5, Jan 2026 0, Feb 18, Mar 0, Apr 21, May 10, Jun 5, Jul 12, Aug 14, Sep 10, Oct 3, Nov 2026 15.
- Examples: `reserve_price_high` on 2026-07-27, SIR|NI periods 35 to 40 (6 periods) — measured $2154.45, median $0.49, threshold $13.13, severity 170.5. FIR|NI on 2026-09-27 (DST, 46 periods) periods 32 to 39, measured $211.95, median $0.96, threshold $77.19, severity 2.77. 2026-04-05 (50 periods) has no observations.
- The $10 floor is holding: SI 99th percentiles in this window sit around $5–$6, so SI hits are the days that also clear $10. No `ANALYSIS_VERSION` bump.
- Generation-change uses a per-time-of-day baseline. A plant that changes its usual daily shape, for example a hydro station that starts peaking, is flagged until that shape is 14 days old, then becomes the baseline.
- A 14-sample 99th percentile is close to the max of that cell. The 30 MW / 100 MW floors are what stop a noisy percentile from firing. They also mean a 20 MW plant trip never flags, by design of the size cutoff and the deviation guard.
- Periods 49 and 50 exist on one DST-end day a year. They usually have `sample_count = 0` in a 28-day window and cannot fire. They do not mark the day `partial`.
- Generation-change backfill on 2026-11-22 over the 12-month lake (data from 2026-01-06): plant `generation_high` 2,796 / `generation_low` 2,651 (19.1 per day, maximum 53; 86% have severity below 1.5; median 1.09); fuel `generation_high` 579 / `generation_low` 417. The largest plant hits are Manapouri and Clyde hydro, which look like normal scheduling. These observations are not episode members in v1 ([ADR-0021](0021-episodes.md), [#180](https://github.com/joshmcarthur/gridwatch/issues/180)). Tuning the plant detector is [#179](https://github.com/joshmcarthur/gridwatch/issues/179).

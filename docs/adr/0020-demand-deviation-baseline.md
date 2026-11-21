# ADR-0020: Demand-deviation baseline

- Status: Accepted
- Date: 2026-11-22

## Context

[#35](https://github.com/joshmcarthur/gridwatch/issues/35) asks for a demand-deviation detector. "Expected demand" is not in the lake. This ADR records the baseline the owner accepted (2026-11-22, Pacific/Auckland) and the detector built on it. It supersedes the docs-only proposal in [#123](https://github.com/joshmcarthur/gridwatch/pull/123).

The series is gold `grid_load_period.load_mwh` ([ADR-0018](0018-energy-balance.md)): RTD model load at grid exit points, by island (`NI`, `SI`) and trading period, from Nodal Prices and Volumes ([#9](https://github.com/joshmcarthur/gridwatch/issues/9)). It is **grid load (modelled)**, not metered consumption. Docs and site copy must not call it consumption.

The shared run-detector kit ([ADR-0019](0019-observations-and-price-anomaly-detector.md)) can pool every complete period on the previous 28 days, or match the same trading period on every prior day (`baselineByTradingPeriod`). Demand has a strong time-of-day **and** weekday pattern, so overnight and the evening peak must not share a percentile, and Tuesday evening must not share a cell with Sunday evening. Generation-change already matches period but not weekday. Demand matches both.

[Brief §6.4](../brief.md) asks for straightforward, explainable detectors. Machine learning is not required for v1.

## Decision

The v1 baseline for demand deviation is: the complete `load_mwh` values of the **same trading period** on the **same weekday** in the **last 8 weeks**, excluding the date under test and incomplete days. A period is a hit when its absolute deviation from that cell's median is strictly greater than the percentile fence of the cell, and also strictly greater than a minimum MWh floor.

The detector is `demand_deviation` in `publisher/src/gold/demand-deviation.ts`. It is a thin adapter over the ADR-0019 kit. The kit gains `baselineSameWeekday`. Omit the key so existing config hashes do not change. Demand sets it true together with `baselineByTradingPeriod`.

### Series and subjects

- **Input.** Gold `grid_load_period` only. One value per island and trading period: `load_mwh`. A null load is never a hit. Day completeness is `bool_and` of that island-day's period `inputs_complete` flags, which is the same as `grid_load_day.inputs_complete`. The fingerprint does not read `grid_load_day`.
- **Subjects.** `NI`, `SI`, and `NZ`. Subject type is `island` ([ADR-0019](0019-observations-and-price-anomaly-detector.md)). `NZ` is the sum of the two island loads in the period. It is null when either island load is null. The `island` column is `NI` or `SI` for those subjects, and null for `NZ`.
- **Observation types.** `demand_high` and `demand_low`. The measured unit is MWh. Wording still says modelled grid load, not consumption.

### Baseline cell

For subject S, date D, period P:

1. Look back 56 calendar days (8 weeks). The fingerprint window is those 56 days of `grid_load_period` plus D (windowed gold input, [ADR-0019](0019-observations-and-price-anomaly-detector.md)).
2. Keep rows whose weekday equals D's weekday, whose `trading_period` equals P, and whose `trading_date` is not D. Weekday is `dayofweek` of the trading date (the period number, not clock time).
3. Drop a sample when `load_mwh` is null or `inputs_complete` is false. Drop every sample from a day whose island-day completeness is false. For `NZ`, drop the period when either island is incomplete or null.
4. The cell needs at least 4 samples (`minBaselinePeriods`). Otherwise `baseline_ready` is false, the sentinel is written, and there is no observation.

The median, 99th percentile and 1st percentile are taken over that cell only. With 8 samples the 99th percentile is at or next to the sample maximum, and the 1st is at or next to the sample minimum. That is accepted: a hit must sit outside the recent comparable range, and also at least 50 MWh from the median.

A period with no same-weekday-and-period samples (`sample_count = 0`), for example periods 47–50 on a DST-end day, is vacuously `baseline_ready` (the shared kit). It cannot hit: thresholds are null. A cell with 1 to 3 samples is not ready, and the day is `partial`.

### Hits and runs

A period is a high hit when `load_mwh > max(p99, median + 50)`. It is a low hit when `load_mwh < min(p01, median - 50)`. Equivalently: `|load - median|` is strictly greater than the percentile fence from the median, and strictly greater than 50 MWh.

Runs follow ADR-0019: consecutive period numbers, at least 2 periods, one trading date, a missing or null period ends a run, no gap bridging. Severity is 1 at the threshold.

### DST

A trading date has 46, 48 or 50 periods ([ADR-0003](0003-time-column-naming.md)). The comparable cell is the **same period number**, not the same clock time after a DST change. Periods 47–50 exist only on DST-end days, so those cells usually have `sample_count = 0`. Periods 1–46 exist every day.

### Holidays

A public holiday against ordinary weekdays of the same name is a known false-positive class (a low on Christmas Day, a high on the working day after). v1 does not build a holiday calendar and does not drop those days from the baseline.

### Config

One object, `DEMAND_DEVIATION_CONFIG`, in `publisher/src/gold/demand-deviation.ts`. A test pins the hash. Any change bumps `ANALYSIS_VERSION`.

| Key | Value | Why |
| --- | --- | --- |
| `baselineWindowDays` | 56 | Eight comparable weekdays. The calendar window is 56 days. |
| `minBaselinePeriods` | 4 | Half the cell, as ADR-0019 takes 14 of 28 days. A sample is one prior same-weekday of that period. |
| `highPercentile` | 0.99 | Same fence as the price detectors. With n ~ 8 this is the sample max. |
| `lowPercentile` | 0.01 | The mirror. With n ~ 8 this is the sample min. |
| `minDeviationFromMedian` | 50 | MWh floor so a tight cluster of Tuesdays does not flag a 5 MWh wiggle. About 2% of a national period (EMI demand 116.9 GWh on 2026-10-29 is ~2435 MWh per period) and about 7% of a South Island period. |
| `minPeriods` | 2 | Same as the price detectors. One period is a chart spike, not an observation. |
| `baselineByTradingPeriod` | true | Compare period 20 to other period 20s, not to nights. |
| `baselineSameWeekday` | true | Compare Wednesday period 20 to other Wednesdays, not to Sundays. |

### Tables, fingerprint, registry

- **Tables.** `demand_deviation_baselines` (sentinel, one row for each subject and trading period of the date) and `observations_demand_deviation`.
- **Fingerprint.** `goldDataset` with `{ layer: "gold", table: "grid_load_period", windowDays: 56 }`. `inputs_sha256` is the same `dateFingerprint` that `wantedFingerprints` uses. A revised load day, a day that enters or leaves the window, and a version bump each change the fingerprint.
- **Registry.** After the existing detectors, before `gold_episodes`. The detector reads `grid_load_period`. It does not rewrite ADR-0021 episode grouping. Wiring `demand_deviation_baselines` into `gold_episodes` is a follow-up.

## Alternatives considered

- **Machine learning.** Rejected. [Brief §6.4](../brief.md): historical percentiles, absolute thresholds and duration. Machine learning is not required for v1. A model would not be explainable from the observation row.
- **All-periods 28-day baseline (ADR-0019 kit as-is).** Rejected. Demand has a strong time-of-day and weekday pattern. Mixing overnight load with the evening peak makes the 99th percentile a statement about the peak, and overnight can never hit high.
- **Per-period 28 days, any weekday (`baselineByTradingPeriod` only).** Rejected as the default. 28 samples are already too few for a stable 99th percentile (ADR-0019 alternatives). The cell also mixes Sunday evening with Tuesday evening.
- **Weather-adjusted baseline.** Rejected for v1. The lake has no weather series. A temperature regression would be a model, not a percentile of comparable days, and a reader could not rebuild the threshold from the observation row.
- **A holiday calendar.** Deferred. It is a known false-positive class. Building and maintaining NZ public and provincial holidays is out of scope for the first detector.
- **Islands only, no national sum.** Rejected as the default. Island rows match the gold grain and capture HVDC-side load. National demand is what people mean by "demand" next to a national price. `NZ` is one extra subject: the sum of the two island `load_mwh` values.
- **A percentage floor instead of 50 MWh.** Deferred. A single MWh floor matches the price detectors' shape (`minDeviationFromMedian`). It is a larger share of SI than of NI. The owner can change the number, or split it, after a backfill.

## Consequences

- The first four same-weekdays of history have `baseline_ready` false.
- Public holidays will flag. That is accepted in v1.
- A load regime that lasts more than about four weeks of that weekday becomes the baseline and stops being flagged, as with prices.
- Periods 47–50 on a DST-end day usually have `sample_count = 0` and cannot fire. They do not mark the day `partial`.
- Episode grouping does not yet read this sentinel. Demand observations exist as gold rows; they are not members of `gold_episodes` until a follow-up.
- Demand-deviation backfill counts are pending. This environment has no gold lake, so the run over the full backfill has not happened. Counts, examples and false positives seen will be added here after that run.

# ADR-0020: Demand-deviation baseline

- Status: Proposed
- Date: 2026-11-21

## Context

[#35](https://github.com/joshmcarthur/gridwatch/issues/35) asks for a demand-deviation detector. The first acceptance criterion is that the baseline method is agreed on this issue. "Expected demand" is not in the lake. This ADR picks one default so the owner can accept it or change a value. It does not register a detector.

The series is gold `grid_load_period.load_mwh` ([ADR-0018](0018-energy-balance.md)): RTD model load at grid exit points, by island (`NI`, `SI`) and trading period, from Nodal Prices and Volumes ([#9](https://github.com/joshmcarthur/gridwatch/issues/9)). It is **grid load (modelled)**, not metered consumption. Docs and site copy must not call it consumption.

The shared run-detector kit ([ADR-0019](0019-observations-and-price-anomaly-detector.md)) builds one baseline per subject from every complete period on the previous 28 days. That pool is a poor fit for demand: load has a strong time-of-day and weekday pattern, so overnight and the evening peak would share a percentile. A baseline of the same period on the last 28 days of any weekday has only 28 samples, which ADR-0019 already rejected as too few for a 99th percentile.

[Brief §6.4](../brief.md) asks for straightforward, explainable detectors. Machine learning is not required for v1.

## Decision

The v1 baseline for demand deviation is: the complete `load_mwh` values of the **same trading period** on the **same weekday** in the **last 8 weeks**, excluding the date under test and incomplete days. A period is a hit when it is strictly beyond the larger of the cell's 99th percentile and median + 50 MWh (high), or the smaller of its 1st percentile and median - 50 MWh (low).

This is a proposed method. It is not implemented. Status stays Proposed until the owner says go or changes a value.

### Series and subjects

- **Input.** Gold `grid_load_period` only. One value per island and trading period: `load_mwh`. A null load is never a hit.
- **Subjects.** `NI`, `SI`, and `NZ`. Subject type is `island` ([ADR-0019](0019-observations-and-price-anomaly-detector.md)). `NZ` is the sum of the two island loads in the period. It is null when either island load is null. The `island` column is `NI` or `SI` for those subjects, and null for `NZ`.
- **Observation types.** `demand_high` and `demand_low`. The measured unit is MWh. Wording still says modelled grid load, not consumption.

### Baseline cell

For subject S, date D, period P:

1. Look back 56 calendar days (8 weeks). The fingerprint window is those 56 days of `grid_load_period` plus D (windowed gold input, [ADR-0019](0019-observations-and-price-anomaly-detector.md)).
2. Keep rows whose weekday equals D's weekday, whose `trading_period` equals P, and whose `trading_date` is not D.
3. Drop a sample when `load_mwh` is null or `inputs_complete` is false. The input is `grid_load_period` only, so there is no day-level check. For `NZ`, drop the period when either island is incomplete or null.
4. The cell needs at least 4 samples (`minBaselinePeriods`, the shared-kit key). Otherwise `baseline_ready` is false, the sentinel is written, and there is no observation.

The median, 99th percentile and 1st percentile are taken over that cell only. With 8 samples the 99th percentile is at or next to the sample maximum, and the 1st is at or next to the sample minimum. That is accepted: a hit must sit outside the recent comparable range, and also at least 50 MWh from the median.

### Hits and runs

A period is a high hit when `load_mwh > max(p99, median + 50)`. It is a low hit when `load_mwh < min(p01, median - 50)`.

Runs follow ADR-0019: consecutive period numbers, at least 2 periods, one trading date, a missing or null period ends a run, no gap bridging. Severity is 1 at the threshold.

### DST

A trading date has 46, 48 or 50 periods ([ADR-0003](0003-time-column-naming.md)). The comparable cell is the **same period number**, not the same clock time after a DST change. Periods 47-50 exist only on DST-end days, so those cells will often have `baseline_ready` false. Periods 1-46 exist every day.

### Holidays

A public holiday against ordinary weekdays of the same name is a known false-positive class (a low on Christmas Day, a high on the working day after). v1 does not build a holiday calendar and does not drop those days from the baseline.

### Config (provisional)

| Key | Value | Why |
| --- | --- | --- |
| `baselineWindowDays` | 56 | Eight comparable weekdays. Also the fingerprint window of gold partitions. |
| `minBaselinePeriods` | 4 | Half the cell, as ADR-0019 takes 14 of 28 days. |
| `highPercentile` | 0.99 | Same fence as the price detectors. With n ~ 8 this is the sample max. |
| `lowPercentile` | 0.01 | The mirror. With n ~ 8 this is the sample min. |
| `minDeviationFromMedian` | 50 | MWh floor so a tight cluster of Tuesdays does not flag a 5 MWh wiggle. About 2% of a national period (EMI demand 116.9 GWh on 2026-10-29 is ~2435 MWh per period) and about 7% of a South Island period. |
| `minPeriods` | 2 | Same as the price detectors. One period is a chart spike, not an observation. |

Values are provisional. A later implementation pins them in one config object and bumps `ANALYSIS_VERSION` on any change.

### What this ADR does not do

- It does not register a detector.
- It does not edit `publisher/src/datasets.ts`.
- It does not add gold tables, tests, or a backfill.

The ADR-0019 kit already has `baselineByTradingPeriod`, which gives one baseline per (subject, `trading_period`) over the prior `baselineWindowDays` days (ADR-0019, generation detectors). Demand needs one more restriction: only samples on the same weekday as the date. Implementation, when the owner says go, adds that restriction to the kit's period-matched mode as an optional config key, so that existing config hashes stay the same. It does not add a second baseline path.

## Alternatives considered

- **Machine learning.** Rejected. [Brief §6.4](../brief.md): historical percentiles, absolute thresholds and duration. Machine learning is not required for v1. A model would not be explainable from the observation row.
- **All-periods 28-day baseline (ADR-0019 kit as-is).** Rejected. Demand has a strong time-of-day and weekday pattern. Mixing overnight load with the evening peak makes the 99th percentile a statement about the peak, and overnight can never hit high.
- **Per-period 28 days, any weekday.** Rejected as the default. 28 samples are already too few for a stable 99th percentile (ADR-0019 alternatives). The cell also mixes Sunday evening with Tuesday evening.
- **Weather-adjusted baseline.** Rejected for v1. The lake has no weather series. A temperature regression would be a model, not a percentile of comparable days, and a reader could not rebuild the threshold from the observation row.
- **A holiday calendar.** Deferred. It is a known false-positive class. Building and maintaining NZ public and provincial holidays is out of scope for the first detector.
- **Islands only, no national sum.** Rejected as the default. Island rows match the gold grain and capture HVDC-side load. National demand is what people mean by "demand" next to a national price. `NZ` is one extra subject: the sum of the two island `load_mwh` values.
- **A percentage floor instead of 50 MWh.** Deferred. A single MWh floor matches the price detectors' shape (`minDeviationFromMedian`). It is a larger share of SI than of NI. The owner can change the number, or split it, after a backfill.

## Consequences

- The first four same-weekdays of history have `baseline_ready` false.
- Public holidays will flag. That is accepted in v1.
- A load regime that lasts more than about four weeks of that weekday becomes the baseline and stops being flagged, as with prices.
- Periods 47-50 on a DST-end day will often have no baseline.
- This ADR does not close [#35](https://github.com/joshmcarthur/gridwatch/issues/35). Tests and backfill wait until the owner agrees the method.

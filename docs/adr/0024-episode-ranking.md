# ADR-0024: Episode ranking and candidate selection

- Status: Proposed
- Date: 2026-11-22

## Context

Detection finds unusual things. It does not decide which of them are worth explaining ([brief §6.3](../brief.md), [#37](https://github.com/joshmcarthur/gridwatch/issues/37)). Episodes ([ADR-0021](0021-episodes.md)) group observations into one situation each. This ADR scores each episode and proposes a short list of candidates for each day. The score has four components. Each is stored, so a reader can see why an episode ranked where it did.

Ranking writes `is_candidate` on `episode_scores` and does not write site JSON. Owner decision on [#182](https://github.com/joshmcarthur/gridwatch/issues/182) (2026-11-23): `is_candidate` feeds site events directly, so event pages ([#42](https://github.com/joshmcarthur/gridwatch/issues/42)) emit an event for each candidate, labelled Unreviewed ([ADR-0022](0022-editorial-review-and-publish-flow.md)). The site contract stays unchanged until #42 amends [ADR-0014](0014-site-json-contract.md).

Code: `publisher/src/gold/episode-ranking.ts`. Dataset id `gold_episode_ranking`. It runs after `gold_episodes`.

## Decision

### Tables

Follow [ADR-0011](0011-gold-table-pattern.md). `ANALYSIS_VERSION` starts at 1. It is 2 after [#180](https://github.com/joshmcarthur/gridwatch/issues/180) (corroboration), 3 after [#181](https://github.com/joshmcarthur/gridwatch/issues/181) (candidate defaults and `price_low` cap), and 4 after [#223](https://github.com/joshmcarthur/gridwatch/issues/223) (plant `generation_low` corroboration). One config object, `EPISODE_RANKING_CONFIG`. A test pins its hash. A change to a rule or a value bumps `ANALYSIS_VERSION`.

Output is Parquet at `gold/<table>/trading_date=YYYY-MM-DD/data.parquet`, with a total `ORDER BY`, `SET threads = 1`, `goldStamp` and no `processed_at`.

| Table | One row per |
| --- | --- |
| `episode_ranking_days` (sentinel) | trading date, quiet days included |
| `episode_scores` | episode on that trading date |

`episode_ranking_days` columns: `trading_date`, `episode_count`, `candidate_count`, `history_days`, then `analysis_version`, `inputs_sha256`, `inputs_complete`.

`episode_scores` columns: `episode_id`, `trading_date`, `severity`, `period_count`, `island_count`, `type_count`, `severity_component`, `duration_component`, `breadth_component`, `corroboration_count`, `corroboration_component`, `rarity_component`, `score`, `day_rank`, `is_candidate`, `candidate_reason`, `history_sample_size`, `parameters` (canonical JSON of the config), `input_tables`, `analysis_version`, `inputs_sha256`, `inputs_complete`.

`day_rank` is 1 for the highest score of the day. A tie goes to the smaller `episode_id`. `candidate_reason` is `top_n`, `below_min_score` or `beyond_top_n`.

Input is one gold table, `episode_days`, with `windowDays` of 90. The fingerprint holds the version of each window day that exists. A rebuilt episode day inside the window changes the fingerprint of every later day that reads it, so the ranking is rebuilt. A date is wanted only when its own `episode_days` partition exists. `inputs_complete` is true when `episode_days` for the date is complete and every episode of the date is complete. `history_sample_size` is stored separately.

### Score components

Each component is in [0, 1].

| Component | Definition | Weight |
| --- | --- | --- |
| `severity_component` | `clamp(log10(severity) / log10(cap), 0, 1)`. `cap` is the largest `severityCapByType` entry among the episode's observation types (the default for an unknown type). | 0.30 |
| `duration_component` | `clamp(period_count / 12, 0, 1)` | 0.20 |
| `breadth_component` | `clamp((max(type_count - 1, 0) + max(island_count - 1, 0)) / 4, 0, 1)` | 0.15 |
| `corroboration_component` | `clamp(corroboration_count / 2, 0, 1)`. `corroboration_count` is the number of `CORROBORATION_RULES` that match the episode: a fuel-level `generation_low`, a plant-level `generation_low`, or an NI/SI `demand_high`, on the same trading date that overlaps the episode span on one of its islands ([ADR-0021](0021-episodes.md), [#180](https://github.com/joshmcarthur/gridwatch/issues/180), [#223](https://github.com/joshmcarthur/gridwatch/issues/223)). Each rule counts once. The cap stays 2, so a third match does not raise the component. These observations are not episode members. | 0.10 |
| `rarity_component` | `1 - share`, where `share` is the fraction of prior days in the window that had an episode with the same observation-type set and the same island set. | 0.25 |

`score` is the weighted sum. The weights add up to 1. A test asserts it.

**Severity.** Member severity is 1 at that detector's threshold and unbounded above ([ADR-0019](0019-observations-and-price-anomaly-detector.md)). The scale differs by type, so one cap would let `reserve_price_high` (a $0.5 median, so severity runs to about 170) swamp the others. The episode keeps only the maximum severity, not which member gave it, so the episode takes the largest cap among its types. It can understate a mixed episode, never overstate it.

| Type | Observed range in the ADR-0019 backfill | Cap | Why |
| --- | --- | --- | --- |
| `price_high` | up to about 31 (2026-08-04) | 30 | The largest value seen scores about 1. |
| `reserve_price_high` | up to about 170 (2026-07-27) | 170 | Same. Reserve prices sit near $0, so the denominator is tiny and severity is large. |
| `price_low` | peaks at 1.4937 (109 rows on the 2026-11-23 lake) | 1.49 | Same rounding as `price_high`: the largest seen scores about 1. |
| `separation_high`, `separation_low`, `reserve_price_low` | no figures in ADR-0019 | 10 (the default) | No evidence yet. Revisit after the first ranking over the backfill. |
| `generation_high`, `generation_low` | backfill counts pending | 10 (the default) | As above. |

**Polarity.** `price_low` severity is bounded near 1.5, because a price cannot fall far below a median of $0 to $170. With the default cap of 10 it scored about 0.17 at most on severity, so a `price_low` episode ranked low by construction. [#181](https://github.com/joshmcarthur/gridwatch/issues/181) rescales the cap to the backfill peak (1.49) so those episodes can compete with `price_high`.

**Duration.** `period_count` is the count of distinct trading periods in the episode. Twelve periods (6 hours) scores 1.

**Breadth.** A singleton on one island scores 0. Each extra observation type or extra island adds one step. Four steps scores 1.

**Rarity.** The axis is frequency of shape, not size. Severity already has its own component, so rarity does not repeat it. The window is the 90 days before the date, limited to days that have an `episode_days` partition. If fewer than `minPoolSize` (20) prior days exist, `rarity_component` is 0.5 and `history_sample_size` holds the number of prior days, so a reader sees why. The date under test is never in its own window.

### Candidates

An episode is a candidate when `day_rank <= candidatesPerDay` (1) and `score >= minScore` (0.5). An episode that is first for the day but under the floor has reason `below_min_score`. Incomplete inputs do not block candidacy. The flag `inputs_complete` is on the row.

### Config values

Chosen on [#181](https://github.com/joshmcarthur/gridwatch/issues/181). Weights stay as after [#180](https://github.com/joshmcarthur/gridwatch/issues/180).

| Key | Value |
| --- | --- |
| `weights` | severity 0.30, duration 0.20, breadth 0.15, corroboration 0.10, rarity 0.25 |
| `corroborationCap` | 2 |
| `corroborationRules` | `CORROBORATION_RULES` of `episodes.ts` |
| `severityCapByType` | as in the table above |
| `defaultSeverityCap` | 10 |
| `durationCapPeriods` | 12 |
| `breadthCap` | 4 |
| `historyDays` | 90 |
| `minPoolSize` | 20 |
| `candidatesPerDay` | 1 |
| `minScore` | 0.5 |

### Weekly list

The weekly list is a query, not a table. The week is ISO Monday to Sunday of `trading_date`. Run it with the DuckDB CLI over the gold lake. Both queries were run once through the DuckDB Node API against three synthetic partitions, and they work as written. The ranking itself has not run over a real backfill.

Top candidates for each day:

```sql
SELECT trading_date, day_rank, episode_id, round(score, 3) AS score, candidate_reason
FROM read_parquet('gold/episode_scores/trading_date=*/data.parquet', hive_partitioning = true)
WHERE is_candidate
ORDER BY trading_date, day_rank;
```

Top candidates for each ISO week:

```sql
SELECT week, rk, trading_date, episode_id, score
FROM (
  SELECT date_trunc('week', trading_date) AS week, trading_date, episode_id, score,
         row_number() OVER (
           PARTITION BY date_trunc('week', trading_date)
           ORDER BY score DESC, episode_id) AS rk
  FROM read_parquet('gold/episode_scores/trading_date=*/data.parquet', hive_partitioning = true)
  WHERE is_candidate)
WHERE rk <= 3
ORDER BY week, rk;
```

### Backfill run

Version 3 counts from the local lake re-rank are on [#181](https://github.com/joshmcarthur/gridwatch/issues/181).

### Owner questions

Defaults in brackets. Nothing here is implemented as final.

1. Do the weights 0.30 / 0.20 / 0.15 / 0.10 / 0.25 (severity, duration, breadth, corroboration, rarity) and the caps suit the site? **[yes, provisional]**
2. Is rarity the frequency of the same type-set and island-set over 90 days, not a severity percentile? **[yes, frequency]**
3. Is a window with fewer than 20 prior days neutral (0.5)? **[yes]**
4. Top 1 per day with a floor of 0.5, and the weekly list as a query? **[yes, #181 2026-11-23]**
5. Do the per-type severity caps stand, with the default 10 for types that have no backfill figure? **[yes, except `price_low` at 1.49]**
6. Should `price_low` rank like `price_high`? **[yes, rescale the cap to the backfill peak; #181]**
7. Do candidates with incomplete inputs stay candidates, flagged? **[yes]**
8. Do midnight-split evenings stay two episodes, so each part is ranked alone? **[yes, as in ADR-0021]**
9. Does `is_candidate` feed [#42](https://github.com/joshmcarthur/gridwatch/issues/42) events directly, if #131 merges? **[yes; no step between ranking and events. #182, 2026-11-23. ADR-0022 is accepted.]**
10. Post the backfill top list as one comment on #37 after review? **[yes, only after owner approval]**

## Alternatives considered

- **Score columns on `episodes`.** Rejected. Rarity needs 90 days of history, and `episodes` has no windowed input. A version bump would rebuild every episode partition.
- **Score on the fly in a script.** Rejected. The issue asks for stored components.
- **Rarity as a severity percentile against similar past episodes.** Rejected for v1. It repeats the severity component. It stays as an owner question.
- **One severity cap for all types.** Rejected. Reserve prices would dominate.
- **A `report-candidates` script.** Rejected. The two queries above do the job with no new code.

## Consequences

- A later detector that becomes an episode input changes episodes. The episode day fingerprints change, and the rankings of every date within 90 days rebuild.
- `ANALYSIS_VERSION` is 4 since [#223](https://github.com/joshmcarthur/gridwatch/issues/223). It was 3 after [#181](https://github.com/joshmcarthur/gridwatch/issues/181) and 2 after [#180](https://github.com/joshmcarthur/gridwatch/issues/180). The fuel and plant generation-change sentinels and the demand-deviation sentinel are ranking inputs for the episode's own date. They are `optional`: the baselines need history, so a day without a sentinel still ranks, with a corroboration count of 0. A sentinel that arrives later changes the fingerprint.
- An episode with no corroboration scores a little lower than under version 1, because weight moved to the new component. Early days with no sentinel cannot corroborate.

### Measured on the 2026-11-22 lake (#180)

Version 1 over 367 days: 310 episodes, 127 candidates. Version 2: 310 episodes, 150 candidates. Corroboration count 0 / 1 / 2 covers 170 / 129 / 11 episodes. 8 episodes predate the fuel data. 27 July 2026 stays first (0.814 to 0.789). Two days enter the top 12 (2026-05-27, 2026-07-26) and two leave (2025-12-08, which falls from 0.650 to 0.593 but is still its day's first rank, and 2026-08-06).

### Measured after plant corroboration (#223)

Version 4 over the same 310 episodes, with generation-change at analysis_version 2. Nine episodes match plant `generation_low`. Count 0 / 1 / 2 moves from 187 / 116 / 7 (fuel and demand only) to 184 / 113 / 13. Three of the nine had no corroboration; six already had one. Candidates stay 31. The cap is still 2.

- Rarity is cold for the first 20 days of history.
- `is_candidate` is the event list for [#42](https://github.com/joshmcarthur/gridwatch/issues/42). Ranking does not wait for a human; after emit, events are Unreviewed until a later mark-as-reviewed flow ([ADR-0022](0022-editorial-review-and-publish-flow.md), [#41](https://github.com/joshmcarthur/gridwatch/issues/41)).
- Evidence packages ([#38](https://github.com/joshmcarthur/gridwatch/issues/38)) can read `episode_scores` to pick what to build.

# ADR-0021: Episode gold table and grouping rules

- Status: Proposed
- Date: 2026-11-21

## Context

An episode groups related observations into one underlying market situation ([brief §6.2](../brief.md), [#36](https://github.com/joshmcarthur/gridwatch/issues/36)). Observations are already deterministic gold rows ([ADR-0019](0019-observations-and-price-anomaly-detector.md)). The brief forbids a single universal time window: a dispatch incident lasts minutes, hydro scarcity lasts weeks. Grouping must consider temporal proximity, geographic proximity, shared generators or points of connection, related conditions, duration and severity, and common constraints.

This ADR proposes the gold table sketch and the v1 grouping rules. It does not build the table. Implementation waits for the owner to agree on [#36](https://github.com/joshmcarthur/gridwatch/issues/36).

Detectors in play: `price_high` / `price_low` ([#22](https://github.com/joshmcarthur/gridwatch/issues/22)), `separation_high` / `separation_low` ([#32](https://github.com/joshmcarthur/gridwatch/issues/32)). Not yet built: generation change ([#33](https://github.com/joshmcarthur/gridwatch/issues/33)), reserve price anomaly ([#34](https://github.com/joshmcarthur/gridwatch/issues/34)), demand deviation ([#35](https://github.com/joshmcarthur/gridwatch/issues/35)). Hydro and constraint observations have no detector.

[#21](https://github.com/joshmcarthur/gridwatch/issues/21) is still waiting for the owner to choose among three candidates. A prior agent recommended Mon 27 July 2026, North Island scarcity. This ADR does not reconstruct that day. It states how the proposed rules would group that *kind* of day.

## Decision

### Gold table sketch

Follow [ADR-0011](0011-gold-table-pattern.md). Code would live in `publisher/src/gold/episodes.ts` (not written). Dataset id `gold_episodes`. `ANALYSIS_VERSION` starts at 1. The module holds one config object, `EPISODE_GROUPING_CONFIG`. Any change to a rule or a value bumps `ANALYSIS_VERSION`. A test would pin the hash of the config object, as detectors do.

Output is Parquet at `gold/<table>/trading_date=YYYY-MM-DD/data.parquet`. `writeGoldTables`, a total `ORDER BY`, `SET threads = 1`, `goldStamp`, no `processed_at`. Registry order is after every detector that is an input.

`TABLES = ["episode_days", "episodes"]`. `episode_days` is the sentinel: one row for every trading date, including a day with no observations. The runner reads `inputs_sha256` from it. `episodes` may be empty.

Inputs are gold observation tables, listed explicitly (`observations_price_anomaly`, `observations_price_separation`, and later each new `observations_*`). Each is `{ layer: "gold", table, versionColumn: "inputs_sha256", completenessDataset: null }`. v1 uses no `windowDays`: grouping stays inside one trading date (see below). The fingerprint is `goldDataset`'s `dateFingerprint`: the analysis version and each input partition's `inputs_sha256` for that date. A rebuilt observation day, a new detector partition, and a version bump each change the fingerprint.

`inputs_complete` is true when every member observation has `inputs_complete` and every listed observation table has a partition for the date. A day with no observation partition is not wanted. Incomplete members still form episodes; the flag is on the row.

| Table | One row per |
| --- | --- |
| `episode_days` | trading date (sentinel) |
| `episodes` | episode whose seed observation falls on that trading date |

`episode_days` columns: `trading_date`, `episode_count`, `observation_count`, then `analysis_version`, `inputs_sha256`, `inputs_complete`.

`episodes` columns, in this order:

| Column | Meaning |
| --- | --- |
| `episode_id` | First 16 hex characters of SHA-256 over the seed `observation_id`. It does not include `ANALYSIS_VERSION` or the member set. |
| `seed_observation_id` | The member with the earliest `event_start_utc`, then the lexicographically smallest `observation_id`. |
| `trading_date` | DATE. The seed's trading date. The partition key. |
| `start_trading_period`, `end_trading_period`, `period_count` | Inclusive period span of the union of members, and the count of distinct periods in that union. |
| `event_start_utc`, `event_end_utc` | Min of member starts, max of member ends. The end is exclusive ([ADR-0003](0003-time-column-naming.md)). |
| `member_observation_ids` | Sorted `VARCHAR[]` of member `observation_id`s. |
| `member_count` | Length of that array. |
| `observation_types` | Sorted unique member `observation_type`s. |
| `subjects` | Canonical JSON array of `{ "subject_type", "subject_id" }` from the members, sorted. |
| `islands` | Sorted unique non-null member `island` values. |
| `plant_ids` | Sorted unique non-null member `plant_id` values. |
| `severity` | Max of member severities. Unitless, same scale as observations. |
| `grouping_reason` | Canonical JSON of the sorted unique rule ids that connected the component. A singleton is `{"rules":["singleton"]}`. |
| `parameters` | Canonical JSON of `EPISODE_GROUPING_CONFIG`. The same text on every row. |
| `input_tables`, `analysis_version`, `inputs_sha256`, `inputs_complete` | Provenance ([ADR-0011](0011-gold-table-pattern.md)). |

There is no child `episode_members` table in v1. A reader that needs one row per member unnests `member_observation_ids`.

### Grouping algorithm

Every observation on the date is a node. An undirected edge exists when a typed join rule fires. Each connected component is one episode. Every observation belongs to exactly one episode, including singletons.

The graph is built only from observations whose `trading_date` equals the partition date. v1 does not join across midnight. That matches observations, which already split at the trading-date boundary ([ADR-0019](0019-observations-and-price-anomaly-detector.md)). An evening that crosses 00:00 is two episodes. Cross-date grouping is a later rule, and is the hydro path.

Time comparisons use `event_start_utc` and `event_end_utc`, not period numbers, so a DST day (46 or 50 periods) does not need a special case.

- **Overlap:** half-open intervals overlap: `a.event_start_utc < b.event_end_utc AND b.event_start_utc < a.event_end_utc`.
- **Adjacent within 2 periods:** the gap from the earlier exclusive end to the later start is greater than or equal to 0 and less than or equal to 60 minutes (2 × 30 minutes). Touching (gap 0) counts. Overlap is a separate, stronger predicate; a rule that asks for overlap does not fire on a mere 60-minute gap.

**Island of a member.** Use the observation's `island` when it is `NI` or `SI`. A null island does not join on island; it joins only on exact `subject_id` (or `plant_id` when the rule names a plant). A `point_of_connection_pair` row has null `island` ([ADR-0019](0019-observations-and-price-anomaly-detector.md)). For grouping only, its island is the island of the dearer node in the pair, from the sign of `measured_value`: positive means the from-node was dearer. `OTA2201-HAY2201` is always NI. `HAY2201-BEN2201` and `OTA2201-BEN2201` take NI or SI from which end was dearer. A pair observation joins that island's component. It does not give the other island a free pass into the same episode unless a typed rule also fires on those other observations.

Duration and severity do not gate joins in v1. Each detector already applied its minimum run length. A short `price_high` may join a long `reserve_price_high`. Common constraints are out of v1 ([#44](https://github.com/joshmcarthur/gridwatch/issues/44)).

### Typed join rules (v1)

There is no universal window. Each pair of observation types has its own time predicate and its own subject predicate. Types that have no rows yet are no-ops until their detector writes observations; the rule is still in the config so a later detector does not need a new grouping design.

Related conditions in v1 are the scarcity family: high energy price, high reserve price, low generation, high separation, high demand. Opposite polarity (`*_high` with `*_low`) does not join. `generation_high` (a thermal ramp) does not join `price_high`; that dispatch response belongs in the evidence package ([#38](https://github.com/joshmcarthur/gridwatch/issues/38)), not in the grouping key.

| Rule id | Types | Time | Subject |
| --- | --- | --- | --- |
| `price_high_price_high_adjacent_island` | `price_high` — `price_high` | overlap or adjacent ≤ 2 periods | same island |
| `reserve_price_high_reserve_price_high_adjacent_island` | `reserve_price_high` — `reserve_price_high` | overlap or adjacent ≤ 2 periods | same island |
| `price_high_reserve_price_high_adjacent_island` | `price_high` — `reserve_price_high` | overlap or adjacent ≤ 2 periods | same island |
| `generation_low_generation_low_adjacent_subject` | `generation_low` — `generation_low` | overlap or adjacent ≤ 2 periods | same island, or same `plant_id` |
| `generation_low_price_high_overlap_island` | `generation_low` — `price_high` | overlap only | same island |
| `generation_low_reserve_price_high_overlap_island` | `generation_low` — `reserve_price_high` | overlap only | same island |
| `separation_high_price_high_adjacent_island` | `separation_high` — `price_high` | overlap or adjacent ≤ 2 periods | pair grouping-island equals the price observation's island |
| `demand_high_price_high_overlap_island` | `demand_high` — `price_high` | overlap only | same island |
| `price_low_price_low_adjacent_island` | `price_low` — `price_low` | overlap or adjacent ≤ 2 periods | same island |

`price_low` does not join `generation_low`. `separation_low` has no v1 partner.

Hydro-style observations do not exist yet. When they do, they will use a much longer window (for example 14 days, same island or same catchment) and will not join dispatch-scale types in v1. A hydro month and an evening price spike stay different episodes until a later ADR says otherwise.

Config values, provisional:

| Key | Value | Why |
| --- | --- | --- |
| `adjacentPeriodMax` | 2 | Brief dispatch minutes, not hydro weeks. Two unflagged periods (60 minutes) still join a broken run; three do not. |
| `adjacentGapMinutes` | 60 | The UTC form of `adjacentPeriodMax`. DST-safe. |
| `sameDateOnly` | true | Fits `goldDataset` with no forward window. Matches the observation midnight split. |
| `singletonEpisodes` | true | Every observation is in exactly one episode. |
| `episodeSeverity` | `max` | The episode is as severe as its worst fact. Members keep their own severity. |

### Stable `episode_id`

`episode_id` is the first 16 hex characters of SHA-256 over the seed `observation_id` only.

- A re-run that finds the same seed keeps the id, as observation ids do ([ADR-0019](0019-observations-and-price-anomaly-detector.md)).
- A new detector that adds a member (for example `generation_low` on the same evening) keeps the id. The member array and `inputs_sha256` change. Evidence packages ([#38](https://github.com/joshmcarthur/gridwatch/issues/38)) can keep the same key.
- A grouping-rule change that moves the seed produces a new id. That is a different component.
- `ANALYSIS_VERSION` stays on the row. It is not in the id, so it does not rename episodes on a bump that happens to keep the same seed.

The rejected alternative is a hash of the sorted member `observation_id`s. That name is a fingerprint of the exact set, and it would change every time a detector is added.

### Severity

Member `severity` is unitless and equals 1 at that detector's threshold ([ADR-0019](0019-observations-and-price-anomaly-detector.md)). Episode `severity` is the maximum of the members. There are still no bands. Ranking which episodes become public events is editorial ([#41](https://github.com/joshmcarthur/gridwatch/issues/41)), not this table.

Max is biased toward a single extreme spike. A long moderate cluster can look quieter than a short spike. That is accepted for v1. Duration stays visible in `period_count` and the time span.

### The #21 kind of day

The owner has not chosen a candidate on [#21](https://github.com/joshmcarthur/gridwatch/issues/21). Reconstruction is blocked on that choice. The leading recommendation (comment on #21, 2026-11-20) is Mon 27 July 2026, North Island scarcity: Otāhuhu $3,296 against Benmore $571.5, North Island SIR $2,154, coal/gas ramped, wind low, HVDC north, low residual.

v1 would treat that *kind* of day as follows, once `price_high`, `reserve_price_high` and `generation_low` exist for it:

- `price_high` at an NI node overlapping `reserve_price_high` on NI joins (`price_high_reserve_price_high_adjacent_island`). Period 36 is an overlap, not merely adjacent.
- `generation_low` on NI that overlaps those runs joins (`generation_low_price_high_overlap_island` and `generation_low_reserve_price_high_overlap_island`). The join is island-wide, not the plant's own POC, because island scarcity shows up at Otāhuhu, not only at the wind farm's node.
- `separation_high` on a pair whose dearer node is NI joins the NI component. It does not pull SI-only observations in.
- `generation_high` (thermal ramp) does not join. It is context for [#38](https://github.com/joshmcarthur/gridwatch/issues/38).
- Result: one NI episode whose members are the overlapping `price_high`, `reserve_price_high`, `generation_low` and `separation_high` observations. Severity is the max of those members.

It would *not* be one episode if `generation_low` never fires (plant-size cutoff or a baseline that treats evening wind as normal), if the reserve detector is not built yet, or if the owner later requires a POC match for generation. Those are detector issues, not grouping-rule failures. A chosen #21 event that is the March 2026 high-price month would not form one dispatch-scale episode: that is hydro-window work, which is out of v1.

### Out of v1

- LLM prose (brief §7 step 5). Episodes are deterministic grouping.
- Editorial review and the publish flow for events ([#41](https://github.com/joshmcarthur/gridwatch/issues/41), brief §6.3). An event is an episode someone chooses to explain.
- Evidence packages ([#38](https://github.com/joshmcarthur/gridwatch/issues/38)).
- Constraint and SPD case grouping ([#44](https://github.com/joshmcarthur/gridwatch/issues/44)). No constraint observations exist.
- Hydro observations and any window longer than 60 minutes.
- Joining across trading dates.
- Opposite-polarity joins and `generation_high` as a partner of `price_high`.
- Severity bands, and any rank that decides newsworthiness.

### Tests (implementation PR, not this one)

Synthetic observation sets, not live gold:

- Two overlapping NI `price_high` rows form one episode; NI and SI `price_high` with no pair row form two.
- `price_high` and `reserve_price_high`, same island, gap of 2 periods form one episode; gap of 3 periods form two.
- `generation_low` overlapping `price_high` on the same island forms one episode; adjacent but not overlapping forms two.
- `price_high` and `price_low` on the same island form two.
- A singleton is an episode with `grouping_reason` `singleton`.
- A DST day uses UTC gaps, not period arithmetic.
- A `#21`-shaped set (`price_high` + `reserve_price_high` + `generation_low` overlapping on NI, plus `separation_high` dearer-NI) forms one episode; an extra SI-only `price_high` stays out.
- Byte-identical second run; fingerprint changes on an `ANALYSIS_VERSION` bump.

### Owner questions

Defaults in brackets. Reply on [#36](https://github.com/joshmcarthur/gridwatch/issues/36); this PR will not build the table.

1. Join `price_high` and `reserve_price_high` when they overlap or are adjacent within 2 periods and share an island? **[yes]**
2. Join `generation_low` to `price_high` (and to `reserve_price_high`) only on overlap, same island, not on a 2-period gap, and not on the plant's own POC? **[yes, island-wide overlap]**
3. Keep v1 inside one trading date (no midnight join), matching observations? **[yes]**
4. Every observation is in exactly one episode, including singletons? **[yes]**
5. `episode_id` is the hash of the seed observation id, not of the sorted member set, and not of `ANALYSIS_VERSION`? **[yes, seed only]**
6. Episode severity is the max of members? **[yes]**
7. Pair observations group with the dearer node's island and do not merge the other island's component? **[yes]**
8. `generation_high` does not join `price_high` in v1? **[yes, leave the ramp for #38]**
9. Hydro-style rules wait for a hydro detector, with a window of days or weeks and no join to dispatch types in v1? **[yes]**
10. Leave LLM, editorial [#41](https://github.com/joshmcarthur/gridwatch/issues/41), and constraint cases [#44](https://github.com/joshmcarthur/gridwatch/issues/44) out of this table? **[yes]**

I will not build until you agree.

## Alternatives considered

- **One universal window, for example ±2 hours for every type.** Rejected. Brief §6.2 forbids it. Hydro would be split and dispatch would be glued to unrelated hours.
- **Hash of sorted member ids.** Rejected for the id. Adding [#33](https://github.com/joshmcarthur/gridwatch/issues/33) or [#34](https://github.com/joshmcarthur/gridwatch/issues/34) would rename every mixed episode. The member array already records the set.
- **Seed plus `ANALYSIS_VERSION` in the id.** Rejected. Observation ids omit the version so a re-run keeps the id.
- **Cross-date connected components with a look-ahead window.** Rejected for v1. `goldDataset` windowing looks backward. A component that starts on D and gains a member on D+1 would leave D's partition stale unless D is rebuilt when D+1 arrives. Hydro can revisit this with a different grain.
- **Duplicate an episode into every overlapping date.** Rejected. The same `episode_id` in two partitions fights the one-date fingerprint.
- **A child `episode_members` table.** Deferred. Unnesting the array is enough until a consumer needs a join table.
- **Join on ADR-0008 `region_id`.** Rejected for v1. Price observations leave `region_id` null ([ADR-0019](0019-observations-and-price-anomaly-detector.md)). Island is the geographic key that the data actually has.
- **Weighted or summed episode severity.** Deferred. Max keeps the same unitless scale. `period_count` already shows duration.
- **Connected components that treat `separation_high` as a bridge between islands.** Rejected. On a 27-July-shaped day the story is NI scarcity with separation, not one national blob.

## Consequences

- [#36](https://github.com/joshmcarthur/gridwatch/issues/36) can be implemented as one gold module once the owner agrees. The acceptance criterion "owner agreed the rules on this issue" is this ADR plus that reply.
- The "#21 event forms one episode" criterion cannot be executed until the owner chooses a candidate. The rules above say how a 27-July-shaped day would group, and why a March-shaped month would not.
- Adding a detector means listing its `observations_*` table as a gold input. The fingerprint then rebuilds episode dates. Join rules for its types should already be in the config; a new related-condition pair needs a version bump.
- Midnight-split evenings are two episodes. That is the same loss ADR-0019 accepted for runs that cross the trading date.
- A quiet day still has an `episode_days` row, so the runner can skip an up-to-date date.
- Editorial [#41](https://github.com/joshmcarthur/gridwatch/issues/41) and evidence packages [#38](https://github.com/joshmcarthur/gridwatch/issues/38) read this table. They do not write it.

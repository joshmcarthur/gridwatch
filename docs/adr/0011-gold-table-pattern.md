# ADR-0011: Pattern for gold tables

- Status: Accepted
- Date: 2026-11-20

## Context

Gold generation ([#16](https://github.com/joshmcarthur/gridwatch/issues/16)) is the first gold table. Gold regional prices ([#17](https://github.com/joshmcarthur/gridwatch/issues/17)) and later tables must look the same. Silver rebuilds from bronze ([ADR-0005](0005-dataset-pattern.md), [ADR-0009](0009-runner-default-mode.md)). Gold derives from silver, so it needs its own rule for when to rebuild, and a rule for incomplete inputs.

## Decision

### Layout

- Code is in `publisher/src/gold/`. `common.ts` holds the shared helpers. Each table module (for example `generation.ts`) holds its SQL and its own `ANALYSIS_VERSION`.
- Output is Parquet at `<DATA_ROOT>/gold/<table>/trading_date=YYYY-MM-DD/data.parquet`. `writeGoldTables` copies each table to a `.tmp` file, then renames them, with the sentinel last. It does not call `writeParquetAtomically`, because that helper renames one file at a time. The `ORDER BY` is total, and a gold module sets `SET threads = 1` when it sums floating-point values, so the same inputs give the same bytes.
- A module can write more than one table for a date. The module lists its tables in `TABLES`. The first is the sentinel table: the runner reads the held version from it. `writeGoldTables` writes every table to a `.tmp` file, then renames them, and the sentinel table is written last. A failure while writing changes no partition. A crash between renames leaves the old sentinel, so the date is built again on the next run.
- Time columns follow [ADR-0003](0003-time-column-naming.md). A table keeps `trading_date` and `trading_period` from silver, and `event_start_utc` and `event_end_utc` when it has a period. A day table has `trading_date` only.
- Gold may have `processed_at`, but our tables do not. It would change the bytes on every run.

### Three columns on every gold row

| Column | Meaning |
| --- | --- |
| `analysis_version` (`INTEGER`) | The `ANALYSIS_VERSION` constant of the module. A person bumps it when the logic changes. We do not use the git SHA. The SHA changes on every commit and would rebuild all of gold each time. The Docker image may not have git. |
| `inputs_sha256` (`VARCHAR`) | A SHA-256 over the analysis version and the version of each silver input partition for that date. The version of a silver partition is its `bronze_sha256`. The version of a derived silver table (the entity mappings) is its `inputs_sha256`. |
| `inputs_complete` (`BOOLEAN`) | True only when every input is complete for that date. |

### When gold rebuilds

Gold is in the runner registry, after silver (`publisher/src/datasets.ts`). The `goldDataset` factory in `gold/common.ts` builds the entry: the sentinel table, `versionColumn: "inputs_sha256"`, a `wantedVersions` function and a `partitionRoot` that names `gold/` as the place of the held version. The runner is the same as for silver, with two changes. It reads the held version from `partitionRoot`, and it passes `goldDir` to `publish`. This is the same model as the entity mappings ([ADR-0008](0008-entity-model.md)).

`wantedVersions` returns the fingerprint for each date that has every input. The runner rebuilds a date when the held fingerprint is different or missing. So gold updates when:

- silver for the date is rebuilt from a new bronze file;
- the entity mappings for the date change;
- someone bumps `ANALYSIS_VERSION`.

A run with nothing new writes nothing. `--force` rebuilds the selected dates. Gold runs after silver in the same run, so one `publish` command brings both layers up to date. A date that lacks any input silver is not wanted, and gold writes nothing for it.

### Completeness: flag, do not drop

Rows are written for incomplete inputs, with `inputs_complete = false`. We chose this over writing no rows. A reader can still see the data that exists, and a chart can mark the day. This matches silver, which writes partial days ([ADR-0005](0005-dataset-pattern.md)).

The silver completeness table ([ADR-0010](0010-completeness.md)) is written from each silver `PublishResult`. Gold datasets are not rows in that table: a gold partition lives under `gold/`, and `fillHeldCompleteness` reads `silverDir`. The runner skips completeness for any dataset that sets `partitionRoot`.

`inputsComplete` in `gold/common.ts` still counts trading periods in the silver input files (`periodsInTradingDate`: 46, 48 or 50). It does not import `readCompleteness`, because `completeness.ts` imports the dataset registry and gold already sits in that registry. An input is complete when it has rows in every period. Gold flags incomplete rows. The gold tables and their columns stay the same if a later change reads the completeness table.

The runner shows an incomplete gold day as `PARTIAL`, with the missing periods, in the run summary. The summary lists gold datasets with the silver datasets.

### Generation tables ([#16](https://github.com/joshmcarthur/gridwatch/issues/16))

`gold/generation.ts` reads Generation_MD silver, `entity_plants` and `entity_points_of_connection`. It writes four tables.

| Table | Grain | Key |
| --- | --- | --- |
| `generation_by_plant_period` | plant and trading period | `plant_id`, `trading_period` |
| `generation_by_plant_day` | plant and trading day | `plant_id` |
| `generation_by_fuel_period` | fuel category, island and trading period | `fuel_category`, `island`, `trading_period` |
| `generation_by_fuel_day` | fuel category, island and trading day | `fuel_category`, `island` |

- `megawatt_hours` is the energy: silver `kilowatt_hours` / 1000. `average_megawatts` is the energy divided by the hours covered: MWh x 2 for a period, and MWh / 24 (23 or 25 on a daylight saving day) for a day.
- The fuel category comes from `entity_plants`. A plant with no category, or a plant that is not in `entity_plants`, has the category `unmapped`. No row is dropped.
- `island` is `NI` or `SI` from the unit's point of connection. It is null when the point of connection is not mapped. A national total is the sum of all rows of a fuel. No fuel row already sums the islands, so the sum does not count twice.
- `battery` is storage. It has its own rows. No table has a total, so nothing adds it to primary generation. A consumer that makes a primary total must leave out `battery`.
- `coal_gas` is the category of the Huntly Rankine units ([ADR-0008](0008-entity-model.md)).
- Silver Generation_MD is the only source of generation here, so the tables have no RTD case. Gold tables that read RTD data keep only the latest case for each interval (owner decision on [#9](https://github.com/joshmcarthur/gridwatch/issues/9)).

### Adding a gold table

1. Add `publisher/src/gold/<name>.ts`. Export `ANALYSIS_VERSION = 1`, a `TABLES` list (the first is the sentinel) and `publish<Name>({ silverDir, goldDir, date })`. Export `<name> = goldDataset({ id, tables, inputs, analysisVersion, publish })`.
2. List the silver inputs as `GoldInput` values. Read the fingerprint with `inputFingerprint`. Get completeness from `inputsComplete`. Add `goldStamp(...)` as the last columns of every SELECT. Use a total `ORDER BY` and `lit()` for values. Write with `writeGoldTables`.
3. Write rows even when inputs are incomplete. Return `partial` with the missing periods, or `missing` when an input has no partition for the date.
4. Add the dataset as one line at the end of `datasets` in `publisher/src/datasets.ts`.
5. Test as in `gold/generation.test.ts`: totals against the silver input, identical bytes on a second run, a flagged incomplete day, and the runner skips an up-to-date date and rebuilds a changed one.
6. Bump `ANALYSIS_VERSION` in the same commit as any change to the logic.

## Consequences

- **Owner decision:** a silver logic fix that keeps the same bronze file does not rebuild gold by itself. Use `--force` or bump `ANALYSIS_VERSION`. This is accepted. It is the same limit as the entity mappings.
- **Rebuild cost.** The entity `inputs_sha256` covers every Generation_MD and dispatch partition up to the date ([ADR-0008](0008-entity-model.md)). A revised monthly Generation_MD file therefore rebuilds every later date in gold, not only the days of that month. We accept this for now, because gold generation is cheap (seconds a day) and the entity fingerprint is outside this change. A narrower entity fingerprint would cut the cost. It is a later decision.
- Forgetting to bump `ANALYSIS_VERSION` leaves old gold rows. A review of any change to a gold module must check it.
- A gold dataset that reads several silver tables lists them all. A change in any of them rebuilds that date.
- Plant tables take `island` as `min(island)` over the plant's rows. Units on two islands give `NI`. Units on an unmapped POC are ignored when another unit has an island. The fuel tables split by the unit's own island, so they are exact.
- The runner has one extra `partitionRoot` field and a `goldDir` option. There is no second runner.

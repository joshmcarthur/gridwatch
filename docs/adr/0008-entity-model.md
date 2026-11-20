# ADR-0008: Entity model and mapping tables

- Status: Accepted
- Date: 2026-11-20

## Context

One plant or place has a different identifier in each dataset. Dispatch energy prices and nodal prices use a point of connection (POC). Generation_MD uses a site, a POC, a network code and a plant name. The fleet file uses a unit code and a plant name per unit. The NSP table uses an NSP code, a POC, a region and an island. Brief section 5 asks for one mapping layer that keeps the source IDs. See [#10](https://github.com/joshmcarthur/gridwatch/issues/10), [ADR-0006](0006-mapping-datasets-snapshots.md) and [`docs/sources.md`](../sources.md) sections 3.5 and 3.6.

## Decision

### Entities and canonical IDs

| Entity | Canonical ID | Source IDs that map to it |
| --- | --- | --- |
| Island | `NI` or `SI` | NSP `Island`; `Island` in dispatch prices and nodal prices. |
| Region | NSP `Network reporting region ID` (1 to 40) | NSP region ID and name. |
| Point of connection (POC) | The POC code, for example `HAY2201` | `POC code` (NSP), `PointOfConnection` (dispatch), `PointOfConnectionCode` (nodal), `PointOfConnectionCode` (fleet), `POC_Code` (Generation_MD). |
| Site | The first three letters of the POC code, for example `HAY` | `Site_Code` (Generation_MD). The two agree on all 86 Generation_MD site and POC pairs of Oct 2026. |
| Plant | `<site code>/<lower-case Gen_Code>`, for example `ARI/arapuni` | `(Site_Code, POC_Code, Nwk_Code, Gen_Code)` in Generation_MD. Several of these keys can share one plant. |
| Unit | `<POC code>:<unit code>`, for example `HLY2201:HLY1` | `(PointOfConnectionCode, UnitCode)` in the fleet file; `(PointOfConnectionCode, UnitCode)` in nodal prices. |
| Participant | The 4-letter participant code, for example `MRPL` | NSP `Network participant` and `Embedded under network participant`; fleet `PlantOperatorCode`; Generation_MD `Nwk_Code`. |
| Fuel category | `hydro`, `geothermal`, `wind`, `gas`, `coal_gas`, `solar`, `battery`, `other` | Fleet `FuelCode` and Generation_MD `Fuel_Code`, through the fuel map. |

- **Node and POC are one entity.** No source separates a pricing node from a POC. Dispatch and nodal prices are priced per POC. The model has no separate node entity. If a source separates them, a later ADR adds one.
- **A POC has an island and a place, not always one region.** An NSP table row has one region. A POC can have several NSPs. On 2026-10-15, 17 POCs have NSPs in two regions. The POC table holds `region_id` only when all its NSPs agree, and `region_count` always.
- **Region means the network reporting region.** The NSP table also has a zone. The zone has 5 values for 40 regions, so it is too coarse to use. The network reporting region is the unit of the distribution network area, and it is the unit for regional consumption in the Sankey (brief section 8.1). Every region has one island. Zone stays in the NSP table. The model does not use it.
- **Plant is a Generation_MD concept.** `Gen_Code` is a plant name, such as `aratiatia`. The fleet `PlantName` is a name per unit, such as `Huntly Rankine 1`. No source carries both a unit code and a plant name. So a unit links to a plant only when the unit's POC holds exactly one plant and the fuel category of the unit agrees with the plant. The link is empty otherwise. A plant can have more than one POC and more than one network code, so the plant ID leaves both out. A plant that spans two sites has one ID for each site. A Generation_MD row maps to its plant by the formula, so no key table is needed.
- **Unit is a fleet and nodal concept.** Generation_MD has no unit code. The unit table comes from the fleet file. Nodal prices join to it on POC and unit code.
- **Participant has no name in most sources.** Only the fleet file gives an operator name. A participant from the NSP table or Generation_MD alone has a null name. The fleet placeholder `N/A` is not a participant.
- **Canonical IDs equal source codes where a source code exists.** The tables still carry both the canonical ID column and the source columns, so a future change of rule does not change a join key.

### Fuel map

`publisher/src/silver/fuel-map.ts` holds the map as a hand-kept constant. It maps each source fuel code to a category. Matching is exact. There is no catch-all. A code that is not in the map goes to the unmapped report.

| Category | Source codes (Generation_MD and fleet) |
| --- | --- |
| hydro | `Hydro`, `HYD` |
| geothermal | `Geo`, `GEO` |
| wind | `Wind`, `WIN` |
| solar | `Solar`, `SOL` |
| gas | `Gas`, `GAS` |
| coal_gas | `Coal` (Generation_MD), `CLG` (fleet) |
| battery | `ELE` |
| other | `Diesel`, `DSL`, `Wood` |

- **`battery` extends brief section 8.1 by owner decision.** Batteries will be a larger part of the fleet. A battery is storage, not primary energy: it charges from the grid and discharges back to it. Gold generation by fuel ([#16](https://github.com/joshmcarthur/gridwatch/issues/16)) and the energy balance ([#23](https://github.com/joshmcarthur/gridwatch/issues/23)) must show it apart from primary generation and must not add it to the primary total.
- **`coal_gas` replaces brief section 8.1's `coal` by owner decision.** The fleet file describes `CLG` as "Coal/Gas" in its `Fuel` column. The Huntly Rankine units 1, 2 and 4 can burn either fuel, and no dataset says which one they burned in a period. Generation_MD labels the same plant (`huntly_1_4` at `HLY2201`) `Coal`, but that is a fixed label, not a measurement. Gold ([#16](https://github.com/joshmcarthur/gridwatch/issues/16)) shows this output as one coal/gas band, so Gridwatch never shows a split it cannot measure. `Coal` appears only for `huntly_1_4` in the files checked (202604, 202610 and the fixtures). A future coal-only code gets a `coal` category in a later change.
- Only fuel codes are mapped. The only battery in the data has `ELE` with the technology `BAT`. No other fuel code carries `BAT`.
- `Gas&Oil` (older Generation_MD files, not seen in the last 12 months) is not in the map. It goes to the unmapped report if it appears.
- The fleet placeholder `N/A` (one decommissioned unit, `NPL3`) is not in the map. It shows in the report on every day.
- The map covers the codes of Oct 2026. Older Generation_MD files are not checked.
- **Plant overrides.** `FUEL_PLANT_OVERRIDES` in the same file sets a category by plant ID when the source fuel code is wrong. It does not change the source code. `WPG/waipori` is `wind`: Generation_MD labels `WPG0331` Hydro, and most of that energy is Mahinerangi wind ([#105](https://github.com/joshmcarthur/gridwatch/issues/105)). `BWK/waipori` stays hydro. The override is in `inputs_sha256`, so a change rebuilds the entity tables and then gold generation.

### Mapping tables

One publisher call, `publishEntityMappings`, writes all tables for one trading date. The partitions follow ADR-0005: `silver/<table>/trading_date=YYYY-MM-DD/data.parquet`. Each table holds the mapping that applies on that day. The tables are not snapshots of one source. A reader joins on the day without the snapshot lookup of ADR-0006. Every table also has `inputs_sha256` (see the runner contract).

| Table | One row per | Source columns kept |
| --- | --- | --- |
| `entity_points_of_connection` | POC with an island | `poc_id`; island and its source (`nsp` or `dispatch_prices`); NSP row status; region ID and count; coordinates; NSP count; NSP snapshot date. |
| `entity_regions` | region | region ID and name; `has_nsp_in_force`, false for a region that only closed rows use. |
| `entity_participants` | participant | participant ID; name; flags for plant operator and network participant. Network participants come from NSP rows in force. |
| `entity_plants` | plant ID | `plant_id`, `site_id`, `plant_name`, fuel category, and the lists `fuel_codes`, `points_of_connection` and `network_codes` of its Generation_MD keys. |
| `entity_units` | fleet row in force | `point_of_connection`, `unit_code`, `plant_name`, `technology_code`, `fuel_code`, `plant_operator_code`; `unit_id`, `poc_id`, `plant_id`, fuel category, operator participant ID; fleet snapshot date. |
| `entity_unmapped` | unmapped identifier | dataset, identifier type, source ID, row count in that day's silver. |

Rules for the day:

- **NSP.** Take the newest snapshot on or before the day (ADR-0006). A day with no such snapshot has no mapping, and the call returns `missing`. Keep rows with `start_date <= day <= end_date` (inclusive; a blank end is open).
- **Closed POCs.** A POC with no row in force on the day keeps its newest closed row that started on or before the day (`nsp_row_status` is `last_closed`). Six POCs that carry a price exist only in closed rows. Four of them, such as `HWB1101`, closed before 2026-10-15 and still carry a price. The range lookup of ADR-0006 alone loses these four, and the owner's note on #10 expects the lookup to find all six. The place of a POC does not change when its NSP closes, so we keep the last row. A POC with two islands in its chosen rows fails the build.
- **POCs missing from the NSP table.** A priced POC with no NSP island takes its island from the `Island` column of the dispatch energy prices partitions with `trading_date <= day`. A blank on one day does not matter if another day up to the mapping day has a value. A POC that is blank on every day up to the mapping day has no island, and the report lists it. These POCs have no region and no coordinates (owner decision on [#7](https://github.com/joshmcarthur/gridwatch/issues/7)).
- **Island checks.** The build fails when a dispatch `Island` is not NI, SI or blank. It fails when a POC without an NSP island has two different islands in the window. It fails when a POC has an island in the NSP table and a different island in the dispatch files.
- **Fleet.** Take the newest fleet snapshot on or before the day. If none is that old, take the oldest one. The collector labels the fleet file with the day of the check, so a backfill of past days has no older snapshot. The fleet file keeps its own history in the effective dates, so the oldest snapshot still gives the rows in force on a past day. Keep rows with `effective_start_date <= day < effective_end_date`. This amends ADR-0006, which carries a "Changed by ADR-0008" note.
- **Plants.** Read every Generation_MD partition up to the day. The fuel code comes from the newest day of each key. Generation_MD lags the market by weeks, so recent days read earlier partitions. Generation_MD writes no row for a plant that does not generate, so a plant appears from the first day it has a row.
- **Build failures.** The call also fails when one region ID has two names. It writes nothing then, and an older partition stays as it was.

### Unmapped report

`entity_unmapped` lists identifiers in the silver of the same trading date that do not resolve:

- a POC of dispatch energy prices, nodal prices or Generation_MD that is not in `entity_points_of_connection`;
- a nodal `(POC, unit)` pair that is not in `entity_units`;
- a Generation_MD fuel code that is not in the fuel map, or a Generation_MD network code that is not a participant;
- a fleet fuel code that is not in the fuel map.

An unmapped identifier does not fail the build. A dataset with no partition for the day adds nothing.

### Runner contract

The runner ([#13](https://github.com/joshmcarthur/gridwatch/issues/13)) finds stale silver days by comparing `bronze_sha256` with the manifest. Entity tables have no bronze input, so each table has an `inputs_sha256` column instead. It is a SHA-256 over the fuel map (codes and plant overrides) and the `bronze_sha256` values of every silver partition the build read, with the partition path, in a fixed order. The inputs are the NSP snapshot, the fleet snapshot, the dispatch energy prices and Generation_MD partitions up to the day, and that day's nodal partition. The call returns the same value as `inputsSha256`. A fuel-map change therefore rebuilds every mapping date.

- The publisher runner builds entity mappings last, after all other datasets.
- It builds them for the dates in its range.
- It rebuilds a date when the `inputs_sha256` of the stored partition differs from the value a new build would give. A rewrite of any earlier Generation_MD or dispatch day changes the value for every later date, so the runner rebuilds those dates. This is intended, and the cost is small.
- A non-empty `entity_unmapped` does not count as a failure. It always holds the fleet `N/A` row.
- The runner registers the step as the last entry of `publisher/src/datasets.ts`, with `table`, `versionColumn` and `wantedVersions` fields. `wantedVersions` computes the fresh value from the `bronze_sha256` of the silver inputs, once for all dates. The dates are those with dispatch, nodal or Generation_MD silver and an NSP snapshot.
- `publishEntityMappings` returns the shared `PublishResult` shape (`status`, `rows`, `path`) with the extra fields `tables` and `inputsSha256`. `rows` and `path` are those of the POC table.

## Alternatives

- **Build the tables once for each input change.** Keep only `entity_unmapped` per day, and build the other five tables once for each input change, keyed by the NSP snapshot date. This gives fewer files. We chose one partition per trading day for three reasons. Joins stay simple: a reader joins on `trading_date` and does not look up a snapshot. The tables are small (about 900 POC rows, 90 plants and 120 units a day). A rebuild is cheap and it reuses the runner's stale-day logic through `inputs_sha256`.
- **A separate node entity.** Rejected, because no source separates a node from a POC.
- **Zone as the region.** Rejected, because it has 5 values and does not match the distribution networks.
- **A key table for plants.** Rejected, because the plant ID is a formula of the Generation_MD row.

## Not decided here

- Transmission constraints, outages and the other brief section 5 entities. They wait for their datasets.
- Locations for the 18 grid-level POCs. Issue [#49](https://github.com/joshmcarthur/gridwatch/issues/49) can add a hand-kept table.
- Participant names for participants outside the fleet file.
- Grid exit points and grid injection points. No source names them.

## Consequences

- A reader joins silver rows to the tables on the same `trading_date`. The join keys are `poc_id`, `unit_id`, `plant_id` and `participant_id`. Each is unique in its table.
- The tables repeat for each day, so storage is small.
- `entity_unmapped` has a standing row for the fleet placeholder `N/A`. A runner must not treat a non-empty report as a failure.
- The plant link from a unit is empty when the POC holds more than one plant, when the POC is not in Generation_MD, or when the fuel categories disagree. On 2026-10-19, 27 of 120 units have no link. The three Huntly `CLG` units link to `HLY/huntly_1_4`.
- The owner accepted this ADR on 2026-11-20, with the closed-row rule, the fleet snapshot rule and the per-day tables.

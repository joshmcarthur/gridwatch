# Data sources: EMI access, schemas, cadence and history

Research for [issue #2](https://github.com/joshmcarthur/gridwatch/issues/2). Checked on 20 November 2026 (NZ time) against the EMI catalogue pages and the Azure blob container behind them.

**Method.** Every fact links to the page or file it came from. I listed the container with the Azure REST API and counted files, sizes and `Last-Modified` values. I read one complete recent file per dataset, plus the first lines of the earliest files, in a scratch folder. No samples are committed. **Measured** means I saw it directly. **Inferred** means I deduced it. **Unknown** says what I tried.

Shorthand: `BLOB` = `https://emidatasets.blob.core.windows.net/publicdata`, `WH` = `BLOB/Datasets/Wholesale`.

## 1. Recommended download method (all seven datasets)

**Use the public Azure blob container over HTTPS. Do not scrape the HTML catalogue pages.** Listing and download are anonymous. The pages also publish a SAS token for Storage Explorer and AzCopy; we do not need it, so keep it out of the repository.

| Check | Result (measured) | Evidence |
|---|---|---|
| Backing store | Container `publicdata` on account `emidatasets`. | [forum: access arrangements](https://www.emi.ea.govt.nz/Forum/thread/new-access-arrangements-to-emi-datasets-retirement-of-anonymous-ftp/), [EA: how to access datasets](https://www.ea.govt.nz/data-and-insights/how-to-access-our-downloadable-datasets/) |
| Listing | `GET BLOB?restype=container&comp=list&prefix=<folder>/` returns XML with `Name`, `Content-Length`, `Last-Modified`, `Etag`, `Content-MD5`. Max 5000 per call; follow `NextMarker` as `marker=`. Skip zero-byte "folder" blobs such as `.../DispatchEnergyPrices/2022`. | [example listing](https://emidatasets.blob.core.windows.net/publicdata?restype=container&comp=list&prefix=Datasets/Wholesale/DispatchAndPricing/DispatchEnergyPrices/2026/) |
| Change detection | `Last-Modified`, `ETag`, `Content-Length` on every file. `Content-MD5` only on Cleared Offers (matched my download), 262 of 351 Generation_MD files (up to 201912) and the static 2017-2018 mappings files. | list XML per dataset |
| HTTP behaviour | `If-None-Match` and `If-Modified-Since` return 304. `Range` returns 206. No gzip on the wire. Plain HTTP returns 400. | `curl` on [20261119_DispatchEnergyPrices.csv](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/DispatchEnergyPrices/2026/20261119_DispatchEnergyPrices.csv) |

Parallel download throughput is **unknown** (not tried).

**Collector rule.** List each dataset's prefix, compare `ETag` and `Last-Modified` with the manifest, download new or changed files, and store our own SHA-256. Re-list the last five days each run.

**Platform risk.** The Authority [will decommission EMI](https://www.emi.ea.govt.nz/Forum/thread/emi-retirement-and-electricity-authority-data-and-insights-hub/) (post of 29 Sep 2025) and replace it with the "Data & insights" hub on ea.govt.nz, which documents the same blob endpoint ([dispatch and pricing](https://www.ea.govt.nz/data-and-insights/datasets/wholesale/dispatch-and-pricing/)). EMI pages still return 200. Record hub URLs in the manifest. Whether the container will change at shutdown is **unknown** (the thread gives no date for the dataset move).

## 2. Summary

| Dataset | Prefix (under `WH/`) | One file covers | Format | First file |
|---|---|---|---|---|
| Dispatch Energy Prices | `DispatchAndPricing/DispatchEnergyPrices/<yyyy>/` | trading day | CSV, long | 2022-11-01 |
| Dispatch Reserve Prices | `DispatchAndPricing/DispatchReservePrices/<yyyy>/` | trading day | CSV, long | 2022-11-01 |
| Nodal Prices and Volumes | `DispatchAndPricing/NodalPricesAndVolumes/<yyyy>/` | trading day | CSV, long | 2020-09-10 |
| Cleared Offers | `DispatchAndPricing/ClearedOffers/<yyyy>/` | trading day | CSV, long | 2022-04-01 |
| Generation_MD | `Generation/Generation_MD/` | calendar month | CSV, wide (`TP1`..`TP50`) | 1997-08 |
| HVDC Flows | `Metered_data/HVDC_Flows/` | calendar month | CSV, wide (`TP1`..`TP50`) | 1996-10 |
| Mappings and Geospatial | `MappingsAndGeospatial/` | dated snapshot or static file | CSV, ZIP, PDF | static 2017/2018; snapshots from 2026-01-06 |

File names: `yyyymmdd_DispatchEnergyPrices.csv`, `yyyymmdd_DispatchReservePrices.csv`, `yyyymmdd_DispatchNodalPricesAndVolumes.csv` (extra word `Dispatch`), `yyyymmdd_ClearedOffers.csv`, `yyyymm_Generation_MD.csv`, `yyyymm_HVDC_flows.csv` (lower-case `flows`), `yyyymmdd_NetworkSupplyPointsTable.csv`. Only the meshblocks file starts with a UTF-8 byte-order mark.

**Shared cadence (measured).** Daily files for trading day D carry a `Last-Modified` of about 07:08 NZ on D+1 (the 19 Nov files: Thu 19 Nov 18:06-18:09 UTC). The pages say "made available early each morning".

**Shared revisions.** Files are overwritten in place, with no version history (measured). The pattern of `Last-Modified` values (16-19 Nov stamped on 19 Nov, 15 Nov stamped on 18 Nov) suggests a nightly job that rewrites the last four trading days (**inferred**; I saw one version of each file, so whether content changes is **unknown**). Bulk regenerations also occur (measured): 52 of 1,458 energy price files, 1,011 nodal files (Jun 2023) and 1,035 cleared offers files (Feb 2025) are stamped more than four days after their trading day.

## 3. Datasets

### 3.1 Dispatch Energy Prices

Catalogue: [EMI](https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/DispatchEnergyPrices), [new hub](https://www.ea.govt.nz/data-and-insights/datasets/wholesale/dispatch-and-pricing/dispatch-energy-prices/). Example file: [20261119](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/DispatchEnergyPrices/2026/20261119_DispatchEnergyPrices.csv).

| Question | Answer |
|---|---|
| Pattern | One CSV per trading day, folder per year ("collated into a single daily CSV file, grouped by year", [page](https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/DispatchEnergyPrices)). |
| Columns | `TradingDate, TradingPeriod, PublishDateTime, PointOfConnection, Island, IsProxyPriceFlag, DollarsPerMegawattHour` (NZD/MWh). Proxy flag Y means a nearby POC price was copied after an outage. |
| Resolution | Prices "at intervals ranging from one to several minutes" within a half-hour trading period. The 19 Nov 2026 file has 278 publish times, 246 POCs and 68,388 rows. `PublishDateTime` carries a NZ offset (`+13:00`/`+12:00`). The TP1 price is published at 23:59:45 the day before, so its date differs from `TradingDate`. |
| DST | 46 periods on 27 Sep 2026 ([file](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/DispatchEnergyPrices/2026/20260927_DispatchEnergyPrices.csv)), 50 on 5 Apr 2026 ([file](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/DispatchEnergyPrices/2026/20260405_DispatchEnergyPrices.csv)). |
| Quirk | `Island` is blank for some POCs on some days (`OHG1101` 19 Nov 2026, `KIW2201` 5 Apr 2026). |
| Earliest | 2022-11-01. The page says real-time pricing began on 1 Nov 2022 ([listing](https://emidatasets.blob.core.windows.net/publicdata?restype=container&comp=list&prefix=Datasets/Wholesale/DispatchAndPricing/DispatchEnergyPrices/2022/)). |
| Gap | **22 days missing: 2025-09-11 to 2025-10-02.** `20250910` and `20251003` exist; [`20250911` returns 404](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/DispatchEnergyPrices/2025/20250911_DispatchEnergyPrices.csv). Nodal and Cleared Offers have those days. Reason **unknown** (checked the [forum's latest discussions](https://www.emi.ea.govt.nz/Forum) and the retirement thread). |
| Revisions | As in section 2. These are interim prices, declared final "by 2pm the following business day" unless a pricing error claim is lodged (page). Settled prices are in a separate dataset (section 6, item 5). |
| Size | About 4.3 MB per day. |

### 3.2 Dispatch Reserve Prices

Catalogue: [EMI](https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/DispatchReservePrices), [new hub](https://www.ea.govt.nz/data-and-insights/datasets/wholesale/dispatch-and-pricing/dispatch-reserve-prices/). Example file: [20261119](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/DispatchReservePrices/2026/20261119_DispatchReservePrices.csv).

| Question | Answer |
|---|---|
| Pattern | One CSV per trading day, folder per year. |
| Columns | `TradingDate, TradingPeriod, PublishDateTime, PointOfConnection, Island, FIRDollarsPerMegawattHour, SIRDollarsPerMegawattHour`. FIR is 6-second reserve, SIR is 60-second. Units are dollars per megawatt-hour. Two POCs only: `HAY2201` is always NI and `BEN2201` is always SI in the files checked (556 rows on 19 Nov; [definitions](https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/DispatchReservePrices)). |
| Resolution | Publish times are irregular. On the 5 Apr, 27 Sep, 18 Nov and 19 Nov 2026 files, the median gap between publish times for one POC is 5 minutes. Gaps run from 76 seconds to 25 minutes. A trading period has 2 to 8 publish times. A price is published from about 1 minute before to 27 minutes after its period starts (5 Apr, 27 Sep, 18 Nov and 19 Nov 2026 files). |
| DST | Confirmed. 46 periods on 27 Sep 2026 and 50 on 5 Apr 2026, all present. The UTC span is 23 and 25 hours. |
| Earliest | 2022-11-01. |
| Gap | Same 22 days as energy prices (2025-09-11 to 2025-10-02). |
| Revisions | Section 2. Final prices are in a separate dataset, [Final reserve prices](https://www.ea.govt.nz/data-and-insights/datasets/wholesale/dispatch-and-pricing/final-reserve-prices/) (files unchecked). |
| Size | About 36 KB per day. |

### 3.3 Nodal Prices and Volumes

Catalogue: [EMI](https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/NodalPricesAndVolumes), [new hub](https://www.ea.govt.nz/data-and-insights/datasets/wholesale/dispatch-and-pricing/nodal-prices-and-volumes/). Example file: [20261119](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/NodalPricesAndVolumes/2026/20261119_DispatchNodalPricesAndVolumes.csv).

| Question | Answer |
|---|---|
| Pattern | One CSV per trading day, folder per year, containing "all RTD cases for the preceding day" ([page](https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/NodalPricesAndVolumes)). |
| Columns | 17: `TradingDate, TradingPeriodNumber, IntervalDateTime, RunDateTime, CaseTypeCode, CaseID, PointOfConnectionCode, UnitCode, PlantName, Island, LoadMegawatts, InitialMegawatts, GenerationMegawatts, LocationFactor, DollarsPerMegawattHour, IsDeadFlag, IsDisconnectedFlag`. Rows with `UnitCode` N/A are POC rows (load and price); others are generation by unit. Per the page, load is a model input and generation is the model's dispatch, not metered output. `Island` is blank on 834 of 70,558 rows. |
| Resolution | 5-minute interval. 215 POCs on 19 Nov 2026; only case type `RTD` seen. **Intervals are missing:** 278 of 288 slots on 19 Nov (04:40, 06:50, 07:55, 10:25, 10:30, 13:30, 15:00, 15:30, 15:35, 23:45). |
| Earliest | **2020-09-10**, starting mid-day at TP20 ([file](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/NodalPricesAndVolumes/2020/20200910_DispatchNodalPricesAndVolumes.csv)). No missing days to 2026-11-19. |
| Pre-Nov 2022 values | **Inferred:** the page says real-time pricing began 1 Nov 2022, so earlier files likely hold RTD schedule prices that were not settlement prices. The page does not say so directly. |
| Revisions | Section 2. |
| Size | About 11 MB per day. The largest dataset. |
| Interval time | `IntervalDateTime` is the interval start. Interval 00:00 is in period 1, and the last interval of the day, 23:55, is in the last period (checked on 18 Nov, 27 Sep and 5 Apr). `RunDateTime` is about one minute before the interval start. |
| Cases | A `CaseID` belongs to one interval. Six intervals on 18 Nov 2026 have two cases (a re-run about two minutes later). The key is `(IntervalDateTime, CaseID, PointOfConnectionCode, UnitCode)`. Without `CaseID` the key has duplicates (1,531 of 74,050 rows on 18 Nov). |
| Rows | 18 Nov 2026: 74,050 rows, 216 POCs. 181 POCs have point of connection rows. The other 35 appear only in generation rows. Generation rows carry a price, but it does not always match the point of connection row in the same run (at `WAI0331` the `HTR0` rows differ from the `N/A` row, for example 93.3355 against 93.356, in 160 run and case groups on 18 Nov). Generation rows have load 0 except 374 rows. |
| `N/A` | `UnitCode` and `PlantName` are `N/A` together, on point of connection rows only. Silver stores null. |
| Dead flag | `IsDeadFlag` and `IsDisconnectedFlag` are equal on every row of the three days checked. 288 rows on 18 Nov are `Y` (unit `PPI0`, price 0). |

#### Which price dataset to use

**Use Dispatch Energy Prices (3.1) for "the price at a node in a trading period".** Use Nodal Prices and Volumes (3.3) for load and generation by unit. The owner accepted this for now ([#9](https://github.com/joshmcarthur/gridwatch/issues/9)).

Evidence, from the files for 18 Nov 2026 (measured):

| Check | Dispatch energy prices | Nodal prices and volumes |
|---|---|---|
| POCs with a price | 246 | 216 |
| POCs in one dataset only | 30 | 0 |
| Rows | 70,848 | 74,050 |
| Price precision | 2 decimals | 4 decimals |
| Proxy flag | Yes (966 rows `Y`) | No |
| Duplicate cases for one interval | No | Yes (6 intervals) |
| File size | 4.3 MB | 12 MB |
| First file | 2022-11-01 | 2020-09-10 |

Matching rule: each dispatch row is paired with a nodal row for the same POC (any unit) from the latest `RunDateTime` at or before its `PublishDateTime`, and the pair counts only if the gap is under 5 minutes. Of 70,848 dispatch rows, 60,189 matched. Of those, about 99% have the same price once the nodal price is rounded to cents (98.9% to 99.1% with different tie-breaks). The median gap between run and publish is 38 seconds. 603 rows differ: 288 are proxy prices and 315 are not (cause unchecked, likely a re-run). The other 10,659 dispatch rows did not match: 8,640 are the 30 POCs missing from nodal, 555 are earlier than the first run for that POC, and 1,464 have a latest nodal run more than 5 minutes older, because nodal omits intervals. So the dispatch price is the published nodal price, rounded.

Reasons:

1. Dispatch covers more POCs, so a map or chart has fewer holes.
2. It is the published price, with a proxy flag that says when it was copied from a nearby POC.
3. It has no duplicate cases to resolve.
4. It is a third of the size.

Limits: dispatch prices arrive at irregular times, so [#17](https://github.com/joshmcarthur/gridwatch/issues/17) must set the rule that reaches a trading period. Nodal prices are the fallback for the 22 days missing from dispatch (2025-09-11 to 2025-10-02, outside the 12-month backfill). Nodal has no proxy flag, so a fallback price can hide a copied price.

### 3.4 Cleared Offers

Catalogue: [EMI](https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/ClearedOffers), [new hub](https://www.ea.govt.nz/data-and-insights/datasets/wholesale/dispatch-and-pricing/cleared-offers/). Example file: [20261119](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/ClearedOffers/2026/20261119_ClearedOffers.csv).

| Question | Answer |
|---|---|
| Pattern | One CSV per trading day, folder per year, "all RTD cases for the preceding day" ([page](https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/ClearedOffers)). |
| Columns | 15: `TradingDate, TradingPeriodNumber, IntervalDateTime, RunDateTime, CaseTypeCode, CaseID, ProductClass, PointOfConnectionCode, UnitCode, PlantName, Island, ParticipantCode, ClearedGenerationMegawatts, ClearedFIRMegawatts, ClearedSIRMegawatts`. `ProductClass` is `Injection` (22,804 rows on 19 Nov) or `Offtake` (2,111). Reserve columns are blank when none cleared. UTF-8 plant names with macrons. |
| Resolution | 5-minute RTD interval; 278 intervals, 94 units on 19 Nov. **The same slots are missing as in the nodal file.** On 19 Nov 2026 both files have the same 278 intervals, and 04:40, 06:50, 07:55, 10:25, 10:30, 13:30, 15:00, 15:30, 15:35 and 23:45 are absent from both. The two files also hold the same `IntervalDateTime`, `CaseID` and `RunDateTime` triples. |
| Earliest | **2022-04-01** (the page says RTD-derived files start before real-time pricing). Earlier final-pricing files sit in another folder, unlisted. No missing days to 2026-11-19. |
| Integrity | Serves `Content-MD5`. |
| Revisions | Section 2. A forum thread, [reconciling ClearedMW with SPD case file offers](https://www.emi.ea.govt.nz/Forum/thread/reconciling-differences-in-clearedmw-from-cleared-offers-and-offers-obtained-from-spd-case-files/), suggests the two can differ; unread. |
| Size | About 3.1-3.9 MB per day. Silver Parquet is 127-138 KB per day (19 Nov 2026: 3.8 MB CSV, 137 KB Parquet), so 12 months is about 50 MB. The size does not justify a different backfill start. |
| Interval time | `IntervalDateTime` is the interval start. Interval 00:00 is in period 1, and the last interval, 23:55, is in the last period (checked on 18 Nov, 27 Sep and 5 Apr). `RunDateTime` is usually about one minute before the interval start. Re-run cases come after it: the difference runs from -157 s to +60 s. A `CaseID` belongs to one interval. Six intervals on 18 Nov 2026 have two cases. |
| Key | `(IntervalDateTime, CaseID, ProductClass, PointOfConnectionCode, UnitCode)`. It has no duplicates on 18 Nov, 19 Nov, 27 Sep and 5 Apr. The key without `ProductClass` also has none on those days, but `ProductClass` stays in the key, because a unit could be both. |
| Products | One row holds energy and both reserve products. `ClearedGenerationMegawatts` is blank on every `Offtake` row. `ClearedFIRMegawatts` and `ClearedSIRMegawatts` are blank when none cleared. Across the four days, no row has all three blank. |
| `N/A` and blanks | `Offtake` rows have `PlantName` `N/A`. Most also have `UnitCode` `N/A` (7,187 of 8,083 across the four days checked), and the rest have a unit code such as `RHO99`. `Island` is blank on 2,217 `Injection` rows across the four days (for example the `PTA` units). Silver stores null for all of these. |

### 3.5 Generation_MD

Catalogue: [EMI](https://www.emi.ea.govt.nz/Wholesale/Datasets/Generation/Generation_MD) (new hub title "Generation output", [page](https://www.ea.govt.nz/data-and-insights/datasets/wholesale/generation/generation-output/)). Example file: [202610](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/Generation/Generation_MD/202610_Generation_MD.csv).

| Question | Answer |
|---|---|
| Pattern | One CSV per calendar month in one folder, 351 files, 1997-08 to 2026-10 with no missing month. |
| Columns | **Wide:** `Site_Code, POC_Code, Nwk_Code, Gen_Code, Fuel_Code, Tech_Code, Trading_Date, TP1..TP50`. Values are **kWh** per trading period, from metered injections mapped to plants ([page](https://www.emi.ea.govt.nz/Wholesale/Datasets/Generation/Generation_MD)). 3,104 rows, 89 plants in Oct 2026. The date header is `Trading_date` in the 1997, 2009 and 2019 files I read and `Trading_Date` from 2022. Match case-insensitively. |
| Resolution | Half-hour. `TP49`/`TP50` are blank except on 50-period days: 5 Apr 2026 has 50 values, 27 Sep 2026 has 46. `TP47`/`TP48` are also blank on the 46-period day. |
| Code vocabularies | Two in one file: `Hydro`/`HYD`, `Wind`/`WIN`, `Geo`/`GEO`, `Solar`/`SOL`, plus `ELE`/`BAT` for batteries; 1997 files use `Gas&Oil`. Newer plants use the short codes. |
| Earliest | 1997-08 ([file](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/Generation/Generation_MD/199708_Generation_MD.csv)). |
| Lag | Measured: the `202610` file is stamped 10 Nov 2026, `202608` 9 Oct, `202607` 11 Aug (all UTC), and no file exists for November. **Inferred:** metered data is 10 days to about 6 weeks behind. The page says the series "will be replaced" by a richer one; timing **unknown**. |
| Revisions | Section 2. Earlier months get re-stamped: `202609` was rewritten 17 Nov, a week after `202610` appeared. Bulk rewrites: 28 Jul 2024 (2024-01 to 06), 16 Dec 2024 (2024-08 to 11), 18 Sep 2025 (2025-07, 08). |
| Size | About 0.7-0.9 MB per month now. |

### 3.6 Mappings and Geospatial

Catalogue: [EMI](https://www.emi.ea.govt.nz/Wholesale/Datasets/MappingsAndGeospatial), [new hub](https://www.ea.govt.nz/data-and-insights/datasets/wholesale/mapping-and-geospatial/).

| Sub-dataset (under `WH/MappingsAndGeospatial/`) | Content | Dates |
|---|---|---|
| `NetworkSupplyPointsTable/` | CSV, 27 columns, one row per network supply point (NSP), closed ones included, with `Current flag`, `Start date`, `End date`, POC, region, island, NZTM easting/northing. 2,672 rows, 790 current, 898 POCs on 19 Nov 2026. About 440 KB. | Dated snapshots `yyyymmdd_...csv`, 186 files, **first 2026-01-06**, not every day. Older names such as `20230404_...` return 404. Stamped about 05:40 NZ. |
| `NetworkRegionShapefiles/` | 12 ZIPs (ESRI, GeoJSON, MapInfo; NZTM, WGS84) and a PDF, e.g. [WGS84 GeoJSON](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/MappingsAndGeospatial/NetworkRegionShapefiles/WGS84/GeoJSON/WGS84_GeoJSON_NRR.zip). | Static since 15 Oct 2018. |
| `NetworkRegionsToMeshblocks/` | One CSV, 2.3 MB. | Static (`20171128_...`). |

Each NSP snapshot is a full table with history in `Start date`/`End date`/`Current flag`, so the latest snapshot rebuilds history; archive every snapshot because old ones are dropped. Coverage gap: section 6, item 7.


**Files chosen for [#7](https://github.com/joshmcarthur/gridwatch/issues/7)** (silver pattern: [ADR-0006](adr/0006-mapping-datasets-snapshots.md)):

| Silver table | Source file | Gives |
|---|---|---|
| `network_supply_points` | `NetworkSupplyPointsTable/<yyyymmdd>_NetworkSupplyPointsTable.csv`, every snapshot | POC to island, network reporting region, zone and NZTM coordinates (also as WGS84 lat/lon), with validity dates. Dispatch energy prices and nodal prices join on the POC. |
| `generation_fleet` | [`WH/Generation/GenerationFleet/Existing/DispatchedGenerationPlant.csv`](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/Generation/GenerationFleet/Existing/DispatchedGenerationPlant.csv) | Plant and unit to POC, fuel, technology, operator (owner), capacity, with effective dates. Measured on 20 Nov 2026: 20 KB, 161 rows, 96 POCs, 9 fuel codes, 29 operators. Serves `Content-MD5`. The source overwrites it in place (stamped 19 Nov 2026 19:38 UTC). It is in the Generation folder, not the Mappings folder. |

Not chosen: `NetworkRegionShapefiles/` (region polygons are for the map issue) and `NetworkRegionsToMeshblocks/` (no dataset needs it). The `Proposed/` fleet files are an investment pipeline, not a mapping.

**Why 18 priced POCs have no NSP row (measured 20 Nov 2026).** None of the 18 appears in any of the 186 snapshots, closed rows included. None is in the fleet file either. The table lists network supply points, which are connections where a network or load takes energy from the grid. The 18 are grid nodes (`BEN2201`, `HAY2201`, `INV2201` and others, mostly 220 kV) that carry a price but are not such a connection (inferred; the source gives no reason). The source has no other POC table with island or coordinates: the Transmission folder holds only PDF line diagrams. The dispatch energy prices file gives an `Island` for all 18 on 19 Nov 2026. Every one of the 18 also shares its three-letter site code with an NSP POC on the same island, but we do not use that as a mapping. Another 6 priced POCs (`BPD1101`, `HWB1101`, `MDN1101`, `SWN2201`, `TMU1101`, `WAI0501`) appear only in closed NSP rows (`Current flag` 0), so a lookup that keeps only current rows loses them. So 228 of 246 resolve to an island when the lookup uses every row. Silver does not guess the other 18.

### 3.7 HVDC Flows

Catalogue: [EMI](https://www.emi.ea.govt.nz/Wholesale/Datasets/Metered_data/HVDC_Flows). Example file: [202610](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/Metered_data/HVDC_Flows/202610_HVDC_flows.csv). Checked 21 November 2026 (NZ time) with the blob listing and three files fetched anonymously (202604, 202609, 202610). Used by [#19](https://github.com/joshmcarthur/gridwatch/issues/19) and [ADR-0016](adr/0016-hvdc-flows.md).

| Question | Answer |
|---|---|
| Pattern | One CSV per calendar month in one folder, 361 files, 1996-10 to 2026-10 with no missing month (measured from the listing). About 60 KB per month. No `NextMarker` on the listing. |
| Columns | `POC, Nwk_Code, Generation_Type, Trader, Unit_Measure, Flow_Direction, Status, Trading_Date, TP1..TP50`. Measured in the 202610 header. |
| Rows | Four rows per trading day: `BEN2201` and `HAY2201`, each with `X` and `I`. Measured on all 91 days of 202604, 202609 and 202610 (364 rows). `Unit_Measure` is `kWh` and `Status` is `F` on every row. |
| Meaning of the rows | `BEN2201` (Benmore) and `HAY2201` (Haywards) are the two HVDC terminals ([#7](https://github.com/joshmcarthur/gridwatch/issues/7)). `X` is offtake from the AC grid into the link. `I` is injection from the link into the AC grid. **Inferred** from the data: on 31 Oct 2026 TP1, Benmore `X` is 204.554 MWh and Haywards `I` is 198.323 MWh. The other two cells are zero. The source gives no legend in the file. |
| Resolution | Half-hour. `TP49`/`TP50` are blank on 48-period days and `TP47`..`TP50` on the 46-period day. 5 Apr 2026 has 50 values. A period can carry both directions on one POC: Benmore on 24 Oct 2026 TP27 has `X` 55,845 kWh and `I` 3,170 kWh (measured). |
| Idle periods | Zero, not blank. For example 26 Apr 2026 TP21 to TP35 are zero on all four rows (measured). |
| Disagreement | The two ends can disagree in a period. 12 Apr 2026 TP38 gives a net of +1.115 MWh at Benmore and -0.486 MWh at Haywards (measured). The cause is **unknown**. Gold marks such a period as `none` ([ADR-0016](adr/0016-hvdc-flows.md)). |
| Units | kWh per period. The gold table converts to MWh ([ADR-0016](adr/0016-hvdc-flows.md)). |
| Earliest | 1996-10. Not fetched. |
| Lag | Measured: the `202610` file has a `Last-Modified` of 10 Nov 2026, the same lag as Generation_MD (section 3.5). No November file exists on 21 Nov 2026. Revisions: **unknown**. |

## 4. Backfill start dates and sizes

The owner limited the backfill to the last 12 months for now ([#13](https://github.com/joshmcarthur/gridwatch/issues/13#issuecomment-7025571389)). The default start for every dataset is 12 months before the run date. The runner computes it; it is not a fixed date. Older bronze is not deleted, and `collect --from` can fetch earlier data later.

Sizes below are derived from the measured growth per year in the blob listings (one year of files); gzip is an estimate from one sample file per dataset.

| Dataset | Raw size, 12 months | Files | Gzip (est.) | Earliest available |
|---|---|---|---|---|
| Dispatch Energy Prices | 1.5 GB | about 365 | 0.14 GB | 2022-11-01 |
| Dispatch Reserve Prices | 0.01 GB | about 365 | under 0.01 GB | 2022-11-01 |
| Nodal Prices and Volumes | 4.0 GB | about 365 | 0.5 GB | 2020-09-10 (settlement-relevant from 2022-11-01, inferred) |
| Cleared Offers | 1.3 GB | about 365 | 0.05 GB | 2022-04-01 |
| Generation_MD | 0.01 GB | 12 monthly files | under 0.01 GB | 1997-08 |
| HVDC Flows | under 0.01 GB | 12 monthly files | under 0.01 GB | 1996-10 |
| Mappings | 0.09 GB | all NSP snapshots (first 2026-01-06) and static files | 0.02 GB | 2026-01-06 |
| **Total** | **about 6.9 GB** | **about 1,700** | **about 0.7 GB** | |

One 11.5 MB nodal file downloaded at about 1.6 MB/s on a single stream (one measurement), so the 12-month backfill is about 1.2 hours (nodal about 45 minutes). Growth after that is about 6.8 GB raw per year.

## 5. Licence and attribution

Website content, including these datasets, is licensed under Creative Commons Attribution 4.0 International unless an item says otherwise. You may copy, store, distribute and adapt it "as long as you attribute it to the Electricity Authority and abide by the other license terms". Logos, trade marks, site design and third-party works are excluded. The Authority accepts no liability for accuracy and may change or delete content without notice. Source: [copyright, disclaimer and transparency statement](https://www.ea.govt.nz/copyright-disclaimer-transparency/). I found no dataset-level licence text that differs ([example page](https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/DispatchEnergyPrices)).

## 6. Surprises that change the plan

1. EMI is being decommissioned; build on the blob container and record the new hub URLs. Affects #5, #6-#12, #15.
2. Only Cleared Offers serves `Content-MD5`, so the manifest needs `ETag`, `Last-Modified`, size and our own SHA-256. Affects #5.
3. Files are overwritten in place; keep every version seen, and re-fetch the trailing five days each run. Affects #5, #13, #14, #15.
4. Dispatch energy and reserve prices miss 2025-09-11 to 2025-10-02, so completeness tracking and price charts need a fallback rule. This gap is outside the 12-month backfill from November 2026. Affects #6, #11, #14, #17, #18, #28.
5. Dispatch prices are interim; settled prices are in Final energy prices ([daily files and ByMonth back to 1996-10](https://emidatasets.blob.core.windows.net/publicdata?restype=container&comp=list&prefix=Datasets/Wholesale/DispatchAndPricing/FinalEnergyPrices/ByMonth/), about 330 KB per day), outside the six; the owner should decide on scope (issue #2). Affects #6, #17, #28.
6. Generation_MD lags metered data by weeks (see 3.5), so recent generation must come from Nodal or Cleared Offers dispatch results, which makes those two needed for the generation mix. Affects #8, #16, #20, #23, #27, #30.
7. The NSP table lacks 18 of 246 priced POCs (including `BEN2201`, `HAY2201`) and 376 of 750 current POCs have no coordinates; a location source for grid-level nodes is unknown. Affects #7, #10, #17, #32, #49.
8. Generation_MD uses two fuel-code vocabularies and a changing header case; a fuel map is needed. Affects #8, #10, #16.
9. The NSP table keeps snapshots only from 2026-01-06; archive every one from day one. Affects #5, #7, #10.
10. Nodal and Cleared Offers are 5-minute cases with missing intervals (10 of 288 on the day checked) while dispatch prices arrive at irregular times, so the silver layer needs one rule to reach trading periods. Affects #6, #9, #11, #12, #17.
11. The 12-month backfill is about 6.9 GB raw (more than half Nodal) and about 0.7 GB gzip; it takes about 1.2 hours on one stream. Affects #5, #13 and the hosting spike.
12. The backfill covers the last 12 months only (owner direction). If it is extended, start the dispatch datasets no earlier than 2022-11-01: Nodal exists from 2020-09-10 and Cleared Offers from 2022-04-01, but the settlement relevance of earlier data is inferred (see 3.3). Affects #9, #12, #13.
13. Trading days can have 46 or 50 periods (checked in energy prices, Generation_MD and cleared offers; other datasets unchecked), so never assume 48. Affects #6, #8, #9, #11, #12.
14. HVDC_Flows lags metered data by the same month as Generation_MD (the 202610 file is stamped 10 Nov 2026, section 3.7). Gold transfer is therefore a month behind. A live estimate from island residuals is 60 to 90 MW off the metered flow, so it is not used ([ADR-0016](adr/0016-hvdc-flows.md)). Affects #19, #23.

## 7. Generator outage information

Research for [issue #45](https://github.com/joshmcarthur/gridwatch/issues/45). Checked on 20 November 2026 (NZ time). This is a deferred dataset ([brief §3.3](brief.md), Phase 5) and not part of the 12-month backfill. **Measured** means I saw it directly. **Unknown** says what I tried.

**Finding.** Every public outage source comes from one system: **POCP** (Planned Outage Co-ordination Process), run by Transpower as system operator. It holds planned and unplanned outages for generation, transmission, distribution and direct connections ([EA article](https://www.ea.govt.nz/news/eye-on-electricity/when-do-power-station-outages-occur), [POCP user guide](https://static.transpower.co.nz/public/bulk-upload/documents/UG-SD-989%20POCP%20User%20Guide.pdf)). I found no outage data in the [EMI datasets index](https://www.emi.ea.govt.nz/Wholesale/Datasets). WITS: not checked.

### 7.1 Sources

**EMI report [Scheduled generation outages](https://www.emi.ea.govt.nz/Wholesale/Reports/UWRCKF)**

| Question | Answer |
|---|---|
| Content | MW lost per timestamp, **aggregated** by fuel type, island, participant or outage category. No plant or unit. |
| Access | Anonymous CSV: `https://www.emi.ea.govt.nz/Wholesale/Download/DataReport/CSV/UWRCKF?DateFrom=yyyymmdd&DateTo=yyyymmdd&DateEffective=yyyymmdd&Show=GT`. `Show` is `GT`, `GI`, `P` or `OC`. Measured: HTTP 200. |
| Format | `Timestamp, SeriesCode, Series, Lost megawatts`. Codes such as `NZ_H`, `NI_H`, `CTCT`, `GEN`. |
| History | From 2003 (measured). A range in 2000-2002 returns no rows (the server falls back to 2026). Future dates return planned outages to the end of 2027. |
| As-of view | `DateEffective` shows POCP as it stood on that day (measured: accepted for 2025-01-05). |
| Cadence | Not fixed; owners can change POCP at any time ([report notes](https://www.emi.ea.govt.nz/Wholesale/Reports/UWRCKF)). |
| Licence | None stated. Site content is CC BY 4.0 (section 5); whether that covers this CSV is **unknown**. |

**POCP website** ([Operations Customer Portal](https://customerportal.transpower.co.nz/))

| Question | Answer |
|---|---|
| Content | Per-outage records for each asset, with revision history. |
| Access | Since November 2025 Guest access needs no account and allows export and attachment download ([user guide, Business Rule 4](https://static.transpower.co.nz/public/bulk-upload/documents/UG-SD-989%20POCP%20User%20Guide.pdf)). |
| Format | Web app with an export function. Export format **unknown**: the app is script-driven and I could not inspect it with `curl`. |
| History | Unknown. |
| Cadence | Updated hourly ([Transpower](https://transpower.co.nz/our-work/industry/our-grid/outage-planning)). |
| Licence | "All rights reserved" footer; no data licence found ([page](https://transpower.co.nz/system-operator/information-industry/operational-information-system/outage-planning)). |

**POCP Download API**

| Question | Answer |
|---|---|
| Content | Per-outage records. `GET https://api.transpower.co.nz/v2/so/api/pocp/data/outages`, filters `start`, `end`, `modified_since`, `category`, `grid_points`, `planning_status`. 5,000 rows per call. |
| Access | **Needs an API key from Transpower** ([user guide, section 10.3](https://static.transpower.co.nz/public/bulk-upload/documents/UG-SD-989%20POCP%20User%20Guide.pdf)). Measured: HTTP 401 without a key (the guide says 403). Key eligibility for non-participants: **unknown**, not asked. |
| Format | JSON: `block`, `grid_points`, `owner`, `owner_outage_id`, `category`, `planning`, `type`, `start`, `end`, `mw_loss`, `mw_remain`, `modified`, `pocp_int_id`. |
| History | Unknown. |
| Cadence | `modified_since` allows incremental pulls. |
| Licence | Unknown. |

Not found: a public unplanned-outage feed. Transpower lists unplanned outages on its home page and Facebook ([page](https://transpower.co.nz/our-work/industry/our-grid/outage-planning)), and owners should enter them in POCP within 24 hours where possible ([user guide, Business Rule 3](https://static.transpower.co.nz/public/bulk-upload/documents/UG-SD-989%20POCP%20User%20Guide.pdf)). The Annual Outage Plans (XLSX) on that page cover transmission only. I found no evidence of outages in real-time feeds ([Transpower live data](https://transpower.co.nz/power-system-live-data) mentions generation only).

### 7.2 Mapping to the entity model (#10)

| Level | POCP identifier | Entity-model match | Confidence |
|---|---|---|---|
| Site | `grid_points`, three letters (`SFD`) | `Site_Code` in [Generation_MD](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/Generation/Generation_MD/202610_Generation_MD.csv); first three letters of `POC_Code` (`SFD2201`) | One example checked. The other 74 `Site_Code` values: unchecked. |
| Asset | `block` (`TCC_Stn`), free text set by the owner | No EMI field. Hand-map to plant/unit (`Gen_Code`, `PlantName`, `UnitCode`). | **Inferred.** The API example pairs `TCC_Stn` with `SFD` and Contact Energy; Generation_MD has Contact's `stratford` gas plant at `SFD`. |
| Owner | `owner` name, `org_id` UUID | `ParticipantCode` (`CTCT`) in Cleared Offers. Needs a name-to-code table. | Medium |
| Fuel | Not in POCP. `category` is generation, embedded generation, transmission, distribution or direct connection. | Take fuel from the plant mapping. Filter `category` to drop embedded generation, distribution and transmission. | n/a |

A site can hold several plants (`WKM2201` has `whakamaru` and `mokai`), so a site match does not identify the unit. Capacity effect is `mw_loss` and `mw_remain`.

### 7.3 Caveats

- **Voluntary and revisable.** The EMI report says submission "is not mandatory" and owners can change entries at any time. The user guide says outages are provided as required under Code Schedule 8.3. I did not read the Code to settle which is right. Treat records as the owner's plan, not verified fact.
- **Plans move.** Only `DateEffective` (EMI) or revision history (POCP) shows what was known on a day. Our own daily snapshot is the only way to keep that history.

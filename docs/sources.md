# Data sources: EMI access, schemas, cadence and history

Research for [issue #2](https://github.com/joshmcarthur/gridwatch/issues/2). Checked on 20 November 2026 (NZ time) against the live EMI catalogue pages and the Azure blob container behind them.

**Method.** Every fact below comes from a page or a file URL linked next to it. I listed the container with the Azure REST API and counted files, sizes and `Last-Modified` values. I downloaded one complete recent file per dataset (and the first lines of the earliest files) into a scratch folder to read columns and rows. No sample is committed. A statement marked **unknown** says what I tried.

Shorthand used in links: `BLOB` = `https://emidatasets.blob.core.windows.net/publicdata`, `WH` = `BLOB/Datasets/Wholesale`.

## 1. Recommended download method (all six datasets)

**Use the public Azure blob container over HTTPS, with no credentials. Do not scrape the HTML catalogue pages.**

| Check | Result | Evidence |
|---|---|---|
| Is the catalogue backed by Azure blob storage? | Yes. Container `publicdata` on account `emidatasets`. | [EMI forum: access arrangements](https://www.emi.ea.govt.nz/Forum/thread/new-access-arrangements-to-emi-datasets-retirement-of-anonymous-ftp/), [EA: how to access datasets](https://www.ea.govt.nz/data-and-insights/how-to-access-our-downloadable-datasets/) |
| Does listing work with no credentials? | Yes. `GET BLOB?restype=container&comp=list&prefix=<folder>/` returns XML with `Name`, `Content-Length`, `Last-Modified`, `Etag`, `Content-MD5`. | [list of one year of Dispatch Energy Prices](https://emidatasets.blob.core.windows.net/publicdata?restype=container&comp=list&prefix=Datasets/Wholesale/DispatchAndPricing/DispatchEnergyPrices/2026/) |
| Does download work with no credentials? | Yes. The pages publish a shared access signature (SAS) token for Azure Storage Explorer and AzCopy. We do not need it, so do not copy it into the repository. | [EA: how to access datasets](https://www.ea.govt.nz/data-and-insights/how-to-access-our-downloadable-datasets/) |
| Paging | Max 5000 blobs per list call. Follow `NextMarker` as `marker=`. Always list by `prefix`. | [EA: how to access datasets](https://www.ea.govt.nz/data-and-insights/how-to-access-our-downloadable-datasets/) |
| Zero-byte "folder" blobs | The listing includes blobs such as `.../DispatchEnergyPrices/2022` with `Content-Length` 0. Skip them. | [list](https://emidatasets.blob.core.windows.net/publicdata?restype=container&comp=list&prefix=Datasets/Wholesale/DispatchAndPricing/DispatchEnergyPrices/2022) |
| Change detection | `Last-Modified`, `ETag` and `Content-Length` are present for every file. `Content-MD5` is present only for Cleared Offers (all files; I checked the 19 Nov 2026 file and the value matched the MD5 of the bytes I downloaded), for 262 of the 351 Generation_MD files (the older ones, up to 201912), and for the static 2017-2018 mappings files. It is absent for the other datasets and for every recent file except Cleared Offers. | list XML per dataset (see sections) |
| Conditional and ranged requests | `If-None-Match` and `If-Modified-Since` return 304. `Range` returns 206. `Accept-Encoding: gzip` is ignored (no compression on the wire). | `curl` against [20261119_DispatchEnergyPrices.csv](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/DispatchEnergyPrices/2026/20261119_DispatchEnergyPrices.csv) |
| Plain HTTP | Returns 400. Use HTTPS. | same |
| Speed | One 11.5 MB nodal file took 7.3 s (about 1.6 MB/s, single stream, one measurement). A prefix listing took 0.5 s. Parallel throughput is **unknown** (not tried). | `curl -w` timings |

**Collector rule.** List each dataset's prefix, compare `ETag` and `Last-Modified` with the manifest, download new or changed files, and store our own SHA-256 (only Cleared Offers gives a server MD5). Re-list the last five days on every run (see "Revisions").

**Platform risk.** EMI is being retired. The Authority said on 29 Sep 2025 that it will [decommission EMI](https://www.emi.ea.govt.nz/Forum/thread/emi-retirement-and-electricity-authority-data-and-insights-hub/) and replace it with the "Data & insights" hub on ea.govt.nz. Datasets already have pages there ([dispatch and pricing](https://www.ea.govt.nz/data-and-insights/datasets/wholesale/dispatch-and-pricing/)), and the hub documents the same blob endpoint. The old EMI pages still return 200 today. The blob container is the stable part, so build on it, and use the new hub URLs in docs and the source manifest. Whether the container name or account will change at EMI shutdown is **unknown** (the thread gives no date for the dataset move; I read the whole thread).

## 2. Summary table

| Dataset | Blob prefix (under `WH/`) | One file covers | Format | Time shape | First file | Latest file (20 Nov 2026) |
|---|---|---|---|---|---|---|
| Dispatch Energy Prices | `DispatchAndPricing/DispatchEnergyPrices/<yyyy>/` | one trading day | CSV, long | one row per POC per price publication | 2022-11-01 | 2026-11-19 |
| Dispatch Reserve Prices | `DispatchAndPricing/DispatchReservePrices/<yyyy>/` | one trading day | CSV, long | as above, two POCs | 2022-11-01 | 2026-11-19 |
| Nodal Prices and Volumes | `DispatchAndPricing/NodalPricesAndVolumes/<yyyy>/` | one trading day | CSV, long | one row per 5-min case per POC or unit | 2020-09-10 | 2026-11-19 |
| Cleared Offers | `DispatchAndPricing/ClearedOffers/<yyyy>/` | one trading day | CSV, long | one row per 5-min case per unit | 2022-04-01 | 2026-11-19 |
| Generation_MD | `Generation/Generation_MD/` | one calendar month | CSV, wide (`TP1`..`TP50`) | one row per plant per day | 1997-08 | 2026-10 |
| Mappings and Geospatial | `MappingsAndGeospatial/` | dated snapshot, or static file | CSV, ZIP, PDF | reference data | 2017/2018 static; snapshots from 2026-01-06 | 2026-11-19 snapshot |

File names: `yyyymmdd_DispatchEnergyPrices.csv`, `yyyymmdd_DispatchReservePrices.csv`, `yyyymmdd_DispatchNodalPricesAndVolumes.csv` (note the extra word `Dispatch`), `yyyymmdd_ClearedOffers.csv`, `yyyymm_Generation_MD.csv`, `yyyymmdd_NetworkSupplyPointsTable.csv`. All are plain CSV with a header row and, on the files I read, no quoting problems. Only the meshblocks file starts with a UTF-8 byte-order mark; strip it when parsing.

## 3. Datasets

### 3.1 Dispatch Energy Prices

Catalogue: [EMI](https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/DispatchEnergyPrices), [new hub](https://www.ea.govt.nz/data-and-insights/datasets/wholesale/dispatch-and-pricing/dispatch-energy-prices/).

| Question | Answer |
|---|---|
| Download | Blob prefix above. Example: [2026/20261119_DispatchEnergyPrices.csv](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/DispatchEnergyPrices/2026/20261119_DispatchEnergyPrices.csv). |
| File pattern, period | One CSV per trading day, in a folder per year. The page says the data is "collated into a single daily CSV file, grouped by year". |
| Format and columns | CSV, long. `TradingDate, TradingPeriod, PublishDateTime, PointOfConnection, Island, IsProxyPriceFlag, DollarsPerMegawattHour`. Units are NZD per MWh. `IsProxyPriceFlag` Y means a nearby POC price was copied after an outage ([column definitions](https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/DispatchEnergyPrices)). |
| Resolution | Prices "at intervals ranging from one to several minutes" within a half-hour trading period (same page). The 19 Nov 2026 file has 278 distinct publish times, 246 POCs and 68,388 rows. Trading period (1..48) is a column. `PublishDateTime` has a NZ offset (`+13:00` or `+12:00`). The TP1 price is published at 23:59:45 on the previous calendar day, so `PublishDateTime` date differs from `TradingDate`. |
| DST | 46 trading periods on 27 Sep 2026 and 50 on 5 Apr 2026 (checked in [20260927](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/DispatchEnergyPrices/2026/20260927_DispatchEnergyPrices.csv) and [20260405](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/DispatchEnergyPrices/2026/20260405_DispatchEnergyPrices.csv)). |
| Data quirk | `Island` is blank for some POCs on some days (`OHG1101` on 19 Nov 2026, `KIW2201` on 5 Apr 2026). Take island from the mapping table, not this column. |
| Earliest date | 2022-11-01 (first file `20221101_...`). The page says real-time pricing began on 1 Nov 2022. [Listing](https://emidatasets.blob.core.windows.net/publicdata?restype=container&comp=list&prefix=Datasets/Wholesale/DispatchAndPricing/DispatchEnergyPrices/2022/). |
| Gaps | **22 days are missing: 2025-09-11 to 2025-10-02.** `20250910` and `20251003` exist; `20250911` returns 404 ([HEAD](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/DispatchEnergyPrices/2025/20250911_DispatchEnergyPrices.csv)). Cleared Offers and Nodal files exist for those days. Reason **unknown** (I looked at the [forum's latest discussions](https://www.emi.ea.govt.nz/Forum) and the EMI retirement thread; neither mentions it). |
| Cadence and lag | The file for trading day D first appears about 07:08 NZ on D+1 (the 19 Nov file has `Last-Modified` Thu 19 Nov 18:08 UTC = Fri 20 Nov 07:08 NZDT). The page says "made available early each morning". |
| Revisions | Files are overwritten in place with no version history. Inferred pattern from `Last-Modified`: a nightly job at about 18:06 UTC rewrites the last four trading days. Files for 16-19 Nov were all stamped 19 Nov 18:07-18:08; the 15 Nov file was stamped 18 Nov. Whether the content changes between rewrites is **unknown** (I could only see one version). These are interim prices: they are declared final "by 2pm the following business day" unless a pricing error claim is lodged, and the settled prices live in the separate [Final energy prices](https://www.ea.govt.nz/data-and-insights/datasets/wholesale/dispatch-and-pricing/final-energy-prices/) dataset (see section 6). Occasional bulk regeneration also happens: 52 of 1,458 files have `Last-Modified` more than four days after their trading date (17 on 17 Nov 2022, 13 on Apr 2025, 4 on Oct 2025, others scattered). |
| Size | About 4.3 MB per day (4.2-4.4 MB by year). 6.31 GB for 1,458 files from 2022-11-01. About 1.5 GB per year. One day gzips to 0.37 MB (11.6x). |
| Licence | CC BY 4.0, attribute the Electricity Authority (section 5). |

### 3.2 Dispatch Reserve Prices

Catalogue: [EMI](https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/DispatchReservePrices), [new hub](https://www.ea.govt.nz/data-and-insights/datasets/wholesale/dispatch-and-pricing/dispatch-reserve-prices/).

| Question | Answer |
|---|---|
| Download | Blob prefix above. Example: [2026/20261119_DispatchReservePrices.csv](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/DispatchReservePrices/2026/20261119_DispatchReservePrices.csv). |
| File pattern, period | One CSV per trading day, in a folder per year. |
| Format and columns | CSV, long. `TradingDate, TradingPeriod, PublishDateTime, PointOfConnection, Island, FIRDollarsPerMegawattHour, SIRDollarsPerMegawattHour`. FIR is fast instantaneous reserve (6-second), SIR is sustained (60-second). NZD per MWh. Only two POCs: `HAY2201` (North) and `BEN2201` (South) ([definitions](https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/DispatchReservePrices)). I confirmed both in the 19 Nov file: 556 rows. |
| Resolution | Same as energy prices: one to several minutes within a trading period. DST handled the same way (not separately checked). |
| Earliest date | 2022-11-01. |
| Gaps | Same 22 missing days as energy prices: 2025-09-11 to 2025-10-02. |
| Cadence, lag, revisions | Same as energy prices (same job times in the listing). Interim, then final via [Final reserve prices](https://www.ea.govt.nz/data-and-insights/datasets/wholesale/dispatch-and-pricing/final-reserve-prices/) (I did not read that dataset's files). |
| Size | About 36 KB per day. 54 MB for 1,458 files. Negligible. |
| Licence | CC BY 4.0. |

### 3.3 Nodal Prices and Volumes

Catalogue: [EMI](https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/NodalPricesAndVolumes), [new hub](https://www.ea.govt.nz/data-and-insights/datasets/wholesale/dispatch-and-pricing/nodal-prices-and-volumes/).

| Question | Answer |
|---|---|
| Download | Blob prefix above. Example: [2026/20261119_DispatchNodalPricesAndVolumes.csv](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/NodalPricesAndVolumes/2026/20261119_DispatchNodalPricesAndVolumes.csv). |
| File pattern, period | One CSV per trading day, folder per year. "A single file is published daily and contains the nodal price and volume data from all RTD cases for the preceding day" ([page](https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/NodalPricesAndVolumes)). |
| Format and columns | CSV, long, 17 columns: `TradingDate, TradingPeriodNumber, IntervalDateTime, RunDateTime, CaseTypeCode, CaseID, PointOfConnectionCode, UnitCode, PlantName, Island, LoadMegawatts, InitialMegawatts, GenerationMegawatts, LocationFactor, DollarsPerMegawattHour, IsDeadFlag, IsDisconnectedFlag`. Rows with `UnitCode` = `N/A` are POC rows (load and price). Other rows are generation by unit (96 units on 19 Nov). A unit code ending in 0 "is likely representing many generating units". Load is an input to the model, generation is the model's dispatch, not metered output ([page](https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/NodalPricesAndVolumes)). `Island` is "North Island"/"South Island" and blank on 834 of 70,558 rows. |
| Resolution | 5-minute dispatch interval (`IntervalDateTime`) within a trading period. 70,558 rows and 215 POCs on 19 Nov 2026. Only `RTD` case type appears in the files I read. **Some intervals are missing**: 278 of 288 slots present on 19 Nov (missing 04:40, 06:50, 07:55, 10:25, 10:30, 13:30, 15:00, 15:30, 15:35, 23:45). `IsDeadFlag`/`IsDisconnectedFlag` are Y on 278 rows. |
| Earliest date | **2020-09-10** (first file starts mid-day at TP20, 09:35, [sample](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/NodalPricesAndVolumes/2020/20200910_DispatchNodalPricesAndVolumes.csv)). The page says "Real-time pricing began on 1 November 2022", so files before that carry RTD schedule prices that were not the settlement prices (my reading of the page; the page does not use the word "indicative"). No missing days from 2020-09-10 to 2026-11-19. |
| Cadence, lag | Same nightly job as dispatch prices: the 19 Nov file was stamped 19 Nov 18:08 UTC (07:08 NZ 20 Nov). |
| Revisions | Overwritten in place. Same trailing-window pattern. One big bulk regeneration: 1,011 files stamped June 2023, and a handful later (2024-2026). Content differences between versions **unknown**. |
| Size | About 11 MB per day (10.5-12 MB). 24.7 GB for 2,262 files from 2020-09-10. 16.1 GB for 1,480 files from 2022-11-01. About 4.0 GB per year. One day gzips to 1.46 MB (7.9x). **Largest dataset by far.** |
| Licence | CC BY 4.0. |

### 3.4 Cleared Offers

Catalogue: [EMI](https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/ClearedOffers), [new hub](https://www.ea.govt.nz/data-and-insights/datasets/wholesale/dispatch-and-pricing/cleared-offers/).

| Question | Answer |
|---|---|
| Download | Blob prefix above. Example: [2026/20261119_ClearedOffers.csv](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/DispatchAndPricing/ClearedOffers/2026/20261119_ClearedOffers.csv). |
| File pattern, period | One CSV per trading day, folder per year. Contains "all RTD cases for the preceding day" ([page](https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/ClearedOffers)). |
| Format and columns | CSV, long, 15 columns: `TradingDate, TradingPeriodNumber, IntervalDateTime, RunDateTime, CaseTypeCode, CaseID, ProductClass, PointOfConnectionCode, UnitCode, PlantName, Island, ParticipantCode, ClearedGenerationMegawatts, ClearedFIRMegawatts, ClearedSIRMegawatts`. `ProductClass` is `Injection` (22,804 rows on 19 Nov) or `Offtake` (2,111). FIR and SIR columns are blank when no reserve is cleared. Units are MW. Plant names include macrons (UTF-8). |
| Resolution | 5-minute RTD interval. 278 intervals, 94 units and 29 participants on 19 Nov 2026. No duplicate keys. Not checked: whether the same 10 slots are missing as in the nodal file. |
| Earliest date | **2022-04-01** (RTD-derived files start before real-time pricing; the page says so). Files for earlier periods come from final-pricing schedules and sit in a different folder: **unknown** (I did not list it). No missing days from 2022-04-01 to 2026-11-19. |
| Cadence, lag | Same nightly job and times as the others. |
| Revisions | Overwritten in place. Bulk regeneration: 1,035 files stamped 2 Feb 2025. A forum thread titled ["Reconciling differences in ClearedMW from cleared offers and offers obtained from SPD case files"](https://www.emi.ea.govt.nz/Forum/thread/reconciling-differences-in-clearedmw-from-cleared-offers-and-offers-obtained-from-spd-case-files/) suggests the two can differ. The size of the difference is **unknown** (I did not open that thread). |
| Size | About 3.1-3.6 MB per day, rising over time. 5.63 GB for 1,694 files from 2022-04-01. 4.96 GB for 1,480 files from 2022-11-01. About 1.3 GB per year. One day gzips to 0.15 MB (27x). |
| Integrity | The only one of the four daily datasets that serves `Content-MD5`. |
| Licence | CC BY 4.0. |

### 3.5 Generation_MD

Catalogue: [EMI](https://www.emi.ea.govt.nz/Wholesale/Datasets/Generation/Generation_MD) (new hub title: "Generation output", [page](https://www.ea.govt.nz/data-and-insights/datasets/wholesale/generation/generation-output/)).

| Question | Answer |
|---|---|
| Download | Prefix `WH/Generation/Generation_MD/` (one folder, no year subfolders, 351 files). Example: [202610_Generation_MD.csv](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/Generation/Generation_MD/202610_Generation_MD.csv). |
| File pattern, period | One CSV per calendar month: `yyyymm_Generation_MD.csv`. Continuous from 1997-08 to 2026-10 (no missing months). |
| Format and columns | CSV, **wide**. `Site_Code, POC_Code, Nwk_Code, Gen_Code, Fuel_Code, Tech_Code, Trading_Date, TP1..TP50`. Value is energy in **kWh** per trading period; "mapping metered injections ... to the generating plant" ([page](https://www.emi.ea.govt.nz/Wholesale/Datasets/Generation/Generation_MD)). 3,104 rows and 89 plants in Oct 2026. Trading date column is `Trading_date` in files I read from 1997, 2009 and 2019, and `Trading_Date` in files from 2022 on (the change falls between 2019 and 2022). Match the header case-insensitively. |
| Resolution | Half-hour trading period. `TP49` and `TP50` are blank except on the 50-period day. Checked: 5 Apr 2026 has 50 values and 27 Sep 2026 has 46 (blanks after TP46). |
| **Code vocabulary changes** | `Fuel_Code` and `Tech_Code` use two vocabularies in the same file: `Hydro`/`HYD`, `Wind`/`WIN`, `Geo`/`GEO`, `Solar`/`SOL`, plus `ELE`/`BAT` (batteries) and `Gas`, `Coal`, `Diesel`, `Wood`. Newer plants use the short codes. Old files (1997) use `Gas&Oil`. A fuel mapping table is needed. |
| Earliest date | 1997-08 (file [199708](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/Generation/Generation_MD/199708_Generation_MD.csv)). |
| Cadence and lag | Monthly. The Oct 2026 file is stamped 10 Nov 2026 (UTC); Aug 2026 is stamped 9 Oct; Jul 2026 is stamped 11 Aug. So the newest data is 10 days to about 6 weeks old. **No data exists yet for 1-19 Nov 2026.** The page says "This data series will be replaced by one that is more reliable and contains a richer set of plant metadata at some point in the future" (timing **unknown**). |
| Revisions | Overwritten in place. Earlier months are re-stamped: the Sep 2026 file was rewritten on 17 Nov, a week after the Oct file appeared. Bulk rewrites: 28 Jul 2024 (Jan-Jun 2024), 16 Dec 2024 (Aug-Nov 2024), 18 Sep 2025 (Jul-Aug 2025). Content differences **unknown**. |
| Size | 0.4 MB per month in 1997, 0.7-0.9 MB per month now. 236 MB for all 351 files. One recent month gzips to 0.26 MB (3.2x). |
| Licence | CC BY 4.0. |

### 3.6 Mappings and Geospatial

Catalogue: [EMI](https://www.emi.ea.govt.nz/Wholesale/Datasets/MappingsAndGeospatial), [new hub](https://www.ea.govt.nz/data-and-insights/datasets/wholesale/mapping-and-geospatial/). Three sub-datasets.

| Sub-dataset | Prefix (under `WH/MappingsAndGeospatial/`) | What it is | Dates |
|---|---|---|---|
| Network supply points table | `NetworkSupplyPointsTable/` | CSV, 27 columns, one row per NSP (including closed ones), with `Current flag`, `Start date`, `End date`, POC, network participant, reconciliation type, zone, island, NZTM easting/northing, network reporting region. 2,672 rows in the 19 Nov 2026 file, 790 current, 898 distinct POCs. | A dated snapshot `yyyymmdd_NetworkSupplyPointsTable.csv` (about 440 KB). 186 files, **first 2026-01-06**, newest 2026-11-19. Published on most days but not every day. Older names, such as `20230404_...` shown in the 2018-2024 forum example, return 404. |
| Network region shapefiles | `NetworkRegionShapefiles/` | ZIPs of the network reporting regions and zones in ESRI, GeoJSON and MapInfo, NZTM and WGS84, plus a PDF note. 13 files, all stamped 15 Oct 2018. | Static. [WGS84 GeoJSON regions](https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/MappingsAndGeospatial/NetworkRegionShapefiles/WGS84/GeoJSON/WGS84_GeoJSON_NRR.zip) (518 KB). |
| Network regions to meshblocks | `NetworkRegionsToMeshblocks/` | One CSV: `Region ID, Network reporting region, Root NSP, 2013 Meshblock ID`, 2.3 MB. | Static, `20171128_...`, stamped 15 Oct 2018. |

| Question | Answer |
|---|---|
| Cadence, lag | NSP table: snapshots stamped about 16:38-16:41 UTC (about 05:40 NZ) on the day named. Shapefiles and meshblocks: never updated since 2018. |
| Revisions | Each snapshot is a full table, with history in `Start date`/`End date`/`Current flag`. A single latest snapshot is enough to rebuild history, but retention of old snapshots is short (see Earliest date), so archive every snapshot we fetch. |
| Coverage against the other datasets | **POCs in the NSP table do not cover the price datasets.** 18 of the 246 POCs in the 19 Nov energy price file are absent, including the two reference nodes `BEN2201` and `HAY2201` and other grid-level nodes (`HAY1101`, `INV2201`, `ISL2201`, `OTA2201` and others). Of 750 current POCs, only 374 have NZTM coordinates, and 32 of the 246 priced POCs have none. All POCs in Cleared Offers, Generation_MD and the nodal file do appear in the table. A coordinates source for grid-level nodes is **unknown**: not found in the six datasets. |
| Size | About 80.6 MB for all 186 NSP snapshots. Shapefile and meshblock files total about 5.7 MB. Gzip of one NSP snapshot: 70 KB. |
| Licence | CC BY 4.0. |

## 4. Backfill start dates and size estimates

| Dataset | Recommended backfill start | Why | Raw size from start | Gzip estimate | Per-year growth (raw) |
|---|---|---|---|---|---|
| Dispatch Energy Prices | 2022-11-01 | First file; start of real-time pricing | 6.31 GB (1,458 files) | about 0.55 GB | 1.5 GB |
| Dispatch Reserve Prices | 2022-11-01 | First file | 0.05 GB | under 0.01 GB | 0.01 GB |
| Nodal Prices and Volumes | 2022-11-01 | Matches the dispatch datasets and real-time pricing. Earlier files (from 2020-09-10, extra 8.6 GB) are optional history, not settlement prices. | 16.07 GB (1,480 files) | about 2.0 GB | 4.0 GB |
| Cleared Offers | 2022-11-01 | Same reason. Files from 2022-04-01 are available (extra 0.7 GB) if wanted. | 4.96 GB (1,480 files) | about 0.2 GB | 1.3 GB |
| Generation_MD | 1997-08 (everything) | Small enough to take it all | 0.24 GB (351 files) | about 0.08 GB | 0.01 GB |
| Mappings and Geospatial | Latest NSP snapshot plus all 186 retained snapshots, and the static files | Cheap; snapshot retention is short | about 0.09 GB | about 0.02 GB | small |
| **Total** | | | **about 27.7 GB** | **about 3 GB** | **about 6.8 GB raw, about 0.7 GB gzip** |

Gzip numbers are from one day or month per dataset, so they are only indicative. A first backfill of about 6,400 files at about 1.6 MB/s on one stream is about 5 hours (nodal alone about 2.8 hours); the speed is a single measurement.

## 5. Licence and attribution

The Authority licenses website content, including these datasets, under Creative Commons Attribution 4.0 International, unless an item says otherwise. You may copy, store, distribute and adapt the material "as long as you attribute it to the Electricity Authority and abide by the other license terms". It excludes logos, trade marks and the site's design, and third-party works. It also carries a disclaimer: the Authority does not accept liability for accuracy and may change or delete content without notice. Source: [Copyright, disclaimer and transparency statement](https://www.ea.govt.nz/copyright-disclaimer-transparency/). The dataset pages carry the line "Copyright material on this site is protected by copyright owned by the Electricity Authority or its licensors" ([example](https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/DispatchEnergyPrices)). I found no dataset-level licence text that differs from the site-wide one.

Suggested footer text: "Contains data from the Electricity Authority's Electricity Market Information (EMI) datasets, licensed under CC BY 4.0. Gridwatch NZ has processed and summarised the data. The Electricity Authority does not endorse this site."

## 6. Surprises that change the plan

Each item lists the issue it affects. Issue numbers are from the open backlog.

1. **EMI is being decommissioned.** Catalogue pages move to the ea.govt.nz Data & insights hub; the blob container is documented in both places. Do not parse EMI HTML; record hub URLs in the manifest. Affects #5, #6-#12, #15. ([thread](https://www.emi.ea.govt.nz/Forum/thread/emi-retirement-and-electricity-authority-data-and-insights-hub/))
2. **No credentials are needed, and anonymous listing works.** The published SAS token is not required. Keep it out of the repository and out of config. Affects #5.
3. **`Content-MD5` exists only for Cleared Offers.** The manifest cannot rely on a server hash for the other datasets. Use `ETag`, `Last-Modified`, `Content-Length` and our own SHA-256. Affects #5.
4. **Files are overwritten in place, with a rolling rewrite of the last four days and occasional bulk regenerations.** There is no version history on the server. The collector must re-check the last five days every run and keep each version it sees. Bulk regenerations (June 2023 nodal, Feb 2025 cleared offers) mean a full backfill can differ from an earlier one. Affects #5, #13, #14, #15.
5. **22 days are missing from Dispatch Energy Prices and Dispatch Reserve Prices (2025-09-11 to 2025-10-02).** The other daily datasets have those days. Completeness tracking (#14) and the price charts need a rule for this, for example fall back to Final energy prices or nodal prices. Affects #6, #11, #14, #17, #18, #28.
6. **Dispatch prices are interim real-time prices, not the settled price.** The settled price is in two datasets outside the six: [Final energy prices](https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/FinalEnergyPrices) and Final reserve prices. In the blob listing, Final energy prices has daily files for the last year (names `yyyymmdd_FinalEnergyPrices.csv`, with a few `_I` files) and `ByMonth/yyyymm_FinalEnergyPrices.csv` files back to 1996-10 ([listing](https://emidatasets.blob.core.windows.net/publicdata?restype=container&comp=list&prefix=Datasets/Wholesale/DispatchAndPricing/FinalEnergyPrices/ByMonth/)). Columns are `TradingDate, TradingPeriod, PointOfConnection, DollarsPerMegawattHour`. The meaning of the `_I` suffix is **unknown** (not documented on the pages I read); I infer "interim". The owner should decide whether to add it to scope; it is a small dataset (about 330 KB per day). Affects #6, #17, #28, and the brief's "essential" label for dispatch prices.
7. **Generation_MD is monthly, 10 days to 6 weeks behind, and has a wide layout.** The daily page cannot show metered generation by fuel for the latest weeks. Recent days must come from Nodal `GenerationMegawatts` or Cleared Offers `ClearedGenerationMegawatts` (dispatch results, not metered). Cleared Offers and Nodal are therefore needed for the generation mix and Sankey, not only for prices and reserves. Affects #8, #16, #20, #23, #27, #30.
8. **Generation_MD codes are inconsistent** (`Hydro` and `HYD`, `Wind` and `WIN`, `Solar` and `SOL`, `Geo` and `GEO`, batteries as `ELE`/`BAT`) and the date header changes case. A fuel mapping table and case-insensitive header handling are required. Affects #8, #10, #16.
9. **The mapping table does not cover all priced nodes and lacks coordinates for half of its POCs.** Grid-level nodes (including the reference nodes `BEN2201` and `HAY2201`) are not in it, and 376 of 750 current POCs have no coordinates. The nodal price map needs another source for locations, or must accept gaps. Affects #7, #10, #17, #32, #49.
10. **The NSP table keeps only snapshots from 2026-01-06.** Archive every snapshot (bronze) from day one. Affects #5, #7, #10.
11. **Nodal and Cleared Offers use 5-minute RTD cases, with missing intervals (10 of 288 on the day I checked), while dispatch prices come at irregular times (278 per day).** The silver layer needs a rule to convert both to trading periods (for example, time-weighted average, as the EA says it does for interim prices). Affects #6, #9, #11, #12, #17.
12. **Backfill is about 28 GB raw, three-quarters of it Nodal.** Gzip makes it about 3 GB. Storage is not a constraint, download time is (hours, single stream). Affects #5, #13 and the hosting spike.
13. **The brief's November 2022 start is right for prices and reserve prices.** Nodal exists from 2020-09-10 and Cleared Offers from 2022-04-01, but only the post-1 Nov 2022 values are settlement-relevant. I recommend 2022-11-01 for all four dispatch datasets. Affects #9, #12, #13.
14. **DST days have 46 or 50 trading periods in every dataset.** Do not assume 48. Affects #6, #8, #9, #11, #12.

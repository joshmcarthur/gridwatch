# Glossary

Plain-language meanings of the terms used in this repository. Each entry says what the term is and why it matters here. Detail lives in the linked ADR or in [`sources.md`](sources.md). New terms go in the group they belong to, in alphabetical order.

## Electricity market

**Case (RTD case).** One run of real-time dispatch (RTD), the system operator's schedule for a 5-minute interval, with a `CaseID`. A re-run about two minutes later can give a second case for the same interval. Silver keeps every case. See [ADR-0005](adr/0005-dataset-pattern.md) and [sources 3.3](sources.md#33-nodal-prices-and-volumes).

**Cleared offer.** A generator or reserve provider offers to supply energy or reserve. The cleared quantity is the part the market accepted. The Cleared Offers dataset gives it for each 5-minute interval and unit. See [sources 3.4](sources.md#34-cleared-offers).

**Dispatch energy prices.** The price in dollars per megawatt-hour at each point of connection, published at irregular times. Gridwatch uses it for "the price at a node in a trading period". See [sources 3.1](sources.md#31-dispatch-energy-prices).

**Dry year.** A year with low inflows to the hydro lakes. New Zealand relies on hydro, so a dry year needs more thermal generation, and prices rise. The Huntly Rankine units are kept as dry-year cover.

**FIR and SIR.** The two reserve classes in the reserve price and cleared offer files. FIR is 6-second reserve. SIR is 60-second reserve. The daily page calls them fast reserve and slow reserve, and shows a daily summary, not a per-period series. Gold reserve tables have one row per class, island and trading period. See [sources 3.2](sources.md#32-dispatch-reserve-prices) and [ADR-0013](adr/0013-gold-reserve-prices.md).

**Frequency keeping.** A service that keeps the system frequency at 50 Hz from moment to moment. The brief lists it as an ancillary service for a later phase.

**Gentailer.** A company that both generates and retails electricity, such as Genesis, Meridian, Mercury or Contact.

**Interim and final prices.** Dispatch prices are interim. The Authority declares them final by 2pm on the next business day, unless someone lodges a pricing error claim. Settled prices are in a separate dataset. See [sources 3.1](sources.md#31-dispatch-energy-prices).

**Period price.** The time-weighted mean of the dispatch prices in one 30-minute trading period. Each price counts from its publish time until the next publish (rule B). See [ADR-0012](adr/0012-gold-prices.md).

**Price anomaly.** A run of at least 2 trading periods when the price at a reference node is above the 99th percentile, or below the 1st percentile, of the node's last 28 days. The price must also be at least $25/MWh from the median. See [ADR-0019](adr/0019-observations-and-price-anomaly-detector.md).

**Price separation.** A run of at least 2 trading periods when the spread between two reference nodes is above the 99th percentile, or below the 1st percentile, of the pair's last 28 days, and at least $100/MWh from the median. It describes the data. It says nothing about the cause. See [ADR-0019](adr/0019-observations-and-price-anomaly-detector.md).

**Proxy price.** A price copied from a nearby point of connection after an outage. The `IsProxyPriceFlag` column marks it (`Y`). Silver keeps it as a flag.

**Reserve.** The market prices and clears reserve as well as energy. The brief lists reserve prices as something the site should explain. See FIR and SIR for the two classes. The site explains it as spare generating capacity held ready in case a power station trips.

**Reserve price.** What the market paid to keep reserve ready. The site shows the day's lowest, average and highest price for each island and class (`ReservesClassDay`). It is a price, not a security measure: a high reserve price means backup was dear, not that the grid was at risk. See [ADR-0013](adr/0013-gold-reserve-prices.md).

**Spread.** The price at one reference node minus the price at another, in a trading period. A positive spread means the first node costs more. See [ADR-0012](adr/0012-gold-prices.md).

**Trading date.** The calendar date in New Zealand time. Silver partitions by trading date. See [ADR-0003](adr/0003-time-column-naming.md).

**Trading period.** A 30-minute block of the trading date, numbered from 1 at local midnight. A normal day has 48. The day daylight saving starts has 46, and the day it ends has 50. Never assume 48. See [ADR-0003](adr/0003-time-column-naming.md).

## Grid and places

**Embedded generation.** Generation that connects inside a distribution network, not directly to the grid. The NSP table records the parent in its "embedded under" columns. See [sources 7.2](sources.md#72-mapping-to-the-entity-model-10).

**Grid exit point and grid injection point.** Places where power leaves or enters the grid. The brief lists them as possible entities. No source we use names them, so the model has none. See [ADR-0008](adr/0008-entity-model.md).

**Grid load (modelled).** Real-time dispatch (RTD) model load at grid exit points, net of embedded generation behind them, plus dispatchable and battery load. It is not metered consumption. Gold holds it in `grid_load_period` and `grid_load_day`, from Nodal Prices and Volumes joined to the entity points of connection, for each island and trading period. See [ADR-0018](adr/0018-energy-balance.md) and [sources 3.3](sources.md#33-nodal-prices-and-volumes).

**HVDC.** The high-voltage direct current link between the North and South Islands. Its terminals are at Benmore (`BEN2201`) in the South Island and Haywards (`HAY2201`) in the North Island. These two POCs are the only ones in the reserve price files. The metered flow at both ends is in HVDC_Flows ([sources 3.7](sources.md#37-hvdc-flows), [ADR-0016](adr/0016-hvdc-flows.md)). The brief lists "how does the HVDC link work" as a topic to explain.

**Offtake and injection.** The two directions of metered HVDC flow at a terminal. Offtake (`X`) is energy taken from the AC grid into the link. Injection (`I`) is energy put from the link into the AC grid. Each terminal has both.

**Link losses.** The energy that enters the link and does not leave it. Gold takes it as Benmore offtake plus Haywards offtake, minus Benmore injection and Haywards injection ([ADR-0016](adr/0016-hvdc-flows.md)).

**HVDC import.** The energy that an island receives over the HVDC link in a period, in MWh. For the North Island it is the energy received at Haywards. For the South Island it is minus the energy sent at Benmore. The sign is right in both directions, and the two islands' imports add up to minus the link losses. See [ADR-0018](adr/0018-energy-balance.md).

**Northward and southward.** The two directions of transfer across the HVDC link. Northward means from the South Island to the North Island. Gold reports the sign of the transfer as positive when it is northward, measured at Haywards. The direction is `none` when the two ends disagree or the link is idle.

**Island.** `NI` (North Island) or `SI` (South Island). Every point of connection in the model has one. See [ADR-0008](adr/0008-entity-model.md).

**Network reporting region.** The area of a distribution network, with an ID from 1 to 40 in the NSP table. It is Gridwatch's meaning of "region". See [ADR-0008](adr/0008-entity-model.md).

**Network supply point (NSP).** A connection where a network or load takes energy from the grid. The NSP table lists them, closed ones included, each with a point of connection, region, island and dates. See [sources 3.6](sources.md#36-mappings-and-geospatial) and [ADR-0006](adr/0006-mapping-datasets-snapshots.md).

**Node.** A place in the grid with a price. In our sources a node and a point of connection are the same thing, so the model has one entity. See [ADR-0008](adr/0008-entity-model.md).

**Point of connection (POC).** The 7-character code of a priced place in the grid, such as `HAY2201`. Dispatch prices, nodal prices, the fleet file and Generation_MD all use it, so it is the main join key. See [ADR-0008](adr/0008-entity-model.md).


**Reference node and price region.** A reference node is one of three POCs whose prices gold tracks: `OTA2201`, `HAY2201` and `BEN2201`. Its price region is a Gridwatch label (`upper_north_island`, `lower_north_island`, `south_island`). A price region is not an entity-model region. Observation tables carry the label in `price_region`. Their `region_id` is the ADR-0008 region, not this label. See [ADR-0012](adr/0012-gold-prices.md) and [ADR-0019](adr/0019-observations-and-price-anomaly-detector.md).

**Site.** The first three letters of a POC code, such as `HAY`. Several POCs can share one site. Generation_MD calls it `Site_Code`. See [ADR-0008](adr/0008-entity-model.md).

**Zone.** A column in the NSP table with 5 values. It is too coarse to use as a region, so the model ignores it. See [ADR-0008](adr/0008-entity-model.md).

## Generation

**Average megawatts (MW).** The power a fuel made, averaged over a trading period. Generation_MD gives MWh for each period, and a period lasts 30 minutes, so average MW is MWh x 2. Gridwatch charts show average MW, not MWh. See [ADR-0017](adr/0017-static-svg-charts.md).

**Battery.** A storage category, not primary energy. A battery charges from the grid and discharges back to it. Gold must show it apart from primary generation and must not add it to the primary total. Source code `ELE`. See [ADR-0008](adr/0008-entity-model.md).

**CCGT.** Combined cycle gas turbine. A gas turbine whose hot exhaust also drives a steam turbine, so it uses less gas per MWh. Huntly 5 is one.

**Coal/gas (`coal_gas`).** The category for the Huntly Rankine units, which can burn either fuel. No dataset says which one they burned, so Gridwatch shows one band. See [ADR-0008](adr/0008-entity-model.md).

**Cogeneration.** A plant that makes electricity and useful heat together, often at an industrial site. The fleet file uses the technology code `COG`.

**Fleet.** The generation fleet file (`DispatchedGenerationPlant.csv`). It lists each plant unit with its point of connection, fuel, operator and dates. See [ADR-0006](adr/0006-mapping-datasets-snapshots.md).

**Fuel category.** The Gridwatch grouping of source fuel codes. There are eight: `hydro`, `geothermal`, `wind`, `gas`, `coal_gas`, `solar`, `battery` and `other`. A hand-kept map assigns codes to categories, and unknown codes go to the unmapped report. See [ADR-0008](adr/0008-entity-model.md).

**kWh and MWh.** Kilowatt-hours and megawatt-hours, units of energy. One MWh is 1,000 kWh. Generation_MD gives kWh for each trading period, and silver keeps kWh in `kilowatt_hours`. See [ADR-0007](adr/0007-generation-md-monthly-files.md).

**Nameplate capacity.** The rated size of a unit in megawatts, from the fleet file (`nameplate_megawatts`).

**OCGT.** Open cycle gas turbine. A gas turbine without a steam stage. It starts quickly, so it often runs only at peak times. Huntly 6 is one.

**Peaking plant.** A plant that runs mainly at times of high demand or high prices. The fleet file marks it with `PeakingPlantFlag` = `Y`.

**Plant.** A generating station. In Generation_MD it is a `Gen_Code` such as `aratiatia`. Its ID is `<site>/<lower-case Gen_Code>`, for example `ARI/arapuni`. See [ADR-0008](adr/0008-entity-model.md).

**Primary generation.** The total of every fuel except battery. Unmapped generation is included, because it is still made power. Battery is storage, so it is never in this total. See [ADR-0014](adr/0014-site-json-contract.md).

**Rankine unit.** A steam unit: fuel boils water, and the steam drives a turbine. The fleet file uses the technology code `RKN`. Huntly Rankine 1, 2 and 4 burn coal or gas, so they are `coal_gas`.

**Unit.** One generating unit at a POC, with a unit code such as `HLY1`. Its ID is `<POC>:<unit code>`. The fleet file and nodal prices carry it. See [ADR-0008](adr/0008-entity-model.md).

## Organisations and sources

**Electricity Authority (EA).** The body that publishes the wholesale market data Gridwatch uses. See [sources](sources.md).

**EMI.** Electricity Market Information, the Authority's data platform. It is being replaced by a "Data & insights" hub. We download from the blob container behind it. See [sources section 1](sources.md#1-recommended-download-method-all-six-datasets).

**Participant.** An organisation in the market, with a 4-letter code such as `MRPL`. Plant operators in the fleet file and network participants in the NSP table and Generation_MD are participants. See [ADR-0008](adr/0008-entity-model.md).

**POCP.** The Planned Outage Co-ordination Process. Transpower runs it as system operator. All public outage sources come from it. See [sources section 7](sources.md#7-generator-outage-information).

**SPD case files.** Files with the detail of the dispatch process. The brief treats them as a later enrichment, to explain constraints and market outcomes.

**Transpower.** The system operator. It runs POCP. See [sources section 7](sources.md#7-generator-outage-information).

## Gridwatch data terms

**Backfill.** Collecting history. The first run of each dataset collects the last 12 months. See [ADR-0009](adr/0009-runner-default-mode.md).

**Baseline window.** The earlier days whose complete values set the percentiles of a detector. It does not include the day under test. The price anomaly and price separation detectors use the 28 days before the date. See [ADR-0019](adr/0019-observations-and-price-anomaly-detector.md).

**Bronze.** The raw archive: source files exactly as published, plus the manifest. See [ADR-0001](adr/0001-typescript-monorepo-and-data-layers.md) and [ADR-0004](adr/0004-bronze-archive-and-manifest.md).

**`bronze_sha256`.** A column in every silver table. It holds the SHA-256 of the bronze file the row came from. The runner uses it to find silver that is out of date. See [ADR-0009](adr/0009-runner-default-mode.md).

**Candidate.** An episode that ranks first on its trading date and scores at least 0.5 (`is_candidate`). It is a public event, labelled Unreviewed. See [ADR-0024](adr/0024-episode-ranking.md) and [ADR-0022](adr/0022-editorial-review-and-publish-flow.md).

**Canonical ID.** The one Gridwatch ID for an entity, such as a POC code or `<site>/<plant>`. Tables keep the source IDs next to it. See [ADR-0008](adr/0008-entity-model.md).

**Claim.** One statement in an evidence package: a value, a unit, the table and function that gave it, and a confidence level. Its id is a stable name, such as `price.OTA2201.p36`. A claim can list the claims it is built from in `depends_on`. See [ADR-0025](adr/0025-evidence-packages.md).

**Complete, partial, missing and invalid.** The result of publishing a day. Complete: all expected periods have rows. Partial: some periods have no rows, and silver holds the rows that exist. Missing: no data for the date. Invalid: a check failed, and nothing is written. See [ADR-0005](adr/0005-dataset-pattern.md).

**Confidence level.** How sure a claim is: confirmed, strong evidence or possible explanation ([brief §7.2](brief.md)). The evidence package builder writes only confirmed, which means the value is read from a gold or silver row, or is a plain sum or join of such values. See [ADR-0025](adr/0025-evidence-packages.md).

**Entity.** A thing that appears in several datasets under different IDs, such as a POC, plant, unit or participant. See [ADR-0008](adr/0008-entity-model.md).

**Energy-balance residual.** For an island and a period: generation plus HVDC import, minus grid load (modelled). Gold keeps it as a column and never adjusts it. It holds what the three sources do not explain: transmission losses, Generation_MD omission and zero-fill, definition differences, embedded generation counted twice, calibration, and the gap between RTD model load and metered generation. The plant list is the [sources 3.5 coverage table](sources.md#35-generation_md) (issue #99 / PR #101). See [ADR-0018](adr/0018-energy-balance.md).

**Episode score.** A number from 0 to 1 for one episode. It adds four stored components: severity, duration, breadth and rarity. Rarity is how seldom a day with the same observation types and islands occurred in the last 90 days. See [ADR-0024](adr/0024-episode-ranking.md).

**`event_start_utc` and `event_end_utc`.** The UTC start (included) and end (excluded) of a trading period or dispatch interval. They are unambiguous across the daylight saving change. See [ADR-0003](adr/0003-time-column-naming.md).

**Evidence package.** One JSON file for one episode ([ADR-0021](adr/0021-episodes.md)): the episode, its observations, series of prices, reserves, generation, HVDC and load around it, reference data, the completeness of every input, a list of claims and links to the data. The builder writes no prose. It writes `<gold>/evidence/<date>/<episode_id>.json` on demand. See [ADR-0025](adr/0025-evidence-packages.md).

**Gold.** Derived and presentation data: analytical tables and the site JSON. Tables are Parquet partitions at `gold/<table>/trading_date=YYYY-MM-DD/data.parquet`. The site JSON is described in [ADR-0014](adr/0014-site-json-contract.md). See [ADR-0001](adr/0001-typescript-monorepo-and-data-layers.md) and [ADR-0011](adr/0011-gold-table-pattern.md).

**`analysis_version`.** An integer in every gold row. Each gold module has a constant of this name, and a person bumps it when the logic changes. The runner then rebuilds the gold tables. See [ADR-0011](adr/0011-gold-table-pattern.md).

**`inputs_complete`.** A boolean in every gold row. Gold flags incomplete rows and does not drop them. It is true only when every input of the gold table has the `_completeness` status `complete` for the date, and the row-level data rule holds ([ADR-0011](adr/0011-gold-table-pattern.md)). The data rule for generation is rows in every expected trading period. For gold prices and reserves it is at least one silver row for the node, or the class and island, in the period ([ADR-0012](adr/0012-gold-prices.md), [ADR-0013](adr/0013-gold-reserve-prices.md)). Gold is not a row in `silver/_completeness` ([ADR-0010](adr/0010-completeness.md)). For an observation table, the flag is the subject-day of the gold input: a node in `price_periods` for the price anomaly detector, a pair in `price_spreads` for the price separation detector ([ADR-0019](adr/0019-observations-and-price-anomaly-detector.md)).

**`inputs_sha256`.** A column in every entity table and every gold table. It is a hash of the version of each silver input that built the table (and, in gold, the `analysis_version`). The runner rebuilds a date when it changes. See [ADR-0008](adr/0008-entity-model.md) and [ADR-0011](adr/0011-gold-table-pattern.md).

**Manifest.** The append-only file `manifest.jsonl`. It records every download with its hash and the trading dates it covers. See [ADR-0004](adr/0004-bronze-archive-and-manifest.md).

**Observation.** A fact that a detector found on one trading date, such as a run of high prices at a node. Each detector writes one gold table, `observations_<detector>`, with the same columns. See [ADR-0019](adr/0019-observations-and-price-anomaly-detector.md).

**Partition.** One file of a silver table for one date, at `silver/<dataset>/trading_date=YYYY-MM-DD/data.parquet`. See [ADR-0001](adr/0001-typescript-monorepo-and-data-layers.md) and [ADR-0005](adr/0005-dataset-pattern.md).

**Peak period.** In an evidence package, the trading period inside the episode with the highest period price at a reference node. Claims about a series are made for the first period of the episode and for the peak period. See [ADR-0025](adr/0025-evidence-packages.md).

**Period axis.** The 46, 48 or 50 trading periods of a day. Every array in a site day file has one entry for each period of this axis, so a DST day has its own length. See [ADR-0014](adr/0014-site-json-contract.md).

**Section state.** The state of a section of a site day file: `complete`, `incomplete` or `missing`. A section is `incomplete` when an input is not complete, and `missing` when gold has no partition for it. The words are not the silver status words of [ADR-0010](adr/0010-completeness.md). See [ADR-0014](adr/0014-site-json-contract.md).

**Silver.** Typed, validated Parquet with UTC timestamps and the source IDs kept, partitioned by date. See [ADR-0001](adr/0001-typescript-monorepo-and-data-layers.md).

**Site JSON.** The daily file `gold/site/days/YYYY-MM-DD.json` and the index `gold/site/index.json`. The site reads them and never queries the lake. See [ADR-0014](adr/0014-site-json-contract.md).

**Snapshot.** A dated copy of a mapping table, such as one NSP file. Mapping datasets have one silver partition for each snapshot date. See [ADR-0006](adr/0006-mapping-datasets-snapshots.md).

**Unmapped report.** The `entity_unmapped` table. It lists identifiers in dispatch prices, nodal prices and Generation_MD that do not resolve to an entity. It lists them and does not drop them. See [ADR-0008](adr/0008-entity-model.md).

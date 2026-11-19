Gridwatch NZ

Project handoff and working brief

Status: Concept and initial technical direction established
Working name: Gridwatch NZ
Project type: Independent New Zealand electricity-market observatory
Primary objective: Make the operation of New Zealand’s electricity market understandable through data-driven explanations of what is happening, why it is happening, and what it means.

⸻

1. Project vision

Gridwatch NZ is an independent observatory for the New Zealand electricity market.

The goal is not to build another electricity dashboard or replicate the Electricity Authority’s existing reporting. Instead, the project should turn publicly available market data into useful explanations for people who are interested in how the electricity system works.

It should help answer questions such as:

* What is happening in the electricity market?
* Why are wholesale prices unusually high or low?
* Why do prices differ between regions?
* Which generators are setting prices?
* Is the system experiencing a supply constraint?
* What happens when a major generator goes offline?
* How much does it cost to maintain system security?
* Who benefits from particular market conditions?
* Are there emerging patterns that might be worth paying attention to?

The intended audience is an interested, technically curious member of the public rather than necessarily an electricity-market specialist.

The project should be independent and evidence-led. It should explain market behaviour without assuming that high prices, low prices, or particular commercial outcomes are inherently good or bad.

1.1 Inspiration

The project follows a similar philosophy to existing independent data projects:

* wellington-water-map.joshmcarthur.com
* metlake.joshmcarthur.com

Metlake is particularly relevant as an architectural reference: a data ingestion pipeline, an analytical dataset stored in Parquet, and a public-facing site that makes the resulting information accessible.

Gridwatch should adopt a similar approach, with an emphasis on historical analysis and explanation rather than real-time operational monitoring.

⸻

2. Product direction

The strongest initial product opportunity is a market event explainer.

Rather than simply showing charts of prices and generation, Gridwatch should identify interesting events and explain them.

For example:

Wholesale electricity prices rose sharply in the lower North Island yesterday afternoon. Generation from a particular source declined, reserve prices increased, and prices separated between parts of the country. Here’s what the data tells us about what happened.

The explanation should link directly to the underlying evidence.

This is the central product distinction:

A conventional dashboard tells you what the numbers are. Gridwatch should help explain why they look that way.

2.1 Initial opportunity areas

Six areas have been identified as potentially valuable.

Area	Description	Initial priority
Market event explanations	Detect and explain unusual wholesale market behaviour	Very high
Hydro scarcity	Understand storage, inflows, water values and their relationship with prices	High
Generator offers and dispatch	Understand which generators are dispatched and how prices are formed	High
Ancillary services	Explain reserves, frequency keeping and the cost of system security	Medium
Wholesale vs consumer experience	Explore how wholesale market behaviour relates to consumer electricity costs	Medium
Distributed energy and flexibility	Explore solar, batteries, EVs and demand response	Later

The initial product should concentrate on the first three, with the ability to incorporate the others as the data and analytical model mature.

⸻

3. Data strategy

A key decision is to avoid ingesting the entire Electricity Authority dataset catalogue at the outset.

Instead, establish a small, useful foundation and add datasets when they help answer a specific analytical question.

The primary source is the Electricity Authority’s EMI (Electricity Market Information) platform.

Dataset catalogue:
https://www.emi.ea.govt.nz/Wholesale/Datasets

3.1 Initial datasets

The following datasets form the proposed initial ingestion scope.

Dataset	Purpose	Priority
Dispatch Energy Prices	Wholesale prices at grid connection points	Essential
Nodal Prices and Volumes	Nodal prices, generation and load information	Essential
Dispatch Reserve Prices	Frequency and instantaneous reserve prices	High
Cleared Offers	Cleared generation and reserve quantities	High
Generation_MD	Historical metered generation by plant	High
Mappings and Geospatial	Map source identifiers to physical locations and entities	Essential

Useful starting points:

* Dispatch Energy Prices: https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/DispatchEnergyPrices
* Nodal Prices and Volumes: https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/NodalPricesAndVolumes
* Dispatch Reserve Prices: https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/DispatchReservePrices
* Cleared Offers: https://www.emi.ea.govt.nz/Wholesale/Datasets/DispatchAndPricing/ClearedOffers
* Generation_MD: https://www.emi.ea.govt.nz/Wholesale/Datasets/Generation/Generation_MD
* Mappings and Geospatial: https://www.emi.ea.govt.nz/Wholesale/Datasets/MappingsAndGeospatial

Dataset coverage, schemas, access methods and update frequencies should be verified before implementing the connectors. The above is the proposed scope, not a guarantee that every dataset has a uniform format or cadence.

3.2 Suggested historical coverage

A practical starting point:

* Backfill operational dispatch datasets from approximately November 2022.
* Backfill Generation_MD as far back as practical.
* Retrieve the relevant reference and mapping datasets.
* Continue incremental ingestion as new data becomes available.

The exact start date should be adjusted based on data availability and the cost of historical ingestion.

3.3 Datasets to defer

These may become valuable, but are not necessary to establish the initial product:

* SPD case files.
* Full generator offer stacks.
* Transmission constraints.
* Generator outage information.
* Hydro storage and expected water values.
* Hydro inflows.
* Forecast prices.
* More detailed metering datasets.
* Frequency keeping and other ancillary service datasets.

SPD case files are particularly interesting as a future enrichment. They contain information about the dispatch process and can help explain constraints and market outcomes.

However, processing every dispatch case in depth from day one would add unnecessary complexity. A better approach is to identify interesting periods first, then selectively investigate the relevant SPD cases.

⸻

4. Data architecture

The proposed architecture is deliberately simple and batch-oriented.

The site does not need to operate as a real-time market monitoring system. Most of the initial data sources are published on a schedule, making a daily build a sensible starting point.

4.1 Proposed pipeline

Electricity Authority sources
          |
          v
    Source connectors
          |
          v
   Raw source archive
          |
          v
 Normalisation and validation
          |
          v
   Canonical Parquet datasets
          |
          v
    DuckDB / Python
          |
          v
  Analytics and event detection
          |
          v
 Structured event evidence
          |
          v
 Narrative generation
          |
          v
   JSON presentation data
          |
          v
       Astro build
          |
          v
    Static website / CDN

4.2 Data layers

Raw archive

Preserve original source files.

For each downloaded file, retain:

* Original file.
* Source dataset identifier.
* Source publication or update timestamp, if available.
* Retrieval timestamp.
* Checksum.
* Relevant source metadata.

This provides reproducibility and allows reprocessing when normalisation logic changes.

Canonical datasets

Normalise the source data into consistent Parquet datasets.

Important considerations:

* Preserve original source identifiers.
* Maintain a canonical entity mapping.
* Use UTC timestamps internally.
* Preserve original trading dates and trading-period identifiers.
* Handle New Zealand daylight saving carefully.
* Retain source provenance.
* Do not force every dataset into the same time resolution.

Dispatch data, metered generation and hydro information may all have different temporal resolutions. The analytical model should preserve those distinctions.

Derived datasets

Create reusable analytical datasets, for example:

* National generation by fuel type.
* Generation by plant.
* Regional wholesale prices.
* Nodal price spreads.
* Inter-island electricity transfers.
* Reserve price trends.
* Generation changes.
* Price anomaly indicators.

These should be reproducible from the canonical data.

Presentation data

Generate JSON artefacts for the website.

The Astro site should consume prepared data rather than querying the entire analytical lake itself.

This keeps the public site simple and allows the analytical pipeline to evolve independently.

⸻

5. Entity and time modelling

A consistent entity model will become increasingly important as additional datasets are incorporated.

Potential entities include:

* Generators.
* Generation plants.
* Generating units.
* Market participants.
* Grid connection points.
* Grid exit points.
* Points of connection.
* Islands.
* Trading periods.
* Transmission constraints.

The same physical generator or location may appear differently across datasets. A canonical mapping layer should reconcile these identifiers while retaining the original source IDs.

5.1 Time handling

New Zealand’s daylight saving transitions require particular care.

The system should distinguish:

1. Event time — when something happened in the market.
2. Source publication time — when the data became available.
3. Ingestion time — when Gridwatch downloaded it.
4. Analysis time — when Gridwatch processed it.

Internally, timestamps should be unambiguous. Original trading dates and periods should also be retained for traceability.

5.2 Data freshness

A daily publication does not mean every underlying dataset represents the previous day.

Each dataset should have its own completeness and freshness information.

The site should clearly communicate the latest available data, rather than implying that all information is current to the same point in time.

⸻

6. Event detection and analysis

The event detection system is potentially the most important analytical component.

It should not simply identify price spikes. It should identify unusual or interesting behaviour across several dimensions.

The proposed model has three levels.

6.1 Observations

An observation is a discrete fact detected in the data.

Examples:

* A nodal price exceeds its historical 99th percentile.
* Prices between two regions diverge significantly.
* A generator’s output drops sharply.
* Reserve prices increase substantially.
* Demand deviates from expectations.
* A particular fuel type becomes unusually dominant.

Observations should be deterministic and reproducible.

6.2 Episodes

An episode groups related observations.

For example:

* A generator output decline.
* A simultaneous increase in reserve prices.
* A regional price separation.
* A change in dispatch patterns.

These may all be manifestations of one underlying market episode.

Grouping should consider:

* Temporal proximity.
* Geographic proximity.
* Shared generators or connection points.
* Related market conditions.
* Duration and severity.
* Common underlying constraints.

There should not be one universal time window. A dispatch incident may last minutes, while hydro scarcity can develop over weeks or months.

6.3 Events

An event is an episode considered significant enough to explain publicly.

Not every anomaly needs to become a published event.

A separate editorial or analytical layer should decide which episodes are worth investigating.

This distinction matters: event detection should find interesting things, not decide what is newsworthy.

6.4 Initial detectors

Start with straightforward, explainable detectors:

Detector	What it identifies
Price anomaly	Unusually high or low wholesale prices
Nodal price separation	Significant regional price differences
Generation change	Unexpected output changes at a plant or fuel level
Reserve anomaly	Unusual reserve prices
Demand deviation	Unexpected changes in demand
Hydro anomaly	Unusual storage or water-value conditions, once data is added
Transmission constraint	Persistent regional separation or identified constraints, once data is added

Use historical percentiles, absolute thresholds and duration-based measures initially.

Machine learning is not required to establish the first version.

⸻

7. Turning data into explanations

The narrative layer should be built on structured evidence, not free-form interpretation of raw data.

The recommended approach is:

1. Detect observations using deterministic code.
2. Group related observations into episodes.
3. Retrieve relevant market context and reference information.
4. Assemble a structured evidence package.
5. Use an LLM to turn that evidence into readable prose.
6. Validate numerical claims and links against the source evidence.

The LLM should help communicate the analysis, not independently invent the analysis.

7.1 Event explanation structure

Each published event should answer three questions.

What happened?

Describe observable facts.

For example:

* Wholesale prices increased.
* Generation from a particular plant declined.
* Reserve prices increased.
* Prices separated between regions.

Why did it happen?

Explain the likely mechanism.

For example:

* Reduced generation required replacement supply.
* A transmission constraint limited the ability to move electricity between regions.
* More expensive generation became marginal.

The explanation must distinguish what is established from what is inferred.

What does it mean?

Explain the wider significance.

For example:

* The event illustrates the importance of transmission capacity.
* The system was more exposed to a particular generation source.
* The event demonstrates how regional prices can diverge.

7.2 Confidence levels

Explanations should communicate how strong the evidence is.

Level	Meaning
Confirmed	Direct official market data or notice establishes the fact
Strong evidence	Multiple observations support the interpretation
Possible explanation	The interpretation is consistent with the data but not independently established

Avoid presenting correlation as causation.

Every important factual claim should be traceable to underlying data or a published source.

⸻

8. Visualisation concepts

Visualisations should help explain the electricity system, rather than simply decorate a dashboard.

8.1 National electricity Sankey

A Sankey diagram showing generation and electricity flows is a promising signature visualisation.

A possible structure:

Generation by fuel
        |
        v
    Island / region
        |
        v
 Inter-island transfer
        |
        v
 Regional consumption

Potential generation categories:

* Hydro.
* Geothermal.
* Wind.
* Gas.
* Coal.
* Solar.
* Other.

Potential destinations:

* North Island.
* South Island.
* Consumption.
* Losses or other balance terms, where reliable data permits.

Important physical interpretation

The New Zealand electricity network is a meshed electrical network.

It is not possible to trace individual electrons from a particular generator to a particular household in the way a conventional Sankey might imply.

The visualisation should therefore represent physical flows and regional energy balances, not pretend to show contractual or individual generator-to-consumer relationships.

Generation, injections, inter-island transfers, consumption and losses are distinct quantities.

The data must be checked carefully before attempting to balance the diagram. Any unexplained difference should be represented transparently rather than artificially adjusted away.

Interaction

Potential features:

* Select a date or date range.
* Compare different days.
* Hover for MW, MWh and percentage values.
* Click a fuel type to explore individual plants.
* Compare seasonal generation mixes.
* Compare high-price and low-price days.

Use consistent units: instantaneous MW for snapshots and MWh for energy over a period.

8.2 Generation mix over time

A stacked area chart could show how generation sources change throughout the day.

This would help explain:

* Daily demand patterns.
* Hydro and thermal generation changes.
* Wind variability.
* Solar contributions.
* How generation responds to market conditions.

8.3 Wholesale price maps

A map of New Zealand showing nodal prices could make regional differences immediately understandable.

Potential features:

* Select a trading period.
* Show price at each node.
* Highlight large price differences.
* Animate changes through a day.
* Compare two time periods.

8.4 Other useful visualisations

* Reserve prices over time.
* Plant-level generation trends.
* Hydro storage trends.
* Price duration curves.
* Regional price spreads.
* Historical event timelines.
* Generation and demand comparisons.

Visualisations should be introduced when they help answer a question, rather than creating charts simply because data is available.

⸻

9. Website and publication model

The proposed frontend is Astro, with a static daily publication model.

This fits the initial data sources and avoids unnecessary infrastructure.

9.1 Daily issues

Each historical day should be a first-class page.

Example:

/2026/11/19/

A daily issue could include:

1. A short editorial summary.
2. National generation and consumption Sankey.
3. Generation mix throughout the day.
4. Wholesale prices and regional differences.
5. Interesting events detected and explained.
6. Relevant market conditions, such as hydro storage and reserves.

This creates a browsable historical record of how the market behaved.

9.2 Homepage

The homepage should answer:

* What is happening in the market?
* What is the latest available data?
* Has anything interesting happened recently?
* What should I understand about current market conditions?

Possible sections:

Latest market update

A short, plain-English summary of the most recent complete data.

Market conditions

Separate indicators for:

* Wholesale prices.
* Supply and generation.
* Hydro conditions.
* Reserves and system security.
* Regional price differences.

Avoid a single green/amber/red market-health score.

High prices do not necessarily mean the system is insecure, and a system can experience security concerns without particularly high prices.

Recent events

A feed of interesting detected and explained events.

Understanding the market

Educational material linked to actual market behaviour.

9.3 Static does not mean non-interactive

The site can be statically generated while still supporting rich browser-based visualisations.

The browser can load JSON data for historical days and render interactive charts.

There is no need for a backend API in the initial version.

⸻

10. Educational content

A reusable library of explainers should develop alongside the event analysis.

Potential subjects:

* How nodal pricing works.
* What makes a generator marginal?
* What is hydro scarcity?
* How do transmission constraints affect prices?
* What are instantaneous reserves?
* What is frequency keeping?
* How does the HVDC link work?
* Why does wind generation affect market prices?
* What is the relationship between wholesale and retail electricity prices?

Each concept should ideally have:

1. A simple explanation.
2. A more technical explanation.
3. A visual explanation.
4. A historical example.
5. Links to relevant Gridwatch data and events.

The strongest approach is to connect educational material to real events rather than build a disconnected textbook.

⸻

11. Proposed technology

The current preferred technology choices are:

Component	Proposed technology
Ingestion	Python
Raw archive	Object storage
Analytical storage	Parquet
Query engine	DuckDB
Analytics	Python
Event detection	Python / deterministic rules
Narrative generation	LLM using structured evidence
Presentation data	JSON
Frontend	Astro
Visualisations	D3, Observable Plot or ECharts
Hosting	Static hosting / CDN
Scheduling	Scheduled batch pipeline

The architecture should avoid unnecessary services.

In particular, there is no immediate need for:

* A continuously running application server.
* A relational database.
* A message broker.
* Redis.
* A complex streaming architecture.
* Real-time event processing.

A PostgreSQL database may become useful if the project later needs editable event records, user accounts, workflows or other mutable application state.

⸻

12. Important engineering considerations

Data corrections

Published datasets may be revised.

Ingestion should be capable of detecting changed source files and reprocessing affected partitions.

Checksums and source manifests will help.

Provenance

Every derived metric and published event should be traceable to its source datasets.

Multiple time resolutions

Do not assume all market data is half-hourly.

Dispatch, metering, generation and hydro datasets may have different resolutions.

Data completeness

A missing dataset should not silently produce misleading charts or explanations.

Each daily issue should know which source datasets were available and complete.

Reproducibility

The same source data and analytical version should produce the same observations and metrics.

Narrative text may vary, but its underlying facts should not.

Historical comparability

Price anomalies should be evaluated in historical context.

An absolute threshold alone may be misleading because the market’s normal operating conditions change over time.

⸻

13. Suggested development sequence

The project should be developed incrementally.

Phase 1 — Data foundation

* Verify source access and dataset schemas.
* Implement the initial source connectors.
* Archive raw source files.
* Normalise the core datasets.
* Establish the canonical entity mappings.
* Store canonical data in Parquet.
* Make the data queryable through DuckDB.

Deliverable: A reproducible local or scheduled data lake containing the initial datasets.

Phase 2 — First analytical outputs

Implement:

* National generation by fuel.
* Generation by plant.
* Wholesale price history.
* Nodal price differences.
* Reserve price history.
* Basic anomaly detection.

Deliverable: A collection of reproducible daily analytical outputs.

Phase 3 — First public site

Build the Astro site with:

* Homepage.
* Daily issue pages.
* Generation mix visualisation.
* Price visualisation.
* Initial Sankey.
* Historical navigation.

Deliverable: A useful public-facing electricity-market observatory, even before sophisticated event explanations exist.

Phase 4 — Event detection and explanations

* Implement observation detectors.
* Group observations into episodes.
* Rank interesting episodes.
* Build structured evidence packages.
* Generate explanations.
* Add source links and confidence levels.
* Introduce editorial review where appropriate.

Deliverable: The first genuinely differentiated Gridwatch feature.

Phase 5 — Enrichment

Add datasets in response to analytical gaps.

Likely candidates:

1. SPD dispatch case files.
2. Generator outages.
3. Transmission constraints.
4. Hydro storage and expected water values.
5. Hydro inflows.
6. More detailed ancillary services data.

Deliverable: Better-supported and more sophisticated explanations.

⸻

14. Initial success criteria

The first version should not be judged by how many datasets it ingests or how many charts it contains.

More useful measures are:

* Can it accurately reconstruct what happened on a particular day?
* Can it identify interesting price and generation events?
* Can it explain a regional price separation?
* Can it distinguish a price event from a system-security event?
* Can a non-specialist understand the explanation?
* Can every important factual statement be traced to published evidence?
* Can historical days be compared consistently?
* Can the pipeline run reliably without significant manual intervention?

A particularly useful milestone would be to take a known historical market event and reconstruct it from the underlying data, producing a clear explanation with supporting visualisations.

⸻

15. Open questions

These are deliberately unresolved and should be explored as the project develops.

Data access

* What is the most reliable method of accessing and incrementally downloading EMI datasets?
* Are there useful bulk-download or API mechanisms?
* How are revisions and corrections published?
* Which datasets have sufficiently reliable historical coverage?

Analytical model

* What constitutes a genuinely interesting market event?
* How should episodes be grouped?
* How should significance be measured?
* How can the system distinguish a supply problem from a transmission problem?

Explanations

* Which market events can be explained confidently using the initial datasets?
* Which require SPD cases or outage information?
* How should uncertainty be communicated?
* How much editorial review is necessary?

Presentation

* Is the daily issue the primary product, or should the homepage focus more on current market conditions?
* What is the most useful first version of the Sankey?
* How should the site balance national summaries and regional detail?

⸻

16. Immediate next steps

The recommended next steps are:

1. Verify the initial dataset sources. Confirm download methods, schemas, update schedules and historical availability.
2. Define the canonical data model. Particularly the mapping between generators, generating units, participants, grid connection points and locations.
3. Build the first ingestion pipeline. Start with dispatch prices, nodal prices and volumes, Generation_MD and reference mappings.
4. Produce a historical daily dataset. Pick a representative day and calculate generation mix, regional prices and price spreads.
5. Prototype the Sankey. Validate the underlying energy accounting before investing in the visualisation.
6. Choose a known market event. Attempt to reconstruct and explain it using the initial datasets.
7. Build the first daily issue. Keep the initial Astro site deliberately small.

The most important early technical milestone is not a website. It is a trustworthy, queryable historical dataset that can support interesting analysis.

The most important product milestone is a convincing explanation of a real market event.

⸻

17. Guiding principles

The project should be guided by the following principles:

1. Explain, don’t just display. Charts are evidence; explanations are the product.
2. Start small. Ingest only what is needed to answer useful questions.
3. Preserve provenance. Every important claim should be traceable to source data.
4. Separate fact from interpretation. Make uncertainty visible.
5. Don’t confuse price with security. They are related but distinct aspects of the market.
6. Prefer reproducible analysis. Use deterministic calculations for facts and metrics.
7. Use AI as a communicator, not an oracle. Narrative generation should be grounded in structured evidence.
8. Build a historical record. Each day’s market behaviour should remain accessible.
9. Add complexity when justified. Avoid real-time infrastructure and unnecessary services until there is a demonstrated need.
10. Make the electricity market understandable. The ultimate measure of success is whether people understand something they did not understand before.

⸻

Project summary: Gridwatch NZ is a daily, data-driven observatory of New Zealand’s electricity market. It will ingest publicly available market data, build a historical analytical lake, detect interesting market behaviour, and publish plain-English explanations supported by interactive visualisations and verifiable evidence.

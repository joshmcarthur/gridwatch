# ADR-0028: Dispatch generation when Generation_MD is absent

- Status: Accepted
- Date: 2026-11-23

## Context

Gold generation ([ADR-0011](0011-gold-table-pattern.md)) read only Generation_MD. That monthly file lags 10 days to about 6 weeks, so recent daily pages had prices and no mix. Silver already holds Nodal Prices and Volumes, CC BY 4.0, published about 07:08 NZ the next morning. Transpower live generation is not licensed for reuse. Spec: [docs/specs/2026-11-23-dispatch-generation-design.md](../specs/2026-11-23-dispatch-generation-design.md).

## Decision

Keep the four gold generation tables. Prefer silver `generation_md` when that partition exists. Otherwise build the same tables from nodal unit `generation_megawatts`.

Each gold generation row has `source`: `metered` or `dispatch`. When Generation_MD later arrives, the date rebuilds from meters and `source` flips.

Dispatch energy uses the latest RTD case per 5-minute interval, then the mean megawatts of the intervals in the trading period times 0.5 hours. That is the same case rule as gold load.

Fuel and plant come from `entity_units`. A unit with no `plant_id` stays in the fuel tables and is omitted from the plant tables.

The runner wants a date when the metered inputs exist, or when the dispatch inputs exist (`nodal_prices_and_volumes`, `entity_units`, `entity_points_of_connection`). A date with both uses the metered fingerprint.

Energy balance and the Sankey stay on metered Generation_MD and metered HVDC. They do not read dispatch generation. HVDC shares the Generation_MD month lag, so those days have no energy-balance partition.

Generation-change detectors read gold generation as the day's mix. A 28-day baseline can mix dispatch days and metered days. They do not filter to `source = metered`. Filtering would hide recent days.

## Consequences

- A finished trading day can have a generation mix the next morning.
- Dispatch megawatts are the model, not meters. Totals move when the monthly file lands. The site must label `source`.
- `ANALYSIS_VERSION` is 2. Every generation date rebuilds.
- The exporter still lists metered inputs until the site-contract slice, so a dispatch day can be gold-complete and still `incomplete` on the site until that slice.

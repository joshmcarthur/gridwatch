# Site visual sample

The site builds these files when `DATA_ROOT/gold/site/index.json` is missing. They are real EMI publishes, not the exporter lock in `publisher/src/site/fixtures/`.

| Day | Why it is here |
| --- | --- |
| 2026-09-26 | Ordinary Saturday, 48 periods |
| 2026-09-27 | DST start, 46 periods |
| 2026-10-29 | Ordinary Thursday, 48 periods |

Each day has a full fuel mix, real Otahuhu / Haywards / Benmore prices, and a complete energy-balance Sankey. `episodes` is complete with an empty list: the 28-day detector window is not in this sample.

To refresh, collect and publish those dates into a local `DATA_ROOT`, then copy only the complete day files and rewrite `index.json` to list those days. Do not run `UPDATE_SITE_FIXTURES=1`; that updates the exporter lock, not this directory.

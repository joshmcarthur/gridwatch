# site

Placeholder. The Astro site is scaffolded in a later issue. It will read `data/gold/site/` at build time.

The publisher writes one JSON file per trading day to `gold/site/days/YYYY-MM-DD.json`, and an index to `gold/site/index.json` ([ADR-0014](../docs/adr/0014-site-json-contract.md)). The site imports the types only, from `@gridwatch/publisher/site-contract`. `site/fixtures/` holds a committed sample: the day 2026-09-27 (the DST-start day, 46 periods) and its index. The generation in the sample is real Generation_MD. The reference-node prices are synthetic (OTA 80 + period, HAY 70 + period, BEN 60 + period), because no fixture has real reference-node prices on a day that also has generation. To refresh the sample after an exporter or contract change, run `UPDATE_SITE_FIXTURES=1 npm test -- export.test.ts` from the repository root, and review the diff.

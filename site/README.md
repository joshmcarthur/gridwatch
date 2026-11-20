# site

Astro static site for Gridwatch NZ. It reads prepared JSON at build time and does not query the lake ([ADR-0014](../docs/adr/0014-site-json-contract.md)).

## Build

```bash
npm run build -w site
```

The build reads `DATA_ROOT/gold/site/index.json` when that file exists. If it does not, it uses the committed sample in `site/fixtures/`. Default `DATA_ROOT` is `./data` at the repository root.

```bash
npm run dev -w site
```

## Preview with compose

Build the static files, then serve them with nginx:

```bash
npm run build -w site
docker compose up site
```

The site is at http://localhost:8080. The compose service mounts `site/dist`. It does not run Astro.

## Data contract

The publisher writes one JSON file per trading day to `gold/site/days/YYYY-MM-DD.json`, and an index to `gold/site/index.json`. The site imports types only, from `@gridwatch/publisher/site-contract`. `site/fixtures/` holds a committed sample: the day 2026-09-27 (the DST-start day, 46 periods) and its index. The generation in the sample is real Generation_MD. The reference-node prices are synthetic (OTA 80 + period, HAY 70 + period, BEN 60 + period), because no fixture has real reference-node prices on a day that also has generation. To refresh the sample after an exporter or contract change, run `UPDATE_SITE_FIXTURES=1 npm test -- export.test.ts` from the repository root, and review the diff.

## Design

Layout, type and colour follow the Landscape HTML archives (local `design/` zip files, not in git). Tokens live in `src/styles/tokens.css`. Charts reuse those tokens. The chart library is Observable Plot ([ADR-0015](../docs/adr/0015-chart-library.md)). The Plot package is not a dependency until a chart issue adds it.

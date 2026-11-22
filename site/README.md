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

## Publish with compose

```bash
docker compose run --rm site-build
docker compose up -d site
```

`site-build` runs `site/publish.ts`. It builds the site into the inactive slot (`site-out/releases/a` or `site-out/releases/b`), checks that `index.html` exists, then points the `site-out/current` symlink at that slot with an atomic rename. The first run uses `a`. The next run writes the other slot and swaps; the previous slot stays until the run after that overwrites it. Before spawning Astro, the job fails if `DATA_ROOT/gold/site/index.json` is missing (default `DATA_ROOT` is `/data`). The Astro child also sets `SITE_REQUIRE_GOLD=1`, so it does not fall back to fixtures. If the build fails, `current` keeps the old slot.

The `site` service serves `site-out/current` with nginx at http://localhost:8080. It serves nothing until `site-build` has run once.

## Data contract

The publisher writes one JSON file per trading day to `gold/site/days/YYYY-MM-DD.json`, and an index to `gold/site/index.json`. The site imports types only, from `@gridwatch/publisher/site-contract`. `site/fixtures/` holds a committed sample: the day 2026-09-27 (the DST-start day, 46 periods) and its index. The generation in the sample is real Generation_MD. The reference-node prices are synthetic (OTA 80 + period, HAY 70 + period, BEN 60 + period), because no fixture has real reference-node prices on a day that also has generation. The sample has no HVDC_Flows file, so `sankey` is `missing` (the month lag). It has no Dispatch Reserve Prices file, so `reserves` is `missing`. To refresh the sample after an exporter or contract change, run `UPDATE_SITE_FIXTURES=1 npm test -- export.test.ts` from the repository root, and review the diff.

## Design

Layout, type and colour follow the Landscape HTML archives (local `design/` zip files, not in git). Tokens live in `src/styles/tokens.css`. Charts reuse those tokens. The chart library is Observable Plot ([ADR-0015](../docs/adr/0015-chart-library.md)). Charts render to static SVG at build time, with no client JavaScript ([ADR-0017](../docs/adr/0017-static-svg-charts.md)).

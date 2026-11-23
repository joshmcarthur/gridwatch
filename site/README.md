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

In the compose stack, the `updater` service builds the site, and the `site` service serves it. See the root README. To build by hand, stop the `updater` first, then run the `site-build` job:

```bash
docker compose stop updater
docker compose --profile jobs run --rm site-build
docker compose start updater
```

`site-build` runs `site/publish.ts`. It builds the site into the inactive slot (`site-out/releases/a` or `site-out/releases/b`), checks that `index.html` exists, then points the `site-out/current` symlink at that slot with an atomic rename. The first run uses `a`. The next run writes the other slot and swaps; the previous slot stays until the run after that overwrites it. Before spawning Astro, the job fails if `DATA_ROOT/gold/site/index.json` is missing (default `DATA_ROOT` is `/data`). The Astro child also sets `SITE_REQUIRE_GOLD=1`, so it does not fall back to fixtures. If the build fails, `current` keeps the old slot.

The `site` service serves `site-out/current` with Caddy at http://localhost:8080 (`GRIDWATCH_PORT` changes the port). Until the first build, the `updater` puts a "pages are on their way" page there.

## Data contract

The publisher writes one JSON file per trading day to `gold/site/days/YYYY-MM-DD.json`, and an index to `gold/site/index.json`. The site imports types only, from `@gridwatch/publisher/site-contract`. `site/fixtures/` holds three complete sample days so a checkout without gold still shows a real mix, real reference-node prices, and the energy-balance Sankey: 2026-09-26 (ordinary Saturday), 2026-09-27 (DST start, 46 periods), and 2026-10-29 (ordinary Thursday). See `site/fixtures/README.md`. The exporter's trimmed-silver lock lives separately in `publisher/src/site/fixtures/`; refresh that with `UPDATE_SITE_FIXTURES=1 npm test -- export.test.ts` from the repository root.

## Design

Layout, type and colour follow the Landscape HTML archives (local `design/` zip files, not in git). Tokens live in `src/styles/tokens.css`. Charts reuse those tokens. The chart library is Observable Plot ([ADR-0015](../docs/adr/0015-chart-library.md)). Charts render to static SVG at build time ([ADR-0017](../docs/adr/0017-static-svg-charts.md)). Mix compare on the daily page is a small island: it fetches another day's build-time mix SVG. Plot still runs at build time.

# ADR-0001: TypeScript monorepo, day-based processing and medallion data layers

- Status: Accepted
- Date: 2026-11-20

## Context

The [project brief](../brief.md) (sections 4.1 and 11) proposes Python. The owner made further decisions after the brief. This ADR records them in one place. Later issues point here.

## Decision

### Language

TypeScript everywhere. No Python. One toolchain. DuckDB does the data work through the official Node client, `@duckdb/node-api`. SQL is the analytics language. TypeScript orchestrates. This replaces the Python proposal in the brief.

### Day-based processing

The unit of collection and processing is the NZ trading day. There is no intraday capture and no time-bucket merging.

### Four boundaries

| Path          | Role                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `collector/`  | Downloads source files unchanged into `data/bronze/` and records a manifest                      |
| `publisher/`  | Reads bronze. Writes `data/silver/` (normalised) and `data/gold/` (derived tables and site JSON) |
| `data/`       | The data. Gitignored                                                                             |
| `site/`       | Astro site. Reads `data/gold/site/` at build time                                                |
| `compose.yml` | Runs `collector` and `publisher` as one-shot jobs. A later issue adds the `site` service         |

### Medallion data layers

| Layer          | Brief term (section 4.2)      | Contents                                                                               | Written by |
| -------------- | ----------------------------- | -------------------------------------------------------------------------------------- | ---------- |
| `data/bronze/` | Raw archive                   | Source files exactly as published, plus manifest                                       | collector  |
| `data/silver/` | Canonical datasets            | Typed, validated Parquet. UTC timestamps. Source IDs kept. Partitioned by trading date | publisher  |
| `data/gold/`   | Derived and presentation data | Analytical Parquet tables. Site JSON under `gold/site/`                                | publisher  |

All code resolves these directories from the `DATA_ROOT` environment variable (default `./data`).

### Code layout

- `collector/src/electricity-authority/<dataset>.ts`
- `publisher/src/silver/<dataset>.ts`
- `publisher/src/gold/...`

A dataset uses the same ID in the collector and the publisher.

### Test runner and lint

- Vitest is the test runner. It runs TypeScript with no extra build step. It runs from the repository root over all workspaces.
- Biome is the one lint and format tool. It needs one config file and one dependency. It replaces ESLint plus Prettier.
- TypeScript checks types only (`noEmit`). Node 26 runs `.ts` files directly in the compose services, so the repository has no build step.

## Consequences

- One language and one package manager across the project.
- `collector` and `publisher` each hold a small `data-root.ts`. We accepted this duplication to avoid a shared package. Revisit it if shared code grows.
- `@duckdb/node-api` ships native binaries. The Docker image must match the platforms that run it.
- Node LTS is pinned in `.nvmrc` and `engines`.

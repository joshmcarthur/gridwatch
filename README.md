# Gridwatch NZ

An independent observatory for the New Zealand electricity market. Gridwatch turns public market data into plain-English explanations of what happened, why, and what it means. See the [project brief](docs/brief.md).

The repository is a TypeScript monorepo. To add a dataset, follow [ADR-0005](docs/adr/0005-dataset-pattern.md). See [ADR-0001](docs/adr/0001-typescript-monorepo-and-data-layers.md) for the decisions behind the layout. New to the market or the data terms? Read the [glossary](docs/glossary.md).

## Layout

| Path          | Role                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `collector/`  | Downloads source files unchanged into `data/bronze/` and records a manifest                      |
| `publisher/`  | Reads bronze. Writes `data/silver/` (normalised) and `data/gold/` (derived tables and site JSON) |
| `data/`       | The data. Gitignored. [`data/README.md`](data/README.md) explains the layers                     |
| `site/`       | Astro site (placeholder). Reads `data/gold/site/` at build time                                  |
| `compose.yml` | Runs `collector` and `publisher` as one-shot jobs                                                |

Processing is per NZ trading day. Dataset code lives in `collector/src/electricity-authority/<dataset>.ts`, `publisher/src/silver/<dataset>.ts` and `publisher/src/gold/`.

### Data layers

| Layer          | Brief term (section 4.2)    | Contents                                                                               | Written by |
| -------------- | --------------------------- | -------------------------------------------------------------------------------------- | ---------- |
| `data/bronze/` | Raw archive                 | Source files exactly as published, plus manifest                                       | collector  |
| `data/silver/` | Canonical datasets          | Typed, validated Parquet, UTC timestamps, source IDs kept, partitioned by trading date | publisher  |
| `data/gold/`   | Derived + presentation data | Analytical Parquet tables, and site JSON under `gold/site/`                            | publisher  |

Set the `DATA_ROOT` environment variable to move the data directory. The default is `./data`.

## Develop

Use the Node version in `.nvmrc`.

```bash
npm ci
npm run lint        # Biome
npm run typecheck   # tsc, all workspaces
npm test            # Vitest
```

## Run

Two one-shot jobs bring `data/` up to date. Run the collector, then the publisher. The daily cron job does the same ([ADR-0002](docs/adr/0002-daily-run-data-and-site-hosting.md)).

```bash
docker compose run --rm collector && docker compose run --rm publisher
```

- **First run.** Each dataset backfills the last 12 months, computed from the run date. This is about 7 GB and about 1.2 hours ([`docs/sources.md`](docs/sources.md) section 4). Make sure the disk has room. `docker compose up` runs the same jobs.
- **Later runs.** The collector fetches the trailing 5 days, and any date or month of the 12-month window that it does not hold (a failed day, or a gap). Generation_MD months are checked again for the last 3 months. The publisher publishes the days that are new or whose bronze file changed. A run with nothing new changes nothing.
- **A range.** `--from YYYY-MM-DD --to YYYY-MM-DD` replaces the default range. `--dataset <id>` limits the run (repeat it for more). The publisher also takes `--force` to publish up-to-date days again. Older data is never deleted.
- **Failures.** One failing dataset does not stop the others. The summary names it and the exit code is 1.

```bash
docker compose run --rm collector --from 2025-01-01 --to 2025-03-31 --dataset dispatch_energy_prices
docker compose run --rm publisher --from 2025-01-01 --to 2025-03-31 --dataset dispatch_energy_prices
docker compose run --rm collector --help
```

The rules for each kind of dataset are in [ADR-0009](docs/adr/0009-runner-default-mode.md).

Architecture decisions are in [`docs/adr/`](docs/adr/). Copy `0000-template.md` for a new one.

## How work is tracked

GitHub issues in this repository are the work. The [Gridwatch Delivery Board](https://github.com/users/joshmcarthur/projects/5) shows their order and progress.

- **The issue is the spec.** Read the issue body and all comments before you start. When a later comment from the owner differs from the body, the comment wins.
- **Phases are parent issues.** Each phase is a parent issue with sub-issues.
- **Dependencies are "blocked by" links.** An issue is ready when every issue that blocks it is closed.
- **Priority is the board's `Priority` field**: `Now`, `Next` or `Later`. Labels do not set priority. The owner changes priority by moving cards on the board's **Steer** view.
- **Pick the next issue like this:** take an open, unassigned, ready issue with no sub-issues. Choose the highest `Priority`. If two issues have the same priority, choose the lower issue number.
- **Keep `Status` current:**

  | Status | When |
  |---|---|
  | Backlog | Not started |
  | In progress | You took the issue. Also comment on the issue to say so |
  | In review | A pull request is open. Link it from the issue |
  | Done | The issue is closed. The board sets this automatically |

- **`spike` issues** are research or decisions. The output is a document or an ADR, and the work usually ends with a question to the owner on the issue.
- **The owner merges pull requests.** Use `Closes #N` only when the pull request completes the issue. Otherwise use `Refs #N`.

To read or change board fields from the command line, `gh` needs the `project` scope (`gh auth refresh -s project`):

```bash
gh project item-list 5 --owner joshmcarthur --format json
```

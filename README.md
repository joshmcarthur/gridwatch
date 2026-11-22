# Gridwatch NZ

An independent observatory for the New Zealand electricity market. Gridwatch turns public market data into plain-English explanations of what happened, why, and what it means. See the [project brief](docs/brief.md).

The repository is a TypeScript monorepo. To add a dataset, follow [ADR-0005](docs/adr/0005-dataset-pattern.md). To add a gold table, follow [ADR-0011](docs/adr/0011-gold-table-pattern.md). See [ADR-0001](docs/adr/0001-typescript-monorepo-and-data-layers.md) for the decisions behind the layout. New to the market or the data terms? Read the [glossary](docs/glossary.md).

## Layout

| Path          | Role                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `collector/`  | Downloads source files unchanged into `data/bronze/` and records a manifest                      |
| `publisher/`  | Reads bronze. Writes `data/silver/` (normalised) and `data/gold/` (derived tables and site JSON) |
| `data/`       | The data. Gitignored. [`data/README.md`](data/README.md) explains the layers                     |
| `site/`       | Astro site. Reads `data/gold/site/` at build time. `site/publish.ts` builds it into `site-out/`  |
| `updater/`    | Long-running loop. Runs collect, publish and the site build in cycles, newest days first         |
| `compose.yml` | Runs `updater` and a Caddy `site`. The one-shot jobs are on the `jobs` profile                   |

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

## Run it yourself

You need Docker with Compose. You do not need a checkout of this repository. The stack pulls a prebuilt image from [GitHub Container Registry](#container-images).

```bash
mkdir gridwatch && cd gridwatch
curl -fsSLO https://raw.githubusercontent.com/joshmcarthur/gridwatch/main/compose.yml
docker compose up -d
```

Open <http://localhost:8080>. Any tool that takes a `compose.yml` can run the same file.

The stack has two services:

- **`updater`** fetches the data, builds the site and keeps it current. It needs no cron job.
- **`site`** is [Caddy](https://caddy.community/). It serves the last good build, so the site stays up while a new build runs.

The site is ready in stages. The first page you see says the pages are on their way. After about 5 minutes the site shows the latest 7 days. The updater then fills in older days, 30 days at a time, back to 12 months. A test run took about 12 minutes for each 30-day step, so the full fill takes about 2.5 hours. It needs about 7 GB of disk ([`docs/sources.md`](docs/sources.md) section 4). After that, it checks for new data every 6 hours and rebuilds the site only when something changed. If you stop or restart it, it carries on from the data it already holds.

### Settings

Set these in your shell, or in a `.env` file next to `compose.yml`.

| Variable              | Default          | Meaning                                                                |
| --------------------- | ---------------- | ---------------------------------------------------------------------- |
| `GRIDWATCH_PORT`      | `8080`           | The port the site listens on                                           |
| `GRIDWATCH_IMAGE_TAG` | `latest`         | The image to run. Use `sha-<7-char>` to pin a commit                   |
| `GRIDWATCH_DATA`      | a Docker volume  | Where the data lives. A path such as `./data` uses a folder on the host |
| `GRIDWATCH_SITE_OUT`  | a Docker volume  | Where the built site lives. Same rule as `GRIDWATCH_DATA`              |

Prefer the default volumes. If you use host folders, create them first and give them to uid 1000, because the containers run as `node` (uid 1000). Docker would otherwise create them owned by root, and the updater could not write to them. On Docker Desktop for Mac, a host folder for `GRIDWATCH_SITE_OUT` can make the site return errors for a few seconds after each build.

```bash
mkdir data site-out && sudo chown 1000:1000 data site-out
```

### Update

```bash
docker compose pull && docker compose up -d
```

The data volume stays. The updater rebuilds the site once when it starts, so new pages from the new image appear.

### Run a job by hand

The `collector`, `publisher` and `site-build` services are one-shot jobs on the `jobs` profile. `docker compose up` does not start them. Stop the `updater` first, so two runs do not write the same data:

```bash
docker compose stop updater
docker compose --profile jobs run --rm collector --from 2025-01-01 --to 2025-03-31 --dataset dispatch_energy_prices
docker compose --profile jobs run --rm publisher --from 2025-01-01 --to 2025-03-31 --dataset dispatch_energy_prices
docker compose --profile jobs run --rm site-build
docker compose start updater
```

- **No range.** The collector fetches the trailing 5 days, and any date or month of the 12-month window that it does not hold (a failed day, or a gap). The monthly datasets (Generation_MD and HVDC_Flows) are checked again for the last 3 months. The publisher publishes the days that are new or whose bronze file changed. A run with nothing new changes nothing.
- **A range.** `--from YYYY-MM-DD --to YYYY-MM-DD` replaces the default range. `--dataset <id>` limits the run (repeat it for more). The publisher also takes `--force` to publish up-to-date days again. Older data is never deleted.
- **Failures.** One failing dataset does not stop the others. The summary names it and the exit code is 1.
- **Help.** `docker compose --profile jobs run --rm collector --help` lists the options.

The rules for each kind of dataset are in [ADR-0009](docs/adr/0009-runner-default-mode.md). The stack design is in [ADR-0026](docs/adr/0026-self-hosting-stack.md).

### From a checkout

`compose.yml` has no `build:` section, so it runs only a published image. To run your own build, build and tag the image, then point the stack at it:

```bash
docker build -t ghcr.io/joshmcarthur/gridwatch:local .
GRIDWATCH_IMAGE_TAG=local docker compose up -d
```

To keep the data in `./data` as the queries in `docs/events/` expect, also set `GRIDWATCH_DATA=./data` (see the settings above).

Architecture decisions are in [`docs/adr/`](docs/adr/). Copy `0000-template.md` for a new one.

## Container images

Each merge to `main` runs the **Publish Docker image** workflow, which builds the `Dockerfile` and pushes to GitHub Container Registry:

```text
ghcr.io/joshmcarthur/gridwatch:latest
ghcr.io/joshmcarthur/gridwatch:sha-<7-char>
```

The package is public, so `docker compose pull` needs no login. GitHub creates a new package as private. If you fork the repository and publish your own image, either make the package public (**Packages → gridwatch → Package settings**) or log in on the host first, with a token that has `read:packages`:

```bash
echo <github-token-with-read:packages> | docker login ghcr.io -u USERNAME --password-stdin
```

To publish manually, run the **Publish Docker image** workflow from the Actions tab. You can supply an extra tag.

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

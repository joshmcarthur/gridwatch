# ADR-0002: Where the daily run executes, and where data and the site are hosted

- Status: Accepted
- Date: 2026-11-20

## Context

[Issue #3](https://github.com/joshmcarthur/gridwatch/issues/3) asks where the daily job runs, where `data/` lives, where the site is published, where secrets live, and what it costs. [ADR-0001](0001-typescript-monorepo-and-data-layers.md) fixes the shape: one-shot `collector` and `publisher` jobs that read and write `DATA_ROOT`, and a static site. The [brief](../brief.md) says to avoid unnecessary services.

The owner said this is a "for fun" project. The data is not in git. The owner already deploys with Docker on a home server. The owner limited the backfill to the last 12 months for now: about 6.9 GB raw, growing about 6.8 GB per year ([`docs/sources.md`](../sources.md) section 4).

## Decision

Everything runs on the owner's home server.

- **Runner:** cron (or a systemd timer) on the home server runs `docker compose run --rm collector`, then `docker compose run --rm publisher`. The schedule does not use GitHub Actions. GitHub Actions is for CI only.
- **Storage:** local disk on the home server, set as `DATA_ROOT`. The owner accepts a single copy of bronze. The risk is accepted.
- **Site:** an nginx container on the home server serves the built site.
- **Secrets:** files on the home server, readable only by the user that runs the jobs. This covers the LLM key later.

**Invariant.** `collector` and `publisher` know only `DATA_ROOT`. No code path in the apps branches on hosting. If hosting moves to the cloud later, sync and publish stay separate steps because the apps only know `DATA_ROOT`.

## Consequences

- No cloud account, no runner and no new service. The only added piece is nginx in `compose.yml`.
- The home server must be on at run time. If it is off, that day's run is missed. The collector re-fetches the last five days, so a short outage heals.
- Cron fails silently. A failed run needs a visible signal. Issue [#15](https://github.com/joshmcarthur/gridwatch/issues/15) chooses how.
- The 12-month backfill (about 6.9 GB, about 1.2 hours) runs in place on the server. It has no disk or time limit.
- Issue [#31](https://github.com/joshmcarthur/gridwatch/issues/31) builds the nginx service and the site publish step.

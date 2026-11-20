# ADR-0002: Where the daily run executes, and where data and the site are hosted

- Status: Accepted
- Date: 2026-11-20

## Context

[Issue #3](https://github.com/joshmcarthur/gridwatch/issues/3) asks where the daily job runs, where `data/` lives, where the site is published, where secrets live, and what it costs. [ADR-0001](0001-typescript-monorepo-and-data-layers.md) fixes the shape: one-shot `collector` and `publisher` jobs that read and write `DATA_ROOT`, and a static site. The [brief](../brief.md) says to avoid unnecessary services.

The owner said this is a "for fun" project. The data is not in git. The owner already deploys with Docker on a home server. The owner limited the backfill to the last 12 months for now: about 6.9 GB raw, growing about 6.8 GB per year ([`docs/sources.md`](../sources.md) section 4).

## Decision

Everything runs on the owner's home server.

- **Runner:** cron on the home server runs [`scripts/daily-run.sh`](../../scripts/daily-run.sh) at 08:00 NZ (`CRON_TZ=Pacific/Auckland`). The script runs `docker compose run --rm collector`, then `docker compose run --rm publisher`. GitHub Actions is for CI only.
- **Storage:** local disk on the home server, set as `DATA_ROOT`. The owner accepts a single copy of bronze. The risk is accepted.
- **Site:** an nginx container on the home server serves the built site.
- **Secrets:** files on the home server, readable only by the user that runs the jobs. This covers the LLM key later.

**Invariant.** `collector` and `publisher` know only `DATA_ROOT`. No code path in the apps branches on hosting. If hosting moves to the cloud later, sync and publish stay separate steps because the apps only know `DATA_ROOT`.

## Consequences

- No cloud account, no runner and no new service. The only added piece is nginx in `compose.yml`.
- The home server must be on at run time. If it is off, that day's run is missed. The collector re-fetches the last five days, so a short outage heals.
- Cron is silent when the job prints nothing. `scripts/daily-run.sh` is quiet on success. On failure it writes to stderr and exits non-zero. `MAILTO` in the crontab mails that output.
- The 12-month backfill (about 6.9 GB, about 1.2 hours) runs in place on the server. It has no disk or time limit.
- Issue [#31](https://github.com/joshmcarthur/gridwatch/issues/31) builds the nginx service and the site publish step.

## Amendment (2026-11-20, [#15](https://github.com/joshmcarthur/gridwatch/issues/15))

The documented default is cron only: a crontab snippet and `scripts/daily-run.sh`. Do not add systemd unit or timer files. A systemd timer may wrap the same script; that is not the install path.

Daily files land about 07:08 NZ on D+1 ([`docs/sources.md`](../sources.md) section 2). The job runs at 08:00 NZ so that day's file is usually present. The collector also re-fetches the last five days.

The failure signal is `MAILTO` plus a non-zero exit. No other notifier.

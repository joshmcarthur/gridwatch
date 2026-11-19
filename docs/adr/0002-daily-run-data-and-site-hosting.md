# ADR-0002: Where the daily run executes, and where data and the site are hosted

- Status: Accepted
- Date: 2026-11-20

## Context

[Issue #3](https://github.com/joshmcarthur/gridwatch/issues/3) asks where the daily job runs, where `data/` lives, where the site is published, where secrets live, and what it costs. [ADR-0001](0001-typescript-monorepo-and-data-layers.md) fixes the shape: one-shot `collector` and `publisher` jobs that read and write `DATA_ROOT`, and a static site. The [brief](../brief.md) says to avoid unnecessary services.

The owner said this is a "for fun" project and that the default is to deploy with Docker on a home server. Cost is not a driver. The raw backfill is about 28 GB ([`docs/sources.md`](../sources.md)). A GitHub-hosted runner has 14 GB of disk and a 6-hour job limit ([limits](https://docs.github.com/en/actions/reference/limits), [runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)).

## Decision

A GitHub Actions workflow runs the daily `docker compose run` jobs. Two hosting choices stay open for storage and site. Both use the same code.

| Part    | Home server (default)                    | Alternative                                 |
| ------- | ---------------------------------------- | ------------------------------------------- |
| Runner  | Self-hosted GitHub Actions runner        | GitHub-hosted runner                        |
| Storage | Local disk                               | R2 through a separate sync step             |
| Site    | nginx container                          | GitHub Pages                                |

**Invariant.** `collector` and `publisher` know only `DATA_ROOT`. Storage sync and site publish are separate workflow steps. No code path in the apps branches on hosting. This keeps both choices cheap.

**Build the home server first.** Issues [#15](https://github.com/joshmcarthur/gridwatch/issues/15) and [#31](https://github.com/joshmcarthur/gridwatch/issues/31) build local disk, nginx and a self-hosted runner. The alternative stays documented here. Do not build it yet. Do not add flags or config for it.

**Bronze.** The owner accepts a single copy of bronze. The risk is accepted.

### Security of the self-hosted runner

GitHub advises against self-hosted runners on public repositories. A workflow started by a fork pull request can run code on the runner ([hardening for self-hosted runners](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#hardening-for-self-hosted-runners)). This repository is public. These mitigations are required:

- Only the scheduled workflow uses the runner. Its triggers are `schedule` and `workflow_dispatch`. It never runs on `pull_request`.
- The runner has a label that only that workflow targets.
- The repository settings require approval for workflows from fork pull requests.
- The runner runs as an unprivileged user, ideally in its own container.

## Consequences

- Scheduled workflows can start late. GitHub turns them off after 60 days with no repository activity in a public repository ([schedule event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)). The daily run is not repository activity. Add a failure alert or a keepalive commit.
- The home server must be on at run time. If it is off, the run waits or fails. The collector re-fetches the last five days, so a short outage heals.
- Secrets (LLM key later, any deploy token) live in GitHub Actions secrets. They are available to the self-hosted runner, so the mitigations above protect them.
- Simpler option not chosen: plain cron on the home server calling `docker compose run`, with no Actions and no runner exposure. The owner chose Actions.
- Moving to the alternative later changes the workflow steps only: runner label, sync step, deploy step.

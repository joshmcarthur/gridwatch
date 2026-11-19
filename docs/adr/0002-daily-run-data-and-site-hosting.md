# ADR-0002: Where the daily run executes, and where data and the site are hosted

- Status: Proposed
- Date: 2026-11-20

## Context

[Issue #3](https://github.com/joshmcarthur/gridwatch/issues/3) asks five questions: runner, data persistence, site hosting, secrets and cost. [ADR-0001](0001-typescript-monorepo-and-data-layers.md) fixes the shape: `collector` and `publisher` run as one-shot jobs, read and write `DATA_ROOT`, and the site is static. The [brief](../brief.md) (sections 4 and 11) says to avoid unnecessary services.

Facts from [`docs/sources.md`](../sources.md) that drive the choice:

- Raw backfill is about 28 GB (about 3 GB gzip). Growth is about 6.8 GB a year raw. The backfill needs about 5 hours at one measured download speed.
- A normal day adds about 20 MB raw. Source files appear at about 07:08 NZ. The collector re-fetches the last five days each run.
- Bronze must never be lost. Silver and gold can be rebuilt from bronze.

Limits that matter (checked 2026-11-20):

- GitHub-hosted runners: 6 hours per job ([limits](https://docs.github.com/en/actions/reference/limits)). 14 GB SSD ([runner specs](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)). Cache is 10 GB per repository, so a cache cannot hold bronze. Standard runners are free on public repositories (same page). This repository is public.
- Scheduled workflows can start late, and GitHub turns them off after 60 days without repository activity in a public repository ([schedule event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)).
- Cloudflare R2: US$0.015 per GB-month, first 10 GB free, no egress fee ([pricing](https://developers.cloudflare.com/r2/pricing/)).
- Cloudflare Pages free plan: 500 builds a month, 20,000 files per site, 25 MiB per file ([limits](https://developers.cloudflare.com/pages/platform/limits/)).
- Backblaze B2: from US$6.95 per TB-month, first 10 GB free ([pricing](https://www.backblaze.com/cloud-storage/pricing)).
- Hetzner Cloud: shared plans from EUR 5.49 a month excluding VAT ([cloud](https://www.hetzner.com/cloud/)). The page gives no disk size. I did not check which plan holds 28 GB.

## Options

### A. GitHub Actions, R2, Cloudflare Pages

- **Runner:** a scheduled GitHub Actions workflow. It runs `docker compose run` for each job.
- **Data:** R2 is the durable home for `data/`. A separate sync step (`rclone` or `aws s3 sync`) pulls what the run needs and pushes the result. The collector and publisher stay free of cloud SDKs. A daily run pulls silver and gold plus the trailing bronze days. It does not pull all bronze.
- **Backfill:** run once on the owner's machine, then upload. It cannot run on a hosted runner: 28 GB does not fit 14 GB of disk.
- **Site:** the workflow builds Astro, then deploys to Cloudflare Pages with `wrangler`.
- **Secrets:** GitHub Actions secrets: R2 access key, Cloudflare API token, LLM key later.
- **Cost:** about US$0.3 a month for 28 GB in R2, rising about US$0.1 a month each year. Actions and Pages are free at this size. The LLM is extra.
- **Trade-offs:** no server to patch. Bronze is in a second place that is not a laptop. Cost: schedule can start late, and it stops after 60 quiet days. Bronze sits in one provider.

### B. Small VPS with cron

- **Runner:** cron on a VPS calls `docker compose run`.
- **Data:** local disk is the working copy. A nightly sync copies bronze to B2 as backup.
- **Site:** the VPS builds Astro and serves it with a web server, or it pushes to Pages.
- **Secrets:** files on the VPS, root-only.
- **Cost:** about EUR 6 to 10 a month for the server (disk size to confirm), plus about US$0.2 a month for B2 backup.
- **Trade-offs:** backfill runs in place with no disk or time limit. Cost: one server to patch, secure and monitor. This is the most moving parts.

### C. Owner's existing host with cron

- **Runner, data, secrets:** as B, on a machine the owner already runs.
- **Backup and site:** B2 for bronze. Pages for the site.
- **Cost:** about US$0.2 a month plus existing hosting.
- **Trade-offs:** cheapest and fastest to start. Uptime depends on that host. I do not know what host the owner has.

## Decision

**Proposed: option A.** It has no server to run. It keeps bronze off the owner's machines. It costs less than any VPS. It matches the brief: scheduled batch job, object storage, static host.

The collector and publisher keep their `DATA_ROOT` contract. Only the workflow and a small sync script know about R2.

## Consequences

- A later issue writes the workflow, the sync script and the Pages deploy. It also adds a liveness check, for example a failed-run alert, because late and disabled schedules fail silently.
- One owner step is needed: create an R2 bucket and a Pages project, and set the secrets.
- Bronze files in R2 are the single copy. Enable bucket versioning or add a periodic copy to B2 if that risk is not acceptable. Not decided here.
- Cloudflare Pages allows 20,000 files on the free plan. If site JSON grows past that, move data files to R2 or pay for the larger limit.
- Unknown: publisher run time on a full silver and gold rebuild. If it passes 6 hours or 14 GB, move that job to option B or C.

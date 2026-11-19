# ADR-0002: Where the daily run executes, and where data and the site are hosted

- Status: Proposed
- Date: 2026-11-20

## Context

[Issue #3](https://github.com/joshmcarthur/gridwatch/issues/3) asks where the daily job runs, where `data/` lives, where the site is published, where secrets live, and what it costs. [ADR-0001](0001-typescript-monorepo-and-data-layers.md) fixes the shape: one-shot `collector` and `publisher` jobs that read and write `DATA_ROOT`, and a static site. The [brief](../brief.md) says to avoid unnecessary services.

Facts from [`docs/sources.md`](../sources.md):

- The raw backfill is about 28 GB and takes about 5 hours. Growth is about 6.8 GB a year.
- A normal day adds about 20 MB. Source files appear at about 07:08 NZ. The collector re-fetches the last five days.
- Bronze must never be lost. Silver and gold can be rebuilt.

Limits (checked 2026-11-20):

- GitHub-hosted runners: 6 hours per job, 14 GB disk ([limits](https://docs.github.com/en/actions/reference/limits), [runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)). The cache is 10 GB per repository. Standard runners are free on public repositories. This repository is public.
- Scheduled workflows can start late. GitHub turns them off after 60 days with no repository activity ([schedule event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)).
- R2 costs US$0.015 per GB-month. The first 10 GB, 1 million Class A and 10 million Class B operations a month are free. Egress is free ([pricing](https://developers.cloudflare.com/r2/pricing/)). R2 does not implement bucket versioning ([S3 API](https://developers.cloudflare.com/r2/api/s3/api/)).
- GitHub Pages: 1 GB site, soft 100 GB a month of bandwidth ([limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)).
- Cloudflare Pages free plan: 20,000 files per site ([limits](https://developers.cloudflare.com/pages/platform/limits/)).
- Backblaze B2: from US$6.95 per TB-month, first 10 GB free ([pricing](https://www.backblaze.com/cloud-storage/pricing)).

## Options

### A. GitHub Actions, R2, a Pages host

- **Runner:** a scheduled GitHub Actions workflow runs `docker compose run` for each job.
- **Data:** R2 holds `data/`. A separate sync step (`rclone`) pulls silver, gold and the trailing bronze days, then pushes the result. The collector and publisher stay free of cloud SDKs.
- **Backfill:** run once on the owner's machine, then upload. 28 GB does not fit a 14 GB runner.
- **Site:** the workflow builds Astro and deploys it to Cloudflare Pages with `wrangler`.
- **Secrets:** GitHub Actions secrets: R2 key, Cloudflare token, LLM key later.
- **Cost:** about US$0.3 a month. Daily sync list calls are a few Class A operations. That is far inside the free million, so negligible at about 6,400 files ([pricing](https://developers.cloudflare.com/r2/pricing/)).
- **Variant A2: GitHub Pages instead of Cloudflare Pages.** No Cloudflare token, no `wrangler`, no 20,000-file limit. Only the R2 key remains.
- **Trade-offs:** no server to patch. Scheduled runs can be late or disabled.

### B. Small VPS with cron

- **Runner and data:** cron on a VPS calls `docker compose run`. Local disk is the working copy. A nightly sync copies bronze to B2.
- **Site:** the VPS serves it, or pushes it to a Pages host.
- **Secrets:** root-only files on the server.
- **Cost:** about EUR 6 to 10 a month ([Hetzner](https://www.hetzner.com/cloud/) lists shared plans from EUR 5.49), plus under US$1 a month for B2.
- **Trade-offs:** the backfill runs in place. You patch and monitor a server. This option has the most moving parts.
- **Variant B2: a host the owner already runs.** Same design, no new server cost.

## Decision

**Proposed: option A2.** It has no server and the fewest secrets. Each secret is a risk, and A2 removes the Cloudflare token. It matches the brief: scheduled batch job, object storage, static host.

Only the workflow and a sync script know about R2. If A2 later hits the 1 GB site limit or needs Cloudflare features, change to A. Only the deploy step changes.

## Consequences

- **Bronze second copy needs an owner decision.** R2 has no versioning, so R2 would hold the only remote copy. We recommend a periodic `rclone` copy of bronze to B2. At 28 GB it costs under US$1 a month. Until that copy exists, the owner's local backfill copy is the second copy.
- **The daily run is not repository activity.** The 60-day disable can still hit a quiet repository. Mitigate with a failure alert, or a scheduled keepalive commit. Do both if the alert alone is not trusted.
- The owner must create the R2 bucket and set the secrets. A later issue writes the workflow and sync script.
- Not yet known: the publisher run time on a full rebuild, and the Pages file count. Both are open in #15 and #31.

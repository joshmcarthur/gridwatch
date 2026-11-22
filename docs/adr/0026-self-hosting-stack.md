# ADR-0026: A self-hosting stack that runs from one compose file

- Status: Accepted
- Date: 2026-11-23

## Context

[ADR-0002](0002-daily-run-data-and-site-hosting.md) chose host cron to run `collector`, `publisher` and `site-build` in order, with nginx serving the site. That works for the owner's home server, but it is not a way for anyone else to run Gridwatch:

- `docker compose up` started the one-shot jobs together, not in order. The jobs exited. `site-build` was on a profile, so nothing built the site.
- A scheduler outside the repository was needed. Compose has no scheduler.
- The file used `build: .`, relative bind mounts and a bind-mounted `nginx.conf`. It needed a checkout, so a paste into a compose UI or a `curl` of the file alone could not run it.
- The first run was one backfill of about 7 GB and about 2.5 hours. The site showed nothing until it finished.

The goal: one `compose.yml`, with no checkout and no host cron. `docker compose up -d` gives a working site. It shows the latest days first and fills older days afterwards.

## Decision

`compose.yml` runs two services from published images.

- **`updater`** (`updater/main.ts`) runs collect, publish and the site build in cycles. It calls `runCollect`, `runPublish` and `buildAndSwap` in-process. It is a plain directory, not a workspace.
  - **Seed:** the latest 7 days.
  - **Fill:** the 30 days before the start of the unbroken run of held dates that ends at the newest date, back to the 12-month window of [ADR-0009](0009-runner-default-mode.md). Each fill cycle builds the site, so older days appear as they arrive. The unbroken run, not the earliest held date, marks the edge. A range that stops part way holds its oldest files, and the earliest date would skip the newest ones.
  - **Steady state:** one cycle every 6 hours. The site is rebuilt only when the publisher published something, and once at startup.
  - Before the first build it writes a "pages are on their way" page through `buildAndSwap`.
  - It clears stale `*.lock` folders at startup, because a build stopped by a redeploy leaves a lock that makes every later build on that slot fail. It exits on `SIGTERM`, because Node as PID 1 ignores it otherwise.
- **`site`** is `caddy:2-alpine` running `caddy file-server --root /srv/current --listen :8080`. It needs no config file. It follows the `current` symlink swap with no restart.

Volumes are named by default. `GRIDWATCH_DATA` and `GRIDWATCH_SITE_OUT` replace them with host paths. `GRIDWATCH_PORT` and `GRIDWATCH_IMAGE_TAG` set the port and the image. The file has no `build:` key. A local build is `docker build -t ghcr.io/joshmcarthur/gridwatch:local .` with `GRIDWATCH_IMAGE_TAG=local`.

`collector`, `publisher` and `site-build` stay in the same file on the `jobs` profile, for backfills and repairs. This keeps the owner's decision on [#110](https://github.com/joshmcarthur/gridwatch/issues/110) that the `site-build` service stays.

Rejected:

- **A static server written in Node.** We would own path traversal, content types, caching and symlink edge cases.
- **`astro preview`.** Astro documents it as a local check, not a production server. It serves one directory chosen at start, and we did not check that it follows the symlink swap.
- **nginx with the config inlined (`configs: content:`).** It depends on the Compose version of the host. A derived nginx image adds a second image to build and publish.
- **Fetching data while building the Docker image.** It bakes stale data into the image and needs a rebuild for every refresh.
- **A `compose.dev.yml`.** One file is the point. The jobs profile and the local build command cover development.

The invariant of ADR-0002 holds. `collector` and `publisher` know only `DATA_ROOT`. The updater adds no branch on hosting.

## Consequences

- A visitor sees a page within seconds, the latest 7 days after about 5 minutes, and the full 12 months after about 2.5 hours. A test run took 3.7 minutes to seed and about 12 minutes for each 30-day step. The Astro build took 5 to 16 seconds, so a build for each step costs little.
- A restart resumes from the data held. The fill repeats at most the one range that was running.
- Host cron is no longer needed. It is still possible: stop the `updater`, and run the `jobs` services from cron as ADR-0002 describes, with `--profile jobs`.
- Run a job by hand only with the `updater` stopped. Two runs on one data folder would write the same files.
- The stack depends on `ghcr.io/joshmcarthur/gridwatch` being public. It is public today (an anonymous pull of `latest` works). A fork that publishes its own image must make its package public, or the host must run `docker login ghcr.io` first. That setting is in GitHub and outside this repository.
- A host folder for `GRIDWATCH_SITE_OUT` on Docker Desktop for Mac returned 400 for about 3 seconds after each swap. A named volume does not. The README recommends named volumes.
- Caddy serves no compression, the same as the nginx default. A `Caddyfile` would be needed to add it.
- The updater's constants (7 seed days, 30 fill days, a 6-hour cycle, a 10-minute retry) are not settings. A setting is added when a second user needs one.
- Failure alerts are still host configuration, as ADR-0002 says. A failed cycle is logged and retried. The container stays up, so the exit code no longer signals a failure. Alert on the log line `cycle failed`, or on the site's last build time.

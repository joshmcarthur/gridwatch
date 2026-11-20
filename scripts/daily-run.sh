#!/usr/bin/env bash
# Daily collect then publish. Cron mails stderr when MAILTO is set.
# Quiet on success. On failure, print to stderr and exit non-zero.
set -euo pipefail

PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"
stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
log="$LOG_DIR/daily-run.$stamp.log"

if ! {
  echo "start $stamp"
  docker compose run --rm collector
  docker compose run --rm publisher
  echo "ok"
} >"$log" 2>&1; then
  status=$?
  echo "gridwatch daily-run failed (exit $status). log: $log" >&2
  tail -n 80 "$log" >&2 || true
  exit "$status"
fi

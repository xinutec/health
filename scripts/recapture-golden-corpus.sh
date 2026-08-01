#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Re-capture EVERY golden day from prod, preserving each day's timezone and
# description from the fixture already on disk.
#
# Why a dedicated script rather than a shell loop over capture-golden.sh:
# `prod-db.sh` pkills any existing `kubectl port-forward svc/health-db` on isis
# during cleanup, so two of them running at once tear down each other's tunnel.
# The loop therefore has to live INSIDE one prod-db.sh session — which is what
# this does, by handing prod-db.sh a single inner script that iterates.
#
# Slow and deliberate: each day re-runs the classification pipeline against prod
# AND loads that day's buffered OSM row-set (tens of thousands of rows, ~20-40 s
# on its own). Budget a couple of minutes per day. Run it detached:
#
#   nohup scripts/recapture-golden-corpus.sh > /tmp/recapture.log 2>&1 &
#
# This is the ONLY path that pulls fresh inputs from prod, so it also picks up
# any OSM mirror drift since the last capture — expect the diff to mix real
# changes with drift, and read `golden-check` output rather than assuming.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building"
pnpm run build >/dev/null

exec "$SCRIPT_DIR/prod-db.sh" bash "$SCRIPT_DIR/_recapture-all-inner.sh" "$@"

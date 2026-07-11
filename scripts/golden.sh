#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Run the deterministic golden-day regression check — one command, NO DB.
#
# Builds the project locally, then replays the captured fixtures under
# tests/golden/days/ through the pure classification core and diffs each
# day's timeline against its frozen baseline. No tunnel, no port-forward:
# every fixture carries its own input closure (row-sets + recorded OSM
# trace), so the check is a pure-function replay that sees whatever
# pipeline changes you have made. Re-running it from any commit on the
# same fixture gives the same result.
#
# Capture fixtures with scripts/capture-golden.sh (that is the only path
# that touches prod).
#
# Usage:
#   scripts/golden.sh                  # check every captured day
#   scripts/golden.sh --bless          # re-derive every expected
#   scripts/golden.sh --bless 2026-05-15   # one day
#
# Via npm (note the `--` so npm forwards the flags):
#   npm run golden
#   npm run golden -- --bless 2026-05-15
#
# Exit 0 = every fixture matches its baseline. Exit 1 = a fixture
# regressed. Exit 2 = no corpus (capture one first).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building"
npm run build >/dev/null

echo "==> replaying golden fixtures (no DB)"
exec node dist/cli/golden-check.js "$@"

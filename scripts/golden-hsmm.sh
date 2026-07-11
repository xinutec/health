#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Run the deterministic HSMM decode-replay check — one command, NO DB.
#
# Builds the project locally, then replays the captured fixtures under
# tests/golden/decoded_days/ through the pure `decodeHsmm` and diffs each
# day's decode against its frozen baseline. No tunnel, no port-forward:
# every fixture carries its own HsmmInputs (row-sets + raw OSM rows +
# per-fix rail/road proximity), so the check is a pure-function replay.
#
# Capture fixtures with capture-hsmm-day.js against prod (the only path
# that touches the DB).
#
# Usage:
#   scripts/golden-hsmm.sh                   # check every captured day
#   scripts/golden-hsmm.sh --bless           # re-derive every expected
#   scripts/golden-hsmm.sh --bless 2026-05-25    # one day
#
# Via npm (note the `--` so npm forwards the flags):
#   npm run golden-hsmm
#   npm run golden-hsmm -- --bless 2026-05-25
#
# Exit 0 = every fixture matches its baseline. Exit 1 = a fixture
# regressed. Exit 2 = no corpus (capture one first).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building"
npm run build >/dev/null

echo "==> replaying HSMM decode fixtures (no DB)"
exec node dist/cli/golden-check-hsmm.js "$@"

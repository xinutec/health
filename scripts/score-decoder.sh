#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Score the REAL HSMM decoder against ground truth — one command, NO DB.
#
# Replays each captured fixture under tests/golden/decoded_days/ through the
# canonical `decodeHsmm` (the production decode, incl. the train soft prior)
# and scores it against the day's ground-truth narrative with both the
# per-minute and the journey-level scorers. Unlike
# `compare-vs-ground-truth.js --source hsmm` (a stale inline decode that
# needs a live DB), this is the faithful decoder measured offline.
#
#   npm run score-decoder                 # every captured day with ground truth
#   npm run score-decoder -- 2026-05-22   # one day
#
# Exit 0 = scored at least one day. Exit 2 = no corpus / no ground truth.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building" >&2
npm run build >/dev/null

echo "==> scoring real decodeHsmm vs ground truth (no DB)" >&2
exec node dist/cli/score-decoder-golden.js "$@"

#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Venue-attribution referee — how good is the venue scorer, over the corpus?
#
# Replays the golden fixtures (no DB, no network) with a trace sink on the
# venue ranking, joins each decision to the day's ground-truth narrative, and
# reports accuracy, how often the near-field short-circuit decided a stay
# instead of the evidence, and — for every miss — whether the true venue was
# even a candidate and by how many nats it lost.
#
# This REPORTS, it does not gate: golden.sh is the gate. Run this before and
# after any change to the venue scorer, so a fix for one stay cannot silently
# cost a confirmed label elsewhere (which is exactly what #341 did).
#
# Usage:
#   scripts/score-venues.sh                  # the corpus report
#   scripts/score-venues.sh --verbose        # every case, not just the misses
#   scripts/score-venues.sh --json out.json  # dump the cases

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building"
npm run build >/dev/null

exec node dist/cli/score-venues.js "$@"

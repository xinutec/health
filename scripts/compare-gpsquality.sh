#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# GPS quality pre-filter TS↔Lean parity: replay every golden day's raw
# PhoneTrack track through `src/geo/gps-quality.ts` and `verified_cli
# gpsquality`, and compare the KEEP-SETS by input index.
#
# Unlike compare-kalman, the bar here IS exactness and it is reachable.
# The filter is drop-only — every emitted fix is a copy of an input fix —
# so nothing computed crosses the wire and there is no ULP class. `cos`
# (via distanceM) reaches only the threshold comparisons, so the sole way
# the arms can disagree is a 1-ULP difference landing exactly on a
# boundary (150 km/h, 80 m, 15 km/h, 800 m). Measured 2026-07-30: 32/32
# days exact. A divergence is a decision flip to adjudicate, not noise.
#
# Needs the local golden day fixtures (gitignored, real coordinates) —
# a tool like golden-hsmm, not part of `npm run verify`.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building (lean)"
(cd lean && lake build >/dev/null)

exec npx tsx lean/experiments/compare-gpsquality.mts "$@"

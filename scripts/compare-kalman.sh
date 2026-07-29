#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# GPS Kalman filter TS↔Lean parity: replay every golden day's raw
# PhoneTrack track through `src/geo/kalman.ts` and `verified_cli kalman`
# and compare the filtered output field by field, as IEEE-754 bit
# patterns.
#
# Unlike compare-geo / compare-rail, the bar here is NOT bit-exactness,
# and the tool is built to say so precisely. Nothing in this filter is
# quantised, so the two arms differ wherever their libms differ: Lean's
# `Float.cos` and V8's `Math.cos` disagree by 1 ULP on ~7.6% of real
# latitudes, `metersToDegreesLon` calls `cos`, and the covariance
# recursion carries that into `lon`. Hence the per-field ULP tally —
# what matters is that row COUNTS always agree (same fixes kept), `lat`
# stays exact (it never calls `cos` — the control), and the `lon` gap
# stays in the single digits.
#
# Needs the local golden day fixtures (gitignored, real coordinates) —
# a tool like golden-hsmm, not part of `npm run verify`.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building (lean)"
(cd lean && lake build >/dev/null)

exec npx tsx lean/experiments/compare-kalman.mts "$@"

#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# HSMM GPS outlier filter TS↔Lean parity: replay every captured HSMM day's
# points through `src/hmm/gps-outliers.ts` and `verified_cli gpsoutliers`,
# and compare the KEPT-SETS by input index.
#
# Distinct from compare-gpsquality, which is a different filter at a
# different stage: that one runs before the Kalman smoother on raw
# PhoneTrack fixes, this one runs after it, inside buildHsmmModel, on the
# smoothed stream the observation tensor is built from.
#
# The bar is exactness and it is reachable. The filter is drop-only —
# every emitted fix is a copy of an input fix — so nothing computed
# crosses the wire and there is no ULP class. `cos` reaches only the
# deviation compared against the 2 km threshold, and the population is
# either metres from its cluster median or tens of kilometres from it, so
# nothing sits at the knife-edge. Measured 2026-08-11: 11/11 days exact,
# over 999 real drops of 8758 fixes. A divergence is a decision flip to
# adjudicate, not noise.
#
# Needs the local HSMM day fixtures (gitignored, real coordinates) —
# a tool like golden-hsmm, not part of `pnpm run verify`.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building (lean)"
(cd lean && lake build >/dev/null)

exec npx tsx lean/experiments/compare-gps-outliers.mts "$@"

#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# How far can a last-bit `cos` disagreement move the Kalman filter's output?
#
# `compare-kalman.sh` (DELETED 2026-09-01, #1301 — its TS arm went at 06346bd)
# reported a per-day tally like `lon 4/924 (≤19ulp)` and
# judges its exit code on row counts, `lat` exactness, and the NUMBER of
# divergent `lon` rows — never on ULP magnitude. This is the tool that says why
# magnitude is not gateable, and the tool to reach for when a reading looks
# surprising.
#
# It perturbs `Math.cos` by ±1 ULP on 7.6% of calls — the rate this runtime's
# `Float.cos` and V8's `Math.cos` actually disagree, measured in
# `Verified/Geo/Kalman.lean` — and runs the TypeScript filter AGAINST ITSELF.
# Both arms are the same TypeScript, so nothing the two implementations disagree
# about can confound it: it isolates `cos`.
#
# Measured over the 35-day corpus on 2026-08-17 (#1020): the amplification band
# runs from 1 to 75 ULP on `lon` depending on the day, no day's real TS↔Lean
# divergence exceeds its own band, and none of 10 500 perturbed runs moved a row
# count. So a double-digit ULP gap is the documented band, not a finding.
#
# ⚠ Prints row indices, timestamps and ULP/absolute distances ONLY, never a
# coordinate — the fixtures are real tracks.
#
# Needs the local golden day fixtures (gitignored, real coordinates), like
# the deleted compare-kalman.sh. Not part of `pnpm run verify`.
#
# Sample count: PROBE_SAMPLES=1000 ./scripts/probe-kalman-ulp.sh 2026-07-14

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building (lean)"
(cd lean && lake build >/dev/null)

exec pnpm exec tsx lean/experiments/probe-kalman-ulp.mts "$@"

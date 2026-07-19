#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Geometry-substrate TS↔Lean parity (V4 of
# docs/proposals/2026-07-verified-core-lean.md): replay every golden
# day's walking legs, quantise the raw fixes to the pinned 1e-7°
# representation, and demand the verified Lean display passes
# (simplify / speed hold / spike rejection via `verified_cli geo`)
# return bit-identical output to the BigInt twin on the same input;
# float↔quant keep-set flips are the fidelity metric.
#
# Needs the local golden day fixtures (gitignored, real coordinates) —
# a tool like golden-hsmm, not part of `npm run verify`.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building (ts + lean)"
npm run build >/dev/null
(cd lean && lake build >/dev/null)

exec node dist/cli/compare-geo.js "$@"

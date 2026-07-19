#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Matcher-level float↔quant parity probe (the V4 matcher arc of
# docs/proposals/2026-07-verified-core-lean.md): replay every golden
# day's walking legs through the production `matchWalkSegment` and the
# BigInt twin (`geo/match-twin.ts`) on identical inputs and classify
# each leg EXACT / NEAR / DIFF. Pins the matcher representation ahead
# of the Lean port; the later three-arm harness gates quant↔Lean at
# bit-exact like compare-geo.
#
# Needs the local golden day fixtures (gitignored, real coordinates) —
# a tool like golden-hsmm, not part of `npm run verify`.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building (ts)"
npm run build >/dev/null

exec node dist/cli/compare-match.js "$@"

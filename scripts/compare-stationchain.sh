#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Station-chain TS↔Lean parity (#672): drive `resolveStationChain` and the
# verified `Verified.Hsmm.StationChain` over the same decoded-day corpus and
# demand identical resolved (board, alight) pairs.
#
# This is what turns the port from GUARD-PINNED into live-compared. The 22
# guards pin it against eleven synthetic V8 outcomes, which is a snapshot of V8
# agreeing with itself; what they cannot see is the TS moving underneath (#417).
#
# Needs the local decoded_days fixtures (gitignored, real coordinates) — a tool
# like golden-hsmm, not part of `pnpm run verify`.
#
# Usage:
#   scripts/compare-stationchain.sh
#   pnpm run compare-stationchain
#
# Exit 0 = every day's pairs identical. Exit 1 = a divergence, an error, or a
# corpus with no train legs at all (which would otherwise report a clean sweep
# of nothing). Exit 2 = no corpus.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building (ts + lean)"
pnpm run build >/dev/null
(cd lean && lake build >/dev/null)

echo "==> comparing station-chain resolution over decoded_days"
exec node dist/cli/compare-stationchain.js "$@"

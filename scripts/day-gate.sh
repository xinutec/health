#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Lean pass-fold parity gate — does `Verified.Geo.PassFold` still produce what
# the 38-pass `velocity.ts` cascade produces? Zero-DB, deterministic (same
# fixture closure as `pnpm run golden`). Wraps src/cli/compare-day.ts.
#
# This is the ONLY thing in the repo that asks whether a Lean port has drifted
# from the TS it ports (#426). Twice that cost a real day to notice.
#
# The bar is absolute, not a ratchet: every day must be IDENTICAL or SHELL ONLY.
# There is deliberately no baseline to bless a divergence into.
#
# Usage:
#   pnpm run day-gate                 # every golden day
#   pnpm run day-gate 2026-05-18      # one day
#
# Exit 0 = every day matches on the fields the fold owns. Exit 1 = a divergence,
# a lookup miss, or an unexpected shell. Exit 2 = no corpus.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building (ts + lean)"
pnpm run build >/dev/null
(cd lean && lake build >/dev/null)

echo "==> replaying the fold over golden fixtures (no DB)"
exec node dist/cli/compare-day.js "$@"

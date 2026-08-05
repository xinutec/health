#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Lean focus-place parity gate — do `Verified.Geo.FocusPlaces` and
# `Verified.Geo.FocusIdentity` still produce what `src/geo/focus-places.ts` and
# `focus-places-identity.ts` produce? Zero-DB, deterministic (the same golden
# fixture closure `pnpm run day-gate` replays, plus the captured focus-cluster
# fixture). Wraps src/cli/compare-focus.ts.
#
# These two modules port the weekly `refresh-focus-places` cron, which no day
# replay reaches, so before this they were guard-pinned and nothing else — the
# class #417 and #425 came from (#435).
#
# The bar is absolute, not a ratchet: every case must be IDENTICAL. There is
# deliberately no baseline to bless a divergence into.
#
# Usage:
#   pnpm run focus-gate                 # every case
#   pnpm run focus-gate 2026-05-18      # one day (skips the corpus + split cases)
#
# Exit 0 = every case identical. Exit 1 = a divergence or an error.
# Exit 2 = no corpus.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building (ts + lean)"
pnpm run build >/dev/null
(cd lean && lake build >/dev/null)

echo "==> mining focus places in both arms (no DB)"
exec node dist/cli/compare-focus.js "$@"

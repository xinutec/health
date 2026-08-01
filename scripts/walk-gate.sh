#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Walk-geometry ratchet gate — does any drawn walk read worse than its blessed
# floor? Zero-DB, deterministic (same fixture closure as `pnpm run golden`).
# Wraps src/cli/score-walk-match.ts; the ratchet lives in src/eval/walk-gate.ts
# and the floor in tests/golden/walk-baseline.json (gitignored, beside the
# fixtures it describes).
#
# Usage:
#   pnpm run walk-gate                                # gate every golden day
#   pnpm run walk-gate 2026-07-01                  # one day
#   pnpm run walk-gate 2026-07-01 2026-07-06       # several days
#   pnpm run walk-gate --bless                     # record the current metrics as floor
#
# Exit 0 = no walk below its floor. Exit 1 = a walk regressed (or, with no
# baseline blessed yet, the raw A/B verdict regressed).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building"
pnpm run build >/dev/null

echo "==> walk-geometry ratchet over golden fixtures (no DB)"
exec node dist/cli/score-walk-match.js "$@"

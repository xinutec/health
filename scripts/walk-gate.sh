#!/usr/bin/env nix-shell
#!nix-shell -i bash -p nodejs_24
# Walk-geometry ratchet gate — does any drawn walk read worse than its blessed
# floor? Zero-DB, deterministic (same fixture closure as `npm run golden`).
# Wraps src/cli/score-walk-match.ts; the ratchet lives in src/eval/walk-gate.ts
# and the floor in tests/golden/walk-baseline.json (gitignored, beside the
# fixtures it describes).
#
# Usage:
#   npm run walk-gate                    # gate every golden day
#   npm run walk-gate -- 2026-07-01      # one day
#   npm run walk-gate -- --bless         # record the current metrics as floor
#
# Exit 0 = no walk below its floor. Exit 1 = a walk regressed (or, with no
# baseline blessed yet, the raw A/B verdict regressed).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building"
npm run build >/dev/null

echo "==> walk-geometry ratchet over golden fixtures (no DB)"
exec node dist/cli/score-walk-match.js "$@"

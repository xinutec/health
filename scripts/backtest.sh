#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Backtest the factor-scorer path against the legacy cascade over a
# date range. Mirrors scripts/golden.sh — builds locally, then runs
# backtest-classification.js against the prod health-db via
# scripts/prod-db.sh.
#
# Usage:
#   scripts/backtest.sh                          # last 7 days
#   scripts/backtest.sh --days 30
#   scripts/backtest.sh --from 2026-05-12 --to 2026-05-22
#
# Via npm (note the `--` so npm forwards flags):
#   npm run backtest
#   npm run backtest -- --days 30
#
# Exit 0 always (measurement tool, not pass/fail).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building"
npm run build >/dev/null

echo "==> running backtest-classification against prod"
exec "$SCRIPT_DIR/prod-db.sh" node dist/cli/backtest-classification.js "$@"

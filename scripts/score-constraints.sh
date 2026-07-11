#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Constraint score — how many physically-impossible things the pipeline emits
# across the frozen golden corpus. Zero-DB, deterministic (same input closure
# as `npm run golden`). The objective the joint-inference rebuild drives to
# zero. See src/infer/day-grammar.ts.
#
# Exit 0 = every day is physically possible. Exit 1 = at least one impossibility.
# Exit 2 = no corpus.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building"
npm run build >/dev/null

echo "==> checking golden corpus against the day grammar (no DB)"
exec node dist/cli/score-constraints.js "$@"

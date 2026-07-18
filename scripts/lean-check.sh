#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Build the Lean verified core — every #guard parity check runs inside
# `lake build`, so a trellis/spec divergence fails the build — then run
# the TS↔Lean decode parity harness (42 seeded problems, day scale
# included, exact path + score agreement required).
#
# Part of `npm run verify`.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> lake build (verified core + #guard checks)"
(cd lean && lake build)

echo "==> TS↔Lean parity harness"
npm run build >/dev/null
node lean/experiments/compare.mjs

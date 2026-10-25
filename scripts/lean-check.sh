#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Build the Lean verified core — every #guard parity check runs inside
# `lake build`, so a trellis/spec divergence fails the build.
#
# ⚠ THE TS↔LEAN PARITY HARNESS IS GONE (#975), and it is not coming back. It ran
# 42 seeded problems through `node lean/experiments/compare.mjs` and required
# exact path + score agreement — a real check while there were two arms. With
# one arm it compares Lean to itself. The `#guard`s keep their frozen reference
# values, which is the trade this repository accepted with the cost stated.
#
# Part of `pnpm run verify`.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> lake build (verified core + #guard checks)"
(cd lean && lake build)

# Nothing in the package that `verified_cli` cannot reach (`lean/Deadcode.lean`):
# a declaration nothing runs, and a #guard or theorem about only such code, is
# deleted rather than kept. `--control` first, so a green run is not a blind one.
echo "==> lake exe deadcode (nothing unreached)"
(cd lean && lake build deadcode && lake exe deadcode --control && lake exe deadcode)


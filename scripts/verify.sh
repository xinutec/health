#!/usr/bin/env bash
# Run the full pre-commit verification.
#
# `npm run verify` chains: typecheck (backend + frontend) →
# schema-types drift check → format → Biome lint (backend) →
# ESLint (frontend) → the vitest suite; then the shared dev-lint rules.
# The toolchain (nodejs) comes from the flake devshell — rev-pinned via
# flake.lock and available without npm on PATH (e.g. the Mac mini),
# same as deploy.sh.
#
# Usage:
#   scripts/verify.sh          # run the full verify
#
# deploy.sh already runs `npm run verify` as its first step; this is
# for running the check on its own.
#
# Exit 0 = everything passes. Non-zero = a step failed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

nix develop -c npm run verify "$@"

# L2 phone-width layout harness (ui-check): build the frontend, then serve the
# dist via e2e/serve.mjs and assert no overlap/overflow at Pixel width. The
# `npm run verify` above is tsc/lint/vitest only (no ng build), so build here.
# See @xinutec/ui-harness + dev-lint/docs/layout-quality-architecture.md.
nix develop -c bash -c '
  set -euo pipefail
  # NG_BUILD_MAX_WORKERS=1 lowers (does not cure) the macOS @angular/build
  # worker-pool teardown abort; re-run verify on a spurious build abort. See the
  # fuller note in the fleet Rust+Angular apps verify.sh (e.g. life).
  export NG_BUILD_MAX_WORKERS=1
  ( cd frontend && npx ng build && npm run ui-check )
'

nix run "$HOME/Code/dev-lint" -- .

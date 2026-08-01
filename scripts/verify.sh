#!/usr/bin/env bash
# Run the full pre-commit verification.
#
# `pnpm run verify` chains: typecheck (backend + frontend) →
# schema-types drift check → format → Biome lint (backend) →
# ESLint (frontend) → the vitest suite; then the shared dev-lint rules.
# The toolchain (nodejs) comes from the flake devShell — rev-pinned via
# flake.lock, the single source of truth every script shares (see
# scripts/_devshell.sh). Available without npm on PATH (e.g. the Mac mini).
#
# Usage:
#   scripts/verify.sh          # run the full verify
#
# deploy.sh already runs `pnpm run verify` as its first step; this is
# for running the check on its own.
#
# Exit 0 = everything passes. Non-zero = a step failed.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Deps must exist before `pnpm run verify` / ng build — verify.sh has to run from a
# clean checkout (a fresh clone, or the tree the fleetwatch collector runs in), not
# just a warm dev machine. Install root + frontend deps when absent or stale.
# --frozen-lockfile is pnpm ci: install exactly the lockfile, or fail. Two
# separate projects, two lockfiles — the backend at the root, the frontend in
# frontend/ — so each is installed on its own.
if [ ! -d node_modules ] || [ pnpm-lock.yaml -nt node_modules ]; then pnpm install --frozen-lockfile; fi
if [ ! -d frontend/node_modules ] || [ frontend/pnpm-lock.yaml -nt frontend/node_modules ]; then ( cd frontend && pnpm install --frozen-lockfile ); fi

pnpm run verify "$@"

# L2 phone-width layout harness (ui-check): build the frontend, then serve the
# dist via e2e/serve.mjs and assert no overlap/overflow at Pixel width. The
# `pnpm run verify` above is tsc/lint/vitest only (no ng build), so build here.
# See @xinutec/ui-harness + dev-lint/docs/layout-quality-architecture.md.
# NG_BUILD_MAX_WORKERS=1 lowers (does not cure) the macOS @angular/build
# worker-pool teardown abort; re-run verify on a spurious build abort. See the
# fuller note in the fleet Rust+Angular apps verify.sh (e.g. life).
( cd frontend && NG_BUILD_MAX_WORKERS=1 pnpm exec ng build && pnpm run ui-check )

dev_lint_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/dev-lint"
[ -d "$dev_lint_dir" ] || dev_lint_dir="$HOME/Code/dev-lint"
[ -d "$dev_lint_dir" ] || dev_lint_dir="$HOME/code/dev-lint"
# The baseline grandfathers DL-KYSELY-DRIVER-TYPE's 56 pre-existing findings in
# db/tables.ts — DATE/DATETIME columns typed `string` and DECIMAL typed
# `number`, none of which is what the mariadb pool actually returns. Counts only
# ratchet down, so new code is held to the honest types from today. Correcting a
# column makes tsc surface every read that relied on the wrong one, which is the
# remediation, not a side effect. Regenerate after fixing a batch:
#   nix run "$dev_lint_dir" -- --write-baseline .dev-lint-baseline .
nix run "$dev_lint_dir" -- --baseline .dev-lint-baseline . # dev-lint

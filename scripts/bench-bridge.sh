#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Ablate the Lean bridge (#405): send each tenant's real payload shape to a
# do-nothing `noop` handler, so the transport+JSON floor is a MEASURED number
# and everything above it is the verified algorithm.
#
# Exists because the arm ratios (#404) came out inverse to how much work the
# call does — the matcher, the only tenant doing real computation, is the
# cheapest at 4.5x while gpsquality is 213x. That points at the crossing rather
# than the core, and the difference is load-bearing: under the Rust-shell
# architecture there is no crossing, so cost below this floor is an artifact of
# today's staging rather than a property of the verified code.
#
# A measurement tool, not a gate — prints a table and exits 0. Not part of
# `pnpm run verify`.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building (ts + lean)"
pnpm run build >/dev/null
(cd lean && lake build >/dev/null)

export LEAN_CLI="${LEAN_CLI:-$SCRIPT_DIR/../lean/.lake/build/bin/verified_cli}"
exec node dist/cli/bench-bridge.js "$@"

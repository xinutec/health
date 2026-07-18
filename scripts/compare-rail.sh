#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Rail-snap TS↔Lean parity (V3 of
# docs/proposals/2026-07-verified-core-lean.md): rebuild each fixture
# train segment's production rail graph, quantise the weights ×2²⁰, and
# demand the verified Lean Dijkstra return the identical path (and
# consistent distance) to the TS shortestPath on the same quantised
# graph; float↔quant path identity is the fidelity metric.
#
# Needs the local railsnap fixture (gitignored, real coordinates) — a
# tool like golden-hsmm, not part of `npm run verify`.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building (ts + lean)"
npm run build >/dev/null
(cd lean && lake build >/dev/null)

exec node dist/cli/compare-rail.js "$@"

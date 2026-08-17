#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Pipeline-head TS↔Lean parity: `snapToPlace` and `classifySegments`, the two
# steps between the raw fixes and the day fold's `segsRaw`.
#
# Two passes. The synthetic cases pin the branches — a fix already AT a centroid
# (snaps without moving), an out-of-radius fix, an ambiguous runner-up, a
# two-segment cut. The corpus pass then replays every golden day through the
# same chain `velocity.ts` runs:
#
#   inDay → qualityFilterGps → snapToPlace → ≤200 m → filterGpsTrack
#         → classifySegments → segsRaw
#
# The bar is EXACTNESS and it is reachable. Inputs cross as IEEE bit patterns,
# `snapToPlace` emits either the input coordinates or a centroid copied from the
# place list (nothing computed), and `classifySegments`' floats are pinned
# bit-for-bit by `Segments.lean`'s guards against the production TS. Measured
# 2026-08-17: 35/35 days exact for both ops. A divergence is a decision flip to
# adjudicate, not noise to tolerate.
#
# Needs the local golden day fixtures (gitignored, real coordinates) for the
# corpus pass; it is skipped with a note when they are absent. Nothing from a
# fixture is printed — counts, dates and indices only.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building (lean)"
(cd lean && lake build >/dev/null)

exec pnpm exec tsx lean/experiments/compare-head.mts "$@"

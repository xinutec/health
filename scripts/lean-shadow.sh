#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Lean-shadow A/B on the real captured corpus (V2 of
# docs/proposals/2026-07-verified-core-lean.md): quantise each golden
# day's decode model to integers and demand the verified Lean decoder
# and the TS trellis agree EXACTLY; separately report quantisation
# fidelity (float↔quant minute agreement + score delta).
#
# Needs the local decoded_days corpus (gitignored, real data) — so this
# is a tool like golden-hsmm, not part of `npm run verify`.
#
# Usage:
#   scripts/lean-shadow.sh                # every captured day
#   scripts/lean-shadow.sh 2026-05-25    # one day

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building (ts + lean)"
npm run build >/dev/null
(cd lean && lake build >/dev/null)

exec node dist/cli/lean-shadow.js "$@"

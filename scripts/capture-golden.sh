#!/usr/bin/env nix-shell
#!nix-shell -i bash -p openssh nodejs_24
# Capture a deterministic golden fixture for one day from prod.
#
# Builds locally, then runs capture-golden.js against the prod health-db
# via scripts/prod-db.sh (opens the tunnel + exports DB / NC env). The
# capture wraps the production OSM adapter in a recorder, so the fixture
# stores exactly the OSM lookups the pipeline made. Writes
# tests/golden/days/<date>-<user>.json (gitignored).
#
# Capture is the only path that pulls fresh inputs from prod;
# golden --bless never re-pulls.
#
# Usage:
#   scripts/capture-golden.sh <date> <user> <timezone> [--description "..."]
#   scripts/capture-golden.sh 2026-05-15 pippijn Europe/London
#
# Via npm:
#   npm run capture-golden -- 2026-05-15 pippijn Europe/London

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> building"
npm run build >/dev/null

echo "==> capturing against prod"
exec "$SCRIPT_DIR/prod-db.sh" node dist/cli/capture-golden.js "$@"

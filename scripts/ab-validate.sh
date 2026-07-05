#!/bin/bash
# A/B compare presence-continuity flag across all decoded days.
# Run from repo root.
set -euo pipefail
DATES="2026-04-29 2026-04-30 2026-05-18 2026-05-19 2026-05-20 2026-05-21 2026-05-22 2026-05-23 2026-05-24 2026-05-25 2026-05-26 2026-05-27 2026-05-28 2026-05-29 2026-05-30 2026-05-31 2026-06-01 2026-06-02"

echo "=== Pass A: flag OFF, chronological ===" >&2
for d in $DATES; do
  USE_FACTOR_SCORER=1 USE_BIOMETRIC_FACTOR=1 ./scripts/prod-db.sh node dist/cli/decode-day.js --date "$d" > /tmp/dec.log 2>&1
  ./scripts/prod-db.sh node dist/cli/refresh-presence-log.js > /tmp/ref.log 2>&1
done
./scripts/prod-db.sh node scripts/dump-all-segments.mjs 2>/dev/null | grep -v '^Forwarding\|^Handling' > /tmp/flag_off.json

echo "=== Pass B: flag ON, chronological ===" >&2
for d in $DATES; do
  USE_CONTINUITY_CONTINUATION=1 USE_FACTOR_SCORER=1 USE_BIOMETRIC_FACTOR=1 ./scripts/prod-db.sh node dist/cli/decode-day.js --date "$d" > /tmp/dec.log 2>&1
  ./scripts/prod-db.sh node dist/cli/refresh-presence-log.js > /tmp/ref.log 2>&1
done
./scripts/prod-db.sh node scripts/dump-all-segments.mjs 2>/dev/null | grep -v '^Forwarding\|^Handling' > /tmp/flag_on.json

echo "=== sizes ===" >&2
wc -c /tmp/flag_off.json /tmp/flag_on.json >&2
echo "=== diff summary ===" >&2
node scripts/diff-segments.mjs /tmp/flag_off.json /tmp/flag_on.json off on

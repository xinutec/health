#!/bin/bash
# A/B in prod's actual config: cascade path (no USE_FACTOR_SCORER).
# Compares continuity flag off vs on across all decoded days.
set -euo pipefail
DATES="2026-04-29 2026-04-30 2026-05-18 2026-05-19 2026-05-20 2026-05-21 2026-05-22 2026-05-23 2026-05-24 2026-05-25 2026-05-26 2026-05-27 2026-05-28 2026-05-29 2026-05-30 2026-05-31 2026-06-01 2026-06-02"

echo "=== Pass A: cascade + continuity OFF ===" >&2
for d in $DATES; do
  ./scripts/prod-db.sh node dist/cli/decode-day.js --date "$d" > /tmp/dec.log 2>&1
  ./scripts/prod-db.sh node dist/cli/refresh-presence-log.js > /tmp/ref.log 2>&1
done
./scripts/prod-db.sh node scripts/dump-all-segments.mjs 2>/dev/null | grep -v '^Forwarding\|^Handling' > /tmp/cascade_off.json

echo "=== Pass B: cascade + continuity ON ===" >&2
for d in $DATES; do
  USE_CONTINUITY_CONTINUATION=1 ./scripts/prod-db.sh node dist/cli/decode-day.js --date "$d" > /tmp/dec.log 2>&1
  ./scripts/prod-db.sh node dist/cli/refresh-presence-log.js > /tmp/ref.log 2>&1
done
./scripts/prod-db.sh node scripts/dump-all-segments.mjs 2>/dev/null | grep -v '^Forwarding\|^Handling' > /tmp/cascade_on.json

echo "=== sizes ===" >&2
wc -c /tmp/cascade_off.json /tmp/cascade_on.json >&2

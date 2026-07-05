#!/usr/bin/env bash
# One-off: pull Fitbit creds from the prod pod, run the body backfill.
set -euo pipefail
cd "$(dirname "$0")/.."
POD=$(ssh root@isis.xinutec.org "kubectl -n health get pods -l app=health-auth -o jsonpath='{.items[0].metadata.name}'")
eval "$(ssh root@isis.xinutec.org "kubectl -n health exec $POD -- sh -c 'echo export FITBIT_CLIENT_ID=\$FITBIT_CLIENT_ID FITBIT_CLIENT_SECRET=\$FITBIT_CLIENT_SECRET'")"
export FITBIT_CLIENT_ID FITBIT_CLIENT_SECRET
exec ./scripts/prod-db.sh node dist/cli/backfill-body.js "${1:-pippijn}" "${2:-2023-06-01}"

#!/usr/bin/env bash
# Is production decoding with the record this tree tests?
#
# Production reads its decoder record from the Secret `health-decoder` (key
# `params`, into DECODER_PARAMS_JSON); the gates read
# tests/golden/fits/decoder-params.json. Nothing writes the one from the other,
# so a record change could be measured, blessed and deployed as code while
# production went on decoding with the old numbers (the in-place spells once
# ran five days that way). This reads the Secret and compares the two as JSON
# values; CHECK_RECORD names another record to compare (its own test).
#
# Exit 0 when they match, 1 when they differ (each differing key printed),
# 2 when the Secret cannot be read. Writing the Secret is a production change
# made by hand; this only says that one is owed.
set -euo pipefail
HEALTH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_RECORD="${CHECK_RECORD:-$HEALTH_DIR/tests/golden/fits/decoder-params.json}"
[[ -f "$REPO_RECORD" ]] || { echo "check-decoder-record: no $REPO_RECORD (golden corpus absent)" >&2; exit 2; }
prod=$(ssh root@isis.xinutec.org "kubectl -n health get secret health-decoder -o jsonpath='{.data.params}'" | base64 -d) \
	|| { echo "check-decoder-record: cannot read Secret health-decoder" >&2; exit 2; }
PROD_RECORD="$prod" python3 - "$REPO_RECORD" <<'EOF'
import json, os, sys
prod = json.loads(os.environ["PROD_RECORD"])
repo = json.load(open(sys.argv[1]))
def flat(d, p=""):
    if isinstance(d, dict):
        out = {}
        for k, v in d.items(): out.update(flat(v, f"{p}.{k}"))
        return out
    return {p: d}
fp, fr = flat(prod), flat(repo)
diff = sorted(k for k in set(fp) | set(fr) if fp.get(k, "<absent>") != fr.get(k, "<absent>"))
if not diff:
    print("check-decoder-record: production's record matches the repo's")
    sys.exit(0)
print(f"check-decoder-record: production's record differs from the repo's in {len(diff)} key(s):", file=sys.stderr)
for k in diff[:20]:
    print(f"  {k}: production {json.dumps(fp.get(k, '<absent>'))[:80]} | repo {json.dumps(fr.get(k, '<absent>'))[:80]}", file=sys.stderr)
sys.exit(1)
EOF

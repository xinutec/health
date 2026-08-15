#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Grade a MINING change against the golden corpus, without re-capturing it.
#
# The problem this exists for: a day replay reads `inputs.knownPlaces` as a
# CAPTURED INPUT, so every change to the focus-place miner is invisible to
# golden. The obvious remedy — re-mine prod and re-capture the corpus — also
# refreshes every other prod input, and that drift has broken confirmed truth
# rows for reasons unrelated to the change under test (#379). It measures the
# wrong thing and costs a prod round trip to do it.
#
# So instead: mine into a file, copy the corpus, swap ONLY `knownPlaces`, and
# run the gate there. Everything else in the fixture is byte-identical, so any
# truth row that moves moved because of the mining.
#
#   scripts/mining-experiment.sh                 # mine fresh, then grade
#   scripts/mining-experiment.sh <places.json>   # re-use an earlier mining
#
# Writes nothing to prod (the miner runs `--dry-run`) and nothing to
# `tests/golden/` — the copy lives under a temp dir and is left in place so
# the two runs can be diffed afterwards. Prints where.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO"

: "${TMPDIR:=/tmp}"
WORK="$(mktemp -d "${TMPDIR%/}/mining-experiment.XXXXXX")"
PLACES="${1:-$WORK/known-places.json}"

echo "==> building" >&2
pnpm run build >/dev/null

if [ "$#" -eq 0 ]; then
	echo "==> mining (dry run, writes no prod rows)" >&2
	scripts/prod-db.sh node dist/cli/refresh-focus-places.js pippijn \
		--dry-run --emit-known-places "$PLACES" >&2
fi
[ -s "$PLACES" ] || {
	echo "no known-places file at $PLACES" >&2
	exit 1
}

# The corpus is large and only `days/` is rewritten; everything else the gate
# reads (ground truth, the floors, the baselines) is copied so the verdicts
# mean the same thing they do in place.
echo "==> copying the corpus to $WORK/tests/golden" >&2
mkdir -p "$WORK/tests"
cp -R tests/golden "$WORK/tests/golden"

echo "==> swapping knownPlaces into the copy" >&2
node dist/cli/patch-known-places.js "$WORK/tests/golden/days" "$PLACES" >&2

# `golden-check` resolves the corpus from the CWD, so running it from the copy
# is the whole of the redirection — no flag, no env var, nothing to leave set.
echo "==> grading the copy (tenants on, as deploy.sh does)" >&2
# `dist` is a SYMLINK, not a copy. Node resolves a module's realpath before
# looking for `node_modules`, so the linked build finds the repo's packages —
# while `process.cwd()` stays here, which is the whole of how `golden-check`
# gets pointed at the copied corpus. Copying `dist` instead strands it with no
# `node_modules` beside it and dies on the first import.
ln -sfn "$REPO/dist" "$WORK/dist"
cd "$WORK"
set +e
LEAN_KALMAN=on LEAN_GPSQUALITY=on LEAN_BIOLABELS=on LEAN_HSMM=on LEAN_RAIL=on \
	LEAN_MATCH=on LEAN_PASSES=on LEAN_STATIONCHAIN=shadow LEAN_CALL_TIMEOUT_MS=30000 \
	node dist/cli/golden-check.js
STATUS=$?
set -e

echo >&2
echo "==> corpus copy kept at $WORK/tests/golden (mining: $PLACES)" >&2
# The copy above was patched IN PLACE, so it is not the control — the control
# is a second copy that never gets patched, graded by the same build. Without
# it the numbers have nothing to be a difference from.
echo "==> the control arm is a SEPARATE, UNPATCHED copy — this one is patched:" >&2
echo "      CTRL=\$(mktemp -d \"\${TMPDIR%/}/mining-control.XXXXXX\")" >&2
echo "      mkdir -p \"\$CTRL/tests\" && cp -R $REPO/tests/golden \"\$CTRL/tests/golden\"" >&2
echo "      ln -sfn $REPO/dist \"\$CTRL/dist\" && cd \"\$CTRL\"" >&2
echo "      LEAN_KALMAN=on … node dist/cli/golden-check.js   # same tenants as above" >&2
exit $STATUS

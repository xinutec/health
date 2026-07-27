#!/usr/bin/env bash
set -euo pipefail
# Inner loop of scripts/recapture-golden-corpus.sh — runs INSIDE the prod-db.sh
# tunnel, with DB_* / NC_* / feature flags already exported. Not meant to be
# invoked directly (there would be no tunnel).
#
# One day failing to capture must not abandon the other thirty, so the capture
# call sits in an `if` — which `set -e` exempts, giving both properties at once:
# a failing day is recorded and skipped, while a failure ANYWHERE ELSE (a bad
# fixture, a missing binary) still aborts instead of silently producing a
# partial corpus. Failures are re-reported at the end with a non-zero exit.
#
# Optional args: specific dates to re-capture (default: every fixture on disk).

cd "$(dirname "${BASH_SOURCE[0]}")/.."

mapfile -t FILES < <(ls tests/golden/days/*.json | sort)
WANTED=("$@")

failed=()
done_count=0
total=0

for f in "${FILES[@]}"; do
	# One parse per fixture, not four — these files are tens of megabytes.
	# A fixture whose meta cannot be read is a hard stop, not a skip: the
	# corpus would come back quietly short of a day.
	IFS=$'\t' read -r date user tz desc < <(
		node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).meta;
		         console.log([m.date,m.user,m.tz,m.description??""].join("\t"))' "$f"
	)

	if [ ${#WANTED[@]} -gt 0 ]; then
		match=0
		for w in "${WANTED[@]}"; do [ "$w" = "$date" ] && match=1; done
		[ "$match" = 1 ] || continue
	fi
	total=$((total + 1))

	echo ""
	echo "=== [$total] re-capturing $date $user ($tz) ==="
	if node dist/cli/capture-golden.js "$date" "$user" "$tz" --description "$desc" 2>&1 | grep -Ev '^velocity .* total='; then
		done_count=$((done_count + 1))
	else
		echo "!!! FAILED $date $user"
		failed+=("$date")
	fi
done

echo ""
echo "=== re-captured $done_count/$total day(s) ==="
if [ ${#failed[@]} -gt 0 ]; then
	echo "FAILED: ${failed[*]}"
	exit 1
fi

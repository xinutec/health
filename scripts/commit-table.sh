#!/usr/bin/env bash
# The COMMIT gate table, derived from the full one.
#
#   scripts/commit-table.sh --write    regenerate gate-commit.json from gate.json
#   scripts/commit-table.sh --check    fail if gate-commit.json is not that
#
# gate.json (rendered from gate.dhall) is the FULL table and runs in deploy.sh.
# gate-commit.json is the same table minus the rows below, and is what the
# pre-commit hook and `pnpm run verify` run. See the last row of gate.dhall for
# why this is a projection rather than a second Dhall file.
#
# ⚠ Dropping a row here is a decision about what a commit may skip; every row
# named must be one deploy.sh still runs (it runs gate.json, so it is).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Names, exactly as gate.dhall spells them.
DEPLOY_ONLY=(
	"the in-process Rust host agrees with the spawned CLI"
	"reset the mode trace"
	"corpus replay gates (release)"
	"every dispatched Lean mode is executed by something"
	"the verified CLI packages (what the production image consumes)"
)

project() {
	local names
	names=$(printf '%s\n' "${DEPLOY_ONLY[@]}" | jq -R . | jq -s .)
	jq --argjson drop "$names" \
		'.checks |= map(select(.name as $n | $drop | index($n) | not))' gate.json
}

case "${1:-}" in
--write)
	project >gate-commit.json
	echo "gate-commit.json: $(jq '.checks | length' gate-commit.json) of $(jq '.checks | length' gate.json) rows"
	;;
--check)
	# Every dropped name must exist in the full table, or the list is stale.
	for n in "${DEPLOY_ONLY[@]}"; do
		jq -e --arg n "$n" '.checks | any(.name == $n)' gate.json >/dev/null ||
			{ echo "commit-table: no row named \"$n\" in gate.json" >&2; exit 1; }
	done
	diff <(project) gate-commit.json >/dev/null || {
		echo "commit-table: gate-commit.json is not gate.json minus its slow rows — run scripts/commit-table.sh --write" >&2
		diff <(project) gate-commit.json >&2 || true
		exit 1
	}
	;;
*)
	echo "usage: scripts/commit-table.sh --write | --check" >&2
	exit 2
	;;
esac

#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Print every golden day's SERVED timeline — the states, as the app would show
# them — so a ticket's boundaries can be re-derived instead of re-quoted.
#
# WHY THIS EXISTS. Adjudicating an open task almost always starts with "is that
# still where the ticket says it is?", and the answer is usually no: a day gets
# re-segmented and every timestamp written against it rots quietly. On
# 2026-09-11 four tasks (#185, #254, #386, #755) each needed the same replay,
# and each had at least one stale figure — a leg 1 minute off, a stop that no
# longer exists, a gap whose place had changed. Doing it by hand took two false
# starts. This is that replay, as a command.
#
# ⚠ IT IS NOT A GATE. It asserts nothing; it prints. The corpus gates decide
# whether the pipeline is right, and this shows you WHAT it currently says so a
# claim can be checked against it.
#
# ⚠ IT READS THE GITIGNORED CORPUS and prints real places and times, so its
# output is Pippijn's own data — do not paste it into a tracked file or a
# commit message (#860). A task is fine; those already carry place names.
#
#   scripts/replay-corpus-states.sh              # every day
#   scripts/replay-corpus-states.sh 2026-05-22   # one day, or any prefix
#
# Exit 2 when the corpus is absent — the ordinary case off this machine, and
# told apart from a real failure the same way the corpus tests do it.

cd "$(dirname "${BASH_SOURCE[0]}")/.."
only="${1:-}"
days_dir=tests/golden/days
[ -d "$days_dir" ] || { echo "SKIPPED: no corpus at $days_dir" >&2; exit 2; }

# Built rather than assumed: a stale binary would replay code that is not HEAD's,
# which is the failure this tool exists to avoid one level up.
cargo build --release -p day-shell --manifest-path rust/Cargo.toml >/dev/null
cargo build --release --example dump_day_request --manifest-path rust/backend/Cargo.toml >/dev/null

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

shown=0
for f in "$days_dir"/*.json; do
	stem=$(basename "$f" .json)
	[ -n "$only" ] && case "$stem" in "$only"*) ;; *) continue ;; esac
	if ! rust/target/release/examples/dump_day_request "$stem" >"$work/req.json" 2>/dev/null; then
		echo "$stem: no request (day is not replayable)" >&2
		continue
	fi
	if ! rust/target/release/day-shell --osm "$f" <"$work/req.json" 2>/dev/null |
		head -1 >"$work/out.json" || [ ! -s "$work/out.json" ]; then
		echo "$stem: no timeline (day-shell declined)" >&2
		continue
	fi
	shown=$((shown + 1))
	# ⚠ jq, NOT python. `/usr/bin/python3` on this Mac is an Xcode shim that
	# resolves through `xcrun`, and `nix develop` clears the environment it needs
	# — so it dies with "tool 'python3' not found" INSIDE the devShell while
	# working perfectly outside it. Same family as the SDKROOT breakage. jq is
	# already on PATH in both.
	jq -r --arg stem "$stem" '
		"== \($stem): \(.states | length) states (UTC)",
		( .states[]
		| if .startTs == null or .endTs == null
		  then "   (state with no bounds: \(.mode))"
		  else
		    ( (.startTs | strftime("%H:%M")) + "-" + (.endTs | strftime("%H:%M"))
		    + " " + (((.endTs - .startTs) / 60 | floor | tostring) | ("    " + .)[-5:]) + "m "
		    + ((.mode // "?") + "          ")[0:10] + " "
		    + ((.place // "-") + "                                  ")[0:34] + " "
		    + (.wayName // "-") )
		  end )
	' "$work/out.json"
done

[ "$shown" -gt 0 ] || { echo "no day matched ${only:-*} — a typo here reads as a clean run over nothing" >&2; exit 1; }
echo "replayed $shown day(s)" >&2

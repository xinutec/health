#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Catch the #424 day-gate wedge in the act and take its stack.
#
# The hang is INTERMITTENT — roughly one run in four — and every lead derived by
# reading has been refuted by measurement (the stderr-volume one, twice over).
# What has never been collected is the thing that would settle it: a stack from
# BOTH sides while they are stuck. This runs the gate until that happens.
#
# Why a watcher and not just a timeout: `DAY_BRIDGE_TIMEOUT_MS` is 120 s and
# SIGTERMs the child, which DESTROYS the evidence. The watcher fires well inside
# that window, so the dump is taken while both processes are still wedged.
#
# Usage:
#   scripts/catch-day-hang.sh          # 15 runs, or until one wedges
#   scripts/catch-day-hang.sh 40       # more runs
#
# Exit 0 = caught one, dumps are in the run dir. Exit 1 = ran clean every time,
# which is NOT evidence the deadlock is gone (three clean runs preceded the one
# that wedged on 2026-08-15).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

RUNS="${1:-15}"
# A day costs 1-3 s. Anything still alive at 25 s is wedged, not slow, and we
# still have ~95 s of the bridge timeout left to sample it in.
STUCK_AFTER_S="${STUCK_AFTER_S:-25}"
OUT="${OUT:-/tmp/day-hang-$$}"
mkdir -p "$OUT"

echo "==> catcher: $RUNS runs, stuck bar ${STUCK_AFTER_S}s, dumps in $OUT"

caught=0

# The watcher runs beside each gate run and dies with it. A watcher that
# outlives the thing it watches samples the NEXT run's healthy child and reports
# a stack that means nothing.
watch_for_wedge() {
	local run="$1" gate_pid="$2"
	local -A seen=()
	while kill -0 "$gate_pid" 2>/dev/null; do
		local now; now=$(date +%s)
		# verified_cli is the Lean side; compare-day is the node side. Both were
		# observed at 0.0% CPU, so both stacks are needed — one alone cannot say
		# which is waiting on the other.
		local pid
		for pid in $(pgrep -f 'verified_cli' 2>/dev/null || true); do
			if [[ -z "${seen[$pid]:-}" ]]; then
				seen[$pid]=$now
				continue
			fi
			local age=$(( now - seen[$pid] ))
			if (( age >= STUCK_AFTER_S )); then
				echo "==> WEDGE: verified_cli pid $pid stuck ${age}s (run $run)" | tee -a "$OUT/caught.txt"
				local node_pid
				node_pid=$(pgrep -f 'compare-day' | head -1 || true)
				{
					echo "### run=$run verified_cli=$pid node=$node_pid age=${age}s"
					echo "--- ps ---"; ps -o pid,ppid,%cpu,stat,wchan,command -p "$pid" ${node_pid:+-p "$node_pid"} || true
					echo "--- lsof verified_cli ---"; lsof -p "$pid" 2>/dev/null || true
					[[ -n "$node_pid" ]] && { echo "--- lsof node ---"; lsof -p "$node_pid" 2>/dev/null || true; }
				} >>"$OUT/wedge-run$run.txt" 2>&1
				# `sample` is the decisive one: it names the syscall each side is
				# parked in. It takes ~5 s and must finish before the 120 s bridge
				# timeout SIGTERMs the child out from under it.
				sample "$pid" 5 -file "$OUT/sample-verified_cli-run$run.txt" >/dev/null 2>&1 || true
				[[ -n "$node_pid" ]] && sample "$node_pid" 5 -file "$OUT/sample-node-run$run.txt" >/dev/null 2>&1 || true
				touch "$OUT/CAUGHT"
				return 0
			fi
		done
		sleep 2
	done
}

for run in $(seq 1 "$RUNS"); do
	echo "==> run $run/$RUNS"
	pnpm run day-gate >"$OUT/gate-run$run.log" 2>&1 &
	gate_pid=$!
	watch_for_wedge "$run" "$gate_pid" &
	watcher_pid=$!

	wait "$gate_pid" || true
	# Kill the watcher WITH the watched, always — including on the paths where
	# the gate failed rather than finished.
	kill "$watcher_pid" 2>/dev/null || true
	wait "$watcher_pid" 2>/dev/null || true

	# CANARY. The first version of this script had no `_devshell.sh` source, so
	# `pnpm` was not on PATH, all 15 runs died in milliseconds, and it reported
	# "15 runs, no wedge" — a sweep that reached NOTHING, worn as a clean result.
	# A hang-catcher that cannot tell "ran and did not wedge" from "never ran" is
	# worse than none, because it retires the suspicion it was built to test.
	if ! grep -qE '(IDENTICAL|SHELL ONLY|DIVERGED|TIMEOUT|LOOKUP MISS)' "$OUT/gate-run$run.log" 2>/dev/null; then
		echo "!!! run $run produced no gate verdict — the gate did not run. Aborting." >&2
		head -5 "$OUT/gate-run$run.log" >&2 || true
		exit 3
	fi

	if grep -q 'TIMEOUT' "$OUT/gate-run$run.log" 2>/dev/null; then
		echo "    run $run reported a TIMEOUT day — the bounded form of the wedge"
		grep -n 'TIMEOUT' "$OUT/gate-run$run.log" | head -3
	fi
	if [[ -e "$OUT/CAUGHT" ]]; then
		caught=1
		echo "==> caught on run $run; stacks in $OUT"
		break
	fi
done

if (( caught )); then
	echo "==> CAUGHT. Read $OUT/sample-*.txt first — the syscall each side is parked in."
	exit 0
fi

echo "==> $RUNS runs, no wedge. THIS IS NOT EVIDENCE THE DEADLOCK IS GONE:"
echo "    three clean runs of the same build preceded the one that wedged."
exit 1

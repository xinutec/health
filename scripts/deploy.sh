#!/usr/bin/env bash
# Deploy the health-sync app end-to-end.
#
# ⚠ NO nix-shell SHEBANG. It was `#!nix-shell -i bash -p git gh`, pinning both to
# the default channel because a non-channel `gh` was said to 401 against the
# macOS keyring. Re-measured 2026-08-29 (health #950) and the premise does not
# reproduce: the home-manager `gh` 2.93.0 and a `nix-shell -p gh` 2.89.0 both
# read the same keyring entry and both report `✓ Logged in ... (keyring)`.
# git, gh and git-crypt have been in home-manager's `home.packages` since
# 2026-06-28, so the shebang was buying 1.79 s of nix-shell startup per run
# against 0.01 s for bash, plus a git one minor version behind the one on PATH.
#
# Node is sourced per-command from the flake devShell (`nix develop`,
# rev-pinned via flake.lock — same single source of truth as every other
# script; see scripts/_devshell.sh). This is deliberate: the ambient nix
# channel drifts to a too-old Node and the Angular 22 build hard-requires
# >= 24.15. git/gh stay on the shebang's default-channel nix-shell — a
# non-default-channel gh can't read the macOS keyring (401), so it must
# NOT come from the pinned flake.
# (2026-06-29 Angular 21->22 + zoneless migration; Node 22->24.)
#
# Runs the FULL gate ONCE — `pnpm run verify:deploy` = gate.json, every row,
# including the 42-day corpus replay that can only run here (the fixtures are
# gitignored) — commits all changes in this repo WITHOUT the hook (its table,
# gate-commit.json, is a subset of what just ran), pushes to main, waits for
# CI, then rolls out the new image on isis. The k8s manifests live in the home
# monorepo (xinutec/pippijn code/kubes/health/k8s).
#
# ⚠ Until 2026-09-17 this ran the gate table, then the corpus replay again on
# its own, then `git commit` ran the hook's copy of the whole table: two gates
# and three corpus replays per deploy, ~45 min. The table runs once now.
#
# WHAT THIS DOES NOT DO — do not read the gates above as controlling what
# reaches production. This script BUILDS NOTHING: `.github/workflows/
# build.yml` pushes `xinutec/health-sync:latest` on every push to main,
# gated only on CI's verify (typecheck / lint / unit tests / lean-check —
# never the replay gates, which need the gitignored corpus CI cannot
# have). Every CronJob in the health namespace pulls `:latest` per
# invocation, so a green CI run puts new classification code into
# production the next time a cron fires, with no replay gate in front of
# it. Step 6 restarts ONE Deployment — health-auth — which is the only
# workload that does not re-pull on its own, and therefore the only thing
# these gates actually gate. Measured and written down 2026-08-14 (#813),
# where the two ways to end that asymmetry are set out.
#
# Usage:
#   scripts/deploy.sh -m "commit message"
#   scripts/deploy.sh -F /path/to/message.txt
#
# git / gh / git-crypt come from home-manager's `home.packages`; node comes
# per-command from the flake devShell (below).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"   # this repo's root

if [[ ! -d "$HEALTH_DIR/.git" ]]; then
	echo "deploy: expected the health git repo at $HEALTH_DIR" >&2
	exit 2
fi

# --- argument parsing ----------------------------------------------------
MSG_FILE=""

# ⚠ THE SKIP MUST NAME A REASON. `DEPLOY_SKIP_GOLDEN=1` is refused: a bare `1`
# records that someone wanted past the gates and not why, and the second use is
# always easier than the first. Set it to the reason —
#
#   DEPLOY_SKIP_GOLDEN="health #1052: the 06-16 truth rows need a re-audit"
#
# — and the reason is printed here and again at the end, so a deploy that
# skipped nine gates cannot read like an ordinary one.
if [[ -n "${DEPLOY_SKIP_GOLDEN:-}" && "${DEPLOY_SKIP_GOLDEN}" == "1" ]]; then
	cat >&2 <<-'REFUSE'
	DEPLOY_SKIP_GOLDEN=1 is refused: give the REASON instead of a 1.

	    DEPLOY_SKIP_GOLDEN="health #1052: the 06-16 truth rows need a re-audit" \
	      ./scripts/deploy.sh -m '...'

	It disables NINE gates. Naming why is the difference between a considered
	exception and a habit.
	REFUSE
	exit 2
fi
CLEANUP_MSG_FILE=0
case "${1:-}" in
	-m)
		[[ -n "${2:-}" ]] || { echo "deploy: -m requires a message" >&2; exit 2; }
		MSG_FILE=$(mktemp -t deploy-msg.XXXXXX)
		CLEANUP_MSG_FILE=1
		printf '%s\n' "$2" > "$MSG_FILE"
		;;
	-F)
		[[ -n "${2:-}" && -f "${2}" ]] || { echo "deploy: -F needs an existing file" >&2; exit 2; }
		MSG_FILE="$2"
		;;
	*)
		echo "Usage: $0 -m 'commit message' | -F message-file" >&2
		exit 2
		;;
esac

cleanup() {
	# Preserve the script's real exit status. Under `set -e`, an EXIT
	# trap whose last command fails clobbers the exit code — and on a
	# `-F` run CLEANUP_MSG_FILE is 0, so the `[[ ]]` test below is
	# false, which used to turn every successful deploy into exit 1.
	local rc=$?
	if [[ "$CLEANUP_MSG_FILE" -eq 1 && -f "$MSG_FILE" ]]; then
		rm -f "$MSG_FILE"
	fi
	return "$rc"
}
trap cleanup EXIT

# --- verify --------------------------------------------------------------
# The Angular 22 frontend build needs Node >= 24.15; the flake devShell
# pins it (24.18 at the current lock). Sourced per-command via `nix
# develop` so it layers over — not shadows — the shebang's gh. HEALTH_DEVSHELL=1
# tells any nested health script it is already
# inside the devShell, so it skips its own re-exec.
DEV="nix develop $HEALTH_DIR -c env HEALTH_DEVSHELL=1"
# The replay gates that compared two arms died with the TypeScript backend
# (#975) and have no successor by construction. The single-arm ones came back
# in Rust against Lean and run in the full table. What is gone is coverage
# LOST, not waived — #1048 holds it — and a deploy says so at the start and at
# the end, because a check that goes quiet is worse than one that goes red.
dead_gates_banner() {
	cat >&2 <<-BANNER

	================================================================
	  ⚠  REPLAY GATES WITH NO SUCCESSOR — coverage lost, not skipped
	================================================================
	    day gate (Lean vs the TypeScript it ported)
	    focus gate                compare-match
	    golden with tenants ON
	================================================================
	  deleted with the TS backend, #975 (06346bd, 2026-08-26)
	  held at health #1048 — do not treat this deploy as gated by them
	  walks, truth, journeys, day, the decoder scoreboard and the
	  re-decode run in the full gate (gate.json).
	================================================================

	BANNER
}

cd "$HEALTH_DIR"
if [[ -z "${DEPLOY_SKIP_GOLDEN:-}" ]]; then
	echo "==> [1/6] the full gate: pnpm run verify:deploy (gate.json, corpus replay included)"
	dead_gates_banner
	DEAD_GATES=1
	$DEV pnpm run verify:deploy
else
	# ⚠ The COMMIT table only: everything but the corpus replay, the host/CLI
	# equivalence, the mode-reachability pair and the sandboxed CLI build —
	# `scripts/commit-table.sh` is the list. Announced here and again at the end.
	echo "==> [1/6] the commit gate ONLY: pnpm run verify (gate-commit.json) — replay SKIPPED"
	cat >&2 <<-BANNER

	================================================================
	  ⚠  DEPLOYING WITH THE REPLAY GATES SKIPPED
	  reason: ${DEPLOY_SKIP_GOLDEN}
	================================================================
	    corpus_gate  hsmm_decode_corpus  (and the host/CLI equivalence,
	    mode reachability, the sandboxed CLI build)
	================================================================

	BANNER
	SKIPPED_GOLDEN=1
	$DEV pnpm run verify
fi


# --- stage + commit ------------------------------------------------------
echo "==> [2/6] staging changes"
cd "$HEALTH_DIR"
git add -A

# --- commit + push -------------------------------------------------------
# Nothing staged is NOT nothing to deploy: work committed by hand (the normal
# case when a fix had to be gated and reviewed before it could ship) is already
# in HEAD. Exiting here made such a commit undeployable by this script — the
# 5ef3517 walk fix sat committed and unshippable until this was fixed. Skip the
# commit, deploy what HEAD already says.
if git diff --cached --quiet; then
	echo "==> [3/6] git commit — nothing staged; deploying the existing HEAD"
else
	echo "==> [3/6] git commit (--no-verify: the hook's table is a subset of step 1)"
	git commit --no-verify -F "$MSG_FILE"
fi

COMMIT_SHA=$(git rev-parse HEAD)
echo "    HEAD is now $COMMIT_SHA"

echo "==> [4/6] git push origin main"
git push origin main

# --- wait for CI ---------------------------------------------------------
# Find the CI run that matches THIS commit's SHA. `gh run list --limit 1`
# would race: between push and gh-list the previous commit's run is often
# still the freshest, and gh run watch on an already-completed run exits
# in ~0 ms, which then rolls out the stale image. Poll until a run for
# our specific SHA shows up (Actions usually queues within a few seconds).
echo "==> [5/6] watching CI for $COMMIT_SHA"
cd "$HEALTH_DIR"
RUN_ID=""
for attempt in $(seq 1 30); do
	RUN_ID=$(gh run list --branch main --limit 10 --json databaseId,headSha \
		--jq ".[] | select(.headSha == \"$COMMIT_SHA\") | .databaseId" | head -1)
	if [[ -n "$RUN_ID" ]]; then
		echo "    found run $RUN_ID after $attempt attempt(s)"
		break
	fi
	sleep 2
done
if [[ -z "$RUN_ID" ]]; then
	echo "deploy: no CI run for $COMMIT_SHA appeared within ~60s" >&2
	exit 1
fi
# Bound the CI wait. `gh run watch` polls until the run finishes — with
# no ceiling, a stuck Actions queue (a real ~5-hour stall has happened)
# would hang the deploy indefinitely. Cap it at 30 min — ⚠ NOT 15: the image build takes 20-23 min (three runs on
# 2026-09-17: 21, 23, 20), so a 15-min cap failed every deploy at step 5 and
# left the rollout undone, reading as a CI fault. A normal build
# is ~1 min, so anything past 15 is wedged — fail fast, before rollout.
ci_status=0
timeout 1800 gh run watch --exit-status "$RUN_ID" || ci_status=$?
if [[ $ci_status -ne 0 ]]; then
	if [[ $ci_status -eq 124 ]]; then
		echo "deploy: CI run $RUN_ID did not finish within 30 min — aborting before rollout." >&2
		echo "        Inspect or cancel it: gh run view $RUN_ID  |  gh run cancel $RUN_ID" >&2
	else
		echo "deploy: CI run $RUN_ID failed (exit $ci_status) — aborting before rollout." >&2
	fi
	exit 1
fi

# --- rollout -------------------------------------------------------------
echo "==> [6/6] rollout on isis"
ssh root@isis.xinutec.org \
	'kubectl -n health rollout restart deploy/health-auth && kubectl -n health rollout status deploy/health-auth --timeout=180s'

if [[ -n "${DEAD_GATES:-}" ]]; then
	cat >&2 <<-BANNER

	⚠ THE TWO-ARM REPLAY GATES NO LONGER EXIST — #975 deleted them with the
	   TypeScript backend: the day gate, the focus gate, compare-match and the
	   golden pass with tenants on. This deploy was NOT checked against them.
	   Held at #1048.
	BANNER
fi
if [[ -n "${SKIPPED_GOLDEN:-}" ]]; then
	# Again at the END. The banner above is thousands of lines back by now, and a
	# deploy is judged by its last line.
	cat >&2 <<-BANNER

	⚠ THIS DEPLOY SKIPPED NINE GATES — ${DEPLOY_SKIP_GOLDEN}
	   The day gate, the golden corpus and the walk ratchet did NOT run.
	BANNER
fi
echo "==> done."

#!/usr/bin/env nix-shell
#!nix-shell -i bash -p git gh
# Deploy the health-sync app end-to-end.
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
# Runs `npm run verify` (typecheck + lint + tests), then the local
# fixture gates (`npm run golden` + `npm run walk-gate` — these can
# only run here, the fixtures are gitignored), commits all changes in
# this repo, pushes to main, waits for CI, then rolls out the new image
# on isis. The k8s manifests live in the home monorepo (xinutec/pippijn
# code/kubes/health/k8s); this repo builds xinutec/health-sync:latest.
#
# Usage:
#   scripts/deploy.sh -m "commit message"
#   scripts/deploy.sh -F /path/to/message.txt
#
# The shebang pulls in git / gh via nix-shell so you can run the script
# directly on macOS; node comes per-command from the flake devShell (below).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"   # this repo's root

if [[ ! -d "$HEALTH_DIR/.git" ]]; then
	echo "deploy: expected the health git repo at $HEALTH_DIR" >&2
	exit 2
fi

# --- argument parsing ----------------------------------------------------
MSG_FILE=""
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
# tells any nested health script (npm run golden -> golden.sh) it is already
# inside the devShell, so it skips its own re-exec.
DEV="nix develop $HEALTH_DIR -c env HEALTH_DEVSHELL=1"
echo "==> [1/7] npm run verify (node from flake devShell)"
cd "$HEALTH_DIR"
$DEV npm run verify

# --- golden + geometry gates ---------------------------------------------
# The deterministic fixture gates: day-state snapshot diff (incl. worldline
# feasibility + the journey ratchet) and the walk-geometry ratchet. Both are
# zero-DB replays of the local fixtures under tests/golden/ — gitignored, so
# CI can never run them; the deploy path is the only place they can gate.
# Skip only with DEPLOY_SKIP_GOLDEN=1 (e.g. an infra-only change while a
# bless is in flight).
if [[ "${DEPLOY_SKIP_GOLDEN:-0}" != "1" ]]; then
	echo "==> [2/7] golden corpus + walk-geometry ratchet"
	$DEV npm run golden
	$DEV npm run walk-gate
else
	echo "==> [2/7] SKIPPED golden + walk-gate (DEPLOY_SKIP_GOLDEN=1)"
fi

# --- stage + commit ------------------------------------------------------
echo "==> [3/7] staging changes"
cd "$HEALTH_DIR"
git add -A

# Nothing to commit? Exit clean rather than creating an empty commit.
if git diff --cached --quiet; then
	echo "deploy: nothing staged — nothing to deploy."
	exit 0
fi

# --- commit + push -------------------------------------------------------
echo "==> [4/7] git commit"
git commit -F "$MSG_FILE"

COMMIT_SHA=$(git rev-parse HEAD)
echo "    HEAD is now $COMMIT_SHA"

echo "==> [5/7] git push origin main"
git push origin main

# --- wait for CI ---------------------------------------------------------
# Find the CI run that matches THIS commit's SHA. `gh run list --limit 1`
# would race: between push and gh-list the previous commit's run is often
# still the freshest, and gh run watch on an already-completed run exits
# in ~0 ms, which then rolls out the stale image. Poll until a run for
# our specific SHA shows up (Actions usually queues within a few seconds).
echo "==> [6/7] watching CI for $COMMIT_SHA"
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
# would hang the deploy indefinitely. Cap it at 15 min: a normal build
# is ~1 min, so anything past 15 is wedged — fail fast, before rollout.
ci_status=0
timeout 900 gh run watch --exit-status "$RUN_ID" || ci_status=$?
if [[ $ci_status -ne 0 ]]; then
	if [[ $ci_status -eq 124 ]]; then
		echo "deploy: CI run $RUN_ID did not finish within 15 min — aborting before rollout." >&2
		echo "        Inspect or cancel it: gh run view $RUN_ID  |  gh run cancel $RUN_ID" >&2
	else
		echo "deploy: CI run $RUN_ID failed (exit $ci_status) — aborting before rollout." >&2
	fi
	exit 1
fi

# --- rollout -------------------------------------------------------------
echo "==> [7/7] rollout on isis"
ssh root@isis.xinutec.org \
	'kubectl -n health rollout restart deploy/health-auth && kubectl -n health rollout status deploy/health-auth --timeout=180s'

echo "==> done."

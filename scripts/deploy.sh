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
# Runs `pnpm run verify` (typecheck + lint + tests), then the replay gates
# in step 2 (count the commands there — golden, walk-gate, score-decoder,
# day-gate, focus-gate, golden with the Lean tenants on, golden-hsmm; they
# can only run here, the fixtures are gitignored), commits all changes in
# this repo, pushes to main, waits for CI, then rolls out the new image
# on isis. The k8s manifests live in the home monorepo (xinutec/pippijn
# code/kubes/health/k8s).
#
# WHAT THIS DOES NOT DO — do not read the gates above as controlling what
# reaches production. This script BUILDS NOTHING: `.github/workflows/
# build.yml` pushes `xinutec/health-sync:latest` on every push to main,
# gated only on CI's verify (typecheck / lint / unit tests / lean-check —
# never the replay gates, which need the gitignored corpus CI cannot
# have). Every CronJob in the health namespace pulls `:latest` per
# invocation, so a green CI run puts new classification code into
# production the next time a cron fires, with no replay gate in front of
# it. Step 7 restarts ONE Deployment — health-auth — which is the only
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
# tells any nested health script (pnpm run golden -> golden.sh) it is already
# inside the devShell, so it skips its own re-exec.
DEV="nix develop $HEALTH_DIR -c env HEALTH_DEVSHELL=1"
echo "==> [1/7] pnpm run verify (node from flake devShell)"
cd "$HEALTH_DIR"
$DEV pnpm run verify

# --- golden + geometry + decoder gates ------------------------------------
# The deterministic fixture gates: day-state snapshot diff (incl. worldline
# feasibility + the journey ratchet), the walk-geometry ratchet, and the
# decoder scoreboard. All are zero-DB replays of the local fixtures under
# tests/golden/ — gitignored, so CI can never run them; the deploy path is the
# only place they can gate. Skip only with DEPLOY_SKIP_GOLDEN=1 (e.g. an
# infra-only change while a bless is in flight).
#
# score-decoder joined this list on 2026-07-29 because it had gone red
# unnoticed: it was in no gate at all, so a scoreboard regression could sit
# there indefinitely. It had — 2026-05-22 phantomRides 0 → 1, which turned out
# to be the NARRATIVE getting sharper (an `unclear` row upgraded to `wrong
# {user}`, so it became enforceable and could convict a leg) rather than any
# decoder change. Harmless in the end, but nothing would have said so. Ordered
# last of the three because it is the newest and the noisiest.
#
# day-gate joined on 2026-08-04 (#426). It is the only thing in the repo that
# asks whether a Lean port has drifted from the TS it ports, and until it existed
# nothing did: `pickBestStation` went stale against #373 and was found by reading
# (#417); the underground trio went five commits and ~300 lines behind and was
# found by a fold abort on the first real day it ran (#425). The alternative — a
# timestamp sweep flagging any `Verified/**.lean` older than a `src/**.ts` its
# docstring names — over-reports: a TS commit touching a file need not touch the
# ported function.
#
# Its bar is ABSOLUTE, not a ratchet: every day IDENTICAL or SHELL ONLY, no
# baseline to bless a divergence into. Verified red as well as green — a TS-only
# change to the enricher's sample count reddens it on the first two days tried,
# and reddens it as a LOOKUP MISS naming the coordinate, which is the localised
# signal rather than a downstream field diff.
#
# It covers four Lean stages as of #430 — the biometric splits and the stay
# bridge, the five corrections before the cascade, the 38 passes, and the six
# stages after them — and compares all five boundaries between them, so a
# divergence is named where it happens rather than where it surfaces. The splits
# are a second sub-chain, not chained to the rest: the OSM enrichment loop runs
# between them and is not ported.
#
# 50 s for 33 days, so its place in this list is not a cost question.
#
# focus-gate joined on 2026-08-05 (#435) and asks the same question about the
# OTHER end of the pipeline. The day gate reaches everything `computeVelocity`
# runs; it reaches nothing the weekly `refresh-focus-places` cron runs, so
# `Verified.Geo.FocusPlaces` (800 lines) and `Verified.Geo.FocusIdentity` were
# guard-pinned and nothing else — a guard is a snapshot of V8 at porting time
# and keeps passing while the TS moves, which is exactly how #417 happened.
#
# Same absolute bar, no baseline. It replays each golden day's PhoneTrack fixes
# through `detectFocusPlaces`, then the whole corpus at once — the shape the
# cron actually runs on, and the only input that reaches the long-span
# classification branches — and finally the captured conflated café/residence
# cluster through `splitCluster`. 8 s for 35 cases.
# ⚠ EIGHT OF THIS BLOCK'S GATES DIED WITH THE TYPESCRIPT BACKEND (#975, 06346bd,
# 2026-08-26), not the four this banner claimed until 2026-08-29. The first four
# — `golden`, `golden` with tenants ON, `day-gate`, `golden-hsmm` — lost their
# package.json scripts with `src/` and were noticed. The other four were not:
# `walk-gate`, `score-decoder`, `focus-gate` and `compare-match` kept their
# entries and kept being invoked here.
#
# ⚠ AND THEY DID NOT FAIL AT `node dist/`, WHICH IS WHY IT WENT UNSEEN FOR THREE
# DAYS. Each begins `pnpm run build >/dev/null`, and `package.json` has had no
# `build` script since 06346bd. So they died one line EARLIER than anyone was
# looking, printing `==> building` and nothing else. Measured 2026-08-29:
# `walk-gate.sh` exits 1 with that as its entire output.
#
# The consequence was not a silent pass. `set -euo pipefail` means step 2
# ABORTED at the first of them — so this block has been unable to complete since
# 06346bd.
#
# ⚠ AND IT STAYED UNABLE AFTER THE 2026-08-29 REPAIR. That pass removed the eight
# and kept `compare-gps-outliers`, calling it "the one gate that still works";
# measured 2026-09-01, it exits 1 on a deleted `src/` import. Believing it was a
# survivor took checking that its script EXISTED and that it did not share the
# others\' `pnpm run build` failure — neither of which is running it. Three
# harnesses that do run replaced it (#1301).
#
# They are removed from the run rather than left to fail, and their loss is
# announced at the start and again at the end, on the same argument as the skip
# banner below: a deploy is judged by its last line, and a check that goes quiet
# is worse than one that goes red. The coverage is GONE, not waived — #1048 is
# where that is held.
dead_gates_banner() {
	cat >&2 <<-BANNER

	================================================================
	  ⚠  FIVE GATES NO LONGER EXIST — coverage lost, not skipped
	================================================================
	    golden with tenants ON    golden-hsmm
	    day gate                  decoder scoreboard
	    focus gate                compare-match
	================================================================
	  deleted with the TS backend, #975 (06346bd, 2026-08-26)
	  held at health #1048 — do not treat this deploy as gated by them
	  THREE came back 2026-08-31/09-01 and run in step 2 below.
	================================================================

	BANNER
}

# The other half of the same lesson: a gate whose script vanishes must say so by
# name, not die inside `pnpm` with an exit code and no subject. Everything below
# is checked to exist before any of it runs, so the NEXT deletion of a producer
# is caught here instead of at whichever call site happens to be first.
require_pnpm_scripts() {
	local missing=()
	for s in "$@"; do
		$DEV node -e "process.exit(require('./package.json').scripts['$s']?0:1)" \
			|| missing+=("$s")
	done
	if (( ${#missing[@]} )); then
		echo "==> [2/7] ABORT: package.json has no script named: ${missing[*]}" >&2
		echo "    A gate's script was deleted without its call site. See #1048 for" >&2
		echo "    the last time this happened (#975 took EIGHT of them, and this" >&2
		echo "    guard missed four because it checks that a package.json ENTRY" >&2
		echo "    exists, not that the script it names can RUN)." >&2
		exit 1
	fi
}

if [[ -z "${DEPLOY_SKIP_GOLDEN:-}" ]]; then
	echo "==> [2/7] corpus replay gates — walk geometry, the truth floor, the journey floor"
	dead_gates_banner
	DEAD_GATES=1
	# ⚠ `compare-gps-outliers` USED TO BE THIS STEP, described as "the one replay
	# gate that still runs". IT DID NOT RUN. Measured 2026-09-01: it exits 1 with
	# ERR_MODULE_NOT_FOUND on `src/hmm/gps-outliers.js`, deleted at 06346bd — so
	# under `set -euo pipefail` this block has been unable to complete since
	# 2026-08-26, and the 2026-08-29 repair that removed eight corpses around it
	# did not change that.
	#
	# ⚠ AND IT FAILED FOR THE REASON `require_pnpm_scripts` ALREADY NAMES in its
	# own abort message: that guard checks a package.json ENTRY EXISTS, not that
	# what it names can RUN. The 08-29 pass checked the `pnpm run build` failure
	# mode the other eight shared and stopped one layer short of the import. The
	# script is deleted now (#1301) rather than left as a name that lies.
	#
	# What replaces it is three harnesses that DO run, in Rust against Lean, with
	# no TypeScript arm to lose. They replay the gitignored corpora — which is
	# why they belong here and not in gate.dhall — and each gates a committed
	# floor a human blessed from the TypeScript before it went:
	#
	#   walk_gate        238 walks over 42 days vs walk-baseline.json
	#   truth_corpus     312 confirmed ground-truth rows vs truth-baseline.json
	#   journey_corpus    80 of 92 journeys vs journey-baseline.json
	#
	# ~7 minutes, of which walk_gate is ~5. They announce a SKIP rather than
	# passing quietly when the corpus is absent, so a machine without it cannot
	# read as gated.
	$DEV cargo test --manifest-path rust/Cargo.toml -p backend --release \
		--test walk_gate --test truth_corpus --test journey_corpus -- --nocapture
else
	# ⚠ ONE gate, by name. This message has twice outlived what it describes: it
	# once said "golden + walk-gate + score-decoder" while skipping six more, and
	# then named five while four of those could no longer run at all.
	cat >&2 <<-BANNER

	================================================================
	  ⚠  DEPLOYING WITH THE REPLAY GATES SKIPPED
	  reason: ${DEPLOY_SKIP_GOLDEN}
	================================================================
	    walk_gate  truth_corpus  journey_corpus
	================================================================
	  the other five do not run either way — deleted with the TS
	  backend, #975/#1048
	================================================================

	BANNER
	SKIPPED_GOLDEN=1
fi

# --- stage + commit ------------------------------------------------------
echo "==> [3/7] staging changes"
cd "$HEALTH_DIR"
git add -A

# --- commit + push -------------------------------------------------------
# Nothing staged is NOT nothing to deploy: work committed by hand (the normal
# case when a fix had to be gated and reviewed before it could ship) is already
# in HEAD. Exiting here made such a commit undeployable by this script — the
# 5ef3517 walk fix sat committed and unshippable until this was fixed. Skip the
# commit, deploy what HEAD already says.
if git diff --cached --quiet; then
	echo "==> [4/7] git commit — nothing staged; deploying the existing HEAD"
else
	echo "==> [4/7] git commit"
	git commit -F "$MSG_FILE"
fi

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

if [[ -n "${DEAD_GATES:-}" ]]; then
	cat >&2 <<-BANNER

	⚠ FOUR GATES DID NOT RUN AND NO LONGER EXIST — #975 deleted them with the
	   TypeScript backend: the golden corpus (both passes), the day gate and
	   golden-hsmm. This deploy was NOT checked against them. Held at #1048.
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

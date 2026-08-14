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
if [[ "${DEPLOY_SKIP_GOLDEN:-0}" != "1" ]]; then
	echo "==> [2/7] golden corpus + walk-geometry ratchet + decoder scoreboard + Lean day/focus parity"
	$DEV pnpm run golden
	$DEV pnpm run walk-gate
	$DEV pnpm run score-decoder
	$DEV pnpm run day-gate
	$DEV pnpm run focus-gate
	# Second pass, tenants ON: the ONLY place the verified Lean core is executed
	# by a gate. Everything above runs with all seven flags `off`, so a broken
	# bridge, a divergence, or a tenant that never ran could all ship — the arm
	# simply is not consulted (#392).
	#
	# `on` rather than `shadow` deliberately. `shadow` runs both arms and serves
	# TS, so the 32/32 fixture diff would still be measuring TS and only the
	# ledger would speak. Under `on` the corpus diff is ALSO a statement about
	# Lean's output: 32/32 means serving the verified core reproduces every
	# blessed day byte-for-byte.
	#
	# Not a substitute for the `compare-*.mts` referees and not substituted BY
	# them: those feed raw fixes, which is exactly how #393's 17° bearing case
	# hid from `compare-kalman` while the pipeline exercised it every day. This
	# runs the real serving path on real days.
	#
	# hsmm, rail and stationchain are staged too even though the corpus cannot
	# reach them — `gateLedgers` prints their waiver each run, and turns it into
	# a STALE WAIVER report the moment the corpus does reach one.
	#
	# ALL SEVEN tenants run `on` here as of #403 — `match` and `passes` included,
	# which they were not until the ceiling existed to hold their standing debt.
	#
	# The two were excluded because both serve or shadow in production while
	# carrying UNEXPLAINED divergences, so staging them failed the run on a
	# pre-existing condition, and the only lever to hand was widening the
	# accepted-delta manifests — recording "we checked this and it is fine" about
	# legs nobody had checked. `tests/golden/lean-delta-baseline.json` is the
	# honest third option: a one-way ceiling of un-adjudicated fingerprints that
	# may shrink and never grow. It carries one entry today (a `simplify` DP
	# near-tie at n=72); `match` is clean on this corpus modulo its signed
	# manifest. That does NOT retire the instruction below — a ceiling entry is
	# debt, an accepted delta is a judgement, and the two must not merge.
	#
	# Do not close a gap here by widening the accepted-delta manifests.
	#
	# LEAN_CALL_TIMEOUT_MS is raised for the same reason the cron raises it: the
	# walk matcher is a real computation, and on the heaviest legs the 5 s
	# request-path default expires and falls back to TS. That fallback is silent
	# by construction, so at the default this gate FAILED on a swallowed bridge
	# call roughly at random depending on machine load — a nondeterministic gate,
	# measuring the host rather than the code.
	echo "==> [2/7] golden corpus again, with ALL SEVEN Lean tenants ON"
	$DEV LEAN_KALMAN=on LEAN_GPSQUALITY=on LEAN_BIOLABELS=on LEAN_HSMM=on LEAN_RAIL=on \
		LEAN_MATCH=on LEAN_PASSES=on LEAN_STATIONCHAIN=shadow LEAN_CALL_TIMEOUT_MS=30000 pnpm run golden

	# The station-chain tenant (#711), on the one gate that can REACH it. The
	# run above waives it for the same #233 reason it waives hsmm and rail — the
	# corpus replays cached decodes, so `segmentsFromStates` never runs and the
	# resolver with it. `golden-hsmm` decodes the eleven fixtures for real, and
	# gates the ledger with no waiver available at all.
	#
	# It is a deploy gate rather than a CI one because it needs the gitignored
	# `tests/golden/decoded_days` corpus, exactly as `pnpm run golden` above
	# does. `shadow` not `on`: this tenant writes (its output is persisted to
	# `decoded_days`), so serving it is a decision, not a gate setting.
	$DEV LEAN_STATIONCHAIN=shadow LEAN_CALL_TIMEOUT_MS=30000 pnpm run golden-hsmm

	# The HSMM outlier filter's ONLY evidence (#695). `Verified.Hsmm.GpsOutliers`
	# has no tenant, no ledger and no gate — unlike `GpsQuality`, whose
	# comparator can stay a hand-run referee because `LEAN_GPSQUALITY` serves it
	# daily and prints a verdict. So this comparator is the whole of what stands
	# behind that module, and leaving it hand-run would repeat #9's hazard in
	# miniature: a check that exists, is never run, and quietly stops being true.
	#
	# Cheap enough that there is no argument against it — 11 fixtures, ~2 s
	# total, against the ~12 min the matcher gate below costs. It replays the
	# gitignored `decoded_days` corpus, which is why it belongs here rather than
	# in gate.dhall, exactly like the three around it.
	$DEV pnpm run compare-gps-outliers

	# The MATCHER FLIP GATE (#9). Until now `compare-match` appeared in
	# package.json and nowhere else — not here, not gate.dhall, not any script
	# that runs unattended. So a three-arm bit-exact comparison existed and
	# nothing failed when it stopped being true, which is the hazard
	# ledger-verdict.ts was written for one layer down (#387): printing evidence
	# is not enforcing it.
	#
	# It asserts three conditions the run above cannot:
	#   COVERAGE    legs were actually matched (a run that matched nothing
	#               reports a clean sweep of nothing);
	#   NO FALLBACK quant↔Lean bit-exact on every leg, so serving Lean IS serving
	#               the verified twin and nothing silently diverges from it;
	#   AGREEMENT   every float↔quant divergence is in the signed-off manifest,
	#               adjudicated on all THREE axes a leg can move in — line,
	#               vertex, and timestamp (#401).
	#
	# It also reports manifest COVERAGE: entries whose leg no longer appears are
	# named as RESOLVED / RE-FINGERPRINTED / NOT COVERED rather than vanishing
	# silently (#662). None of those fail the run; they are how a re-keying
	# announces itself as one act instead of as N new findings.
	#
	# A deploy gate rather than a CI one for the same reason as the two above: it
	# replays the gitignored `tests/golden/days` corpus. It is the SLOWEST of the
	# three (~12 min, 208 legs each through three matchers), which is the price of
	# the only check that compares the served arm against the verified one on
	# real days.
	#
	# This gate going red does NOT mean production is wrong — LEAN_MATCH is
	# `shadow`, so the TS matcher is what serves. It means the manifest no longer
	# describes the corpus, and the fix is to adjudicate the leg it names, never
	# to widen the manifest to match.
	$DEV LEAN_CALL_TIMEOUT_MS=30000 pnpm run compare-match --gate
else
	echo "==> [2/7] SKIPPED golden + walk-gate + score-decoder (DEPLOY_SKIP_GOLDEN=1)"
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

echo "==> done."

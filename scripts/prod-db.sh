#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Run a command with a tunnel open to the prod health-db.
#
# Opens an SSH-forwarded connection to the prod MariaDB and exports the
# env a health-sync CLI needs — DB_HOST/PORT/USER/PASSWORD/NAME,
# NC_CLIENT_ID/SECRET, NC_BASE_URL, TZ=UTC — pulled live from the
# running pod. Then runs the given command and tears the tunnel down.
#
# Usage:
#   scripts/prod-db.sh bin/backend coverage
#   scripts/prod-db.sh bin/backend freshness
#   scripts/prod-db.sh bin/backend zones-census
#
# The command runs locally against 127.0.0.1:13306 -(ssh)-
# svc/health-db:3306. Build the binary yourself first (`cargo build --bin
# backend`). TZ is pinned to UTC so a local run matches prod (the
# classification pipeline is not timezone-pure).
#
# Wrapper chatter goes to stderr, so the command's stdout stays clean.
# ssh / node come from the flake devShell (see scripts/_devshell.sh),
# rev-pinned via flake.lock like every other script.

[ "$#" -ge 1 ] || {
	echo "usage: prod-db.sh <command...>" >&2
	exit 2
}

# ⚠ REFUSE `node dist/…` AGAINST PRODUCTION.
#
# `dist/` is compiled output of `src/`, which was deleted on 2026-08-26 (#975).
# It was gitignored, so a clean checkout never had it — but machines predating
# the deletion kept a copy that still ran. The 67 scripts that invoked it, and
# the 6 MB tree itself, are gone as of 2026-08-29 (#1225). THIS GUARD STAYS: it
# costs nothing, and it is what would catch the next `dist/` reappearing on
# somebody's machine.
#
# Two of the reachable ones WRITE: `refresh-presence-log.js` and
# `refresh-focus-places.js` both contain INSERT/UPDATE/DELETE, and
# `scripts/ab-validate.sh` pipes the first through this script. So on this one
# machine, a wired command would have run the DELETED TypeScript against the
# production database — including whatever bugs it had when it was retired
# (see #1140 for one that deletes real focus places).
#
# Refusing here rather than in twenty callers because this is the single
# chokepoint every prod-touching path goes through. A loud refusal beats a
# silent wrong execution; a clean checkout already fails with "Cannot find
# module", and this makes THIS machine behave the same way.
for arg in "$@"; do
	case "$arg" in
	dist/* | */dist/*)
		cat >&2 <<-EOF
			prod-db.sh: refusing to run "$arg" against production.

			dist/ is build output of src/, deleted 2026-08-26 (#975). What is
			left on this machine is the retired TypeScript backend, and running
			it here would write to the production database with code that is no
			longer the implementation.

			The Rust equivalents are bin/backend subcommands. See #1225.
		EOF
		exit 2
		;;
	esac
done

HEALTH_HOST=root@isis.xinutec.org
NS=health
LOCAL_PORT=13306

echo "==> fetching DB credentials from prod" >&2
# ⚠ NEWEST RUNNING pod, not `items[0]`. During a rollout there are two, and
# `items[0]` is as likely to be the one terminating — the same trap health #975
# records for reading env off a pod. Credentials rarely differ between them, so
# this fails silently when it fails at all, which is why it is sorted rather
# than trusted.
POD=$(ssh "$HEALTH_HOST" "kubectl -n $NS get pods -l app=health-auth \
  --field-selector=status.phase=Running --sort-by=.metadata.creationTimestamp \
  -o jsonpath='{.items[-1:].metadata.name}'")
[ -n "$POD" ] || {
	echo "could not find a health-auth pod" >&2
	exit 1
}
# One round-trip: dump the pod env, pick out the vars locally. Captured
# into a shell var — never echoed.
ENVDUMP=$(ssh "$HEALTH_HOST" "kubectl -n $NS exec $POD -- printenv")
get() { printf '%s\n' "$ENVDUMP" | grep "^$1=" | head -1 | cut -d= -f2- || true; }
DB_USER=$(get DB_USER)
DB_PASSWORD=$(get DB_PASSWORD)
DB_NAME=$(get DB_NAME)
NC_BASE_URL=$(get NC_BASE_URL)
NC_CLIENT_ID=$(get NC_CLIENT_ID)
NC_CLIENT_SECRET=$(get NC_CLIENT_SECRET)
# The Rust backend's config layer REFUSES a missing required var by name rather
# than defaulting it, so `backend check` cannot start without these even though
# it only reads the database (health #982). Pulled from the same dump as the
# rest; never echoed.
FITBIT_CLIENT_ID=$(get FITBIT_CLIENT_ID)
FITBIT_CLIENT_SECRET=$(get FITBIT_CLIENT_SECRET)
# Google Health credentials, for `backend google-probe` and `google-compare`
# (#260).
#
# ⚠ NOT FROM THE POD DUMP ABOVE. Every other credential here comes off a running
# `health-auth` pod, and the Google ones are not on it — they are wired onto the
# `health-sync` CronJob, whose pods are transient and have all Completed by the
# time anyone looks. Reading them the same way returns empty, and because
# `GoogleCreds::from_env` needs all three, the failure surfaces as
# "must all be set" — which reads as "prod is not configured for Google" when
# in fact prod is fine and the lookup was pointed at the wrong workload.
#
# So this reads the Secret the CronJob references. The name is resolved FROM the
# CronJob rather than hardcoded, so a rename cannot leave this silently reading
# nothing.
#
# ⚠ Optional, and deliberately so: every other caller of this script only
# touches the database, and refusing to open a DB tunnel because an unrelated
# credential is missing would break all of them.
GH_SECRET=$(ssh "$HEALTH_HOST" "kubectl -n $NS get cronjob health-sync \
  -o jsonpath='{.spec.jobTemplate.spec.template.spec.containers[0].env[?(@.name==\"GH_REFRESH_TOKEN\")].valueFrom.secretKeyRef.name}'" 2>/dev/null || true)
if [ -n "$GH_SECRET" ]; then
	# One round-trip for all three, decoded locally. Captured into shell vars,
	# never echoed — same handling as DB_PASSWORD above.
	GHDUMP=$(ssh "$HEALTH_HOST" "kubectl -n $NS get secret $GH_SECRET \
	  -o go-template='{{range \$k, \$v := .data}}{{\$k}}={{\$v}}{{\"\\n\"}}{{end}}'" 2>/dev/null || true)
	ghget() { printf '%s\n' "$GHDUMP" | grep "^$1=" | head -1 | cut -d= -f2- | base64 -d 2>/dev/null || true; }
	GH_CLIENT_ID=$(ghget GH_CLIENT_ID)
	GH_CLIENT_SECRET=$(ghget GH_CLIENT_SECRET)
	GH_REFRESH_TOKEN=$(ghget GH_REFRESH_TOKEN)
fi
# Feature flags that gate which classification pipeline runs. Without
# these the Mac falls back to defaults — silently testing the legacy
# cascade while production runs the factor scorer, and goldens drift
# out of sync with what users see. Mirror every gating env the pod
# uses; just credentials isn't enough.
USE_FACTOR_SCORER=$(get USE_FACTOR_SCORER)
USE_BIOMETRIC_FACTOR=$(get USE_BIOMETRIC_FACTOR)
# C4 continuity flags — these gate the HSMM decode itself, so a Mac
# replay that misses them decodes a different day than the cron wrote
# to decoded_days.
USE_CADENCE_IMPUTATION=$(get USE_CADENCE_IMPUTATION)
USE_SEGMENT_EVIDENCE=$(get USE_SEGMENT_EVIDENCE)
USE_CHAIN_CONTEXT=$(get USE_CHAIN_CONTEXT)
USE_REACQUIRE_ROBUST_SPEED=$(get USE_REACQUIRE_ROBUST_SPEED)
[ -n "$DB_PASSWORD" ] || {
	echo "DB_PASSWORD not found in pod env" >&2
	exit 1
}
export DB_USER DB_PASSWORD DB_NAME NC_CLIENT_ID NC_CLIENT_SECRET
export FITBIT_CLIENT_ID FITBIT_CLIENT_SECRET
# Only when prod has them: `GoogleCreds::from_env` treats an empty string as
# present, so exporting a blank would turn "not configured" into a 401 at the
# token endpoint — a much worse error to read than a missing-variable refusal.
[ -n "$GH_CLIENT_ID" ] && export GH_CLIENT_ID || true
[ -n "$GH_CLIENT_SECRET" ] && export GH_CLIENT_SECRET || true
[ -n "$GH_REFRESH_TOKEN" ] && export GH_REFRESH_TOKEN || true
export DB_HOST=127.0.0.1 DB_PORT="$LOCAL_PORT" TZ=UTC
# Only export feature flags when prod actually sets them — exporting
# an empty string is not the same as unset (the code reads === "1").
[ -n "$USE_FACTOR_SCORER" ] && export USE_FACTOR_SCORER || true
[ -n "$USE_BIOMETRIC_FACTOR" ] && export USE_BIOMETRIC_FACTOR || true
[ -n "$USE_CADENCE_IMPUTATION" ] && export USE_CADENCE_IMPUTATION || true
[ -n "$USE_SEGMENT_EVIDENCE" ] && export USE_SEGMENT_EVIDENCE || true
[ -n "$USE_CHAIN_CONTEXT" ] && export USE_CHAIN_CONTEXT || true
[ -n "$USE_REACQUIRE_ROBUST_SPEED" ] && export USE_REACQUIRE_ROBUST_SPEED || true
# NC_BASE_URL is usually unset in the pod (the app falls back to a
# built-in default). Only export it when prod actually sets it —
# exporting an empty string would fail URL validation.
[ -n "$NC_BASE_URL" ] && export NC_BASE_URL || true

echo "==> opening tunnel to prod health-db" >&2
# The [k]ubectl bracket keeps this pattern from matching its own pkill
# command line, so cleanup only kills real kubectl port-forwards.
PF_PATTERN="[k]ubectl.*port-forward svc/health-db $LOCAL_PORT"
cleanup() {
	kill "${TUNNEL_PID:-}" 2>/dev/null || true
	ssh "$HEALTH_HOST" "pkill -f '$PF_PATTERN' 2>/dev/null || true" 2>/dev/null || true
}
trap cleanup EXIT
# Clear any forward left behind by an interrupted earlier run, then
# open a fresh one: Mac:LOCAL_PORT -(ssh -L)- isis:LOCAL_PORT
# -(kubectl)- svc/health-db:3306.
ssh "$HEALTH_HOST" "pkill -f '$PF_PATTERN' 2>/dev/null || true" 2>/dev/null || true

# A back-to-back run can still find the PREVIOUS run's local listener
# bound here — ssh releases the port some time after it is killed, not
# at once. Starting ours while that one lingers means ExitOnForwardFailure
# kills ours, and the stale listener then answers the readiness probe in
# its place. Wait for the port to go quiet, so what we probe is our own.
if (exec 3<>"/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null; then
	printf "    local port %s still held by an earlier run" "$LOCAL_PORT" >&2
	for i in $(seq 1 40); do
		(exec 3<>"/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null || break
		printf . >&2
		sleep 0.5
		[ "$i" -eq 40 ] && {
			echo " still held — refusing to probe a listener that is not ours" >&2
			exit 1
		}
	done
	echo " freed" >&2
fi
# ServerAlive* keeps the long-lived tunnel from idling out during
# CPU-heavy phases that aren't touching the DB (e.g. the route-aware
# HSMM decode loop) — without these the upstream resets the
# connection after a few minutes of silence and the MariaDB pool
# fails on the next query.
# ⚠ >&2 ON THE TUNNEL, because kubectl's "Forwarding from ..." and one
# "Handling connection" per query go to ITS stdout, which is this script's
# stdout, which is the command's. The header above has always promised a clean
# stdout and did not deliver: a 2026-08-26 `decode-day --dry-run | diff` picked
# up three kubectl lines mixed into the JSON, and a run whose output is piped
# somewhere less forgiving would have carried them silently.
ssh -o ExitOnForwardFailure=yes -o ServerAliveInterval=60 -o ServerAliveCountMax=10 \
	-L "$LOCAL_PORT:127.0.0.1:$LOCAL_PORT" "$HEALTH_HOST" \
	"kubectl -n $NS port-forward svc/health-db $LOCAL_PORT:3306" >&2 &
TUNNEL_PID=$!

# Readiness has to test the FAR end. A bare connect proves only that the
# local ssh listener is bound, and ssh binds it the moment it connects —
# whether or not kubectl ever bound its own end, and whether or not the
# server behind it is up. That is why a back-to-back run could print
# "ok" and then fail on the very first query with ER_SOCKET_UNEXPECTED_CLOSE.
# MariaDB sends its handshake greeting unprompted on accept, so one byte
# arriving here proves the whole chain: Mac, ssh, kubectl, server. Cost is
# one aborted connection per invocation, which the server does not mind.
db_greets() {
	local b rc
	# The braces matter: a failed `exec` redirection is reported by the
	# shell itself, and a `2>/dev/null` on the exec line is not applied
	# in time to suppress it. Grouping puts the message inside the
	# redirect, so a refused probe stays silent instead of printing a
	# scary "Connection refused" on every poll of a healthy startup.
	{ exec 3<>"/dev/tcp/127.0.0.1/$LOCAL_PORT"; } 2>/dev/null || return 1
	IFS= read -r -t 5 -n 1 b <&3
	rc=$?
	exec 3<&- 3>&-
	return "$rc"
}

printf "    waiting for tunnel" >&2
for i in $(seq 1 60); do
	kill -0 "$TUNNEL_PID" 2>/dev/null || {
		echo " tunnel process exited" >&2
		exit 1
	}
	if db_greets; then
		echo " ok" >&2
		break
	fi
	printf . >&2
	sleep 0.5
	[ "$i" -eq 60 ] && {
		echo " timeout" >&2
		exit 1
	}
done

echo "==> running: $*" >&2
"$@"

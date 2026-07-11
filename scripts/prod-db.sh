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
#   scripts/prod-db.sh node dist/cli/analyze-day.js 2026-05-15 pippijn Europe/London
#   scripts/prod-db.sh node dist/cli/golden-check.js
#   scripts/prod-db.sh node /tmp/some-diagnostic.mjs
#
# The command runs locally against 127.0.0.1:13306 -(ssh)-
# svc/health-db:3306. Build the project yourself first if the command
# needs dist/. TZ is pinned to UTC so a local run matches prod (the
# classification pipeline is not timezone-pure).
#
# Wrapper chatter goes to stderr, so the command's stdout stays clean.
# ssh / node come from the flake devShell (see scripts/_devshell.sh),
# rev-pinned via flake.lock like every other script.

[ "$#" -ge 1 ] || {
	echo "usage: prod-db.sh <command...>" >&2
	exit 2
}

HEALTH_HOST=root@isis.xinutec.org
NS=health
LOCAL_PORT=13306

echo "==> fetching DB credentials from prod" >&2
POD=$(ssh "$HEALTH_HOST" "kubectl -n $NS get pods -l app=health-auth -o jsonpath='{.items[0].metadata.name}'")
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
# Feature flags that gate which classification pipeline runs. Without
# these the Mac falls back to defaults — silently testing the legacy
# cascade while production runs the factor scorer, and goldens drift
# out of sync with what users see. Mirror every gating env the pod
# uses; just credentials isn't enough.
USE_FACTOR_SCORER=$(get USE_FACTOR_SCORER)
USE_BIOMETRIC_FACTOR=$(get USE_BIOMETRIC_FACTOR)
USE_CONTINUITY_CONTINUATION=$(get USE_CONTINUITY_CONTINUATION)
[ -n "$DB_PASSWORD" ] || {
	echo "DB_PASSWORD not found in pod env" >&2
	exit 1
}
export DB_USER DB_PASSWORD DB_NAME NC_CLIENT_ID NC_CLIENT_SECRET
export DB_HOST=127.0.0.1 DB_PORT="$LOCAL_PORT" TZ=UTC
# Only export feature flags when prod actually sets them — exporting
# an empty string is not the same as unset (the code reads === "1").
[ -n "$USE_FACTOR_SCORER" ] && export USE_FACTOR_SCORER || true
[ -n "$USE_BIOMETRIC_FACTOR" ] && export USE_BIOMETRIC_FACTOR || true
[ -n "$USE_CONTINUITY_CONTINUATION" ] && export USE_CONTINUITY_CONTINUATION || true
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
# ServerAlive* keeps the long-lived tunnel from idling out during
# CPU-heavy phases that aren't touching the DB (e.g. the route-aware
# HSMM decode loop) — without these the upstream resets the
# connection after a few minutes of silence and the MariaDB pool
# fails on the next query.
ssh -o ExitOnForwardFailure=yes -o ServerAliveInterval=60 -o ServerAliveCountMax=10 \
	-L "$LOCAL_PORT:127.0.0.1:$LOCAL_PORT" "$HEALTH_HOST" \
	"kubectl -n $NS port-forward svc/health-db $LOCAL_PORT:3306" &
TUNNEL_PID=$!

printf "    waiting for tunnel" >&2
for i in $(seq 1 60); do
	kill -0 "$TUNNEL_PID" 2>/dev/null || {
		echo " tunnel process exited" >&2
		exit 1
	}
	if (echo >"/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null; then
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

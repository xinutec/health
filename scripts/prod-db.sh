#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Run a command with a tunnel open to the prod health-db.
#
# Opens an SSH-forwarded connection to the prod MariaDB and exports the
# env a health-sync CLI needs — DB_HOST/PORT/USER/PASSWORD/NAME,
# NC_CLIENT_ID/SECRET, NC_BASE_URL, TZ=UTC — read from the workloads'
# specs and Secrets. Then runs the given command and tears the tunnel down.
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
# ssh / jq / node come from the flake devShell (see scripts/_devshell.sh),
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
# `ab-validate.sh` pipes the first through this script. So on this one
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
# The env a workload's container is GIVEN, resolved the way Kubernetes resolves
# it: literal values, and `secretKeyRef` keys read from the Secrets the spec
# names. Prints NAME=VALUE lines.
#
# ⚠ FROM THE SPEC, NOT `kubectl exec … printenv`. An exec runs inside the serving
# pod and spends its memory limit, which has OOM-killed prod before; the spec
# needs no running pod at all. That is also what the CronJob always needed: its
# pods have Completed by the time anyone looks.
#
# ⚠ Secret values reach jq on STDIN, never in argv, where `ps` would show them,
# and go straight into the environment, never echoed.
workload_env() {
	local spec names secrets
	spec=$(ssh "$HEALTH_HOST" "kubectl -n $NS get $1 -o json")
	names=$(printf '%s\n' "$spec" | jq -r '(.spec.template.spec // .spec.jobTemplate.spec.template.spec).containers[0]
		| [.env[]?.valueFrom.secretKeyRef.name // empty] | unique | join(" ")')
	secrets='{"items":[]}'
	[ -z "$names" ] || secrets=$(ssh "$HEALTH_HOST" "kubectl -n $NS get secret $names -o json")
	{
		printf '%s\n' "$spec"
		printf '%s\n' "$secrets"
	} | jq -rs '.[0] as $w | (.[1] | if .kind == "List" or has("items") then .items else [.] end) as $s
		| ($w.spec.template.spec // $w.spec.jobTemplate.spec.template.spec).containers[0].env[]?
		| if .value != null then "\(.name)=\(.value)"
		  elif .valueFrom.secretKeyRef then
		    .valueFrom.secretKeyRef as $r
		    | ($s[] | select(.metadata.name == $r.name) | .data[$r.key] // empty | @base64d) as $v
		    | "\(.name)=\($v)"
		  else empty end'
}

# EVERY variable the workloads define is exported, not a chosen few: a curated
# list is how a new pipeline flag went missing and a Mac run silently tested a
# different cascade from prod (2026-05-23). The serving Deployment carries the
# database, Nextcloud and Fitbit credentials and the flags; the sync CronJob adds
# Google's (#260). The Deployment's value wins where both define a name, so it is
# applied last.
#
# ⚠ The CronJob is OPTIONAL: every other caller only touches the database, and
# refusing to open a tunnel because an unrelated credential is missing would
# break all of them.
#
# ⚠ EMPTY IS NOT EXPORTED. Empty is not unset: Google's credentials read empty as
# present (a 401 at the token endpoint instead of a missing-variable refusal),
# and an empty NC_BASE_URL fails URL validation.
export_env() {
	local line name
	while IFS= read -r line; do
		name=${line%%=*}
		[[ $name =~ ^[A-Z_][A-Z0-9_]*$ && -n ${line#*=} ]] || continue
		export "$name=${line#*=}"
	done
}
export_env < <(workload_env cronjob/health-sync 2>/dev/null || true)
export_env < <(workload_env deployment/health-auth)
[ -n "${DB_PASSWORD:-}" ] || {
	echo "DB_PASSWORD not found in the health-auth spec" >&2
	exit 1
}
# The tunnel's end, not the in-cluster service the spec names.
export DB_HOST=127.0.0.1 DB_PORT="$LOCAL_PORT" TZ=UTC

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

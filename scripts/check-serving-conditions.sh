#!/usr/bin/env bash
# Run the CANDIDATE image under PRODUCTION'S CONDITIONS, without serving anyone.
#
#   ./scripts/prod-db.sh ./scripts/check-serving-conditions.sh
#
# # Why this exists
#
# On 2026-08-23 the Rust+Lean backend was cut over and reverted within the hour.
# Neither defect was in the logic — both were properties of the DEPLOYMENT that
# no test could see:
#
#   * the root filesystem is READ-ONLY, and the Lean stderr capture opens a
#     `tempfile()` in /tmp. Every `/velocity` returned 400 (#1106).
#   * the migration advisory lock was taken on one pooled connection and
#     released on another, so the process held it forever and the node pod
#     behind it could not start (#1108).
#
# The verification campaign was extensive — 16/16 routes byte-identical, 39/39
# days, the whole golden corpus — and blind to both, because every run of it
# happened on a developer machine with a writable /tmp and an idle database.
#
# ⚠ THE POD IS DERIVED FROM THE LIVE DEPLOYMENT, never written out here. A
# hand-copied podspec is a copy of production that stops being production the
# moment the model changes, and would then pass while the real thing failed —
# the exact shape of `feedback_a_test_that_mirrors_the_wiring_tests_its_copy`.
# Only the command, the probes and the restart policy are overridden, and each
# override is justified below.
#
# ⚠ IT CARRIES NO LABELS, so the Service cannot select it. It talks to the real
# database because that is the condition under test; it receives no traffic.
# ⚠ `-e` ON PURPOSE, with failure tolerated ONLY where a check RESULT is being
# collected (each such spot says so). Without it an ssh or jq failure partway
# through would leave every later probe reading an empty string and the script
# reporting whatever that compared to — a check passing for the wrong reason,
# which is worse than no check at all.
set -euo pipefail

HOST=${HOST:-isis.xinutec.org}
NS=health
POD=health-auth-conditions
BIN=${BIN:-/Users/pippijn/Library/Caches/cargo/target/release/backend}
DAY=${DAY:-2026-05-22}
# `ABLATE=no-tmp` — see the note in the pod derivation below.
ABLATE=${ABLATE:-}
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

fail=0
note() { printf '%-58s %s\n' "$1" "$2"; }
bad() { note "$1" "FAIL — $2"; fail=1; }

cleanup() {
  # Best-effort: this runs on every exit path including the failures, and a
  # cleanup that aborted would leave the pod behind.
  ssh "root@$HOST" "kubectl -n $NS delete pod $POD --ignore-not-found --wait=false" >/dev/null 2>&1 || true
  if [ -n "${COOKIE:-}" ]; then "$BIN" drop-session "$COOKIE" >/dev/null 2>&1 || true; fi
  return 0
}
trap cleanup EXIT

echo "==> deriving a pod from the live health-auth Deployment${ABLATE:+  (ABLATE=$ABLATE)}"
ssh "root@$HOST" "kubectl -n $NS get deploy health-auth -o json" > /tmp/health-auth-deploy.json || {
  echo "could not read the Deployment"; exit 1; }

# ⚠ `jq`, NOT python3. Inside `prod-db.sh`'s dev shell `/usr/bin/python3` is the
# Xcode shim and dies with "tool 'python3' not found"; jq is a real binary.
#
# ⚠ `ABLATE=no-tmp` STRIPS THE WRITABLE /tmp, and exists so this check can be
# shown to catch the thing it was built for. A check nobody has seen fail is a
# check nobody knows works — and this one was written after an outage it did not
# prevent, so "it passes" is not evidence on its own.
#
# It perturbs the POD, never the probes: the questions asked afterwards are
# identical, which is what makes a difference in the answers mean something.
# Expected under ablation: /healthz and /api/me stay 200 and /velocity turns 400.
# That asymmetry IS #1106 — the pod stays healthy and only the fold route dies.
case "$ABLATE" in
  ''|no-tmp) ;;
  *) echo "unknown ABLATE=$ABLATE (want: no-tmp)" >&2; exit 2 ;;
esac

jq --arg pod "$POD" --arg ns "$NS" --arg ablate "$ABLATE" '
  {
    apiVersion: "v1",
    kind: "Pod",
    # ⚠ NO LABELS. The Service selects on them, and this pod must never be sent
    # a real request.
    metadata: { name: $pod, namespace: $ns },
    spec: (
      .spec.template.spec
      # The one thing under test: the Rust binary instead of node.
      | .containers[0].command = ["bin/backend", "serve"]
      # Probes dropped because this script drives the checks itself; a readiness
      # probe would only re-ask /healthz, the check least likely to fail.
      | .containers[0] |= del(.readinessProbe, .livenessProbe, .startupProbe)
      # ⚠ Never: a crash must STAY crashed and be visible. Restarting would let
      # the script see a healthy second attempt.
      | .restartPolicy = "Never"
      | if $ablate == "no-tmp" then
            .volumes = [ (.volumes // [])[] | select(.name != "tmp") ]
          | .containers[0].volumeMounts =
              [ ((.containers[0].volumeMounts) // [])[] | select(.name != "tmp") ]
        else . end
    )
  }' /tmp/health-auth-deploy.json > /tmp/health-auth-conditions.json || exit 1

ro=$(jq -r '.spec.containers[0].securityContext.readOnlyRootFilesystem' /tmp/health-auth-conditions.json)
if [ "$ro" != "true" ]; then
  bad "read-only root carried over from the Deployment" "got $ro — the check would prove nothing"
  exit 1
fi
note "read-only root carried over from the Deployment" "yes"
tmpvol=$(jq -r '[(.spec.volumes // [])[] | select(.name=="tmp")] | length' /tmp/health-auth-conditions.json)
note "writable /tmp present" "$([ "$tmpvol" = "1" ] && echo yes || echo "NO (this is the #1106 condition)")"

ssh "root@$HOST" "kubectl -n $NS delete pod $POD --ignore-not-found --wait=true" >/dev/null 2>&1 || true
ssh "root@$HOST" "kubectl -n $NS apply -f -" < /tmp/health-auth-conditions.json >/dev/null || {
  echo "could not create the pod"; exit 1; }

echo "==> waiting for it to start"
for _ in $(seq 1 60); do
  # `|| true`: the pod may not exist yet, and that is a reason to keep waiting.
  phase=$(ssh "root@$HOST" "kubectl -n $NS get pod $POD -o jsonpath='{.status.phase}'" 2>/dev/null || true)
  # ⚠ `if`, not `[ … ] && break`. Under `set -e` a false test returns 1 and
  # aborts the script — the loop would exit on its FIRST pass, before the pod
  # ever started, and report phase=Pending as a startup failure.
  if [ "$phase" = "Running" ] || [ "$phase" = "Failed" ]; then break; fi
  sleep 2
done
if [ "$phase" != "Running" ]; then
  bad "the candidate starts under production's conditions" "phase=$phase"
  ssh "root@$HOST" "kubectl -n $NS logs $POD --tail=20" 2>&1 | tail -20 || true
  exit 1
fi
note "the candidate starts under production's conditions" "Running"

# ⚠ The lock check runs WHILE the candidate is up. #1108 was invisible to every
# test precisely because nothing ever asked this question with the server live.
# ⚠ The SQL goes in on STDIN. Passing it with `-e` means nesting single quotes
# inside an `sh -c` payload inside an ssh argument, and the inner quotes silently
# terminate the payload — `IS_USED_LOCK('health_migrate')` arrives as
# `IS_USED_LOCK(health_migrate)` and MariaDB reads it as a COLUMN. That fails
# loudly here, but the same trick elsewhere is how a probe comes back empty and
# reads as "free".
lock=$(ssh "root@$HOST" "kubectl -n $NS exec -i deploy/health-db -- sh -c 'mariadb -N -B -u root -p\$MARIADB_ROOT_PASSWORD'" <<'SQL' 2>/dev/null | tr -d '\r' || true
SELECT IFNULL(IS_USED_LOCK('health_migrate'), 'FREE');
SQL
)
if [ "$lock" = "FREE" ]; then
  note "the migration lock is free while it serves (#1108)" "FREE"
else
  bad "the migration lock is free while it serves (#1108)" "held: $lock — node and the CronJobs cannot migrate"
fi

echo "==> minting a session"
export SESSION_SECRET=$(ssh "root@$HOST" "kubectl -n $NS get pod $POD -o jsonpath='{.spec.containers[0].env}'" >/dev/null 2>&1; \
  ssh "root@$HOST" "kubectl -n $NS exec $POD -- printenv SESSION_SECRET" 2>/dev/null | tr -d '\r')
COOKIE=$("$BIN" mint-session pippijn 2>/dev/null || true)
if [ -z "$COOKIE" ]; then bad "mint a session" "could not"; exit 1; fi

# Driven from INSIDE the pod: there is no Service in front of it, and putting one
# there would defeat the point of a candidate that serves nobody.
probe() { # path -> HTTP status
  ssh "root@$HOST" "kubectl -n $NS exec $POD -- node -e \"
    fetch('http://127.0.0.1:3000$1', {headers:{Cookie:'session=$COOKIE'}})
      .then(r => { console.log(r.status); process.exit(0) })
      .catch(e => { console.log('ERR ' + e.message); process.exit(0) })\"" 2>/dev/null | tr -d '\r'
}

for spec in "/healthz:200" "/api/me:200" "/api/velocity?date=$DAY&tz=Europe/London:200"; do
  path=${spec%:*}; want=${spec##*:}
  # `|| true`: a probe that cannot run is a FAILED CHECK, reported below, not a
  # reason to abandon the remaining probes.
  got=$(probe "$path" || true)
  if [ "$got" = "$want" ]; then note "GET $path" "$got"; else bad "GET $path" "$got, wanted $want"; fi
done

echo
if [ "$fail" -eq 0 ]; then
  echo "the candidate serves under production's conditions"
else
  echo "✗ the candidate does NOT hold up under production's conditions — do not cut over"
  ssh "root@$HOST" "kubectl -n $NS logs $POD --tail=25" 2>&1 | tail -25 || true
fi
exit "$fail"

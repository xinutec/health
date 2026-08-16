#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# ONE day through both arms, for the commit hook — a tripwire for a TS change
# that never reached the Lean fold.
#
# WHY THIS EXISTS WHEN `check:cascade-parity` ALREADY RUNS. That check reads the
# pass NAMES out of velocity.ts and compares them to PassFold's hand-copied
# list, so it catches a pass being ADDED. It cannot catch a pass's BODY
# changing. On 2026-08-15 `feefb75` added MINED_LABEL_MIN_DAYS to velocity.ts
# with no Lean counterpart: the name list still matched, the check passed, and
# the day gate went RED on 6 of 35 days. Nobody would have known until the next
# deploy — `scripts/deploy.sh` is the only place the full gate runs.
#
# That is the THIRD silent TS/Lean drift (#417, #425, this), and all three were
# found by accident. This one is found by the commit that causes it.
#
# HONEST ABOUT WHAT ONE DAY BUYS: this is a TRIPWIRE, not the gate. The full
# 35-day corpus still runs in deploy.sh and still owns the verdict. A drift that
# happens to leave this day identical gets through — but a drift that touches
# nothing in a whole day is rare, and the alternative is 52 s on every commit.
#
# Exit 0 = this day's arms agree, or there is no corpus to ask (see below).
# Exit 1 = they disagree. Fix the port, do not skip the hook.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# The sentinel is one of the six days `feefb75` broke, chosen so this check is
# known to have caught a real defect rather than assumed to. It exercises the
# stay-enrichment place cascade, which is where a naming or labelling change
# lands.
DAY="${DAY_GATE_SMOKE_DATE:-2026-05-14}"

# `tests/golden/` is gitignored, so a clean checkout has no corpus and
# `pnpm run verify` must still work there. A missing corpus is a SKIP, and it
# says so out loud: a check that silently passes when it reached nothing is the
# defect this whole file is about.
# NO CORPUS IS DETECTED FROM THE GATE'S OWN EXIT 2, not by testing a path here.
# Two drafts of this file guessed a path and got it wrong — `tests/golden/
# fixtures` does not exist, and the days carry a `-pippijn` suffix — so on a
# machine that HAS the corpus it skipped, and would have passed silently
# forever. Duplicating another tool's layout is how a check stops reaching
# anything; ask the tool.
echo "day-gate-smoke: $DAY"
set +e
out=$(pnpm run day-gate "$DAY" 2>&1)
rc=$?
set -e

if (( rc == 2 )); then
	echo "day-gate-smoke: SKIPPED — no corpus (gate exit 2)"
	echo "  (gitignored; the full gate runs in deploy.sh, where the corpus exists)"
	exit 0
fi

# CANARY: exit 0 is not enough. A run that produced no verdict for this day did
# not measure it, and must not read as agreement — the same defect as the two
# bad path guesses above, and as the hang-catcher that reported "15 runs, no
# wedge" having never started.
if (( rc == 0 )) && printf '%s\n' "$out" | grep -qE "^$DAY +(IDENTICAL|SHELL ONLY)"; then
	printf '%s\n' "$out" | grep -E "^$DAY"
	exit 0
fi

printf '%s\n' "$out" >&2
if (( rc == 0 )); then
	echo "day-gate-smoke: the gate exited 0 but printed no verdict for $DAY." >&2
	echo "  Treating that as a FAILURE: a check that reached nothing is not a pass." >&2
	exit 1
fi
cat >&2 <<EOF

day-gate-smoke FAILED on $DAY.

A TS change has almost certainly not reached the Lean fold. The two arms are
compared field by field, so read the named fields above: they say WHICH part of
the day disagreed.

  pnpm run day-gate            # the full 35-day corpus, ~52 s
  DAY_DIFF_DUMP=1 pnpm run day-gate $DAY   # the first differing VALUE per field

Do not re-bless anything to make this pass. If the TS moved deliberately, port
the same change to lean/Verified/ in this commit — that is the rule this check
exists to enforce.
EOF
exit 1

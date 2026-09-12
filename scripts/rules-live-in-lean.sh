#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# A named constant must be declared in ONE language, not two.
#
# WHY THIS EXISTS. The decisions live in Lean and Rust is IO glue, but nothing
# enforced it and the boundary has a gradient: a rule needed AT an IO site costs
# one line to write there and a new entry point plus a JSON round-trip to write
# in Lean. So rules drift Rustwards, quietly, one constant at a time.
#
# Measured 2026-09-12, the first time anybody looked: FOURTEEN constant names
# were declared on both sides. Thirteen were EXACT DUPLICATES — same name, same
# value, two declarations, so changing one and forgetting the other is a silent
# divergence. The fourteenth was worse: `ACCURACY_CEILING_M` was 200.0 in Rust
# and 80 in Lean, the same name for two different rules.
#
# ⚠ THIS CHECKS NAMES, NOT SEMANTICS, and that is deliberate. "Is this constant
# a RULE or is it IO tuning?" has no oracle — a check that needs that judgement
# would argue with its reader and get muted. "Is this name declared twice?" is
# decidable from the two trees and needs no opinion at all.
#
# ⚠ IT CANNOT SEE A RULE THAT WAS ONLY EVER WRITTEN IN RUST. A threshold with a
# name Lean never used passes silently. This is a ratchet against DIVERGENCE and
# REGROWTH, not a proof that the split is right.
#
#   scripts/rules-live-in-lean.sh          # check against the allow-list
#   scripts/rules-live-in-lean.sh --list   # print what is shared right now
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ALLOW=scripts/rules-live-in-lean.allow

rust_consts() {
	grep -rhoE "^[[:space:]]*(pub )?const [A-Z][A-Z0-9_]+" rust/backend/src rust/day-shell/src 2>/dev/null |
		grep -oE "[A-Z][A-Z0-9_]+$" | sort -u
}
lean_defs() {
	grep -rhoE "^def [A-Z][A-Z0-9_]+" lean/Verified 2>/dev/null |
		grep -oE "[A-Z][A-Z0-9_]+$" | sort -u
}

shared=$(comm -12 <(rust_consts) <(lean_defs))

if [ "${1:-}" = "--list" ]; then
	printf '%s\n' "$shared"
	exit 0
fi

# ⚠ `grep -c` exits 1 on zero matches, which under `set -e` would kill a CLEAN
# run. Everything below counts with wc instead.
allowed=$(grep -vE '^\s*(#|$)' "$ALLOW" | sort -u)

new=$(comm -13 <(printf '%s\n' "$allowed") <(printf '%s\n' "$shared") | grep -v '^$' || true)
gone=$(comm -23 <(printf '%s\n' "$allowed") <(printf '%s\n' "$shared") | grep -v '^$' || true)

rc=0
if [ -n "$new" ]; then
	echo "✗ a constant is now declared in BOTH Rust and Lean:" >&2
	printf '    %s\n' $new >&2
	cat >&2 <<-'WHY'

	    One name, one declaration. Either the rule belongs in Lean and Rust
	    should ask for it, or it is IO tuning and Lean should not name it.
	    If it is genuinely two different things, rename one — a shared name
	    with two meanings is how ACCURACY_CEILING_M came to be 200 and 80.

	    Adding it to scripts/rules-live-in-lean.allow is the LAST resort and
	    needs a reason on the line above it.
	WHY
	rc=1
fi

if [ -n "$gone" ]; then
	echo "✓ no longer shared — remove from $ALLOW:" >&2
	printf '    %s\n' $gone >&2
	rc=1
fi

[ "$rc" -eq 0 ] && echo "rules-live-in-lean: $(printf '%s\n' "$shared" | grep -cv '^$' || true) shared name(s), all allow-listed"
exit "$rc"

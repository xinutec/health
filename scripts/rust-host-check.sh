#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# `rust/day-shell` — builds, lints, and AGREES WITH THE SPAWNED CLI.
#
# WHY THIS EXISTS ON THE DAY THE CRATE DOES. Every silent drift this repository
# has hit came from a second copy of something with no check between the copies:
# the Lean fold fell a pass behind `velocity.ts` (#444), the pass-name list
# matched while a pass BODY diverged (`feefb75`, 6 of 35 days red), and the
# frontend's union copies needed their own row. `day-shell` is now a THIRD arm
# computing the day, and the argument for it is that its answer is identical to
# the CLI's. An identity nothing re-checks is a claim with a date on it.
#
# Three things, cheapest first:
#   1. it builds        — the Lean static libs are linked, symbols resolve
#   2. clippy is clean  — same bar as `keep the linter clean` everywhere else
#   3. it AGREES        — same bytes as `verified_cli day` on a real day
#   4. it ANSWERS        — the fold's OSM callbacks reach the HOST, not the stub
#
# (3) is the one that matters and the one that can skip: the day request is
# built from `tests/golden/`, which is gitignored, so a clean checkout cannot
# produce one. It skips OUT LOUD. A check that silently passes when it reached
# nothing is the exact defect `day-gate-smoke.sh`'s header is about, and this
# script is its neighbour for that reason.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
cd "$ROOT"

# The crate links `libverified_DayEntry.a` and `libverified_Verified.a`, and
# `build.rs` fails with a message naming the missing one — but only if lake has
# been asked for them. `lake build verified_cli` alone does NOT emit the static
# libs, which is the same shape as `lake build <Module>` not relinking the CLI.
echo "rust-host-check: lean static libs"
(cd lean && lake build verified_cli DayEntry:static Verified:static >/dev/null)

echo "rust-host-check: build + clippy"
cd rust
cargo build --release
# `-D warnings` so a lint is a red row rather than a line nobody reads.
cargo clippy --release --all-targets -- -D warnings
cd "$ROOT"

BIN="$(cd rust && cargo metadata --format-version 1 --no-deps 2>/dev/null |
	sed 's/.*"target_directory":"\([^"]*\)".*/\1/')/release/day-shell"
if [[ ! -x "$BIN" ]]; then
	echo "rust-host-check: built, but no binary at $BIN" >&2
	exit 1
fi

# The equivalence. `DAY_REQ_DUMP` writes the request the fold actually receives;
# the day gate exits 2 when there is no corpus to build one from, which is the
# same contract `day-gate-smoke.sh` reads.
DAY="${RUST_HOST_CHECK_DATE:-2026-05-14}"
REQ_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rust-host-check.XXXXXX")"
trap 'rm -rf "$REQ_DIR"' EXIT

set +e
DAY_REQ_DUMP="$REQ_DIR" pnpm run day-gate "$DAY" >"$REQ_DIR/gate.log" 2>&1
rc=$?
set -e
if (( rc == 2 )); then
	echo "rust-host-check: SKIPPED the equivalence — no corpus (gate exit 2)"
	echo "  (build and clippy still ran; the full check needs tests/golden/)"
	exit 0
fi

REQ="$REQ_DIR/$DAY.json"
if [[ ! -s "$REQ" ]]; then
	cat "$REQ_DIR/gate.log" >&2
	echo "rust-host-check: the gate ran but dumped no request for $DAY." >&2
	echo "  Treating that as a FAILURE: the equivalence reached nothing." >&2
	exit 1
fi

"$BIN" <"$REQ" >"$REQ_DIR/host.json" 2>"$REQ_DIR/host.err"
lean/.lake/build/bin/verified_cli day <"$REQ" >"$REQ_DIR/cli.json"

# The host prints its initialisation timing to stderr, and its ABSENCE is the
# signature of the duplicate-`main` bug: Lean's own entry point wins the link,
# answers the request as a decoder model, and prints well-formed JSON. That
# looked exactly like a pass once already.
if ! grep -q 'init=' "$REQ_DIR/host.err"; then
	cat "$REQ_DIR/host.err" >&2
	echo "rust-host-check: the host produced no init line — Lean's main may have won the link." >&2
	exit 1
fi

# THE CALLBACK REACHED THE HOST. Only the host's implementation counts its
# calls, so a nonzero count means the Lean fold called out mid-run and Rust
# answered — the one thing a spawned process structurally cannot do, and the
# whole reason this crate exists.
#
# VERIFIED RED: removing the `walkEnv` wiring in DayEntry.lean drops it to 0 and
# fails this. What it does NOT catch, tested and refuted rather than assumed:
# re-adding `libosmhoststub` to the host's link does NOT make the stub win, so
# the count stays 4. Rust's own `#[no_mangle]` object defines the symbols before
# the linker reaches the archive, so the archive member is never pulled. The
# stub could only win BEFORE `src/osm.rs` existed — which it briefly did.
# build.rs still filters it out, as defence rather than as the thing this checks.
#
# 2026-05-14 asks 4 times. A day that asks ZERO cannot discriminate and must not
# be the sentinel.
if ! grep -qE 'osm: walkableRoads=[1-9]' "$REQ_DIR/host.err"; then
	cat "$REQ_DIR/host.err" >&2
	echo "rust-host-check: the fold made no OSM callbacks on $DAY." >&2
	echo "  Either the stub won the link again, or this day stopped asking." >&2
	echo "  Both are real; neither may pass silently." >&2
	exit 1
fi

if cmp -s "$REQ_DIR/host.json" "$REQ_DIR/cli.json"; then
	echo "rust-host-check: IDENTICAL on $DAY — $(wc -c <"$REQ_DIR/host.json" | tr -d ' ') bytes, $(cat "$REQ_DIR/host.err")"
	exit 0
fi

echo "rust-host-check FAILED on $DAY — the in-process host and the spawned CLI disagree." >&2
cmp "$REQ_DIR/host.json" "$REQ_DIR/cli.json" >&2 || true
echo >&2
echo "The whole argument for rust/day-shell is that these are the same answer." >&2
echo "Do not relax this check; find which side moved." >&2
exit 1

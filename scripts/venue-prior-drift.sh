#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
# Does re-mining the venue priors REWRITE a day the user already confirmed?
#
# WHY THIS EXISTS. On 2026-09-04 a dinner confirmed as `Pizza Union` was being
# served as `Honest Burgers`, because `fast_food.visits` fell from 5 to 3 in a
# rolling 180-day window (#1405). Nothing noticed, and nothing could:
#
#   * `venuePriors` is a captured fixture INPUT (#1273-class), so every corpus
#     harness grades a blob production stopped using. The gates were green
#     throughout.
#   * There is no stored label. `/velocity` recomputes a historical day from the
#     CURRENT priors on any cache miss, and that cache is in-process with a
#     5-minute TTL (`Verified.VelocityCache.TTL_MS`). So a day is re-derived on
#     essentially every view, and a prior that moved rewrites history silently.
#
# Finding that one stay took an afternoon of hand replay. This is that afternoon,
# as a command.
#
# ⚠ IT NEEDS THE PROD DB, so it is NOT a gate row — `gate.dhall` runs offline and
# on machines without credentials. Run it after a mining change, before trusting
# a re-mine, or on a schedule. `--dry` is passed to the miner: this NEVER writes
# `venue_type_priors` or `focus_places`.
#
# ⚠ IT COMPARES VERDICTS, NOT LABELS. The truth referee is the only thing that
# knows which rows the user CONFIRMED; a label diff would flag the 94% of stays no
# narrative describes. A row going `verified` -> anything else is the finding.
#
#   scripts/venue-prior-drift.sh
#
# Exit 0 when no confirmed row moves, 1 when one does, 2 when the corpus is
# absent (the same SKIP contract the other corpus tooling uses).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORPUS="$ROOT/tests/golden/days"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -d "$CORPUS" ] || {
	echo "venue-prior-drift: no golden corpus at $CORPUS — SKIP." >&2
	exit 2
}

BIN="$(cargo metadata --manifest-path "$ROOT/rust/Cargo.toml" --format-version 1 |
	jq -r .target_directory)/release/backend"
[ -x "$BIN" ] || {
	echo "venue-prior-drift: building the backend binary first…" >&2
	(cd "$ROOT" && cargo build --manifest-path rust/Cargo.toml --release --bin backend)
}

# ⚠ THE ARM IS WHAT THE POD RESOLVES, NOT A FRESH MINE (2026-09-29, #1845).
# Since #1405 the serving path takes the newest prior SNAPSHOT at or before the
# day and only then the current row, so one fresh blob injected for every day
# reproduced the anachronism that ticket removed and reported drift the pod
# never served. `venue-prior-snapshots` dumps the snapshots and the current
# row; `VENUE_PRIORS_DIR` resolves per fixture date by the serving rule.
echo "==> reading the prior snapshots from prod (read-only)" >&2
"$ROOT/scripts/prod-db.sh" "$BIN" venue-prior-snapshots "${HEALTH_USER:-$USER}" "$WORK/snap" >&2
echo "==> baseline: the corpus against its OWN captured priors" >&2
(cd "$ROOT" && VENUE_AB_OUT="$WORK/before.json" \
	cargo test --manifest-path rust/Cargo.toml -p backend --release \
	--test corpus_gate -- --nocapture) >&2
echo "==> arm: the same corpus under the priors the pod resolves for each day" >&2
(cd "$ROOT" && VENUE_PRIORS_DIR="$WORK/snap" VENUE_AB_OUT="$WORK/after.json" \
	cargo test --manifest-path rust/Cargo.toml -p backend --release \
	--test corpus_gate -- --nocapture) >&2

node - "$WORK/before.json" "$WORK/after.json" <<'NODEEOF'
// ⚠ node, not python3: /usr/bin/python3 is an Xcode shim that dies inside the
// devShell ("tool 'python3' not found"), and `_devshell.sh` pins node anyway.
const fs = require("node:fs");
const [beforeP, afterP] = process.argv.slice(2);
// One JSON line per date, appended by every shard (see `VENUE_AB_OUT` in
// tests/corpus/truth.rs) — merged here into date -> rows.
const readLines = (p) => Object.fromEntries(
	fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => {
		const j = JSON.parse(l);
		return [j.date, j.rows];
	}));
const before = readLines(beforeP);
const after = readLines(afterP);
const moved = [];
let checked = 0;
for (const date of Object.keys(before).sort()) {
	const a = before[date];
	const b = after[date];
	if (!b || a.length !== b.length) {
		moved.push([date, null, "NOT MEASURED", "the arm skipped this day"]);
		continue;
	}
	// ⚠ POSITIONAL. 06-22 carries two rows with the same startTs, and a
	// ts-keyed diff invented changes there until the referee was fixed.
	for (let i = 0; i < a.length; i += 1) {
		checked += 1;
		const [ts, va] = a[i];
		const vb = b[i][1];
		if (va !== vb && va === "verified") moved.push([date, ts, va, vb]);
	}
}
const days_n = Object.keys(before).length;
console.log(`\nvenue-prior-drift: ${checked} row(s) compared over ${days_n} day(s)`);
if (moved.length === 0) {
	console.log("venue-prior-drift: every confirmed row the corpus holds also holds under the priors the pod resolves.");
	process.exit(0);
}
console.log(`\n⚠ ${moved.length} CONFIRMED row(s) the corpus holds do NOT hold under the pod's priors:\n`);
for (const [date, ts, va, vb] of moved) console.log(`      ${date} @${ts}  ${va} -> ${vb}`);
console.log("\nThe fixture carries the priors current at CAPTURE; the pod serves the snapshot");
console.log("at or before the day (#1405). See #1845 — do not fix this by weakening the prior.");
process.exit(1);
NODEEOF

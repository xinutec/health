#!/usr/bin/env node
// Which Lean defs can actually be REACHED from a binary — as opposed to written,
// #guard-proven, and orphaned.
//
// WHY THIS EXISTS. `lean-port-coverage.mjs` (DELETED 2026-08-31, #1003) measured
// AUTHORSHIP: did a Lean def implementing this TS export exist anywhere under
// `lean/Verified`. That is the
// right question for "how much is written" and the wrong one for "how much TS can
// we delete", and on 2026-08-17 the two were quoted as if they were the same
// number. They are not: `Geo.Segments.classifySegments` and
// `Geo.PlacePrior.snapToPlace` are both complete, both #guard-pinned, and nothing
// calls either. Deleting their TS counterparts would delete the working system.
//
// A def deletes TS only if a request can reach it. That means a path from one of
// the two binaries — `Main` (the `verified_cli` verbs) or `DayEntry` (the
// in-process day-shell host). Nothing else is an entry point.
//
// ⚠ #guard DOES NOT COUNT, AND THAT IS THE ENTIRE POINT. Guards are top-level
// terms, not defs, so they contribute NO edges here. `snapToPlace` carries 20 of
// them; a reader skimming the module sees an exercised, trustworthy function, and
// it is exercised — by the build, not by production. The same holds for `theorem`
// and `example`. Only `def`/`abbrev`/`instance` bodies produce edges, because
// only they can run inside a request.
//
// DIRECTION OF ERROR, stated so the output can be used safely. Edges are matched
// on BARE names, namespace-blind: two distinct `go`s in two modules are fused, and
// a name appearing in a comment counts. Both over-connect the graph. So:
//
//     UNREACHABLE is trustworthy   — no textual path exists at all, and a real
//                                    call would have left one.
//     REACHABLE is NOT a claim of use — it is "not provably dead by this method".
//
// Read a shrinking UNREACHABLE list as progress. Never read REACHABLE as served:
// serving additionally needs a verb, a tenant in `src/lean/`, and a flag, none of
// which are visible from here.
//
// `lean-port-coverage.mjs` imported `reachableNames()` from here rather than
// rebuilding the graph, so the EXCLUDE list and the rename-claim resolution
// stayed in ONE place. That consumer is gone; the export stays because the
// reasoning below is still why this file owns the graph. A first cut of this cross-reference lived in a throwaway probe
// that skipped both, and it reported `buildQGraph` as an orphaned port on two
// counts that were each wrong: `Main` calls `buildQGraphFast` (the executable
// refinement — the spec is meant to have no caller), and its TS side is in
// `match-twin.ts`, which coverage excludes. Duplicating the scan is how that
// happens; importing is how it stops.
//
// Usage:
//   nix develop . --command node scripts/lean-reachability.mjs [--all] [--claims]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ALL = process.argv.includes("--all");
const CLAIMS_ONLY = process.argv.includes("--claims");
// Importing must not print a report or read this script's argv.
const MAIN = import.meta.url === `file://${process.argv[1]}`;

function filesUnder(dir, ext) {
	const out = [];
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		if (statSync(p).isDirectory()) out.push(...filesUnder(p, ext));
		else if (e.endsWith(ext)) out.push(p);
	}
	return out;
}

// Top-level declarations start at column 0; their bodies are indented. These are
// the col-0 tokens that CONTINUE the declaration above rather than opening a new
// one — `where` in particular, which is where Lean puts helper defs and which a
// naive col-0 split would sever from its parent (`snapToPlace`'s `go` is one).
const CONTINUES = /^(where\b|termination_by\b|decreasing_by\b|deriving\b|\||then\b|else\b)/;
const DECL = /^(?:@\[[^\]]*\]\s*)?(?:private\s+|protected\s+|partial\s+|noncomputable\s+|unsafe\s+)*(def|abbrev|instance|theorem|lemma|example|structure|inductive|class)\s+([A-Za-z_][A-Za-z0-9_'!?]*)?/;
// Only these can run inside a request, so only these emit edges.
const RUNNABLE = new Set(["def", "abbrev", "instance"]);

/** Split a Lean source into top-level segments: [{head, kind, name, body, line}]. */
function segments(src) {
	const lines = src.split("\n");
	const out = [];
	let cur = null;
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		const opensDecl = /^\S/.test(l) && !CONTINUES.test(l);
		if (opensDecl) {
			// A doc comment or attribute belongs to the declaration it precedes, so
			// keep accumulating until the keyword line arrives.
			const m = l.match(DECL);
			if (m) {
				if (cur) out.push(cur);
				cur = { kind: m[1], name: m[2] ?? "", body: [l], line: i + 1 };
				continue;
			}
			if (cur) {
				out.push(cur);
				cur = null;
			}
			continue;
		}
		if (cur) cur.body.push(l);
	}
	if (cur) out.push(cur);
	return out;
}

const defs = new Map(); // bare name -> [{mod, kind, body, line, loc}]
const modOf = new Map(); // "Mod.name" -> mod
const guardsOf = new Map();
const seeds = new Set();

const leanRoot = "lean";
const files = filesUnder(leanRoot, ".lean").filter((p) => !p.includes("/.lake/") && !p.includes("/experiments/"));

for (const p of files) {
	const src = readFileSync(p, "utf8");
	const rel = p.slice(`${leanRoot}/`.length, -".lean".length).replace(/\//g, ".");
	guardsOf.set(rel, (src.match(/^#guard/gm) ?? []).length);
	// The two binaries. Anything not reachable from one of them cannot answer a
	// request, however well proven it is.
	const isEntry = rel === "Main" || rel === "DayEntry" || rel.startsWith("DayEntry.");
	for (const s of segments(src)) {
		if (!s.name) continue;
		const rec = { mod: rel, kind: s.kind, body: s.body.join("\n"), line: s.line, loc: s.body.length };
		if (!defs.has(s.name)) defs.set(s.name, []);
		defs.get(s.name).push(rec);
		modOf.set(`${rel}.${s.name}`, rel);
		if (isEntry && RUNNABLE.has(s.kind)) seeds.add(s.name);
	}
}

/** Bare identifiers in a body, with `Foo.bar` reduced to `bar`. */
function refs(body) {
	const out = new Set();
	for (const m of body.matchAll(/[A-Za-z_][A-Za-z0-9_'!?]*(?:\.[A-Za-z_][A-Za-z0-9_'!?]*)*/g)) {
		const parts = m[0].split(".");
		out.add(parts[parts.length - 1]);
		if (parts.length > 1) out.add(parts[0]);
	}
	return out;
}

// BFS from the binaries over runnable bodies only.
const reachable = new Set();
const queue = [...seeds];
while (queue.length) {
	const name = queue.pop();
	if (reachable.has(name)) continue;
	reachable.add(name);
	for (const rec of defs.get(name) ?? []) {
		if (!RUNNABLE.has(rec.kind)) continue;
		for (const r of refs(rec.body)) if (defs.has(r) && !reachable.has(r)) queue.push(r);
	}
}

// Report on Verified only: that is the ported algorithm layer, and the thing whose
// TS counterpart we are deciding whether to delete.
const verified = [];
for (const [name, recs] of defs) {
	for (const rec of recs) {
		if (!rec.mod.startsWith("Verified.")) continue;
		if (!RUNNABLE.has(rec.kind)) continue;
		verified.push({ name, ...rec, live: reachable.has(name) });
	}
}
const dead = verified.filter((d) => !d.live);
const byMod = new Map();
for (const d of dead) {
	if (!byMod.has(d.mod)) byMod.set(d.mod, []);
	byMod.get(d.mod).push(d);
}

/**
 * Bare names of every def reachable from a binary, for cross-referencing against
 * a TS-export scan. Over-approximate by construction (see the header): treat a
 * name's ABSENCE as evidence, never its presence.
 */
export const reachableNames = () => new Set(reachable);

if (!MAIN) {
	// Imported for `reachableNames()` only.
} else {
const pct = (n, d) => (d === 0 ? "—" : `${((100 * n) / d).toFixed(1)}%`);
console.log(`REACHABILITY from Main + DayEntry (${files.length} modules scanned)\n`);
console.log(`  runnable defs under Verified : ${verified.length}`);
console.log(`  reachable from a binary      : ${verified.length - dead.length}  (${pct(verified.length - dead.length, verified.length)})`);
console.log(`  UNREACHABLE                  : ${dead.length}  (${pct(dead.length, verified.length)})`);
console.log(`  lines in unreachable defs    : ${dead.reduce((a, d) => a + d.loc, 0)}\n`);

// ⚠ DO NOT QUOTE THE COUNT ABOVE AS PORT DEBT. Most of it is #guard FIXTURES.
// `Geo.Reversal` reports 34 dead, and ~30 are one-line constants feeding guards
// (`OUT_AND_BACK`, `TURN119`, `SPAN_1400`) — unreachable, correctly, and not work.
// The per-def view shows the tool working at the right granularity in the same
// module: `splitReversingLegs` is REACHABLE (PassFold calls it) while `reversesAt`
// beside it is not.
//
// There used to be a more trustworthy number here — the cross-reference in
// lean-port-coverage.mjs, TS exports counted as ported whose every twin is
// dead. It cannot be computed any more; see the note at the foot of this file.
console.log("⚠ The count above INCLUDES #guard fixtures; it is context, not port debt.");
console.log("  It is also reachability from LEAN dispatch, which is one hop short of a caller.\n");

if (!CLAIMS_ONLY) {
	const mods = [...byMod.entries()].sort((a, b) => b[1].length - a[1].length);
	console.log(`UNREACHABLE BY MODULE${ALL ? "" : "  (top 20; --all for every module)"}`);
	for (const [mod, ds] of ALL ? mods : mods.slice(0, 20)) {
		const g = guardsOf.get(mod) ?? 0;
		// The guard count is printed BESIDE the dead count on purpose: a module with
		// many guards and no callers is the exact shape this tool exists to surface.
		console.log(`  ${mod.padEnd(38)} ${String(ds.length).padStart(3)} dead   ${String(g).padStart(3)} #guard`);
		if (ALL) for (const d of ds) console.log(`      ${d.name}  (${d.mod.replace(/\./g, "/")}.lean:${d.line}, ${d.loc} lines)`);
	}
	console.log("");
}

// ⚠ THE TS CROSS-REFERENCE IS GONE, AND SO IS THE QUESTION IT ANSWERED.
// `lean-port-coverage.mjs` matched Lean defs against TS exports under `src/geo`
// and `src/hmm`. Both went with the TypeScript backend (#975), so it scanned a
// directory that no longer exists and died with ENOENT rather than reporting
// anything — while these lines went on telling a reader to run it. It is
// deleted rather than left to crash (#1003).
//
// With no second side, "a covered TS export whose every twin is dead" has no
// referent: every Lean def is an orphan by that wording. Reachability, above,
// is what remains, and it is a WEAKER measure in a specific way worth knowing.
//
// ⚠ THIS TOOL MEASURES REACHABILITY FROM LEAN'S DISPATCH TABLES. A `ServeEntry`
// mode counts as reached the moment `dispatch` names it — even if no Rust
// caller ever sends that mode. `gpsoutliers` passed this test while being dead
// for exactly that reason. The missing hop is the shell's call sites, and it is
// invisible from here.
//
// What DOES close the hop, for a mode being added: one witness that `dispatch`
// still routes to it (`the_mode_table_answers_in_process` in
// rust/backend/tests/lean_serve.rs) PLUS a caller that exercises it for real
// (rust/backend/tests/walk_gate.rs). Neither alone suffices — the first passes
// while nothing calls the mode, the second passes if the arm is renamed and the
// caller renamed with it.
console.log("Orphaned PORTS: not measurable here — the TS side it cross-referenced went with #975.");
console.log("  Reachability above is from LEAN dispatch; a mode with no Rust caller still reads as live.");
}

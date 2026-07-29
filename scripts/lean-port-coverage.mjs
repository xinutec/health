#!/usr/bin/env node
// How much of the TS algorithm layer exists in Lean — measured, not remembered.
//
// The port roadmap (docs/proposals/2026-07-lean-port-roadmap.md) is hand-kept and
// it drifted: on 2026-07-29 it still called `kalman.ts` "the single best next
// port" while `Verified/Geo/Kalman.lean` had been complete and #guard-pinned for
// some time. A hand-kept inventory of ~60 modules cannot stay honest.
//
// WHAT THIS MEASURES: for each exported function of an algorithm-layer TS file,
// is a `def` of that name present ANYWHERE under lean/Verified? Deliberately not
// per-file — the ports regroup freely (`map-match-core.ts` lives across
// Simplify/Prefilter/Clean/Trim/Match/MatchViterbi), so a filename-matched check
// reports absent modules that are in fact fully ported. A first version of this
// script did exactly that and had to be thrown away.
//
// WHAT IT DOES NOT MEASURE, and you must not read into it:
//   * FAITHFULNESS. A matching name is not a matching function. The `#guard`
//     count per defining module is the real evidence — those run inside `lake
//     build` and fail it on divergence.
//   * SERVING. Writing Lean changes nothing on its own; it has to reach a
//     request through a `verified_cli` verb, a tenant in `src/lean/`, and a
//     flag. The serve surface is printed separately and is far smaller than the
//     written surface. That gap is the remaining work.
//
// Usage:
//   nix develop . --command node scripts/lean-port-coverage.mjs [--all]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function leanFilesUnder(dir) {
	const out = [];
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		if (statSync(p).isDirectory()) out.push(...leanFilesUnder(p));
		else if (e.endsWith(".lean")) out.push(p);
	}
	return out;
}

// name → the Verified modules defining it, and each module's guard count.
const definedIn = new Map();
const guardsOf = new Map();
for (const p of leanFilesUnder("lean/Verified")) {
	const mod = p.slice("lean/Verified/".length, -".lean".length).replace(/\//g, ".");
	const src = readFileSync(p, "utf8");
	guardsOf.set(mod, (src.match(/^#guard/gm) ?? []).length);
	for (const m of src.matchAll(/^(?:private )?(?:partial )?def ([a-zA-Z0-9_]+)/gm)) {
		if (!definedIn.has(m[1])) definedIn.set(m[1], []);
		definedIn.get(m[1]).push(mod);
	}
}

// Shell / boundary / off-the-served-path per the roadmap — excluded on purpose,
// so this reports on the algorithm layer only and a shell file never reads as a
// coverage gap.
const EXCLUDE =
	/^(osm|osm-.*|.*-cache|.*-adapter.*|timezone|fitbit-tz|route-graph|route-graph-loader|opening-hours|load-classification-inputs|.*shadow.*|.*twin.*|leg-compare|venue-trace)$/;

const rows = [];
for (const f of readdirSync("src/geo").filter((f) => f.endsWith(".ts"))) {
	const base = f.slice(0, -3);
	if (EXCLUDE.test(base)) continue;
	const src = readFileSync(`src/geo/${f}`, "utf8");
	const exports = [...src.matchAll(/^export (?:async )?function ([a-zA-Z0-9_]+)/gm)].map((m) => m[1]);
	if (exports.length === 0) continue;
	const missing = exports.filter((e) => !definedIn.has(e));
	const mods = new Set(exports.flatMap((e) => definedIn.get(e) ?? []));
	const guards = [...mods].reduce((n, m) => n + (guardsOf.get(m) ?? 0), 0);
	rows.push({
		base, missing, guards, mods: [...mods],
		have: exports.length - missing.length, want: exports.length,
		state: missing.length === 0 ? "written" : missing.length === exports.length ? "absent" : "partial",
	});
}

const all = process.argv.includes("--all");
const order = { absent: 0, partial: 1, written: 2 };
rows.sort((a, b) => order[a.state] - order[b.state] || a.base.localeCompare(b.base));

console.log("\n=== TS algorithm layer → Lean (names only; guards are the evidence) ===\n");
for (const r of rows) {
	if (!all && r.state === "written") continue;
	console.log(`  ${r.state.padEnd(8)} ${r.base.padEnd(26)} ${r.have}/${r.want} defs  ${String(r.guards).padStart(4)} guards in ${r.mods.length} module(s)`);
	if (r.missing.length) console.log(`           missing: ${r.missing.join(", ")}`);
}
const by = (s) => rows.filter((r) => r.state === s).length;
console.log(`\n  written ${by("written")} · partial ${by("partial")} · absent ${by("absent")}   (of ${rows.length} algorithm files)`);
console.log(`
  SERVE SURFACE (what actually executes for a request — a different question):
    LEAN_HSMM    the HSMM decode
    LEAN_MATCH   the walk map-matcher
    LEAN_RAIL    rail shortest-path
    LEAN_PASSES  five display-geometry helpers: simplify, spurs, spikes, trim, despike
  Everything else above is written-but-idle. Closing that is the remaining work.
`);

#!/usr/bin/env node
// How much of the TS algorithm layer exists in Lean — measured, not remembered.
//
// The port roadmap (docs/proposals/2026-07-lean-port-roadmap.md) is hand-kept and
// it drifted: on 2026-07-29 it still called `kalman.ts` "the single best next
// port" while `Verified/Geo/Kalman.lean` had been complete and #guard-pinned for
// some time. A hand-kept inventory of ~60 modules cannot stay honest.
//
// WHAT THIS MEASURES: for each exported function of an algorithm-layer TS file,
// is it implemented ANYWHERE under lean/Verified? Deliberately not per-file —
// the ports regroup freely (`map-match-core.ts` lives across
// Simplify/Prefilter/Clean/Trim/Match/MatchViterbi), so a filename-matched check
// reports absent modules that are in fact fully ported. A first version of this
// script did exactly that and had to be thrown away.
//
// A def counts as implementing a TS export when EITHER
//   (a) it carries the same name, or
//   (b) its own doc comment names the export in backticks — `/-- `simplifyPath`
//       ... -/ def qSimplify`.
//
// (b) exists because the ports RENAME. Measured 2026-08-01: `simplifyPath`,
// `removeSpurs`, `despikeUnsupportedApexes`, `matchTrajectory`,
// `dedupeConsecutive`, `spliceRouteDetail` and `trimOverRouteExcursions` are all
// ported and all SERVED (they are what `LEAN_PASSES` and `LEAN_MATCH` execute),
// yet a name-only check called every one of them missing — `map-match-core` read
// 9/19 when it is very nearly complete. Reading that as "10 files left to port"
// is the exact drift this script was written to stop, reintroduced one layer
// down. Only the doc comment ATTACHED TO A DEF is read; a module header (`/-! -/`)
// is not a claim.
//
// Claims are cross-checked: a backticked name that matches no TS export in the
// scanned set is reported under STALE CLAIMS rather than silently believed, so
// the mechanism cannot rot the way the prose roadmap did.
//
// WHAT IT DOES NOT MEASURE, and you must not read into it:
//   * FAITHFULNESS. Neither a matching name nor a claimed one is a matching
//     function — (b) is a claim by the author, not a proof. The `#guard` count
//     per defining module is the real evidence: those run inside `lake build`
//     and fail it on divergence.
//   * SERVING. Writing Lean changes nothing on its own; it has to reach a
//     request through a `verified_cli` verb, a tenant in `src/lean/`, and a
//     flag. The serve surface is printed separately and is far smaller than the
//     written surface. That gap is the remaining work.
//   * ANYTHING OUTSIDE THE SCANNED DIRS. Printed as a blind spot, with counts,
//     rather than left for the reader to assume is covered.
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
// TS export name claimed in a def's doc comment → "Module.leanDef" that claims
// it. Filled after the TS scan, since a SOFT claim only counts once we know
// whether the name is a real export (see below).
const claimedBy = new Map();
const rawClaims = [];

const DEF = "(?:@\\[[^\\]]*\\]\\s*)?(?:private\\s+)?(?:partial\\s+)?(?:noncomputable\\s+)?def\\s+([a-zA-Z0-9_]+)";
const record = (map, key, val) => {
	if (!map.has(key)) map.set(key, []);
	map.get(key).push(val);
};

for (const p of leanFilesUnder("lean/Verified")) {
	const mod = p.slice("lean/Verified/".length, -".lean".length).replace(/\//g, ".");
	const src = readFileSync(p, "utf8");
	guardsOf.set(mod, (src.match(/^#guard/gm) ?? []).length);
	for (const m of src.matchAll(new RegExp(`^${DEF}`, "gm"))) record(definedIn, m[1], mod);
	// A def's own doc comment claims the TS function it implements in one of the
	// two forms the codebase already uses:
	//     /-- `simplifyPath` over the pinned metric ... -/   def qSimplify
	//     /-- The TS `trimOverRouteExcursions` over `n` ... -/  def trim
	// ONLY those. Backticks elsewhere in the prose are parameters (`n`, `tol`),
	// mode strings (`unknown`, `walking`) and loop variables — reading those as
	// claims produced 200+ spurious matches and would over-credit any TS export
	// that happens to share a name with a parameter. `SegmentPasses.effectiveMode`
	// is a cross-reference, not a claim, and the bare-lowerCamel rule drops it.
	//
	// The two forms are NOT equally strong, and are not treated as such:
	//   HARD — "TS `x`" says outright that x is a TS function. If x is no longer
	//          one, that is a stale claim worth shouting about.
	//   SOFT — a LEADING backtick is the module's heading convention and is
	//          ambiguous: `/-- `simplifyPath` over the pinned metric -/` is a
	//          claim, but `/-- `n` is the fix count -/` opens with a PARAMETER.
	//          Nothing distinguishes them syntactically, so a soft claim counts
	//          only when it names a real TS export, and is never reported stale.
	//          Treating soft claims as hard produced 15 "stale" entries that were
	//          all just parameters (`n`, `l`, `found`, `seen`).
	for (const m of src.matchAll(new RegExp(`/--([\\s\\S]*?)-/\\s*${DEF}`, "g"))) {
		const [doc, leanDef] = [m[1], m[2]];
		const site = `${mod}.${leanDef}`;
		// A leading backtick that restates the def's OWN name is a heading, not a claim.
		const lead = doc.match(/^\s*`([a-z][a-zA-Z0-9_]*)`/);
		if (lead && lead[1] !== leanDef) rawClaims.push({ name: lead[1], hard: false, site });
		for (const c of doc.matchAll(/\bTS `([a-z][a-zA-Z0-9_]*)`/g)) {
			rawClaims.push({ name: c[1], hard: true, site });
		}
	}
}

// Shell / boundary / off-the-served-path per the roadmap — excluded on purpose,
// so this reports on the algorithm layer only and a shell file never reads as a
// coverage gap.
const EXCLUDE =
	/^(osm|osm-.*|.*-cache|.*-adapter.*|timezone|fitbit-tz|route-graph|route-graph-loader|opening-hours|load-classification-inputs|.*shadow.*|.*twin.*|leg-compare|venue-trace)$/;

// `src/geo/passes` is the pipeline-pass layer and squarely in scope. `src/hmm`
// and `src/eval` are NOT scanned: eval is the judge, not the subject (the same
// reason line-membership.ts refuses to share checkRailTriples' helpers), and hmm
// needs a shell/algorithm split nobody has made yet. Both are declared below as
// blind spots rather than quietly assumed covered.
const TS_DIRS = ["src/geo", "src/geo/passes"];
const UNSCANNED = ["src/hmm", "src/eval"];

const exportsOf = (dir, f) =>
	[...readFileSync(`${dir}/${f}`, "utf8").matchAll(/^export (?:async )?function ([a-zA-Z0-9_]+)/gm)].map((m) => m[1]);

// Pass 1 — what the scanned TS actually exports, and what the blind-spot dirs
// export. Both are needed BEFORE claims can be resolved: a soft claim is only
// believed if it names something real, and a claim naming an src/hmm function is
// pointing into a blind spot rather than being stale.
const files = [];
const seenExports = new Set();
for (const dir of TS_DIRS) {
	for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
		const base = f.slice(0, -3);
		if (EXCLUDE.test(base)) continue;
		const exports = exportsOf(dir, f);
		if (exports.length === 0) continue;
		for (const e of exports) seenExports.add(e);
		files.push({ base: dir === "src/geo" ? base : `${dir.slice("src/".length)}/${base}`, exports });
	}
}
const blindExports = new Set();
for (const d of UNSCANNED) for (const f of readdirSync(d).filter((f) => f.endsWith(".ts"))) {
	for (const e of exportsOf(d, f)) blindExports.add(e);
}

// Every identifier appearing anywhere in the TS, exported or not. A hard claim
// naming a non-exported local (`segMode`), a TS keyword the prose is describing
// ("mirrors the TS `break`") or a method (`indexOf`) is NOT rot — it just isn't
// a coverage claim either. Rot is a name that has left the TS ENTIRELY, which is
// what this set detects and why the check is usually silent.
const tsWords = new Set();
for (const dir of [...TS_DIRS, ...UNSCANNED]) {
	for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
		for (const m of readFileSync(`${dir}/${f}`, "utf8").matchAll(/\b[a-z][a-zA-Z0-9_]*\b/g)) tsWords.add(m[0]);
	}
}

// Resolve claims. A hard claim ("TS `x`") is checked against the whole TS
// vocabulary; a soft one (leading backtick) has to name a real EXPORT to count.
const staleSites = new Map();
for (const { name, hard, site } of rawClaims) {
	if (seenExports.has(name) || blindExports.has(name)) record(claimedBy, name, site);
	else if (hard && !tsWords.has(name)) record(staleSites, name, site);
}
const stale = [...staleSites.keys()].sort();
const intoBlind = [...claimedBy.keys()].filter((n) => !seenExports.has(n) && blindExports.has(n)).sort();

// Pass 2 — coverage, now that claims are resolved.
const rows = files.map(({ base, exports }) => {
	const renamed = exports.filter((e) => !definedIn.has(e) && claimedBy.has(e));
	const missing = exports.filter((e) => !definedIn.has(e) && !claimedBy.has(e));
	const mods = new Set([
		...exports.flatMap((e) => definedIn.get(e) ?? []),
		...renamed.flatMap((e) => (claimedBy.get(e) ?? []).map((c) => c.slice(0, c.lastIndexOf(".")))),
	]);
	return {
		base, missing, renamed, mods: [...mods],
		guards: [...mods].reduce((n, m) => n + (guardsOf.get(m) ?? 0), 0),
		have: exports.length - missing.length, want: exports.length,
		state: missing.length === 0 ? "written" : missing.length === exports.length ? "absent" : "partial",
	};
});

const all = process.argv.includes("--all");
const order = { absent: 0, partial: 1, written: 2 };
rows.sort((a, b) => order[a.state] - order[b.state] || a.base.localeCompare(b.base));

console.log("\n=== TS algorithm layer → Lean (names + declared renames; guards are the evidence) ===\n");
for (const r of rows) {
	if (!all && r.state === "written") continue;
	console.log(`  ${r.state.padEnd(8)} ${r.base.padEnd(26)} ${r.have}/${r.want} defs  ${String(r.guards).padStart(4)} guards in ${r.mods.length} module(s)`);
	if (r.missing.length) console.log(`           missing: ${r.missing.join(", ")}`);
	if (r.renamed.length && all) {
		for (const e of r.renamed) console.log(`           renamed: ${e} -> ${(claimedBy.get(e) ?? []).join(", ")}`);
	}
}
const by = (s) => rows.filter((r) => r.state === s).length;
const renamedTotal = rows.reduce((n, r) => n + r.renamed.length, 0);
console.log(`\n  written ${by("written")} · partial ${by("partial")} · absent ${by("absent")}   (of ${rows.length} algorithm files)`);
console.log(`  ${renamedTotal} export(s) matched by a DECLARED RENAME rather than by name${all ? "" : " (--all to list)"}.`);

if (stale.length) {
	console.log(`\n  STALE CLAIMS — named in a Lean def's doc comment, but no such TS export exists:`);
	for (const n of stale) console.log(`    ${n}  (claimed by ${(staleSites.get(n) ?? []).join(", ")})`);
	console.log(`  Either the TS moved/was renamed, or the doc comment is wrong. Not counted as coverage.`);
}

console.log(`\n  BLIND SPOTS — not assessed, so absent from every number above:`);
for (const d of UNSCANNED) {
	const n = readdirSync(d).filter((f) => f.endsWith(".ts")).length;
	console.log(`    ${d.padEnd(12)} ${String(n).padStart(3)} files`);
}
console.log(`    ${intoBlind.length} Lean def(s) already claim a function in there, so the real port is`);
console.log(`    further along than these numbers say — by an amount this script does not measure.`);
console.log(`
  SERVE SURFACE (what actually executes for a request — a different question):
    LEAN_HSMM    the HSMM decode
    LEAN_MATCH   the walk map-matcher
    LEAN_RAIL    rail shortest-path
    LEAN_PASSES  five display-geometry helpers: simplify, spurs, spikes, trim, despike
    LEAN_KALMAN  the GPS Kalman filter
    LEAN_GPSQUALITY  the GPS quality pre-filter
  Everything else above is written-but-idle. Closing that is the remaining work.
`);

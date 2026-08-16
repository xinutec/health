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

function filesUnder(dir, ext) {
	const out = [];
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		if (statSync(p).isDirectory()) out.push(...filesUnder(p, ext));
		else if (e.endsWith(ext)) out.push(p);
	}
	return out;
}
const leanFilesUnder = (dir) => filesUnder(dir, ".lean");
// Path under `src/`, minus the extension: `src/hmm/factors/presence-continuity.ts`
// -> `hmm/factors/presence-continuity`. Every scan below keys off this ONE label,
// so a file cannot be counted by one pass and missed by another — which it was:
// the blind-spot tally used a non-recursive `readdirSync` and reported `src/hmm
// 33 files`, silently omitting `factors/presence-continuity.ts` (ported, as
// `Hsmm/Continuity`). Recursion is the fix; a shared label is what keeps it fixed.
const tsFilesUnder = (root) => filesUnder(root, ".ts").map((p) => p.slice("src/".length, -".ts".length));

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
		// `\s+`, not a literal space: doc comments WRAP, and "the TS\n    `buildEmissionFn`"
		// is the same claim as "the TS `buildEmissionFn`". Requiring one space made the
		// claim depend on where the line happened to break, which is not a property of
		// the port — it silently dropped a real claim on first write.
		for (const c of doc.matchAll(/\bTS\s+`([a-z][a-zA-Z0-9_]*)`/g)) {
			rawClaims.push({ name: c[1], hard: true, site });
		}
	}
}

// Shell / boundary / off-the-served-path per the roadmap — excluded on purpose,
// so this reports on the algorithm layer only and a shell file never reads as a
// coverage gap. Matched against the full label, not the bare filename: a bare
// `persist` would also silence a future `src/geo/persist.ts`, and a silent
// exclusion is indistinguishable from coverage. The count is printed either way.
const EXCLUDE = [
	// src/geo — the OSM/DB/timezone boundary, the shadow+twin harnesses, the
	// diagnostic sinks.
	/^geo\/(osm|osm-.*|.*-cache|.*-adapter.*|timezone|fitbit-tz|route-graph|route-graph-loader|opening-hours|load-classification-inputs|.*shadow.*|.*twin.*|leg-compare|venue-trace)$/,
	// Env-flag reads, not algorithm. `src/geo/factors` reached the scan only when
	// the walk went recursive (2026-08-05) — before that the whole directory was
	// invisible and undeclared, which is the worst of both: not measured, and not
	// named as unmeasured either.
	/^geo\/factors\/feature-flag$/,
	// src/hmm SHELL — the Lean bridge, the two DB readers. This is what the
	// roadmap means by "the shell is just glue": it is the part Rust inherits,
	// so it is not a port gap. `decode.ts` is deliberately NOT here — it is
	// split, holding `segmentsFromStates` (algorithm) beside the orchestration.
	/^hmm\/(lean-shadow-core|persist|continuity-context)$/,
	// src/hmm OFF THE SERVED PATH — the roadmap declares these out of scope, and
	// an import trace on 2026-08-09 CONFIRMED each one below: `route-aware-decoder`
	// and `tube-journey-assembler` are imported only by `cli/compare-vs-ground-truth`,
	// `hsmm-marginals` only by `cli/compare-hmm-vs-heuristic`, and
	// `inner-viterbi-edges` / `mode-class-lock` only by `route-aware-decoder`.
	// Nothing decodes through them; porting them would buy coverage in a number
	// and nothing in production.
	//
	// `station-chain` WAS IN THIS LIST AND DID NOT BELONG. The same trace found
	// `src/hmm/decode.ts` importing it: `decodeServed` → both arms →
	// `segmentsFromStates` → `resolveStationChain`, and `decode-day.ts` then
	// `saveDecode`s the result. So 820 lines of served, PERSISTED algorithm were
	// being set aside as off-path — precisely the failure this list's own header
	// warns about, since a silent exclusion reads exactly like a port. It counts
	// as a gap now, which is why the totals moved when nothing was written.
	// Re-derive membership from a trace before adding to this list, never from
	// the roadmap's prose: that prose was traced once, in 2026-07, and this is
	// what it drifting looks like.
	/^hmm\/(route-aware-decoder|tube-journey-assembler|inner-viterbi-edges|hsmm-marginals|mode-class-lock|fit-emissions)$/,
];
const excluded = (label) => EXCLUDE.some((re) => re.test(label));

// `src/geo/passes` is the pipeline-pass layer and squarely in scope. `src/hmm`
// joined the scan on 2026-08-05 once the shell/algorithm split above was made —
// it had been a blind spot only because nobody had made it, and the layer is
// FACTORY-shaped (`buildX(model) -> (state, obs) => number`), so the Lean ports
// carry the closure's name rather than the factory's and a name-only check reads
// ten served factories as missing. The declared-rename claims are what make the
// number honest; wiring the dir in without them would have made this tool worse.
//
// `src/eval` stays out on purpose: it is the judge, not the subject (the same
// reason line-membership.ts refuses to share checkRailTriples' helpers). It is
// declared below as a blind spot rather than quietly assumed covered.
const TS_ROOTS = ["src/geo", "src/hmm"];
const UNSCANNED = ["src/eval"];

const exportsOf = (label) =>
	[...readFileSync(`src/${label}.ts`, "utf8").matchAll(/^export (?:async )?function ([a-zA-Z0-9_]+)/gm)].map(
		(m) => m[1],
	);

// Pass 1 — what the scanned TS actually exports, and what the blind-spot dirs
// export. Both are needed BEFORE claims can be resolved: a soft claim is only
// believed if it names something real, and a claim naming an src/hmm function is
// pointing into a blind spot rather than being stale.
const files = [];
const seenExports = new Set();
const skipped = [];
for (const root of TS_ROOTS) {
	for (const base of tsFilesUnder(root).sort()) {
		if (excluded(base)) {
			skipped.push(base);
			continue;
		}
		const exports = exportsOf(base);
		if (exports.length === 0) continue;
		for (const e of exports) seenExports.add(e);
		files.push({ base, exports });
	}
}
const blindExports = new Set();
for (const d of UNSCANNED) for (const base of tsFilesUnder(d)) for (const e of exportsOf(base)) blindExports.add(e);

// Every identifier appearing anywhere in the TS, exported or not. A hard claim
// naming a non-exported local (`segMode`), a TS keyword the prose is describing
// ("mirrors the TS `break`") or a method (`indexOf`) is NOT rot — it just isn't
// a coverage claim either. Rot is a name that has left the TS ENTIRELY, which is
// what this set detects and why the check is usually silent.
const tsWords = new Set();
for (const dir of [...TS_ROOTS, ...UNSCANNED]) {
	for (const base of tsFilesUnder(dir)) {
		for (const m of readFileSync(`src/${base}.ts`, "utf8").matchAll(/\b[a-z][a-zA-Z0-9_]*\b/g)) tsWords.add(m[0]);
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
	console.log(`  ${r.state.padEnd(8)} ${r.base.padEnd(32)} ${r.have}/${r.want} defs  ${String(r.guards).padStart(4)} guards in ${r.mods.length} module(s)`);
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

console.log(`\n  EXCLUDED — ${skipped.length} file(s) scanned and set aside as shell / boundary / off-path,`);
console.log(`  NOT as coverage. A silent exclusion reads exactly like a port, so it is counted here${all ? ":" : " (--all to list)."}`);
if (all) for (const s of skipped) console.log(`    ${s}`);

console.log(`\n  BLIND SPOTS — not assessed, so absent from every number above:`);
for (const d of UNSCANNED) console.log(`    ${d.padEnd(12)} ${String(tsFilesUnder(d).length).padStart(3)} files`);
console.log(`    src/eval is out by DESIGN — it is the judge, not the subject; porting it would`);
console.log(`    move the referee inside the thing it referees. Not a gap, and not future work.`);
console.log(`    ${intoBlind.length} Lean def(s) claim a function in there, so the real port is`);
console.log(`    further along than these numbers say — by an amount this script does not measure.`);
// Hand-maintained, and it went stale once already: it listed six tenants for
// weeks after nine were serving, omitting the one that matters most. Anyone
// reading this to scope "what is left" would have concluded the day fold was
// idle when it had been writing to `decoded_days` since 2026-08-16.
//
// The authority is the manifest (`code/kubes/dhall/apps/health.dhall` in
// xinutec/pippijn), not this list. Re-read it before trusting these lines.
console.log(`
  SERVE SURFACE (what actually executes for a request — a different question).
  All nine are \`on\` as of 2026-08-16:
    LEAN_DAY     the whole day fold — the only tenant that WRITES (decoded_days)
    LEAN_HSMM    the HSMM decode
    LEAN_MATCH   the walk map-matcher
    LEAN_RAIL    rail shortest-path
    LEAN_PASSES  six display-geometry helpers: simplify, spurs, spikes, trim,
                 despike, splice
    LEAN_KALMAN  the GPS Kalman filter
    LEAN_GPSQUALITY  the GPS quality pre-filter
    LEAN_STATIONCHAIN  the station-chain solver
    LEAN_BIOLABELS     the biometric labellers
  Everything else above is written-but-idle. Closing that is the remaining work.

  ⚠ SERVING IS NOT DELETING. In \`on\` BOTH arms still run — that is why the
  ledgers can print a comparison at all. Nine tenants at \`on\` removed zero
  lines of TypeScript; #975 is the step that removes them.
`);

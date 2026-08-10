/**
 * Which Lean modules does anything actually EXECUTE against the TS they port?
 *
 * #426 asks what detects a port drifting from its subject. `day-gate`
 * (`src/cli/compare-day.ts`) answers it for the 38-pass cascade, and the other
 * tenants have their own referees — but "the other tenants" was an assumption
 * until this counted it. The residue is the honest answer: modules with no
 * executable check at all, where a drift would be found the way #417 and #425
 * were found, by reading or by a production day.
 *
 * # Method, and what it is NOT
 *
 * Import closure, per gate root. A module is counted as covered by a gate if the
 * gate's entry module transitively imports it.
 *
 * That is an UPPER bound on coverage and it is worth being clear about why: an
 * import is not an execution. `PassFold` imports `Verified.Geo.Bus`, but a corpus
 * with an empty `busRouteCache` runs that pass as a no-op, so importing it proves
 * nothing about it. `PassFold.unwitnessed` names the passes no synthetic day
 * reaches for exactly this reason, and `verified_cli day` returns `changed` so a
 * corpus day that fires a pass retires it from that list.
 *
 * So read the number as "could be reached", not "was reached". The residue —
 * modules NOT imported by any gated root — is the sound half: those cannot be
 * exercised even in principle.
 *
 * Roots, and the gate each stands for:
 *
 *   SplitFold + EnrichFold + PreFold + PassFold + Enrich + DayChain + BestPlace
 *                       `pnpm run day-gate` — the biometric splits and the stay
 *                       bridge, the OSM enrichment loop, the five corrections
 *                       before the cascade, the 38 passes, and the stages after
 *                       them
 *                       (#424/#426/#429/#430). `BestPlace` is listed separately
 *                       because nothing in the chain IMPORTS it: `Main.lean`
 *                       composes it into the two callbacks the chain declares,
 *                       so import closure alone would miss it — a reminder that
 *                       this counts modules a gate could reach, by whatever
 *                       route, and not a call graph.
 *   FocusPlaces + FocusIdentity
 *                       `pnpm run focus-gate` — the weekly `refresh-focus-places`
 *                       mining, which no day replay reaches (#435). Both were
 *                       guard-pinned until that gate existed.
 *   Match               `pnpm run compare-match` + LEAN_MATCH under golden
 *   Hsmm.*              LEAN_HSMM + `compare-assemble*`
 *   Rail.*              LEAN_RAIL — WAIVED: the corpus cannot reach it, and
 *                       `gateLedgers` prints that waiver each run
 *   Kalman / GpsQuality / BiometricLabels
 *                       their three tenants + `compare-kalman` /
 *                       `compare-gpsquality`
 *
 * Run: TMPDIR=/tmp npx tsx lean/experiments/lean-coverage.mts
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const LEAN = path.join(import.meta.dirname, "..");

const imports = new Map<string, string[]>();
(function walk(dir: string): void {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p);
		else if (e.name.endsWith(".lean")) {
			const name = path.relative(LEAN, p).slice(0, -5).split(path.sep).join(".");
			imports.set(name, [...readFileSync(p, "utf8").matchAll(/^import (Verified[\w.]*)/gm)].map((m) => m[1]));
		}
	}
})(path.join(LEAN, "Verified"));

function closure(roots: string[]): Set<string> {
	const seen = new Set<string>();
	const stack = [...roots];
	while (stack.length > 0) {
		const m = stack.pop() as string;
		if (seen.has(m)) continue;
		const deps = imports.get(m);
		if (deps === undefined) continue;
		seen.add(m);
		stack.push(...deps);
	}
	return seen;
}

const all = [...imports.keys()];

/**
 * The HSMM and Rail rows used to be `under("Verified.Hsmm")` /
 * `under("Verified.Rail")` — every module whose NAME began with the prefix,
 * while every other row was a real import closure (#674).
 *
 * A blanket is a claim, not a measurement, and this one was granting coverage to
 * files nothing executed: writing `Verified.Hsmm.StationChain` — `#guard`s only,
 * no comparator — moved the live-compared count from 122 to 123 the day the file
 * existed, purely for where it was put.
 *
 * It is the mirror of what `scripts/lean-port-coverage.mjs` was doing on the TS
 * side, where an exclusion list copied from 2026-07 prose hid 820 lines of served
 * algorithm (#672). One tool hid a gap by excluding, this one by including; both
 * read exactly like a measurement.
 *
 * Replaced by the modules the HSMM/Rail comparators actually enter, traced
 * through `Main.lean`'s verb table. `Main.lean` imports `Verified` wholesale, so
 * the IMPORT graph cannot answer this — the roots below come from reading each
 * handler and following what it calls:
 *
 *   `hsmm`          `hsmmResult` → `pDecodeFast`            → Packed
 *   `assemble`      `assembleResult` → `Assemble.build*`,
 *                   `Quantize.quantize`                     → Assemble, Quantize
 *   `assembledecode` `assembleDecodeResult` → `parseAssemble`,
 *                   `buildPData`, `pDecodeFast`             → Assemble, Packed
 *   `coverage`      `coverageResult` → `TrainCandidates`,
 *                   `RouteModel`                            → TrainCandidates
 *   `rail`          `railResult` → `Verified.Rail.dijkstraC`,
 *                   `.dijkstraDist`                         → Certify, Dijkstra
 *
 * Each of those five verbs has a live driver: `lean-hsmm.ts` for `hsmm`,
 * `compare-assemble*.mts` for the two assemble verbs, `compare-coverage.mts` for
 * `coverage`, `LEAN_RAIL` for `rail`.
 *
 * Note `buildPData` and `parseAssemble` live in `Main.lean` itself rather than in
 * a `Verified.*` module — shell-side glue, so there is nothing for this tool to
 * credit — which is exactly why the roots have to be read off the handlers and
 * not guessed from names.
 */
const HSMM_ROOTS = [
	"Verified.Hsmm.Packed",
	"Verified.Hsmm.Assemble",
	"Verified.Hsmm.Quantize",
	"Verified.Hsmm.TrainCandidates",
];
/** WAIVED, and the waiver is why this row must not be a blanket: the golden
 *  corpus preloads `rail_route_cache` (#233) so the Dijkstra never runs, and a
 *  blanket would credit modules to a gate already declared unexercisable.
 *
 *  This row now prints 0, and that does NOT mean Rail has no modules. Both roots
 *  are already claimed by `compare-match`, because `Verified.Geo.LazyDijkstra`
 *  imports `Verified.Rail.Dijkstra` and `LazyLower` imports `Rail.Certify` — the
 *  walk matcher's lazy search is built on the certified one. Import-reachable
 *  from an exercised gate is an UPPER bound, as this file says at the top, so
 *  the #233 waiver is untouched by it. */
const RAIL_ROOTS = ["Verified.Rail.Certify", "Verified.Rail.Dijkstra"];

/**
 * What removing the blanket exposed, recorded so the next reader knows which
 * residue lines are findings and which are shape.
 *
 * FINDINGS — real ports, guards only, no cited harness, entered by no verb:
 *   `Verified.Hsmm.GpsOutliers` (9 def) and `Verified.Hsmm.RouteRail` (9 def).
 *   Their ONLY importer was `Verified.Hsmm.Factors`, whose only importer is
 *   `Verified.lean` — so nothing in `verified_cli` reached them, and the blanket
 *   had been reporting both as live-compared. Both resolved 2026-08-10 (#676),
 *   and they turned out to be different problems wearing the same signature:
 *
 *   `RouteRail` was SUPERSEDED and is deleted. `EmissionFull` sums
 *   `base + geo + routeRail + lineProx` using `RouteModel.routeRailEvidence` —
 *   same four constants, same gates, but it COMPUTES the route-graph facts in
 *   Lean instead of taking them as caller-resolved booleans, which is what the
 *   deleted module took. `EmissionFull` is imported by `Assemble`, which the
 *   `assemble`/`assembledecode` verbs enter, so the live path was never the
 *   orphan. Checked in that order deliberately: superseded was the SECOND
 *   reading, and the first (a wiring defect in `Assemble`) had to be ruled out
 *   before deleting anything.
 *
 *   `GpsOutliers` is NEITHER, and stays. It is the only Lean implementation and
 *   its TS is live — `decode.ts:160` calls `dropGpsOutliers` on every decode. No
 *   verb reaches it for a CAPTURE-time reason: `capture-hsmm-day.ts:191` applies
 *   the same drop BEFORE storing the fixture, so the stored points hold none of
 *   the outliers the pass exists to remove and a replay cannot exercise it. Same
 *   shape as the #233 waiver — determinism bought by moving work out of the
 *   replay — and the fix is on the capture side, not a wiring change here.
 *
 * SHAPE — in the residue correctly, but not ports and not news:
 *   `Verified.Hsmm.Factors` is an AGGREGATOR: 25 imports, zero definitions. It
 *   exists to pull the HSMM tree into the library root.
 *   `Verified.Hsmm.Tests` / `Verified.Rail.Tests` are guard suites. Guard-only
 *   is what they are FOR, the way theorem-only is what a PROVEN module is for.
 *
 * They are left in the count rather than filtered out, because a filter is the
 * thing this whole change was about: the def/guard columns beside each name are
 * what let a reader tell the two apart without one.
 */

// Ordered: each gate is credited only with what no earlier gate already covers,
// so the columns sum to the total rather than double-counting shared kernels.
const GATES: [string, string[]][] = [
	[
		"day-gate",
		[
			"Verified.Geo.SplitFold",
			"Verified.Geo.EnrichFold",
			"Verified.Geo.PreFold",
			"Verified.Geo.PassFold",
			"Verified.Geo.Enrich",
			"Verified.Geo.DayChain",
			"Verified.Geo.BestPlace",
		],
	],
	["focus-gate", ["Verified.Geo.FocusPlaces", "Verified.Geo.FocusIdentity"]],
	["compare-match / LEAN_MATCH", ["Verified.Geo.Match"]],
	["LEAN_HSMM / compare-assemble", HSMM_ROOTS],
	["LEAN_RAIL (waived)", RAIL_ROOTS],
	// #672. The `stationchain` verb, driven by `compare-stationchain.sh` over the
	// decoded-day corpus. Listed only once that comparator existed: the verb
	// landed a commit earlier and this row deliberately did NOT move then,
	// because a verb with nothing behind it is reachable, not compared — which is
	// the exact overstatement #674 removed from this file.
	["LEAN_STATIONCHAIN / compare-stationchain", ["Verified.Hsmm.StationChain"]],
	["kalman / gpsquality / biolabels", ["Verified.Geo.Kalman", "Verified.Geo.GpsQuality", "Verified.Geo.BiometricLabels"]],
];

const claimed = new Set<string>();
for (const [label, roots] of GATES) {
	const fresh = [...closure(roots)].filter((m) => !claimed.has(m));
	for (const m of fresh) claimed.add(m);
	console.log(`${label.padEnd(38)} ${String(fresh.length).padStart(3)}`);
}

/**
 * The residue is not one thing, and counting it as one was backwards.
 *
 * A module with no comparator was read as "a port nothing checks" — the class
 * #417 and #425 came out of. But a module that PROVES something has no
 * comparator BY CONSTRUCTION: there is no TS arm to run against a theorem, and
 * `lake build` failing is the check. `Verified.Geo.LazyLower` is 8 theorems and
 * zero definitions; listing it beside an unexercised port said the best-evidenced
 * file in the tree was the least.
 *
 * So the residue is split on whether the module states any theorem, and both
 * counts are printed per module so the reader can judge a mixed one. `RingSearch`
 * is exactly that case: 1 theorem and 7 definitions, but the definitions are the
 * abstract model the theorem is about — `Int` distances, an abstract stop-margin
 * curve — not a port of anything, so nothing could compare them to TS either.
 *
 * The rule is mechanical and therefore blunt: a module carrying one theorem and a
 * hundred unexercised definitions would land in PROVEN. The def/theorem counts
 * beside each name are what stops that being invisible.
 */
const dark = all.filter((m) => !claimed.has(m)).sort();
const body = (m: string): string => readFileSync(path.join(LEAN, `${m.split(".").join(path.sep)}.lean`), "utf8");
const count = (m: string, re: RegExp): number => (body(m).match(re) ?? []).length;
const shape = (m: string): { thms: number; defs: number; guards: number } => ({
	thms: count(m, /^ *(theorem|lemma) /gm),
	defs: count(m, /^ *(private )?def /gm),
	guards: count(m, /#guard/g),
});
/**
 * Nor is "no comparator" the same as "no check". Every module in the residue
 * carries `#guard`s — 11 to 58 of them — and `lake build` runs them. What a
 * guard cannot do is notice the TS MOVING: it is a snapshot of V8's answer taken
 * when the port was written, so a guard keeps passing while the thing it ports
 * changes underneath. That is not hypothetical — it is exactly how
 * `pickBestStation` went stale against the #373 fix (#417).
 *
 * So guard-pinned is not a weaker comparator, it is blind to a different thing,
 * and the tiers are named for what each MISSES rather than for how good it is.
 *
 * The provenance column asks which `*-refs.mts` harness a pinned module's guards
 * came from, because the project rule is to derive expectations from V8 and never
 * by hand — a guard written from the porter's belief agrees with the port for the
 * same reason the port is wrong.
 *
 * It reads the link from the LEAN side: the module's docstring cites its harness
 * by path (`pinned against Node/V8 (lean/experiments/small-leaves-refs.mts)`).
 * The obvious alternative — search the harnesses for the module's name — was
 * tried first and is WRONG, in the direction that costs you: a harness refers to
 * its subject by TS filename and exported function (`focus-places-identity.ts`,
 * `matchClusters`), never by the Lean module name, so `FocusIdentity` came out
 * unpinned when its guards were V8-derived all along. Reported as a finding, then
 * withdrawn (#434).
 *
 * So the citation is authoritative and a missing one is the signal. A cited file
 * that does not EXIST is worse than no citation — it is a claim of provenance
 * with nothing behind it — so that is checked and called out rather than counted
 * as pinned.
 */
const EXPERIMENTS = path.join(LEAN, "experiments");
const present = new Set(readdirSync(EXPERIMENTS));
/** The harnesses a module's own docstring claims its guards came from, each
 *  marked when the file it names is not there. */
const refsFor = (m: string): string[] =>
	[...new Set([...body(m).matchAll(/experiments\/([\w-]+\.mts)/g)].map((x) => x[1]))].map((f) =>
		present.has(f) ? f : `${f} (MISSING)`,
	);

const tier = (m: string): "proven" | "pinned" | "none" =>
	shape(m).thms > 0 ? "proven" : shape(m).guards > 0 ? "pinned" : "none";
const TIERS: [string, string, string][] = [
	["proven", "PROVEN — `lake build` is the check", "misses nothing it states"],
	["pinned", "GUARD-PINNED — no live comparator", "misses the TS moving (#417)"],
	["none", "NO check of any kind", "misses everything"],
];
for (const [key, label] of TIERS) {
	console.log(`${label.padEnd(38)} ${String(dark.filter((m) => tier(m) === key).length).padStart(3)}`);
}
console.log(`${"".padEnd(38)} ${"---".padStart(3)}\n${"total".padEnd(38)} ${String(all.length).padStart(3)}\n`);
for (const [key, label, misses] of TIERS) {
	const ms = dark.filter((m) => tier(m) === key);
	if (ms.length === 0) continue;
	console.log(`  ${label} — ${misses}`);
	for (const m of ms) {
		const { thms, defs, guards } = shape(m);
		const refs = refsFor(m);
		const prov = key === "pinned" ? (refs.length > 0 ? `  <- ${refs.join(", ")}` : "  <- CITES NO HARNESS") : "";
		console.log(
			`    ${m.padEnd(30)} ${String(thms).padStart(3)} thm ${String(defs).padStart(3)} def ` +
				`${String(guards).padStart(3)} guard${prov}`,
		);
	}
	console.log("");
}

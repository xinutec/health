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
 *   Hsmm.GpsOutliers    `pnpm run compare-gps-outliers` — the HSMM fixtures'
 *                       points through both arms, kept-sets compared (#695)
 *
 * Run: TMPDIR=/tmp npx tsx lean/experiments/lean-coverage.mts
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
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
 *   `GpsOutliers` was NEITHER, and is now live-compared (#695, 2026-08-11). It
 *   is the only Lean implementation and its TS is live — `decode.ts:160` calls
 *   `dropGpsOutliers` on every decode.
 *
 *   The reason recorded here for why no verb reached it was WRONG, and worth
 *   keeping as the correction it is. It said the fixture was captured downstream
 *   of the drop — `capture-hsmm-day.ts:191` applies the same drop BEFORE
 *   storing — so the stored points held no outliers and a replay could not
 *   exercise the pass, making it the #233 waiver shape with a capture-side fix.
 *   Line 191 applies the drop to `computeMinuteProximity`'s ARGUMENT. The stored
 *   `points` are `velResult.points`, raw. Measured: all 11 fixtures carry
 *   outliers, 999 of 8758 fixes, ~11%. The data was there the whole time and the
 *   missing piece was a verb, which is a wiring change here after all.
 *
 *   Two claims stood next to each other for a day — "no verb reaches it", true
 *   and mechanical, and "the fixture cannot exercise it", inferred from a line
 *   number and never run. Only the first was checkable without work, and it was
 *   the one that turned out to be the whole problem.
 *
 * SHAPE — in the residue correctly, but not ports and not news:
 *   `Verified.Hsmm.Factors` is an AGGREGATOR: 24 imports, zero definitions. It
 *   exists to pull the HSMM tree into the library root. It now has a tier of its
 *   own (IMPORT SURFACE) rather than being counted as guard-pinned on the
 *   strength of the phrase `#guard` in its docstring — see {@link shape} (#738).
 *   `Verified.Hsmm.Tests` / `Verified.Rail.Tests` are guard suites. Guard-only
 *   is what they are FOR, the way theorem-only is what a PROVEN module is for.
 *   Both check a port against an in-language exhaustive ORACLE rather than
 *   against V8, which is why the provenance column no longer asks them to cite
 *   a harness — see {@link provenance}.
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
	// #695. Listed on the same condition as the stationchain row above: the
	// `gpsoutliers` verb and `compare-gps-outliers.mts` landed together, so this
	// row moved when the module became COMPARED, not when it became reachable.
	["compare-gps-outliers", ["Verified.Hsmm.GpsOutliers"]],
];

/**
 * ⚠ A GATE ROW IS A CLAIM THAT A COMPARATOR EXISTS, AND NOTHING USED TO CHECK IT.
 *
 * {@link GATES} credits modules by the NAME of the gate that compares them. The
 * rows were added carefully — the `stationchain` and `gps-outliers` comments
 * above record the discipline of listing a row only once its comparator landed —
 * but nothing ever REMOVED a row when a comparator died. On 2026-08-26 the
 * TypeScript backend was deleted (#975) and with it every arm these gates ran
 * against; this file went on crediting them, and reported 120 of 173 modules as
 * live-compared by harnesses that cannot start.
 *
 * That is the exact failure this file's own header warns about — "a coverage
 * tool that grants or withholds credit STRUCTURALLY, by a copied list, is
 * asserting, not measuring" — realised on the list doing the warning. #672,
 * #674 and #942 were the first three instances; this is the fourth and by far
 * the largest.
 *
 * So each row now names the ENTRY POINT that must exist and be runnable, and a
 * dead row credits nothing. Its modules fall through to the residue, where the
 * existing tiering judges them on their guards and theorems like any other
 * unattended port — which is what they now are.
 */
const GATE_ENTRY: Record<string, string[] | null> = {
	"day-gate": ["scripts/day-gate.sh", "lean/experiments/compare-day.mts"],
	"focus-gate": ["scripts/focus-gate.sh", "lean/experiments/compare-focus.mts"],
	"compare-match / LEAN_MATCH": ["lean/experiments/compare-match.mts"],
	"LEAN_HSMM / compare-assemble": ["lean/experiments/compare-assemble.mts"],
	// ⚠ `null` is WAIVED, and it must credit NOTHING — #233 decided there is no
	// rail comparator, so its modules are unattended by choice rather than by
	// accident. This row printed 0 for a year only because `compare-match`
	// claimed both roots first (LazyDijkstra imports Rail.Dijkstra). The moment
	// that gate was correctly marked dead, a `[]` here would have credited 3
	// modules to a gate that has never existed — the same over-credit this
	// change removes, reintroduced one line below the comment describing it.
	"LEAN_RAIL (waived)": null,
	"LEAN_STATIONCHAIN / compare-stationchain": ["lean/experiments/compare-stationchain.mts"],
	"kalman / gpsquality / biolabels": ["lean/experiments/compare-kalman.mts"],
	"compare-gps-outliers": ["lean/experiments/compare-gps-outliers.mts"],
};

const REPO = path.join(LEAN, "..");

/**
 * Can this harness actually run?
 *
 * ⚠ EXISTENCE IS NOT ENOUGH, and that distinction is the whole point here. Four
 * of these `.mts` files are still on disk and every one of them imports
 * `../../src/`, deleted with the TypeScript. A file check would have credited
 * them and reproduced the bug in a new place.
 *
 * So: the entry point must exist AND every relative import it names must
 * resolve. One level deep, which is enough — the arms all reach the deleted tree
 * directly. `.js` specifiers map to `.ts`/`.mts` the way the TS toolchain
 * resolves them.
 */
const harnessRunnable = (rel: string): boolean => {
	const abs = path.join(REPO, rel);
	if (!existsSync(abs)) return false;
	if (!/\.m?ts$/.test(rel)) return true; // a shell entry point: existence is all we can cheaply say
	const src = readFileSync(abs, "utf8");
	const specs = [...src.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1]);
	return specs.every((spec) => {
		const base = path.resolve(path.dirname(abs), spec.replace(/\.js$/, ""));
		return [".ts", ".mts", ".js", ".mjs", ""].some((ext) => existsSync(base + ext));
	});
};

const claimed = new Set<string>();
const deadGates: [string, number][] = [];
for (const [label, roots] of GATES) {
	const entries = GATE_ENTRY[label];
	const fresh = [...closure(roots)].filter((m) => !claimed.has(m));
	if (entries === null) {
		// Waived: no comparator by decision. Credits nothing, and is not a loss.
		console.log(`${label.padEnd(38)} ${"—".padStart(3)}   waived, credits nothing`);
		continue;
	}
	if (!(entries ?? []).some(harnessRunnable)) {
		deadGates.push([label, fresh.length]);
		console.log(`${label.padEnd(38)} ${"—".padStart(3)}   ⚠ COMPARATOR GONE, credits nothing`);
		continue;
	}
	for (const m of fresh) claimed.add(m);
	console.log(`${label.padEnd(38)} ${String(fresh.length).padStart(3)}`);
}
if (deadGates.length > 0) {
	const n = deadGates.reduce((a, [, c]) => a + c, 0);
	console.log(
		`\n⚠ ${deadGates.length} gate(s) name a comparator that cannot run; ` +
			`${n} module(s) fall to the residue below rather than counting as compared.`,
	);
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
/**
 * All three anchor at the start of a line, and the guard one has to (#738).
 *
 * It was `/#guard/g` — every occurrence anywhere in the file, prose included —
 * and 61 of the 128 modules say the word `#guard` in their own docstring while
 * explaining what pins them. 68 phantom guards across the corpus, 3428 counted
 * against 3360 real.
 *
 * On a module with forty real guards a spare one is a rounding error. On
 * `Verified.Hsmm.Factors` it was the entire count: zero theorems, zero
 * definitions, zero guards, one sentence mentioning them — and {@link tier}
 * reads `guards > 0`, so a word in a comment was promoting the module out of
 * "NO check of any kind". The headline this file exists to print was partly
 * bought by prose.
 *
 * Indentation is allowed for symmetry with the other two, not because anything
 * needs it: measured, no `#guard` in the tree is indented, so `^#guard` and
 * `^ *#guard` agree at 3360. `scripts/lean-port-coverage.mjs` has always used
 * the anchored form and was never wrong about this.
 */
const shape = (m: string): { thms: number; defs: number; guards: number } => ({
	thms: count(m, /^ *(theorem|lemma) /gm),
	defs: count(m, /^ *(private )?def /gm),
	guards: count(m, /^ *#guard\b/gm),
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

/**
 * A module that states NOTHING — no theorem, no definition, no guard — is not
 * an unchecked port. It is an import surface: a file whose whole content is
 * `import` lines pulling a subtree into the library root, so that the guards in
 * that subtree run under `lake build`. `Verified.Hsmm.Factors` is the case
 * (#738): 24 imports, and its docstring says as much.
 *
 * It gets its own tier rather than a place in either neighbour, because both
 * neighbours would be a claim about a thing that does not exist. GUARD-PINNED
 * says "checked by guards" of a file with none. "NO check of any kind" says the
 * port is unchecked, of a file that ports nothing — and would put a 1 under the
 * headline for a module where 0 and 1 are equally meaningless.
 *
 * The distinction is only visible because the counts are printed per module. An
 * import surface and a stub read identically from the tier label alone, and
 * telling them apart is what the `0 thm 0 def 0 guard` line beside the name is
 * for — the same argument this file already makes for not filtering the
 * aggregator out of the residue entirely.
 */
/**
 * What the provenance column should say, which is not always "which harness".
 *
 * `CITES NO HARNESS` asks a V8 question: these guards claim no derivation, so
 * they may be the porter's belief agreeing with the porter's code (#434). That
 * is the right question for a PORT. It is the wrong question for the two
 * `*.Tests` modules, and they were the only two flying the flag once #695 and
 * #738 were resolved — a permanent warning that named no defect, which is how a
 * flag stops being read.
 *
 * Neither is a port. `Verified.Hsmm.Tests` checks `viterbi` against an
 * exhaustive brute-force oracle over seeded random problems; `Verified.Rail.Tests`
 * does the same for the Dijkstra against all-simple-paths enumeration. Both arms
 * are Lean, so there is no V8 answer to cite and nothing was written by hand
 * from belief — the expectation is COMPUTED by the oracle at build time, every
 * build, on instances chosen by seed rather than by the author.
 *
 * Selected by module name, deliberately shallowly: the rule is visible, and
 * what would make it wrong is visible too — a `*.Tests` module that pins a TS
 * port instead of running an oracle would be mislabelled here, and the fix
 * would be to name it something else or to read the docstring instead of the
 * name. Nothing about that is worth a parser today, with two modules in scope.
 */
const provenance = (m: string, refs: string[]): string => {
	if (refs.length > 0) return refs.join(", ");
	return m.endsWith(".Tests") ? "IS AN ORACLE SUITE (no TS arm to cite)" : "CITES NO HARNESS";
};

const tier = (m: string): "proven" | "pinned" | "surface" | "none" => {
	const s = shape(m);
	if (s.thms > 0) return "proven";
	if (s.guards > 0) return "pinned";
	return s.defs === 0 ? "surface" : "none";
};
const TIERS: [string, string, string][] = [
	["proven", "PROVEN — `lake build` is the check", "misses nothing it states"],
	["pinned", "GUARD-PINNED — no live comparator", "misses the TS moving (#417)"],
	["surface", "IMPORT SURFACE — states nothing", "nothing to miss; not a port"],
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
		const prov = key === "pinned" ? `  <- ${provenance(m, refs)}` : "";
		console.log(
			`    ${m.padEnd(30)} ${String(thms).padStart(3)} thm ${String(defs).padStart(3)} def ` +
				`${String(guards).padStart(3)} guard${prov}`,
		);
	}
	console.log("");
}

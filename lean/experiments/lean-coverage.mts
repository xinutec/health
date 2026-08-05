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
const under = (prefix: string): string[] => all.filter((m) => m.startsWith(prefix));

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
	["compare-match / LEAN_MATCH", ["Verified.Geo.Match"]],
	["LEAN_HSMM / compare-assemble", under("Verified.Hsmm")],
	["LEAN_RAIL (waived)", under("Verified.Rail")],
	["kalman / gpsquality / biolabels", ["Verified.Geo.Kalman", "Verified.Geo.GpsQuality", "Verified.Geo.BiometricLabels"]],
];

const claimed = new Set<string>();
for (const [label, roots] of GATES) {
	const fresh = [...closure(roots)].filter((m) => !claimed.has(m));
	for (const m of fresh) claimed.add(m);
	console.log(`${label.padEnd(34)} ${String(fresh.length).padStart(3)}`);
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
const shape = (m: string): { thms: number; defs: number } => ({
	thms: count(m, /^ *(theorem|lemma) /gm),
	defs: count(m, /^ *(private )?def /gm),
});
const proven = dark.filter((m) => shape(m).thms > 0);
const ungraded = dark.filter((m) => shape(m).thms === 0);
console.log(`${"PROVEN — gated by `lake build`".padEnd(34)} ${String(proven.length).padStart(3)}`);
console.log(`${"NO check of any kind".padEnd(34)} ${String(ungraded.length).padStart(3)}`);
console.log(`${"".padEnd(34)} ${"---".padStart(3)}\n${"total".padEnd(34)} ${String(all.length).padStart(3)}\n`);
for (const [label, ms] of [
	["proven", proven],
	["ungraded", ungraded],
] as [string, string[]][]) {
	if (ms.length === 0) continue;
	console.log(`  ${label}:`);
	for (const m of ms) {
		const { thms, defs } = shape(m);
		console.log(`    ${m.padEnd(30)} ${String(thms).padStart(3)} thm  ${String(defs).padStart(3)} def`);
	}
}

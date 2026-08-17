/**
 * V8 reference values for the Lean port of `src/geo/walk-building-escape.ts`
 * (the case-based building-escape walk corrector).
 *
 * Everything in that module is pure geometry, so the whole of it ports. The
 * private helpers (`pointInRing`, `nearestOnRing`, `segBadnessM`, `densify`,
 * `repairChord`, the way-segment grid) are pinned THROUGH the exported callers
 * rather than by exporting them for the harness:
 *   - `nudgeTowardWays`      reads `nearestWalkable` out directly,
 *   - `escapeBuildings`      exercises pointInRing / nearestOnRing / the escape,
 *   - `routeChordAroundBuildings` exercises segRingCrossingTs / ringCornersBetween /
 *                            firstCrossedRing / polylineEntersBuilding / repairChord,
 *   - `correctWalkPath`'s diag records expose `runBadM` / `routeBadM` / `addedM` /
 *                            `budgetM` / anchor snap distances — i.e. exact numeric
 *                            read-outs of segBadnessM + pathBadnessM + the grid.
 *
 * The walkable graph is dumped too: the Lean `routeOnWalkable` takes the FUSED
 * graph (nodeKey coordinate fusion is shell work), so `correctWalkPath`'s Lean
 * twin is fed the same topology production would hand it.
 *
 * Run:
 *   nix develop /Users/pippijn/Code/health --command \
 *     npx tsx /Users/pippijn/Code/health/lean/experiments/walk-escape-refs.mts
 */

import type { BuildingFootprint } from "../../src/geo/osm-local.js";
import type { RoadGeometry } from "../../src/geo/map-match-core.js";
import { buildWalkGraph } from "../../src/geo/walkable-route.js";
import {
	correctWalkPath,
	escapeBuildings,
	routeChordAroundBuildings,
	snapPassages,
	DEFAULT_CORRECT_OPTIONS,
	DEFAULT_ESCAPE_OPTIONS,
	type CorrectOptions,
	type CorrectRunDiag,
	type CorrectedPoint,
} from "../../src/geo/walk-building-escape.js";

const f = (x: number): string => (Number.isFinite(x) ? x.toPrecision(17) : String(x));
const fo = (x: number | null | undefined): string => (x === null || x === undefined ? "none" : f(x));

// --- a synthetic city block, in metres north/east of a London origin --------
const LAT0 = 51.52;
const LON0 = -0.13;
const MLAT = 1 / 111_320;
const MLON = 1 / (111_320 * Math.cos((LAT0 * Math.PI) / 180));
/** (north metres, east metres) → lat/lon. */
const P = (n: number, e: number): { lat: number; lon: number } => ({ lat: LAT0 + n * MLAT, lon: LON0 + e * MLON });
const T = (n: number, e: number, ts: number): CorrectedPoint => ({ ...P(n, e), ts });

type Coord = [number, number];
const way = (...ne: Array<[number, number]>): Coord[] => ne.map(([n, e]) => [P(n, e).lat, P(n, e).lon]);
function geoOf(ways: Coord[][]): RoadGeometry {
	return {
		ways: ways.map((coords, i) => ({ osmId: i + 1, name: `w${i + 1}`, subtype: "footway", coords })),
	} as RoadGeometry;
}
function ringOf(...ne: Array<[number, number]>): BuildingFootprint {
	return ne.map(([n, e]) => P(n, e));
}

/** Streets: a 100 m × 100 m block ring (four ways meeting at shared corners). */
const STREETS: Coord[][] = [
	way([0, 0], [0, 100]), // south
	way([100, 0], [100, 100]), // north
	way([0, 0], [100, 0]), // west
	way([0, 100], [100, 100]), // east
];
/** A house near the south street: north 10..30, east 30..70. */
const HOUSE: BuildingFootprint = ringOf([10, 30], [10, 70], [30, 70], [30, 30]);
/** A second, bigger block-filling footprint: north 40..80, east 20..80. */
const BLOCKHOUSE: BuildingFootprint = ringOf([40, 20], [40, 80], [80, 80], [80, 20]);
/** A footprint whose south wall sits ON the south street: north 0..30, east 30..70. */
const LOWHOUSE: BuildingFootprint = ringOf([0, 30], [0, 70], [30, 70], [30, 30]);

const GEO = geoOf(STREETS);

console.log("=== origin scale ===");
console.log(`LAT0=${f(LAT0)} LON0=${f(LON0)} MLAT=${f(MLAT)} MLON=${f(MLON)}`);

console.log("");
console.log("=== ring / way coordinates (Lean inputs) ===");
const dumpRing = (label: string, r: BuildingFootprint): void => {
	console.log(`${label}: ${r.length} pts`);
	for (const p of r) console.log(`  ${f(p.lat)} ${f(p.lon)}`);
};
dumpRing("HOUSE", HOUSE);
dumpRing("BLOCKHOUSE", BLOCKHOUSE);
STREETS.forEach((w, i) => {
	console.log(`street ${i}: ${w.map(([la, lo]) => `(${f(la)},${f(lo)})`).join(" ")}`);
});

console.log("");
console.log("=== buildWalkGraph(STREETS) (shell-side topology) ===");
{
	const g = buildWalkGraph(GEO);
	console.log(`${g.nodes.length} nodes`);
	g.nodes.forEach((n, i) => console.log(`  node ${i}: ${f(n.lat)} ${f(n.lon)}`));
	g.adj.forEach((es, i) => console.log(`  adj ${i}: ${es.map((e) => `${e.to}@${f(e.distM)}`).join(" ")}`));
	const idx = new Map<string, number>();
	g.nodes.forEach((n, i) => idx.set(`${n.lat.toFixed(7)},${n.lon.toFixed(7)}`, i));
	let k = 0;
	for (const w of GEO.ways) {
		for (let i = 1; i < w.coords.length; i++) {
			const a = w.coords[i - 1];
			const b = w.coords[i];
			const ia = idx.get(`${a[0].toFixed(7)},${a[1].toFixed(7)}`);
			const ib = idx.get(`${b[0].toFixed(7)},${b[1].toFixed(7)}`);
			console.log(`  edge ${k++}: ids=${ia},${ib}`);
		}
	}
}

console.log("");
console.log("=== escapeBuildings (case 1 + case 3) ===");
{
	const probes: Array<[string, { lat: number; lon: number }, BuildingFootprint[]]> = [
		// Inside HOUSE, nearest wall is the south wall (n=10) 5 m away; escaping
		// 2 m past it lands 8 m from the south street → within the 20 m snap.
		["inside, escapes to the south street", P(15, 50), [HOUSE]],
		// Nearest wall is the north wall (n=30) 5 m away → 2 m past is n=32,
		// 68 m from the north street → beyond the snap radius → trust GPS.
		["inside, no near-side street", P(25, 50), [HOUSE]],
		// Outside every footprint → untouched.
		["outside", P(50, 50), [HOUSE]],
		// On a wall (n=10 exactly) — the ray cast decides; pinned either way.
		["on the south wall", P(10, 50), [HOUSE]],
		["no buildings", P(15, 50), []],
		// A degenerate ring (< 3 points) is never entered.
		["degenerate ring", P(15, 50), [ringOf([10, 30], [10, 70])]],
	];
	for (const [label, p, bs] of probes) {
		const [out] = escapeBuildings([p], GEO, bs, DEFAULT_ESCAPE_OPTIONS);
		console.log(`${label}: ${f(out.lat)} ${f(out.lon)}`);
	}
}

console.log("");
console.log("=== routeChordAroundBuildings (case 2.5 primitive) ===");
function chord(label: string, a: { lat: number; lon: number }, b: { lat: number; lon: number }, bs: BuildingFootprint[]): void {
	const r = routeChordAroundBuildings(a, b, bs);
	if (r === null) {
		console.log(`${label}: null`);
		return;
	}
	console.log(`${label}: ${r.length} pts`);
	for (const p of r) console.log(`  ${f(p.lat)} ${f(p.lon)}`);
}
chord("no buildings", P(0, 50), P(100, 50), []);
chord("clear chord", P(0, 10), P(100, 10), [HOUSE]);
chord("through the house", P(0, 50), P(100, 50), [HOUSE]);
chord("through the house, east-west", P(20, 0), P(20, 100), [HOUSE]);
chord("through two footprints", P(0, 50), P(100, 50), [HOUSE, BLOCKHOUSE]);
chord("endpoint inside the house", P(15, 50), P(100, 50), [HOUSE]);

console.log("");
console.log("=== correctWalkPath (the full corrector, with diag) ===");
function correct(
	label: string,
	drawn: CorrectedPoint[],
	ways: Coord[][],
	bs: BuildingFootprint[],
	opts: CorrectOptions = DEFAULT_CORRECT_OPTIONS,
): void {
	const diags: CorrectRunDiag[] = [];
	const out = correctWalkPath(drawn, geoOf(ways), bs, opts, (d) => diags.push(d));
	console.log(`${label}: ${out.length} pts, ${diags.length} diag`);
	for (const p of out) console.log(`  ${f(p.lat)} ${f(p.lon)} ${f(p.ts)}`);
	for (const d of diags)
		console.log(
			`  diag ${d.outcome} straight=${f(d.straightM)} runBad=${f(d.runBadM)} routeFound=${d.routeFound}` +
				` routeBad=${fo(d.routeBadM)} added=${fo(d.addedM)} budget=${f(d.budgetM)}` +
				` snapA=${fo(d.anchorASnapM)} snapB=${fo(d.anchorBSnapM)}`,
		);
}

// Clean walk along the south street: nothing implausible → returned untouched.
correct("clean walk", [T(0, 10, 1000), T(0, 50, 1030), T(0, 90, 1060)], STREETS, [HOUSE]);
// A drawn line straight through the house between the two streets: a street
// route exists around the block → case 2.
correct("through the house (route around)", [T(0, 50, 1000), T(100, 50, 1100)], STREETS, [HOUSE]);
// Same crossing but with NO street network → no route, no escape target →
// case 2.5 corner detour or trust-GPS.
correct("through the house, no streets", [T(0, 50, 1000), T(100, 50, 1100)], [], [HOUSE]);
// Only the block ring's south street exists → the route cannot get around.
correct("through the house, south street only", [T(0, 50, 1000), T(100, 50, 1100)], [STREETS[0]], [HOUSE]);
// Case 2 proper: widen the anchor snap and the route bound so the street route
// around the block is actually reachable and affordable → outcome `routed`.
correct("through the house (case 2 routed)", [T(0, 50, 1000), T(100, 50, 1100)], STREETS, [HOUSE], {
	...DEFAULT_CORRECT_OPTIONS,
	routeSnapRadiusM: 60,
	minRouteBudgetM: 400,
});
// Case 1 fallback: a footprint sitting ON the south street, clipped by a line
// 8 m inside it. A tight detour ratio refuses both the street route and the
// corner detour, so the per-vertex escape onto the near-side street is what
// carries the fix → outcome `escaped`.
correct("clipped low house (case 1 escape)", [T(12, 10, 1000), T(12, 90, 1080)], STREETS, [LOWHOUSE], {
	...DEFAULT_CORRECT_OPTIONS,
	maxDetourRatio: 0.9,
	minRouteBudgetM: 0,
	routeSnapRadiusM: 5,
});
// Urban block cut: mid-block, >offNetworkM from every street, with the house
// wall inside buildingProxM — bad, but nothing to correct it with (case 3).
correct("block cut (off-network, near buildings)", [T(35, 40, 1000), T(35, 70, 1030)], STREETS, [HOUSE]);
// Open ground: same geometry, no buildings at all → nothing to correct.
correct("open ground", [T(35, 40, 1000), T(35, 70, 1030)], STREETS, []);
// Step-budget invariant: a budget shorter than any correction reverts the leg.
correct("step-budget revert", [T(0, 50, 1000), T(100, 50, 1100)], STREETS, [HOUSE], {
	...DEFAULT_CORRECT_OPTIONS,
	stepBudgetM: 105,
});
// A tiny leg budget refuses the reroute (minRouteBudgetM floored to 0).
correct("budget zero", [T(0, 50, 1000), T(100, 50, 1100)], STREETS, [HOUSE], {
	...DEFAULT_CORRECT_OPTIONS,
	minRouteBudgetM: 0,
	maxLegInflation: 0,
});

console.log("");
console.log("=== snapPassages ===");
{
	// A mapped passage THROUGH the house: a way from the south street to the
	// north one, threading the footprint with a bend the drawn chord cuts.
	const PASSAGE: Coord[][] = [...STREETS, way([0, 50], [15, 52], [25, 48], [100, 50])];
	const drawn = [T(0, 50, 1000), T(20, 50, 1020), T(100, 50, 1100)];
	const out = snapPassages(drawn, geoOf(PASSAGE), [HOUSE], DEFAULT_CORRECT_OPTIONS);
	console.log(`passage: ${out.length} pts`);
	for (const p of out) console.log(`  ${f(p.lat)} ${f(p.lon)} ${f(p.ts)}`);
	const none = snapPassages(drawn, geoOf(PASSAGE), [], DEFAULT_CORRECT_OPTIONS);
	console.log(`no buildings: ${none.length} pts`);
	const noWays = snapPassages(drawn, geoOf([]), [HOUSE], DEFAULT_CORRECT_OPTIONS);
	console.log(`no ways: ${noWays.length} pts`);
	// Same drawn line, but the only ways are the block streets — nothing in
	// reach inside the footprint, so the in-building vertex keeps its place.
	const plain = snapPassages(drawn, GEO, [HOUSE], DEFAULT_CORRECT_OPTIONS);
	console.log(`no passage way: ${plain.length} pts`);
	for (const p of plain) console.log(`  ${f(p.lat)} ${f(p.lon)} ${f(p.ts)}`);
	// The passage graph, for the Lean twin's way list.
	console.log("passage ways:");
	PASSAGE.forEach((w, i) => console.log(`  way ${i}: ${w.map(([la, lo]) => `(${f(la)},${f(lo)})`).join(" ")}`));
}

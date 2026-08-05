/**
 * V8 reference values for the Lean port of `src/geo/walk-smooth-map.ts`
 * (the continuous MAP walk smoother, the matched-path refiner, and the robust
 * annealed `reconstructWalk`).
 *
 * The module is pure geometry + linear algebra; only `reconstructProfileFromEnv`
 * (env reads) and the `WALK_RECON_DEBUG` tracing stay shell. Profiles are passed
 * EXPLICITLY here so the references never depend on the environment.
 *
 * Run:
 *   nix develop /Users/pippijn/Code/health --command \
 *     npx tsx /Users/pippijn/Code/health/lean/experiments/walk-smooth-refs.mts
 */

import type { RoadGeometry } from "../../src/geo/map-match-core.js";
import type { BuildingFootprint } from "../../src/geo/osm-local.js";
import {
	countSharpTurns,
	reconstructWalk,
	refineMatchedPath,
	smoothWalkMap,
	tortuosity,
	DEFAULT_MAP_SMOOTH_PROFILE,
	DEFAULT_RECONSTRUCT_PROFILE,
	REFINE_MATCHED_PROFILE,
	type WalkEvidence,
	type WalkFix,
} from "../../src/geo/walk-smooth-map.js";

const f = (x: number): string => (Number.isFinite(x) ? x.toPrecision(17) : String(x));

// --- local metric frame, as in the walk-escape harness ---------------------
const LAT0 = 51.52;
const LON0 = -0.13;
const MLAT = 1 / 111_320;
const MLON = 1 / (111_320 * Math.cos((LAT0 * Math.PI) / 180));
/** (north metres, east metres) → lat/lon. */
const P = (n: number, e: number): { lat: number; lon: number } => ({ lat: LAT0 + n * MLAT, lon: LON0 + e * MLON });

type Coord = [number, number];
const way = (...ne: Array<[number, number]>): Coord[] => ne.map(([n, e]) => [P(n, e).lat, P(n, e).lon]);
function geoOf(ways: Coord[][], buildings?: BuildingFootprint[]): RoadGeometry {
	return {
		ways: ways.map((coords, i) => ({ osmId: i + 1, name: `w${i + 1}`, subtype: "footway", coords })),
		...(buildings ? { buildings } : {}),
	} as RoadGeometry;
}
function ringOf(...ne: Array<[number, number]>): BuildingFootprint {
	return ne.map(([n, e]) => P(n, e));
}

/** A straight east-west street along n=0, and a north-south one at e=100. */
const STREETS: Coord[][] = [way([0, 0], [0, 200]), way([0, 100], [200, 100])];
/** A house north of the east-west street: north 5..25, east 30..70. */
const HOUSE: BuildingFootprint = ringOf([5, 30], [5, 70], [25, 70], [25, 30]);

/** A walk east along the street with GPS wobble, at 10 m intervals. */
const WOBBLE: WalkFix[] = [
	{ ...P(3, 0), ts: 1000, accuracyM: 8 },
	{ ...P(-4, 10), ts: 1010, accuracyM: 12 },
	{ ...P(2, 20), ts: 1020, accuracyM: 20 },
	{ ...P(-3, 30), ts: 1030 }, // no reported accuracy → the profile fallback
	{ ...P(5, 40), ts: 1040, accuracyM: 6 },
	{ ...P(-1, 50), ts: 1050, accuracyM: 30 },
	{ ...P(2, 60), ts: 1060, accuracyM: 10 },
	{ ...P(0, 70), ts: 1070, accuracyM: 9 },
];

console.log("=== frame ===");
console.log(`LAT0=${f(LAT0)} LON0=${f(LON0)} MLAT=${f(MLAT)} MLON=${f(MLON)}`);
console.log("");
console.log("=== inputs (Lean literals) ===");
console.log("STREETS:");
STREETS.forEach((w, i) => console.log(`  way ${i}: ${w.map(([la, lo]) => `(${f(la)},${f(lo)})`).join(" ")}`));
console.log("HOUSE:");
for (const p of HOUSE) console.log(`  ${f(p.lat)} ${f(p.lon)}`);
console.log("WOBBLE:");
for (const x of WOBBLE) console.log(`  ${f(x.lat)} ${f(x.lon)} ts=${f(x.ts)} acc=${x.accuracyM ?? "none"}`);

console.log("");
console.log("=== countSharpTurns ===");
{
	const cases: Array<[string, Array<{ lat: number; lon: number }>, number | undefined]> = [
		["too short", [P(0, 0), P(0, 10)], undefined],
		["straight", [P(0, 0), P(0, 10), P(0, 20)], undefined],
		["right angle", [P(0, 0), P(0, 10), P(10, 10)], undefined],
		["staircase", [P(0, 0), P(0, 10), P(10, 10), P(10, 20), P(20, 20)], undefined],
		["shallow 30 deg", [P(0, 0), P(0, 10), P(5.7735, 20)], undefined],
		["30 deg at threshold 25", [P(0, 0), P(0, 10), P(5.7735, 20)], 25],
		["duplicate vertex", [P(0, 0), P(0, 0), P(10, 10)], undefined],
		["reversal", [P(0, 0), P(0, 10), P(0, 0)], undefined],
	];
	for (const [label, pts, th] of cases) {
		console.log(`${label}: ${th === undefined ? countSharpTurns(pts) : countSharpTurns(pts, th)}`);
	}
}

console.log("");
console.log("=== tortuosity ===");
{
	console.log(`single: ${f(tortuosity([P(0, 0)]))}`);
	console.log(`straight: ${f(tortuosity([P(0, 0), P(0, 50), P(0, 100)]))}`);
	console.log(`staircase: ${f(tortuosity([P(0, 0), P(0, 50), P(50, 50), P(50, 100)]))}`);
	console.log(`sub-metre span: ${f(tortuosity([P(0, 0), P(0, 0.4)]))}`);
}

console.log("");
console.log("=== smoothWalkMap ===");
function smooth(label: string, fixes: WalkFix[], ways: Coord[][]): void {
	const r = smoothWalkMap(fixes, geoOf(ways), DEFAULT_MAP_SMOOTH_PROFILE);
	if (r === null) {
		console.log(`${label}: null`);
		return;
	}
	console.log(`${label}: ${r.length} pts`);
	for (const p of r) console.log(`  ${f(p.lat)} ${f(p.lon)} ${f(p.ts)}`);
}
smooth("too few fixes", WOBBLE.slice(0, 3), STREETS);
smooth("wobble on the street", WOBBLE, STREETS);
smooth("wobble, no network", WOBBLE, []);
// Far from any way: the network gate (25 m) never fires, so it is GPS+smoothness.
smooth(
	"far off network",
	WOBBLE.map((x) => ({ ...x, lat: x.lat + 100 * MLAT })),
	STREETS,
);

console.log("");
console.log("=== refineMatchedPath ===");
function refine(
	label: string,
	fixes: WalkFix[],
	matched: Array<{ lat: number; lon: number }>,
	maxDev?: number,
): void {
	const r =
		maxDev === undefined
			? refineMatchedPath(fixes, matched, REFINE_MATCHED_PROFILE)
			: refineMatchedPath(fixes, matched, REFINE_MATCHED_PROFILE, maxDev);
	if (r === null) {
		console.log(`${label}: null`);
		return;
	}
	console.log(`${label}: ${r.length} pts`);
	for (const p of r) console.log(`  ${f(p.lat)} ${f(p.lon)} ${f(p.ts)}`);
}
refine("matched too short", WOBBLE, [P(0, 0)]);
refine("too few fixes", WOBBLE.slice(0, 3), [P(0, 0), P(0, 70)]);
// A straight matched line: no corners at all, so the tight budget holds
// everywhere and the refinement barely moves the line.
refine("straight corridor", WOBBLE, [P(0, 0), P(0, 70)]);
// A STAIRCASE artifact: many clustered sharp corners → full budget locally.
const STAIR: Array<{ lat: number; lon: number }> = [
	P(0, 0),
	P(0, 15),
	P(8, 15),
	P(8, 30),
	P(0, 30),
	P(0, 45),
	P(8, 45),
	P(8, 70),
];
refine("staircase corridor", WOBBLE, STAIR);
// An ISOLATED corner is real street geometry: the tight budget must hold, and
// the skipped route vertex must be spliced back.
const ELBOW: Array<{ lat: number; lon: number }> = [P(0, 0), P(0, 40), P(60, 40)];
const ELBOW_FIXES: WalkFix[] = [
	{ ...P(1, 0), ts: 1000, accuracyM: 10 },
	{ ...P(-1, 20), ts: 1020, accuracyM: 10 },
	{ ...P(2, 38), ts: 1040, accuracyM: 10 },
	{ ...P(20, 42), ts: 1060, accuracyM: 10 },
	{ ...P(45, 39), ts: 1080, accuracyM: 10 },
	{ ...P(60, 41), ts: 1100, accuracyM: 10 },
];
refine("isolated elbow", ELBOW_FIXES, ELBOW);
refine("isolated elbow, maxDev 4", ELBOW_FIXES, ELBOW, 4);
// Fixes far OFF the straight matched line: nothing is a corner, so the tight
// straight budget holds and every vertex is clamped radially back to it.
const OFFLINE_FIXES: WalkFix[] = WOBBLE.map((x) => ({ ...x, lat: x.lat + 20 * MLAT, accuracyM: 5 }));
refine("clamped to the straight budget", OFFLINE_FIXES, [P(0, 0), P(0, 70)]);

console.log("");
console.log("=== reconstructWalk ===");
function recon(
	label: string,
	fixes: WalkFix[],
	geo: RoadGeometry,
	evidence?: WalkEvidence,
	profile = DEFAULT_RECONSTRUCT_PROFILE,
): void {
	const r = reconstructWalk(fixes, geo, profile, evidence);
	if (r === null) {
		console.log(`${label}: null`);
		return;
	}
	console.log(`${label}: ${r.length} pts`);
	for (const p of r) console.log(`  ${f(p.lat)} ${f(p.lon)} ${f(p.ts)}`);
}
recon("too few fixes", WOBBLE.slice(0, 3), geoOf(STREETS));
recon("wobble on the street", WOBBLE, geoOf(STREETS));
recon("no network at all", WOBBLE, geoOf([]));
// With a footprint beside the street: the clearance field pushes the line off
// the wall, and corner insertion repairs any edge still crossing it.
recon("with a building", WOBBLE, geoOf(STREETS, [HOUSE]));
// A gross outlier mid-leg: the redescending kernel must reject it rather than
// detour to it.
const OUTLIER: WalkFix[] = WOBBLE.map((x, i) => (i === 4 ? { ...P(120, 40), ts: x.ts, accuracyM: 6 } : x));
recon("gross outlier rejected", OUTLIER, geoOf(STREETS));
// Endpoint anchors: reconstruct between confident truths.
recon("endpoint anchors", WOBBLE, geoOf(STREETS), {
	start: { ...P(0, -5), sigmaM: 2 },
	end: { ...P(0, 75), sigmaM: 2 },
});
// Step budget: 40 steps × 0.75 m × 1.4 slack = 42 m against a ~70 m draw, so
// the contraction factor fires and the extra iterations run.
recon("step budget contracts", WOBBLE, geoOf(STREETS), { stepsWalked: 40 });
// Ample steps → the factor stays fully off.
recon("step budget slack", WOBBLE, geoOf(STREETS), { stepsWalked: 400 });
// Corner insertion OFF.
recon("corners off", WOBBLE, geoOf(STREETS, [HOUSE]), undefined, {
	...DEFAULT_RECONSTRUCT_PROFILE,
	insertCornerDetours: false,
});
// Hard projection ON (the REFUTED arm — still ported, still pinned).
recon("hard projection on", WOBBLE, geoOf(STREETS, [HOUSE]), undefined, {
	...DEFAULT_RECONSTRUCT_PROFILE,
	hardProjectBuildings: true,
});
// Free-state densification ON (also refuted for prod, kept as a knob).
recon("densified free states", WOBBLE, geoOf(STREETS, [HOUSE]), undefined, {
	...DEFAULT_RECONSTRUCT_PROFILE,
	targetSpacingM: 5,
});
// A walk crossing the footprint: two fixes land inside it, which is BELOW the
// indoor-presence bar, so the clearance field repels and corner insertion
// repairs the edge that still passes through.
const CROSS: WalkFix[] = [
	{ ...P(-15, 50), ts: 1000, accuracyM: 8 },
	{ ...P(-5, 50), ts: 1010, accuracyM: 8 },
	{ ...P(8, 50), ts: 1020, accuracyM: 8 },
	{ ...P(18, 50), ts: 1030, accuracyM: 8 },
	{ ...P(28, 50), ts: 1040, accuracyM: 8 },
	{ ...P(38, 50), ts: 1050, accuracyM: 8 },
];
recon("crossing a footprint", CROSS, geoOf(STREETS, [HOUSE]));
// The SAME crossing with the presence bar lowered to 2: the two inside fixes now
// read as genuine entry, so the building is occupied space and nothing repels.
recon("crossing, presence bar 2", CROSS, geoOf(STREETS, [HOUSE]), undefined, {
	...DEFAULT_RECONSTRUCT_PROFILE,
	indoorPresenceMinFixes: 2,
});
recon("crossing, corners off", CROSS, geoOf(STREETS, [HOUSE]), undefined, {
	...DEFAULT_RECONSTRUCT_PROFILE,
	insertCornerDetours: false,
});
recon("crossing, hard projection on", CROSS, geoOf(STREETS, [HOUSE]), undefined, {
	...DEFAULT_RECONSTRUCT_PROFILE,
	hardProjectBuildings: true,
});
// A NARROW footprint on the same crossing: going around it costs little, so the
// corner detour clears the 2.5x ratio bound and interior corners are inserted.
const NARROW: BuildingFootprint = ringOf([5, 45], [5, 55], [25, 55], [25, 45]);
recon("crossing a narrow footprint", CROSS, geoOf(STREETS, [NARROW]));
recon("narrow, corners off", CROSS, geoOf(STREETS, [NARROW]), undefined, {
	...DEFAULT_RECONSTRUCT_PROFILE,
	insertCornerDetours: false,
});
// With the clearance field all but switched off, the solved line runs straight
// through the narrow footprint — so the between-vertex gap the per-state field
// is structurally blind to is exactly what corner insertion has to repair.
recon("narrow, soft field off, corners on", CROSS, geoOf(STREETS, [NARROW]), undefined, {
	...DEFAULT_RECONSTRUCT_PROFILE,
	buildingSigmaM: 1000,
});
recon("narrow, soft field off, corners off", CROSS, geoOf(STREETS, [NARROW]), undefined, {
	...DEFAULT_RECONSTRUCT_PROFILE,
	buildingSigmaM: 1000,
	insertCornerDetours: false,
});
// Corner insertion only ever fires on an edge that passes THROUGH a ring with
// BOTH ends outside — the between-vertex gap. Sparse fixes (30 m apart) put a
// whole edge across the narrow footprint, which is that case.
const SPARSE: WalkFix[] = [
	{ ...P(-60, 50), ts: 1000, accuracyM: 8 },
	{ ...P(-30, 50), ts: 1030, accuracyM: 8 },
	{ ...P(0, 50), ts: 1060, accuracyM: 8 },
	{ ...P(30, 50), ts: 1090, accuracyM: 8 },
	{ ...P(60, 50), ts: 1120, accuracyM: 8 },
];
recon("sparse crossing, corners on", SPARSE, geoOf(STREETS, [NARROW]), undefined, {
	...DEFAULT_RECONSTRUCT_PROFILE,
	buildingSigmaM: 1000,
});
recon("sparse crossing, corners off", SPARSE, geoOf(STREETS, [NARROW]), undefined, {
	...DEFAULT_RECONSTRUCT_PROFILE,
	buildingSigmaM: 1000,
	insertCornerDetours: false,
});
// Indoor presence: a run of raw fixes inside the SAME footprint exempts those
// states from the clearance field entirely.
const INDOOR: WalkFix[] = [
	{ ...P(0, 20), ts: 1000, accuracyM: 8 },
	{ ...P(10, 35), ts: 1010, accuracyM: 8 },
	{ ...P(15, 45), ts: 1020, accuracyM: 8 },
	{ ...P(12, 55), ts: 1030, accuracyM: 8 },
	{ ...P(15, 65), ts: 1040, accuracyM: 8 },
	{ ...P(0, 80), ts: 1050, accuracyM: 8 },
];
recon("indoor presence exempt", INDOOR, geoOf(STREETS, [HOUSE]));
// The same fixes with the bar raised above the run length: no exemption, so the
// clearance field pushes those states out of the footprint.
recon("indoor presence bar 5", INDOOR, geoOf(STREETS, [HOUSE]), undefined, {
	...DEFAULT_RECONSTRUCT_PROFILE,
	indoorPresenceMinFixes: 5,
});

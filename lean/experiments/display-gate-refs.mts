/**
 * V8 reference values for the Lean port of the display-acceptance cluster in
 * `src/geo/map-match-core.ts` (lines ~408-870): the exact nearest-segment grid,
 * the off-network metrics, the `matchImprovesDisplay` gate, and the
 * divergent-run splice that salvages a locally-rejected match.
 *
 * The private helpers `segmentDistM`, `projectToPolylineArc` and
 * `slicePathByArc` have no exported entry point; they are pinned through the
 * callers that drive them (`SegmentNearGrid.nearestDist` reads `segmentDistM`
 * out directly, `spliceMatchedWithDivergentRuns` exercises the other two).
 *
 * Run:
 *   nix develop /Users/pippijn/Code/health --command \
 *     npx tsx /Users/pippijn/Code/health/lean/experiments/display-gate-refs.mts
 */

import {
	SegmentNearGrid,
	fractionOffRoad,
	matchImprovesDisplay,
	maxPolylineOffRoad,
	metersBetween,
	nearestRoadDist,
	pointDistToPolyline,
	projectPointToSegment,
	quantilePointDistToPolyline,
	spliceMatchedWithDivergentRuns,
	type MatchedPoint,
	type OsmRoadWay,
	type RoadFix,
	type RoadGeometry,
} from "../../src/geo/map-match-core.js";

const f = (x: number): string => (Number.isFinite(x) ? x.toPrecision(17) : String(x));

// --- local metric frame, as in the walk-escape / walk-smooth harnesses -----
const LAT0 = 51.52;
const LON0 = -0.13;
const MLAT = 1 / 111_320;
const MLON = 1 / (111_320 * Math.cos((LAT0 * Math.PI) / 180));
/** (north metres, east metres) → lat/lon. */
const P = (n: number, e: number): { lat: number; lon: number } => ({ lat: LAT0 + n * MLAT, lon: LON0 + e * MLON });
/** …with a timestamp, for fixes and matched vertices. */
const T = (n: number, e: number, ts: number): MatchedPoint => ({ ...P(n, e), ts });

type Coord = [number, number];
const C = (n: number, e: number): Coord => {
	const p = P(n, e);
	return [p.lat, p.lon];
};

const way = (osmId: number, name: string, coords: Coord[]): OsmRoadWay => ({ osmId, name, subtype: "residential", coords });

// A city block: four streets bounding the rectangle n∈[0,100], e∈[0,200].
// The interior is off-network, so a chord across it is a building-cut.
const SOUTH = way(1, "South St", [C(0, -50), C(0, 250)]);
const NORTH = way(2, "North St", [C(100, -50), C(100, 250)]);
const WEST = way(3, "West St", [C(0, 0), C(100, 0)]);
const EAST = way(4, "East St", [C(0, 200), C(100, 200)]);

const GEO: RoadGeometry = { ways: [SOUTH, NORTH, WEST, EAST] };
const EMPTY: RoadGeometry = { ways: [] };

const lines: string[] = [];
const say = (label: string, value: string): void => lines.push(`${label} = ${value}`);
const section = (name: string): void => lines.push(`\n=== ${name} ===`);

// ---------------------------------------------------------------- metric ---
section("metersBetween / projectPointToSegment");
{
	const a = P(0, 0);
	const b = P(100, 200);
	say("metersBetween a b", f(metersBetween(a.lat, a.lon, b.lat, b.lon)));
	say("metersBetween a a", f(metersBetween(a.lat, a.lon, a.lat, a.lon)));

	const seg = (p: { lat: number; lon: number }, s: { lat: number; lon: number }, e: { lat: number; lon: number }, label: string): void => {
		const r = projectPointToSegment(p, s, e);
		say(`${label} t`, f(r.t));
		say(`${label} distM`, f(r.distM));
		say(`${label} lat`, f(r.lat));
		say(`${label} lon`, f(r.lon));
	};
	seg(P(10, 50), P(0, 0), P(0, 100), "mid perpendicular");
	seg(P(10, -30), P(0, 0), P(0, 100), "before a");
	seg(P(10, 300), P(0, 0), P(0, 100), "past b");
	seg(P(10, 50), P(0, 50), P(0, 50), "degenerate segment");
}

// ------------------------------------------------------------ near grid ---
section("SegmentNearGrid");
{
	const grid = SegmentNearGrid.fromWays(GEO.ways, 64);
	if (grid === null) throw new Error("expected a grid");
	const probe = (n: number, e: number, label: string): void => {
		const p = P(n, e);
		say(`${label} nearestDist`, f(grid.nearestDist(p.lat, p.lon)));
		say(`${label} nearestDist clamp20`, f(grid.nearestDist(p.lat, p.lon, 20)));
		say(`${label} bruteforce`, f(nearestRoadDist(p, GEO)));
	};
	probe(1, 100, "just north of South St");
	probe(50, 100, "block centre");
	probe(50, 5, "near West St");
	probe(-300, 100, "far south of everything");
	probe(0, 0, "on a corner");
	probe(99.5, 250, "past the east end of North St");

	say("fromWays empty", String(SegmentNearGrid.fromWays([], 64)));
	say("fromWays single-coord way", String(SegmentNearGrid.fromWays([way(9, "Stub", [C(0, 0)])], 64)));

	const track = SegmentNearGrid.fromTrack([P(0, 0), P(0, 100), P(50, 100)], 64);
	if (track === null) throw new Error("expected a track grid");
	const q = P(10, 50);
	say("track nearestDist", f(track.nearestDist(q.lat, q.lon)));
	say("fromTrack one point", String(SegmentNearGrid.fromTrack([P(0, 0)], 64)));
}

// ------------------------------------------------------- off-road metrics ---
section("fractionOffRoad");
{
	const onStreet: RoadFix[] = [0, 40, 80, 120].map((e, i) => ({ ...P(1, e), ts: i * 10 }));
	const inBlock: RoadFix[] = [40, 80, 120].map((e, i) => ({ ...P(50, e), ts: i * 10 }));
	const mixed: RoadFix[] = [...onStreet.slice(0, 2), ...inBlock];
	say("on street, thr 10", f(fractionOffRoad(onStreet, GEO, 10)));
	say("in block, thr 10", f(fractionOffRoad(inBlock, GEO, 10)));
	say("mixed, thr 10", f(fractionOffRoad(mixed, GEO, 10)));
	say("in block, thr 60", f(fractionOffRoad(inBlock, GEO, 60)));
	say("empty fixes", f(fractionOffRoad([], GEO, 10)));
	say("no ways", f(fractionOffRoad(onStreet, EMPTY, 10)));
}

section("maxPolylineOffRoad");
{
	const hugging = [P(1, 0), P(1, 60), P(1, 120)];
	const blockCut = [P(0, 0), P(100, 200)];
	const twoOnStreet = [P(0, 0), P(0, 200)];
	say("hugging", f(maxPolylineOffRoad(hugging, GEO)));
	say("block cut", f(maxPolylineOffRoad(blockCut, GEO)));
	say("block cut step 40", f(maxPolylineOffRoad(blockCut, GEO, 40)));
	say("two on street", f(maxPolylineOffRoad(twoOnStreet, GEO)));
	say("empty path", f(maxPolylineOffRoad([], GEO)));
	say("no ways", f(maxPolylineOffRoad(hugging, EMPTY)));
	say("single point in block", f(maxPolylineOffRoad([P(50, 100)], GEO)));
	// Chord shorter than the sampling step: no interior samples at all.
	say("sub-step chord in block", f(maxPolylineOffRoad([P(50, 100), P(50, 105)], GEO)));
}

section("pointDistToPolyline / quantile");
{
	const path = [P(0, 0), P(0, 100), P(50, 100)];
	say("point off mid", f(pointDistToPolyline(P(10, 50), path)));
	say("point past end", f(pointDistToPolyline(P(80, 100), path)));
	say("empty path", f(pointDistToPolyline(P(0, 0), [])));
	say("single-vertex path", f(pointDistToPolyline(P(10, 0), [P(0, 0)])));

	const pts = [P(1, 10), P(2, 20), P(3, 30), P(40, 40), P(5, 50)];
	for (const q of [0, 0.5, 0.85, 1]) say(`quantile q=${q}`, f(quantilePointDistToPolyline(pts, path, q)));
	say("quantile empty pts", f(quantilePointDistToPolyline([], path, 0.85)));
	say("quantile empty path", f(quantilePointDistToPolyline(pts, [], 0.85)));
}

// ------------------------------------------------------------- the gate ---
section("matchImprovesDisplay");
{
	const report = (label: string, d: ReturnType<typeof matchImprovesDisplay>): void => {
		say(`${label} use`, String(d.use));
		say(`${label} rawOffRoadM`, f(d.rawOffRoadM));
		say(`${label} matchedOffRoadM`, f(d.matchedOffRoadM));
		say(`${label} strayM`, f(d.strayM));
	};
	// Raw already hugs the network — leave it alone.
	const hugging = [P(1, 0), P(1, 60), P(1, 120)];
	report("raw hugs network", matchImprovesDisplay(hugging, [P(0, 0), P(0, 120)], GEO, 10, 25));

	// Raw cuts the block; the match follows South St then East St.
	const cutting = [P(0, 0), P(50, 100), P(100, 200)];
	const routed = [P(0, 0), P(0, 200), P(100, 200)];
	report("match routes around", matchImprovesDisplay(cutting, routed, GEO, 10, 200));
	report("stray gate vetoes", matchImprovesDisplay(cutting, routed, GEO, 10, 25));

	// A parallel-way snap: the match is on-network but nowhere near the fixes.
	report("parallel snap", matchImprovesDisplay(cutting, [P(100, -50), P(100, 250)], GEO, 10, 25));
	// Matched line no better than raw.
	report("no improvement", matchImprovesDisplay(cutting, cutting, GEO, 10, 500));
	report("no ways", matchImprovesDisplay(cutting, routed, EMPTY, 10, 25));
	report("empty fixes", matchImprovesDisplay([], routed, GEO, 10, 25));
}

// ----------------------------------------------------------- the splice ---
section("spliceMatchedWithDivergentRuns");
{
	const report = (label: string, r: MatchedPoint[] | null): void => {
		if (r === null) {
			say(`${label} result`, "null");
			return;
		}
		say(`${label} n`, String(r.length));
		r.forEach((p, i) => {
			say(`${label} [${i}] lat`, f(p.lat));
			say(`${label} [${i}] lon`, f(p.lon));
			say(`${label} [${i}] ts`, f(p.ts));
		});
	};
	// The matched line: South St from e=0 to e=200.
	const matched: MatchedPoint[] = [T(0, 0, 0), T(0, 100, 100), T(0, 200, 200)];

	// The motivating case: a forecourt run in the middle, supported either side.
	const forecourt: RoadFix[] = [
		...[0, 20, 40, 60, 80, 100].map((e, i) => ({ ...P(1, e), ts: i * 10 })),
		...[110, 120, 130, 140].map((e, i) => ({ ...P(20, e), ts: 60 + i * 10 })),
		...[160, 180, 200].map((e, i) => ({ ...P(1, e), ts: 100 + i * 10 })),
	];
	report("forecourt run", spliceMatchedWithDivergentRuns(forecourt, matched, 10));
	report("forecourt, stray 40", spliceMatchedWithDivergentRuns(forecourt, matched, 40));

	// Same fixes against a denser matched line, so a supported run spans matched
	// vertices strictly between its two endpoints (the slice's interior push).
	const dense: MatchedPoint[] = [0, 50, 100, 150, 200].map((e) => T(0, e, e));
	report("forecourt, dense path", spliceMatchedWithDivergentRuns(forecourt, dense, 10));

	// Too few fixes / degenerate path.
	report("three fixes", spliceMatchedWithDivergentRuns(forecourt.slice(0, 3), matched, 10));
	report("one-vertex path", spliceMatchedWithDivergentRuns(forecourt, [T(0, 0, 0)], 10));

	// Systematic divergence — the parallel-way snap the gate exists for.
	const allOff: RoadFix[] = [0, 40, 80, 120, 160, 200].map((e, i) => ({ ...P(30, e), ts: i * 10 }));
	report("systematic", spliceMatchedWithDivergentRuns(allOff, matched, 10));

	// A teleport smear rather than a forecourt.
	const teleport: RoadFix[] = [
		...[0, 20, 40, 60].map((e, i) => ({ ...P(1, e), ts: i * 10 })),
		{ ...P(400, 80), ts: 40 },
		...[120, 160, 200].map((e, i) => ({ ...P(1, e), ts: 50 + i * 10 })),
	];
	report("teleport", spliceMatchedWithDivergentRuns(teleport, matched, 10));

	// Jitter straddling the bound: three separate divergent runs.
	const jitter: RoadFix[] = [
		{ ...P(1, 0), ts: 0 },
		{ ...P(20, 20), ts: 10 },
		{ ...P(1, 40), ts: 20 },
		{ ...P(20, 60), ts: 30 },
		{ ...P(1, 80), ts: 40 },
		{ ...P(20, 100), ts: 50 },
		{ ...P(1, 120), ts: 60 },
		{ ...P(1, 140), ts: 70 },
	];
	report("three runs", spliceMatchedWithDivergentRuns(jitter, matched, 10));

	// A supported run that walks backward along the path.
	const backward: RoadFix[] = [
		{ ...P(20, 10), ts: 0 },
		{ ...P(20, 20), ts: 10 },
		{ ...P(1, 150), ts: 20 },
		{ ...P(1, 100), ts: 30 },
		{ ...P(1, 50), ts: 40 },
	];
	report("backward run", spliceMatchedWithDivergentRuns(backward, matched, 10));

	// Length-honesty guard: the matched line detours a U around the block
	// between two supported fixes 40 m apart.
	const detour: MatchedPoint[] = [T(0, 0, 0), T(100, 0, 100), T(100, 40, 140), T(0, 40, 240)];
	const uTurn: RoadFix[] = [
		{ ...P(0, 0), ts: 0 },
		{ ...P(0, 40), ts: 10 },
		{ ...P(20, 60), ts: 20 },
		{ ...P(20, 70), ts: 30 },
	];
	report("length guard", spliceMatchedWithDivergentRuns(uTurn, detour, 10));

	// No divergence at all.
	const clean: RoadFix[] = [0, 50, 100, 150, 200].map((e, i) => ({ ...P(1, e), ts: i * 10 }));
	report("no divergence", spliceMatchedWithDivergentRuns(clean, matched, 10));
}

console.log(lines.join("\n"));

import { describe, expect, it } from "vitest";
import type { RoadGeometry } from "../src/geo/road-match.js";
import {
	countSharpTurns,
	DEFAULT_MAP_SMOOTH_PROFILE,
	DEFAULT_RECONSTRUCT_PROFILE,
	reconstructWalk,
	refineMatchedPath,
	smoothWalkMap,
	type WalkFix,
} from "../src/geo/walk-smooth-map.js";

/**
 * `smoothWalkMap` — the continuous MAP trajectory smoother. It reconstructs a
 * walk as the maximum-a-posteriori path under three factors fused together:
 * accuracy-weighted GPS emission, a smoothness/physics prior, and a soft pull
 * toward the walkable surface. Unlike the Viterbi matcher it never snaps to
 * discrete graph vertices, so it cuts corners naturally and cannot invent a
 * graph detour — the properties these tests pin down.
 */

const LAT = 51.56;
const dLat = (m: number) => m / 111_320;

/** A single east–west way "Straight Street" along latitude LAT. */
const straightGeo: RoadGeometry = {
	ways: [
		{
			osmId: 1,
			name: "Straight Street",
			subtype: "residential",
			coords: [
				[LAT, -0.28],
				[LAT, -0.27],
			],
		},
	],
};

/** Noisy fixes that jitter ±`jitterM` north/south around the way, marching east. */
function jitteryFixes(n: number, jitterM: number, accuracyM = 12): WalkFix[] {
	const out: WalkFix[] = [];
	for (let i = 0; i < n; i++) {
		// Deterministic pseudo-jitter: alternating sign, decaying — no RNG.
		const sign = i % 2 === 0 ? 1 : -1;
		out.push({
			lat: LAT + dLat(sign * jitterM),
			lon: -0.28 + (0.01 * i) / (n - 1),
			ts: 1000 + i * 10,
			accuracyM,
		});
	}
	return out;
}

function pathLengthM(pts: Array<{ lat: number; lon: number }>): number {
	let t = 0;
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1];
		const b = pts[i];
		const dy = (b.lat - a.lat) * 111_320;
		const dx = (b.lon - a.lon) * 111_320 * Math.cos((LAT * Math.PI) / 180);
		t += Math.hypot(dx, dy);
	}
	return t;
}

function maxOffWayM(pts: Array<{ lat: number; lon: number }>): number {
	// The way is the line lat=LAT, so off-way distance is |lat-LAT| in metres.
	return Math.max(...pts.map((p) => Math.abs(p.lat - LAT) * 111_320));
}

describe("smoothWalkMap", () => {
	it("returns null for a leg too short to smooth", () => {
		expect(smoothWalkMap([{ lat: LAT, lon: -0.28, ts: 0 }], straightGeo, DEFAULT_MAP_SMOOTH_PROFILE)).toBeNull();
	});

	it("straightens a jittery walk along a straight way (lower tortuosity, hugs the way)", () => {
		const fixes = jitteryFixes(21, 8);
		const rawLen = pathLengthM(fixes);
		const out = smoothWalkMap(fixes, straightGeo, DEFAULT_MAP_SMOOTH_PROFILE);
		expect(out).not.toBeNull();
		const path = out as Array<{ lat: number; lon: number }>;
		// The straight-line end-to-end distance is ~1000 m; raw zig-zags well past it.
		const straight = pathLengthM([fixes[0], fixes[fixes.length - 1]]);
		expect(rawLen).toBeGreaterThan(straight * 1.1); // raw really is jittery
		// Smoothed length is close to the straight distance — the jitter is gone.
		expect(pathLengthM(path)).toBeLessThan(rawLen);
		expect(pathLengthM(path)).toBeLessThan(straight * 1.08);
		// And it sits much nearer the way than the 8 m raw excursions.
		expect(maxOffWayM(path)).toBeLessThan(maxOffWayM(fixes));
	});

	it("keeps timestamps and endpoints anchored to the fixes", () => {
		const fixes = jitteryFixes(11, 6);
		const path = smoothWalkMap(fixes, straightGeo, DEFAULT_MAP_SMOOTH_PROFILE);
		expect(path).not.toBeNull();
		const p = path as Array<{ lat: number; lon: number; ts: number }>;
		expect(p.length).toBe(fixes.length);
		expect(p[0].ts).toBe(fixes[0].ts);
		expect(p[p.length - 1].ts).toBe(fixes[fixes.length - 1].ts);
	});

	it("soft network pull moves the line toward the way but not all the way (GPS still counts)", () => {
		// Fixes sit a constant ~10 m north of the way, low jitter. The smoother
		// should pull them SOUTH toward the way, but GPS emission keeps them from
		// collapsing exactly onto it — the line settles in between.
		const fixes: WalkFix[] = [];
		for (let i = 0; i < 15; i++) {
			fixes.push({ lat: LAT + dLat(10), lon: -0.28 + (0.01 * i) / 14, ts: 1000 + i * 10, accuracyM: 12 });
		}
		const path = smoothWalkMap(fixes, straightGeo, DEFAULT_MAP_SMOOTH_PROFILE) as Array<{ lat: number; lon: number }>;
		const mid = path[Math.floor(path.length / 2)];
		const offM = Math.abs(mid.lat - LAT) * 111_320;
		expect(offM).toBeLessThan(10); // pulled toward the way
		expect(offM).toBeGreaterThan(0.5); // but not collapsed onto it
	});

	it("trusts an accurate fix over a noisy one (accuracy-weighted emission)", () => {
		// A run of clean fixes on the way with ONE 40 m-north outlier tagged as
		// low-accuracy. The outlier should be pulled back near the way; a
		// same-position outlier tagged high-accuracy should be pulled back LESS.
		const base = (acc: number): WalkFix[] => {
			const f: WalkFix[] = [];
			for (let i = 0; i < 11; i++) {
				const outlier = i === 5;
				f.push({
					lat: LAT + dLat(outlier ? 40 : 0),
					lon: -0.28 + (0.01 * i) / 10,
					ts: 1000 + i * 10,
					accuracyM: outlier ? acc : 5,
				});
			}
			return f;
		};
		const noisy = smoothWalkMap(base(60), straightGeo, DEFAULT_MAP_SMOOTH_PROFILE) as Array<{ lat: number }>;
		const precise = smoothWalkMap(base(4), straightGeo, DEFAULT_MAP_SMOOTH_PROFILE) as Array<{ lat: number }>;
		const noisyOff = Math.abs(noisy[5].lat - LAT) * 111_320;
		const preciseOff = Math.abs(precise[5].lat - LAT) * 111_320;
		expect(noisyOff).toBeLessThan(preciseOff); // low-accuracy outlier pulled in harder
	});
});

describe("reconstructWalk step-magnitude factor", () => {
	/** A COHERENT smear — the class the robust kernel cannot reject (P1's
	 *  "coherent-smear phantom", the 07-06 Pancras Road signature): fixes drift
	 *  smoothly ~1.9 km along the corridor, every fix agreeing with its temporal
	 *  neighbours, while the pedometer says the user walked ~300 m. Only the
	 *  independent step signal can contradict it. Deterministic. */
	function smearFixes(n: number): WalkFix[] {
		const out: WalkFix[] = [];
		const cl = 111_320 * Math.cos((LAT * Math.PI) / 180);
		for (let i = 0; i < n; i++) {
			const f = i / (n - 1);
			// Smooth one-way eastward drift over 1900 m with a gentle 40 m weave —
			// locally consistent, globally phantom.
			const eastM = 1900 * f;
			const northM = 40 * Math.sin(f * Math.PI * 3);
			out.push({
				lat: LAT + dLat(northM),
				lon: -0.28 + eastM / cl,
				ts: 1000 + i * 30,
				accuracyM: 15, // confidently wrong — a reacquire smear reports good accuracy
			});
		}
		return out;
	}

	it("collapses a scatter smear toward the pedometer budget", () => {
		const fixes = smearFixes(40);
		const noSteps = reconstructWalk(fixes, straightGeo);
		expect(noSteps).not.toBeNull();
		const withSteps = reconstructWalk(fixes, straightGeo, undefined, { stepsWalked: 400 });
		expect(withSteps).not.toBeNull();
		const lenWithout = pathLengthM(noSteps as Array<{ lat: number; lon: number }>);
		const lenWith = pathLengthM(withSteps as Array<{ lat: number; lon: number }>);
		// Budget = 400 × 0.75 = 300 m; slack ×1.4 → equilibrium ~420 m. Allow
		// convergence slop, but the smear must collapse far below the step-blind line.
		expect(lenWith).toBeLessThan(lenWithout * 0.6);
		expect(lenWith).toBeLessThan(700);
	});

	it("does not distort a legit leg whose length agrees with the steps", () => {
		// ~700 m of consistent low-jitter fixes along the way; 940 steps ≈ 705 m.
		const fixes = jitteryFixes(30, 5);
		const noSteps = reconstructWalk(fixes, straightGeo);
		const withSteps = reconstructWalk(fixes, straightGeo, undefined, { stepsWalked: 940 });
		expect(withSteps).toEqual(noSteps); // within slack → the factor is fully off
	});

	it("stays soft when the budget is only mildly under the drawn length", () => {
		// Same legit ~700 m leg but the pedometer undercounted (500 steps ≈ 375 m).
		// GPS consensus must hold: the leg may shrink a little, never collapse.
		const fixes = jitteryFixes(30, 5);
		const noSteps = reconstructWalk(fixes, straightGeo) as Array<{ lat: number; lon: number }>;
		const withSteps = reconstructWalk(fixes, straightGeo, undefined, { stepsWalked: 500 }) as Array<{
			lat: number;
			lon: number;
		}>;
		expect(pathLengthM(withSteps)).toBeGreaterThan(pathLengthM(noSteps) * 0.8);
	});

	it("is a no-op when steps are unknown", () => {
		const fixes = smearFixes(20);
		expect(reconstructWalk(fixes, straightGeo, undefined, {})).toEqual(reconstructWalk(fixes, straightGeo));
	});
});

describe("reconstructWalk endpoint anchors", () => {
	const cl = 111_320 * Math.cos((LAT * Math.PI) / 180);
	const at = (eastM: number, northM = 0) => ({ lat: LAT + dLat(northM), lon: -0.28 + eastM / cl });

	it("pins the endpoints of a coherent smear to the anchors (#319, the 07-06 anchor bug)", () => {
		// The Regent's Park signature: the walk truly ran station → clinic
		// (~300 m), but the reacquire smear drifts 1.9 km. Both endpoints are
		// confidently known (station entrance / stay centroid) and contradict
		// the smear — with anchors + steps the reconstruction must start and
		// end at them.
		const fixes: WalkFix[] = [];
		const n = 40;
		for (let i = 0; i < n; i++) {
			const f = i / (n - 1);
			fixes.push({ ...at(1900 * f, 40 * Math.sin(f * Math.PI * 3)), ts: 1000 + i * 30, accuracyM: 15 });
		}
		const start = at(0);
		const end = at(300);
		const recon = reconstructWalk(fixes, straightGeo, undefined, {
			start: { ...start, sigmaM: 15 },
			end: { ...end, sigmaM: 15 },
			stepsWalked: 400,
		}) as Array<{ lat: number; lon: number }>;
		expect(recon).not.toBeNull();
		const dist = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
			Math.hypot((a.lat - b.lat) * 111_320, (a.lon - b.lon) * cl);
		expect(dist(recon[0], start)).toBeLessThan(60);
		expect(dist(recon[recon.length - 1], end)).toBeLessThan(60);
	});

	it("barely moves the endpoints of a legit leg whose fixes agree with the anchors", () => {
		const fixes = jitteryFixes(30, 5);
		const noAnchor = reconstructWalk(fixes, straightGeo) as Array<{ lat: number; lon: number }>;
		const anchored = reconstructWalk(fixes, straightGeo, undefined, {
			start: { lat: fixes[0].lat, lon: fixes[0].lon, sigmaM: 30 },
			end: { lat: fixes[fixes.length - 1].lat, lon: fixes[fixes.length - 1].lon, sigmaM: 30 },
		}) as Array<{ lat: number; lon: number }>;
		const dist = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
			Math.hypot((a.lat - b.lat) * 111_320, (a.lon - b.lon) * cl);
		expect(dist(anchored[0], noAnchor[0])).toBeLessThan(10);
		expect(dist(anchored[anchored.length - 1], noAnchor[noAnchor.length - 1])).toBeLessThan(10);
	});
});

describe("refineMatchedPath", () => {
	// Perpendicular distance (m) from a point to a polyline — for the clamp check.
	function distToPolyline(p: { lat: number; lon: number }, path: Array<{ lat: number; lon: number }>): number {
		let best = Number.POSITIVE_INFINITY;
		for (let i = 1; i < path.length; i++) {
			const a = path[i - 1];
			const b = path[i];
			const cl = Math.cos((LAT * Math.PI) / 180);
			const ax = 0;
			const ay = 0;
			const bx = (b.lon - a.lon) * 111_320 * cl;
			const by = (b.lat - a.lat) * 111_320;
			const px = (p.lon - a.lon) * 111_320 * cl;
			const py = (p.lat - a.lat) * 111_320;
			const len2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1e-9;
			const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len2));
			best = Math.min(best, Math.hypot(px - t * bx, py - t * by));
		}
		return best;
	}

	it("de-boxes a small staircase artifact toward the GPS, staying clamped to the matched line", () => {
		// Matched line: a small ±7 m zig-zag along an eastward path — the boxy
		// graph-snap staircase (each reversal a sharp turn). The true walk (raw GPS)
		// went straight down the middle.
		const matched: Array<{ lat: number; lon: number }> = [];
		const fixes: WalkFix[] = [];
		for (let i = 0; i <= 12; i++) {
			const lon = -0.28 + 0.0009 * (i / 12);
			matched.push({ lat: LAT + dLat(i % 2 === 0 ? 7 : -7), lon });
			fixes.push({ lat: LAT, lon, ts: 1000 + i * 10, accuracyM: 10 });
		}
		expect(countSharpTurns(matched)).toBeGreaterThan(3); // the staircase is boxy
		const refined = refineMatchedPath(fixes, matched, undefined, 12);
		expect(refined).not.toBeNull();
		const r = refined as Array<{ lat: number; lon: number }>;
		// The staircase corners are rounded away.
		expect(countSharpTurns(r)).toBeLessThan(countSharpTurns(matched));
		// …but every vertex stays within the clamp radius of the vetted matched line.
		for (const p of r) expect(distToPolyline(p, matched)).toBeLessThanOrEqual(12.5);
	});

	it("returns null when the matched line is too thin to refine", () => {
		expect(refineMatchedPath([{ lat: LAT, lon: -0.28, ts: 0 }], [{ lat: LAT, lon: -0.28 }])).toBeNull();
	});

	it("keeps a real street route on the matched line: no drift on straights, no cutting an isolated corner (#359)", () => {
		// The 2026-07-14 morning-walk class: the matched line rides the correct
		// streets exactly; the raw fixes sit ~8 m off with ordinary wobble. The
		// refinement's licence is the STAIRCASE ARTIFACT (dense alternating graph
		// corners, previous test) — a real, isolated street corner and the straights
		// around it must stay on the line. The whole-line 12 m budget measurably
		// redrew this class up to ~12 m off-street toward the wobble (half-snap).
		const dLonM = (m: number) => m / (111_320 * Math.cos((LAT * Math.PI) / 180));
		// L-shaped matched line: ~120 m east, one real 90° corner, ~120 m north.
		const cornerLon = -0.28 + dLonM(120);
		const matched: Array<{ lat: number; lon: number }> = [];
		for (let i = 0; i <= 3; i++) matched.push({ lat: LAT, lon: -0.28 + dLonM(40 * i) });
		for (let i = 1; i <= 3; i++) matched.push({ lat: LAT + dLat(40 * i), lon: cornerLon });
		expect(countSharpTurns(matched)).toBe(1);
		// Fixes: 8 m north of the east leg, one corner-cutting fix inside the
		// corner, then 8 m west of the north leg.
		const fixes: WalkFix[] = [];
		for (let i = 0; i <= 8; i++) fixes.push({ lat: LAT + dLat(8), lon: -0.28 + dLonM(13 * i), ts: 0, accuracyM: 10 });
		fixes.push({ lat: LAT + dLat(14), lon: cornerLon - dLonM(14), ts: 0, accuracyM: 10 });
		for (let i = 1; i <= 8; i++)
			fixes.push({ lat: LAT + dLat(13 * i), lon: cornerLon - dLonM(8), ts: 0, accuracyM: 10 });
		fixes.forEach((f, i) => {
			f.ts = 1000 + i * 15;
		});
		const refined = refineMatchedPath(fixes, matched, undefined, 12);
		expect(refined).not.toBeNull();
		const r = refined as Array<{ lat: number; lon: number; ts: number }>;
		// No new corners invented…
		expect(countSharpTurns(r)).toBeLessThanOrEqual(countSharpTurns(matched));
		// …and EVERY vertex stays on the matched route — straights and the real
		// corner alike. Cutting the corner 8–12 m would put the line through the
		// corner building; the walked pavement goes around it.
		for (const p of r) expect(distToPolyline(p, matched)).toBeLessThanOrEqual(3);
	});

	it("preserves an ACUTE double-back junction with no fix near it (#361 follow-up)", () => {
		// The junction-cut variant the 1.6× ratio bound wrongly rejected: the real
		// route reaches a junction and doubles back at ~120°, so the restored path
		// is ~1.7× the chord. A right angle fits under √2; an acute real corner
		// must fit too — only the unbounded spur class (hundreds of metres) stays
		// rejected.
		const dLonM = (m: number) => m / (111_320 * Math.cos((LAT * Math.PI) / 180));
		// Route: south-west down to a junction, then back north-east-east: a
		// ~35° hairpin-ish real corner (street A into street B).
		const jn = { lat: LAT, lon: -0.28 };
		const matched: Array<{ lat: number; lon: number }> = [];
		for (let i = 3; i >= 1; i--) matched.push({ lat: LAT + dLat(40 * i), lon: -0.28 - dLonM(20 * i) });
		matched.push(jn);
		for (let i = 1; i <= 3; i++) matched.push({ lat: LAT + dLat(15 * i), lon: -0.28 + dLonM(40 * i) });
		// Fixes on both arms, none within ~35 m of the junction.
		const fixes: WalkFix[] = [];
		for (let i = 3; i >= 1; i--)
			fixes.push({ lat: LAT + dLat(40 * i + 2), lon: -0.28 - dLonM(20 * i), ts: 0, accuracyM: 10 });
		for (let i = 1; i <= 3; i++)
			fixes.push({ lat: LAT + dLat(15 * i + 2), lon: -0.28 + dLonM(40 * i), ts: 0, accuracyM: 10 });
		fixes.forEach((f, i) => {
			f.ts = 1000 + i * 20;
		});
		const refined = refineMatchedPath(fixes, matched, undefined, 12);
		expect(refined).not.toBeNull();
		const r = refined as Array<{ lat: number; lon: number; ts: number }>;
		expect(distToPolyline(jn, r)).toBeLessThanOrEqual(3);
	});

	it("a real crossing double-back (2 clustered sharp corners) is NOT a staircase artifact (#361 follow-up)", () => {
		// A pedestrian-crossing turnback puts exactly TWO sharp corners within a
		// few metres — the 2-corner artifact signature false-matched it and gave
		// the refinement a 12 m licence to cut across the corner block. A genuine
		// graph staircase has MANY clustered corners; two are real geometry.
		const dLonM = (m: number) => m / (111_320 * Math.cos((LAT * Math.PI) / 180));
		// Route: east along a road, 12 m north across a crossing, then east again
		// — two sharp corners 12 m apart.
		const matched: Array<{ lat: number; lon: number }> = [];
		for (let i = 0; i <= 2; i++) matched.push({ lat: LAT, lon: -0.28 + dLonM(40 * i) });
		matched.push({ lat: LAT + dLat(12), lon: -0.28 + dLonM(80) });
		for (let i = 3; i <= 5; i++) matched.push({ lat: LAT + dLat(12), lon: -0.28 + dLonM(40 * i) });
		expect(countSharpTurns(matched)).toBe(2);
		// Fixes wobble ~7 m and cut the crossing diagonally.
		const fixes: WalkFix[] = [];
		for (let i = 0; i <= 4; i++) fixes.push({ lat: LAT + dLat(7), lon: -0.28 + dLonM(18 * i), ts: 0, accuracyM: 10 });
		for (let i = 6; i <= 10; i++) fixes.push({ lat: LAT + dLat(5), lon: -0.28 + dLonM(18 * i), ts: 0, accuracyM: 10 });
		fixes.forEach((f, i) => {
			f.ts = 1000 + i * 20;
		});
		const refined = refineMatchedPath(fixes, matched, undefined, 12);
		expect(refined).not.toBeNull();
		const r = refined as Array<{ lat: number; lon: number; ts: number }>;
		// Tight budget everywhere: no vertex drifts beyond ~3 m of the route.
		for (const p of r) expect(distToPolyline(p, matched)).toBeLessThanOrEqual(3);
	});

	it("preserves a route corner that has NO fix near it (#361)", () => {
		// The junction-cut class: GPS wobble leaves no fix anywhere near a street
		// junction the route turns through, so a one-vertex-per-fix resample drops
		// the junction vertex entirely and the chord between the neighbouring
		// fixes cuts ~15 m through the block. Per-vertex clamping cannot catch
		// this — every VERTEX is on-route; the EDGE shortcuts. The skipped route
		// vertex must be spliced back into the drawn line.
		const dLonM = (m: number) => m / (111_320 * Math.cos((LAT * Math.PI) / 180));
		const cornerLon = -0.28 + dLonM(120);
		const matched: Array<{ lat: number; lon: number }> = [];
		for (let i = 0; i <= 3; i++) matched.push({ lat: LAT, lon: -0.28 + dLonM(40 * i) });
		for (let i = 1; i <= 3; i++) matched.push({ lat: LAT + dLat(40 * i), lon: cornerLon });
		// Fixes hug both legs at ±3 m but stop 25 m short of the corner on each
		// side — nothing observes the junction itself.
		const fixes: WalkFix[] = [];
		for (let i = 0; i <= 7; i++) fixes.push({ lat: LAT + dLat(3), lon: -0.28 + dLonM(13 * i), ts: 0, accuracyM: 10 });
		for (let i = 2; i <= 9; i++)
			fixes.push({ lat: LAT + dLat(13 * i), lon: cornerLon - dLonM(3), ts: 0, accuracyM: 10 });
		fixes.forEach((f, i) => {
			f.ts = 1000 + i * 15;
		});
		const refined = refineMatchedPath(fixes, matched, undefined, 12);
		expect(refined).not.toBeNull();
		const r = refined as Array<{ lat: number; lon: number; ts: number }>;
		// The corner apex must be ON the drawn line: the matched corner vertex is
		// within ~3 m of the refined polyline, so no edge cuts the block.
		const corner = { lat: LAT, lon: cornerLon };
		expect(distToPolyline(corner, r)).toBeLessThanOrEqual(3);
		// Timestamps stay monotonic through the spliced vertex.
		for (let i = 1; i < r.length; i++) expect(r[i].ts).toBeGreaterThanOrEqual(r[i - 1].ts);
	});
});

describe("reconstructWalk hard building constraint (#353)", () => {
	const dLonAt = (m: number) => m / (111_320 * Math.cos((LAT * Math.PI) / 180));
	/** Square footprint centred at (latC, lonC), half-size halfM metres. */
	const square = (latC: number, lonC: number, halfM: number) => [
		{ lat: latC - dLat(halfM), lon: lonC - dLonAt(halfM) },
		{ lat: latC - dLat(halfM), lon: lonC + dLonAt(halfM) },
		{ lat: latC + dLat(halfM), lon: lonC + dLonAt(halfM) },
		{ lat: latC + dLat(halfM), lon: lonC - dLonAt(halfM) },
	];
	const inSquare = (p: { lat: number; lon: number }, latC: number, lonC: number, halfM: number) =>
		Math.abs(p.lat - latC) * 111_320 < halfM &&
		Math.abs(p.lon - lonC) * 111_320 * Math.cos((LAT * Math.PI) / 180) < halfM;
	/** March east along LAT, fixes every ~stepLonM metres. */
	const march = (n: number, stepM: number): WalkFix[] =>
		Array.from({ length: n }, (_, i) => ({
			lat: LAT,
			lon: -0.28 + dLonAt(i * stepM),
			ts: 1000 + i * 30,
			accuracyM: 12,
		}));
	const HARD = {
		...DEFAULT_RECONSTRUCT_PROFILE,
		targetSpacingM: 20,
		hardProjectBuildings: true,
		insertCornerDetours: true,
	};
	/** No point of the polyline — sampled every 2 m along each edge — may sit
	 *  inside the square. */
	const sampledInside = (pts: Array<{ lat: number; lon: number }>, latC: number, lonC: number, halfM: number) => {
		for (let i = 1; i < pts.length; i++) {
			const a = pts[i - 1];
			const b = pts[i];
			const lenM = Math.hypot((b.lat - a.lat) * 111_320, (b.lon - a.lon) * 111_320 * Math.cos((LAT * Math.PI) / 180));
			const steps = Math.max(1, Math.ceil(lenM / 2));
			for (let k = 0; k <= steps; k++) {
				const f = k / steps;
				if (inSquare({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f }, latC, lonC, halfM))
					return true;
			}
		}
		return false;
	};

	it("keeps a transit chord OUT of a footprint it would cut through (no network in scope)", () => {
		// 8 fixes marching east, 80 m apart; a 25 m half-size house straddles the
		// straight line midway between fixes 3 and 4. No walkable ways at all
		// (unmapped-network area) — only the hard constraint can act.
		const fixes = march(8, 80);
		const lonC = -0.28 + dLonAt(3.5 * 80);
		const geo: RoadGeometry = { ways: [], buildings: [square(LAT, lonC, 25)] };
		const recon = reconstructWalk(fixes, geo, HARD) as Array<{ lat: number; lon: number }>;
		expect(recon).not.toBeNull();
		expect(sampledInside(recon, LAT, lonC, 25)).toBe(false);
	});

	it("preserves genuine indoor presence: a sustained observed run inside stays inside", () => {
		// 3 fixes outside, 5 fixes dwelling INSIDE a large footprint (a cafe),
		// 3 fixes outside — the presence run must not be shoved to the walls.
		const lonC = -0.28 + dLonAt(300);
		const fixes: WalkFix[] = [
			...Array.from({ length: 3 }, (_, i) => ({
				lat: LAT,
				lon: -0.28 + dLonAt(i * 60),
				ts: 1000 + i * 30,
				accuracyM: 12,
			})),
			...Array.from({ length: 5 }, (_, i) => ({
				lat: LAT + dLat(i % 2 === 0 ? 3 : -3),
				lon: lonC + dLonAt((i - 2) * 4),
				ts: 1200 + i * 30,
				accuracyM: 15,
			})),
			...Array.from({ length: 3 }, (_, i) => ({
				lat: LAT,
				lon: -0.28 + dLonAt(420 + i * 60),
				ts: 1500 + i * 30,
				accuracyM: 12,
			})),
		];
		const geo: RoadGeometry = { ways: [], buildings: [square(LAT, lonC, 40)] };
		const recon = reconstructWalk(fixes, geo, HARD) as Array<{ lat: number; lon: number }>;
		expect(recon).not.toBeNull();
		// The five dwell fixes map to output indices via free-state insertion;
		// assert that SOME output vertices remain inside (the presence survives).
		const insideCount = recon.filter((p) => inSquare(p, LAT, lonC, 39)).length;
		expect(insideCount).toBeGreaterThanOrEqual(3);
	});

	it("projects an ISOLATED interior fix out (one point inside is not presence)", () => {
		const lonC = -0.28 + dLonAt(240);
		const fixes = march(9, 60).map((f, i) => (i === 4 ? { ...f, lon: lonC, lat: LAT } : f));
		const geo: RoadGeometry = { ways: [], buildings: [square(LAT, lonC, 20)] };
		const recon = reconstructWalk(fixes, geo, HARD) as Array<{ lat: number; lon: number }>;
		expect(recon).not.toBeNull();
		expect(sampledInside(recon, LAT, lonC, 19)).toBe(false);
	});

	it("is inert without buildings: hard flags change nothing (forest walks untouched)", () => {
		const fixes = jitteryFixes(12, 6);
		const soft = reconstructWalk(fixes, straightGeo, {
			...HARD,
			hardProjectBuildings: false,
			insertCornerDetours: false,
		});
		const hard = reconstructWalk(fixes, straightGeo, HARD);
		expect(hard).toEqual(soft);
	});

	it("declines an unbounded detour: a huge slab keeps the honest chord", () => {
		// A 300 m-wide slab dead across the path: the corner path would exceed
		// 2.5x the chord, so the edge is kept as-is rather than invented around.
		const fixes = march(6, 100);
		const lonC = -0.28 + dLonAt(2.5 * 100);
		const slab = [
			{ lat: LAT - dLat(300), lon: lonC - dLonAt(20) },
			{ lat: LAT - dLat(300), lon: lonC + dLonAt(20) },
			{ lat: LAT + dLat(300), lon: lonC + dLonAt(20) },
			{ lat: LAT + dLat(300), lon: lonC - dLonAt(20) },
		];
		const geo: RoadGeometry = { ways: [], buildings: [slab] };
		const withCorners = reconstructWalk(fixes, geo, { ...HARD, hardProjectBuildings: false });
		const without = reconstructWalk(fixes, geo, {
			...HARD,
			hardProjectBuildings: false,
			insertCornerDetours: false,
		});
		expect(withCorners).toEqual(without);
	});
});

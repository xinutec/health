import { describe, expect, it } from "vitest";
import type { RoadGeometry } from "../src/geo/road-match.js";
import {
	countSharpTurns,
	DEFAULT_MAP_SMOOTH_PROFILE,
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
});

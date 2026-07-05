/**
 * `absorbIntraPlaceWalk` — demote a short walk that never left a place's
 * footprint, bracketed by two stays at that same place, to stationary so it
 * merges back into the stay.
 *
 * Motivating real case (2026-06-17): a 5-min "walking" segment split a
 * 5+ hour office stay in two — the user got up, walked ~50 m to the kitchen
 * and back to the same desk (the two Work stays' centroids 2 m apart). It has
 * real steps, so the multipath-spike bridge (avg ≤ 2 km/h) can't catch it;
 * the signal is geometric — the walk stayed within the building.
 *
 * All coordinates synthetic.
 */

import { describe, expect, it } from "vitest";
import type { FilteredPoint } from "../src/geo/kalman.js";
import { absorbIntraPlaceWalk } from "../src/geo/passes/stays.js";
import type { EnrichedSegment } from "../src/geo/velocity.js";

const T0 = 1_750_000_000;
// ~1 m ≈ 0.000009 deg latitude at this scale.
const M = 0.000009;
const BASE_LAT = 51.533;
const BASE_LON = -0.1259;

function fix(ts: number, dxM: number, dyM: number): FilteredPoint {
	return { ts, lat: BASE_LAT + dyM * M, lon: BASE_LON + dxM * M, speed_kmh: 0, bearing: 0 };
}

function stay(startTs: number, endTs: number, place: string, dxM = 0, dyM = 0): EnrichedSegment {
	return {
		startTs,
		endTs,
		mode: "stationary",
		confidence: 0.9,
		confidenceMargin: 100,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0,
		pointCount: 5,
		place,
		centroidLat: BASE_LAT + dyM * M,
		centroidLon: BASE_LON + dxM * M,
	} as EnrichedSegment;
}

function walk(startTs: number, endTs: number): EnrichedSegment {
	return {
		startTs,
		endTs,
		mode: "walking",
		confidence: 0.8,
		confidenceMargin: 100,
		avgSpeed: 2.2,
		maxSpeed: 7.5,
		linearity: 0.2,
		pointCount: 17,
	} as EnrichedSegment;
}

/** Fixes for a walk that strays `peakM` from the origin then returns. */
function excursionFixes(startTs: number, endTs: number, peakM: number): FilteredPoint[] {
	const n = 17;
	return Array.from({ length: n }, (_, i) => {
		const f = i / (n - 1);
		const tri = 1 - Math.abs(2 * f - 1); // 0 → 1 → 0
		return fix(startTs + Math.floor(((endTs - startTs) * i) / n), peakM * tri, 0);
	});
}

const mode = (s: EnrichedSegment): string => s.refinedMode ?? s.mode;

describe("absorbIntraPlaceWalk", () => {
	it("demotes a short within-footprint walk between two same-place stays (the office kitchen run)", () => {
		const segs = [
			stay(T0, T0 + 90 * 60, "Work"),
			walk(T0 + 90 * 60, T0 + 95 * 60),
			stay(T0 + 95 * 60, T0 + 300 * 60, "Work"),
		];
		const pts = excursionFixes(T0 + 90 * 60, T0 + 95 * 60, 50); // strays 50 m, returns
		const out = absorbIntraPlaceWalk(segs, pts);
		expect(mode(out[1])).toBe("stationary");
		expect(out[1].place).toBe("Work");
	});

	it("does NOT demote a walk that leaves the footprint (a real excursion)", () => {
		const segs = [
			stay(T0, T0 + 90 * 60, "Work"),
			walk(T0 + 90 * 60, T0 + 100 * 60),
			stay(T0 + 100 * 60, T0 + 300 * 60, "Work"),
		];
		const pts = excursionFixes(T0 + 90 * 60, T0 + 100 * 60, 220); // walked ~220 m away
		const out = absorbIntraPlaceWalk(segs, pts);
		expect(mode(out[1])).toBe("walking");
	});

	it("does NOT demote when the bracketing stays are different places", () => {
		const segs = [
			stay(T0, T0 + 90 * 60, "Work"),
			walk(T0 + 90 * 60, T0 + 95 * 60),
			stay(T0 + 95 * 60, T0 + 300 * 60, "Home", 0, 30),
		];
		const pts = excursionFixes(T0 + 90 * 60, T0 + 95 * 60, 50);
		const out = absorbIntraPlaceWalk(segs, pts);
		expect(mode(out[1])).toBe("walking");
	});

	it("does NOT demote a long walk even within the footprint", () => {
		const segs = [
			stay(T0, T0 + 90 * 60, "Work"),
			walk(T0 + 90 * 60, T0 + 110 * 60), // 20 min
			stay(T0 + 110 * 60, T0 + 300 * 60, "Work"),
		];
		const pts = excursionFixes(T0 + 90 * 60, T0 + 110 * 60, 50);
		const out = absorbIntraPlaceWalk(segs, pts);
		expect(mode(out[1])).toBe("walking");
	});

	it("leaves a normal walk between two different stays untouched", () => {
		const segs = [
			stay(T0, T0 + 90 * 60, "Home"),
			walk(T0 + 90 * 60, T0 + 105 * 60),
			stay(T0 + 105 * 60, T0 + 300 * 60, "Work", 0, 500),
		];
		const pts = excursionFixes(T0 + 90 * 60, T0 + 105 * 60, 300);
		const out = absorbIntraPlaceWalk(segs, pts);
		expect(out.map(mode)).toEqual(["stationary", "walking", "stationary"]);
	});

	it("demotes BOTH walks of a stay→walk→stay→walk→stay ladder (neighbours read from the input)", () => {
		// Two kitchen runs in one afternoon. The map reads neighbours from the
		// original array, so both interior walks are demoted in one pass (no
		// fixpoint loop needed); mergeAdjacentStays then collapses the lot.
		const segs = [
			stay(T0, T0 + 60 * 60, "Work"),
			walk(T0 + 60 * 60, T0 + 64 * 60),
			stay(T0 + 64 * 60, T0 + 120 * 60, "Work"),
			walk(T0 + 120 * 60, T0 + 124 * 60),
			stay(T0 + 124 * 60, T0 + 300 * 60, "Work"),
		];
		const pts = [
			...excursionFixes(T0 + 60 * 60, T0 + 64 * 60, 45),
			...excursionFixes(T0 + 120 * 60, T0 + 124 * 60, 45),
		];
		const out = absorbIntraPlaceWalk(segs, pts);
		expect(out.map(mode)).toEqual(["stationary", "stationary", "stationary", "stationary", "stationary"]);
	});

	it("does not demote when the bracketing stays have neither a centroid nor any fixes (can't confirm same spot)", () => {
		// Conservative fallback: with no centroid field and no in-window fixes
		// for the stays, the same-spot test can't be evaluated, so the walk is
		// left as a leg.
		const noCentroid = (startTs: number, endTs: number): EnrichedSegment =>
			({ ...stay(startTs, endTs, "Work"), centroidLat: undefined, centroidLon: undefined }) as EnrichedSegment;
		const segs = [
			noCentroid(T0, T0 + 90 * 60),
			walk(T0 + 90 * 60, T0 + 95 * 60),
			noCentroid(T0 + 95 * 60, T0 + 300 * 60),
		];
		// Fixes only for the walk window, none for the stays.
		const pts = excursionFixes(T0 + 90 * 60, T0 + 95 * 60, 40);
		const out = absorbIntraPlaceWalk(segs, pts);
		expect(mode(out[1])).toBe("walking");
	});
});

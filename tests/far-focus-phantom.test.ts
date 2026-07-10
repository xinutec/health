/**
 * `absorbFarFocusPlacePhantom` — swallow a phantom focus-place stay.
 *
 * When the SAME focus place (by id) labels two stays split only by movement,
 * one AT its stored centroid (the real visit) and one FAR from it (a transient
 * the place's over-long veto radius swallowed), the far stay is a labelling
 * artifact that reads as a spurious leave-and-return. Demote it to walking and
 * drop its place so it merges into the arrival.
 *
 * Motivating real case (2026-07-10): a coffee stop ~190 m away at King's Cross
 * station, right after alighting the tube, got stamped "Work" because the Work
 * place's established veto radius reaches ~300 m. It surfaced as
 * Work → walk → Work (left work and came back) when the truth was one arrival.
 *
 * All coordinates synthetic.
 */

import { describe, expect, it } from "vitest";
import type { KnownPlaceProjection } from "../src/geo/classification-inputs.js";
import type { FilteredPoint } from "../src/geo/kalman.js";
import { absorbFarFocusPlacePhantom } from "../src/geo/passes/stays.js";
import type { EnrichedSegment } from "../src/geo/velocity.js";

const T0 = 1_750_000_000;
const M = 0.000009; // ~1 m ≈ 0.000009 deg latitude
const BASE_LAT = 51.533;
const BASE_LON = -0.1259;

const WORK_ID = "work-1";
const HOME_ID = "home-1";

function place(id: string, displayName: string, dxM = 0, dyM = 0): KnownPlaceProjection {
	return {
		id,
		displayName,
		centroidLat: BASE_LAT + dyM * M,
		centroidLon: BASE_LON + dxM * M,
	} as KnownPlaceProjection;
}

function stay(startTs: number, endTs: number, focusPlaceId: string, place: string, dxM = 0, dyM = 0): EnrichedSegment {
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
		focusPlaceId,
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
		linearity: 0.6,
		pointCount: 12,
	} as EnrichedSegment;
}

const noFixes: FilteredPoint[] = [];
const mode = (s: EnrichedSegment): string => s.refinedMode ?? s.mode;

describe("absorbFarFocusPlacePhantom", () => {
	const places = [place(WORK_ID, "Work"), place(HOME_ID, "Home", 0, 1300)];

	it("swallows the far Work stay bracketing the real desk (the KX coffee stop)", () => {
		// far Work (arrival, 190 m from centroid) → walk → real Work (desk, ~0 m)
		const segs = [
			walk(T0, T0 + 2 * 60),
			stay(T0 + 2 * 60, T0 + 7 * 60, WORK_ID, "Work", 0, 190), // phantom, 190 m N
			walk(T0 + 7 * 60, T0 + 12 * 60),
			stay(T0 + 12 * 60, T0 + 140 * 60, WORK_ID, "Work", 0, 0), // real desk
		];
		const out = absorbFarFocusPlacePhantom(segs, places, noFixes);
		expect(mode(out[1])).toBe("walking");
		expect(out[1].place).toBeUndefined();
		expect(out[1].focusPlaceId).toBeUndefined();
		// the real desk stay is untouched
		expect(mode(out[3])).toBe("stationary");
		expect(out[3].place).toBe("Work");
	});

	it("swallows the far one regardless of order (desk first, phantom second)", () => {
		const segs = [
			stay(T0, T0 + 120 * 60, WORK_ID, "Work", 0, 0), // real desk
			walk(T0 + 120 * 60, T0 + 125 * 60),
			stay(T0 + 125 * 60, T0 + 130 * 60, WORK_ID, "Work", 0, 190), // phantom
		];
		const out = absorbFarFocusPlacePhantom(segs, places, noFixes);
		expect(mode(out[0])).toBe("stationary");
		expect(mode(out[2])).toBe("walking");
		expect(out[2].place).toBeUndefined();
	});

	it("does NOT touch two same-place stays that are BOTH at the centroid", () => {
		const segs = [
			stay(T0, T0 + 60 * 60, WORK_ID, "Work", 0, 5),
			walk(T0 + 60 * 60, T0 + 64 * 60),
			stay(T0 + 64 * 60, T0 + 200 * 60, WORK_ID, "Work", 0, 10),
		];
		const out = absorbFarFocusPlacePhantom(segs, places, noFixes);
		expect(out.map(mode)).toEqual(["stationary", "walking", "stationary"]);
	});

	it("does NOT swallow a far stay whose only twin is a DIFFERENT focus place", () => {
		// Home is 1300 m away; a far 'Work' stay with no near Work twin stays put.
		const segs = [
			stay(T0, T0 + 60 * 60, HOME_ID, "Home", 0, 1300),
			walk(T0 + 60 * 60, T0 + 90 * 60),
			stay(T0 + 90 * 60, T0 + 95 * 60, WORK_ID, "Work", 0, 190),
		];
		const out = absorbFarFocusPlacePhantom(segs, places, noFixes);
		expect(out.map(mode)).toEqual(["stationary", "walking", "stationary"]);
	});

	it("does NOT swallow across a real round-trip (a different stay sits between)", () => {
		// Work → lunch elsewhere → Work: the far 'Work' has a genuine other stay
		// between it and the near Work, so it is not a split-by-movement duplicate.
		const segs = [
			stay(T0, T0 + 60 * 60, WORK_ID, "Work", 0, 0), // real desk
			walk(T0 + 60 * 60, T0 + 70 * 60),
			stay(T0 + 70 * 60, T0 + 110 * 60, HOME_ID, "Cafe", 300, 0), // genuine other place
			walk(T0 + 110 * 60, T0 + 120 * 60),
			stay(T0 + 120 * 60, T0 + 125 * 60, WORK_ID, "Work", 0, 190), // far Work
		];
		const out = absorbFarFocusPlacePhantom(segs, places, noFixes);
		expect(out.map(mode)).toEqual(["stationary", "walking", "stationary", "walking", "stationary"]);
	});

	it("does NOT swallow a lone far Work stay with no near twin at all", () => {
		const segs = [
			walk(T0, T0 + 5 * 60),
			stay(T0 + 5 * 60, T0 + 40 * 60, WORK_ID, "Work", 0, 190),
			walk(T0 + 40 * 60, T0 + 45 * 60),
		];
		const out = absorbFarFocusPlacePhantom(segs, places, noFixes);
		expect(mode(out[1])).toBe("stationary");
	});
});

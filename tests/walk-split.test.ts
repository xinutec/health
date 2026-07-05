/**
 * Steps-aware walk-split tests for `splitWalksOnEvidence` (task #245).
 *
 * The motivating shape: a long indoor sit whose jittery indoor GPS scored
 * as one big "walking" segment that ALSO contains a real walk at its edge
 * — a 5-min arrival stop, a ~60-min sit with steps ≈ 0, then a genuine
 * ~10-min walk to the next venue, all emitted as a single ~71-min walk.
 * `demoteJitterWalkToStationary` can't fix it (the segment is not all
 * jitter: it ends with real walking), and `splitStaysOnEvidence` can't
 * either (the segment isn't stationary). This pass carves the physically
 * impossible part out: a human cannot "walk" for 15+ minutes at < 10
 * steps/min, so a long low-cadence edge run inside a walking segment IS
 * a sit, and the boundary where cadence rises is where the real walk
 * starts.
 *
 * Conservative by design, mirroring stay-split: edge runs only (prefix /
 * suffix), a fresh step stream required (a dead Fitbit must not convert
 * real walks into sits), and the remaining walking core must look like a
 * real walk — otherwise the segment is left for the whole-segment
 * demotion pass to judge.
 *
 * All coordinates and venues are synthetic.
 */

import { describe, expect, it } from "vitest";
import type { StepPoint } from "../src/geo/biometrics.js";
import type { FilteredPoint } from "../src/geo/kalman.js";
import type { TrackSegment } from "../src/geo/segments.js";
import { splitWalksOnEvidence } from "../src/geo/stay-split.js";

const T0 = 1_750_000_000; // arbitrary epoch anchor

function fix(ts: number, lat: number, lon: number): FilteredPoint {
	return { ts, lat, lon, speed_kmh: 0, bearing: 0 };
}

function walk(startTs: number, endTs: number, pointCount: number): TrackSegment {
	return {
		startTs,
		endTs,
		mode: "walking",
		confidence: 0.8,
		confidenceMargin: 100,
		avgSpeed: 3,
		maxSpeed: 6,
		linearity: 0.4,
		pointCount,
	};
}

/** Step rows at `perMin` steps for every minute in [fromMin, toMin). */
function steps(fromMin: number, toMin: number, perMin: number): StepPoint[] {
	const out: StepPoint[] = [];
	for (let m = fromMin; m < toMin; m++) {
		if (perMin > 0) out.push({ ts: T0 + m * 60, steps: perMin });
	}
	return out;
}

/** A handful of in-segment fixes spread over [fromMin, toMin). */
function fixes(fromMin: number, toMin: number, n: number): FilteredPoint[] {
	const span = (toMin - fromMin) * 60;
	return Array.from({ length: n }, (_, i) => fix(T0 + fromMin * 60 + Math.floor((i * span) / n), 51.5, -0.14));
}

describe("splitWalksOnEvidence", () => {
	it("carves a long zero-cadence prefix sit out of a phantom walk (the clinic shape)", () => {
		// 71-min "walk": 60 min at ~0 steps, then 11 min at 110 steps/min.
		const seg = walk(T0, T0 + 71 * 60, 20);
		const ctx = {
			hr: [],
			steps: [...steps(0, 60, 0), ...steps(60, 75, 110)],
		};
		const pts = [...fixes(0, 5, 6), ...fixes(60, 71, 10)];
		const out = splitWalksOnEvidence([seg], pts, ctx);
		expect(out).toHaveLength(2);
		expect(out[0].mode).toBe("stationary");
		expect(out[1].mode).toBe("walking");
		// Boundary sits at the cadence rise (minute 60), not somewhere fuzzy.
		expect(Math.abs(out[0].endTs - (T0 + 60 * 60))).toBeLessThanOrEqual(60);
		expect(out[1].startTs).toBe(out[0].endTs);
		// Bounds preserved exactly.
		expect(out[0].startTs).toBe(seg.startTs);
		expect(out[1].endTs).toBe(seg.endTs);
	});

	it("tolerates isolated fidget spikes inside the sit (consult-room walks)", () => {
		// A real indoor sit is not contiguous zeros: isolated minutes of
		// 25-50 steps (walking to a consult room, reception) pepper the
		// hour while the mean stays at sitting level. The contiguous-run
		// version of this pass missed exactly this shape.
		const seg = walk(T0, T0 + 70 * 60, 20);
		const spiky: StepPoint[] = [
			{ ts: T0 + 9 * 60, steps: 45 },
			{ ts: T0 + 10 * 60, steps: 22 },
			{ ts: T0 + 24 * 60, steps: 30 },
			{ ts: T0 + 41 * 60, steps: 35 },
			{ ts: T0 + 52 * 60, steps: 28 },
		];
		const ctx = { hr: [], steps: [...spiky, ...steps(59, 72, 100)] };
		const pts = [...fixes(0, 5, 6), ...fixes(59, 70, 10)];
		const out = splitWalksOnEvidence([seg], pts, ctx);
		expect(out).toHaveLength(2);
		expect(out[0].mode).toBe("stationary");
		expect(out[1].mode).toBe("walking");
		// Boundary lands at the sustained-walk onset (minute ~59), give or
		// take the onset window's slop.
		expect(Math.abs(out[1].startTs - (T0 + 59 * 60))).toBeLessThanOrEqual(2 * 60);
	});

	it("carves a low-cadence suffix sit symmetrically", () => {
		// 40-min "walk": 10 min real walk, then 30 min sitting.
		const seg = walk(T0, T0 + 40 * 60, 20);
		const ctx = { hr: [], steps: [...steps(0, 10, 105), ...steps(10, 45, 2)] };
		const pts = [...fixes(0, 10, 10), ...fixes(10, 40, 8)];
		const out = splitWalksOnEvidence([seg], pts, ctx);
		expect(out).toHaveLength(2);
		expect(out[0].mode).toBe("walking");
		expect(out[1].mode).toBe("stationary");
		expect(Math.abs(out[1].startTs - (T0 + 10 * 60))).toBeLessThanOrEqual(60);
	});

	it("carves both edges when the walk is sandwiched between sits", () => {
		const seg = walk(T0, T0 + 60 * 60, 24);
		const ctx = { hr: [], steps: [...steps(0, 20, 1), ...steps(20, 30, 100), ...steps(30, 65, 0)] };
		const pts = [...fixes(0, 20, 8), ...fixes(20, 30, 8), ...fixes(30, 60, 8)];
		const out = splitWalksOnEvidence([seg], pts, ctx);
		expect(out.map((s) => s.mode)).toEqual(["stationary", "walking", "stationary"]);
	});

	it("does not split when the low-cadence edge is short", () => {
		// 8-min slow start (settling GPS, traffic lights) then real walk.
		const seg = walk(T0, T0 + 30 * 60, 15);
		const ctx = { hr: [], steps: [...steps(0, 8, 3), ...steps(8, 32, 100)] };
		const out = splitWalksOnEvidence([seg], fixes(0, 30, 15), ctx);
		expect(out).toHaveLength(1);
		expect(out[0].mode).toBe("walking");
	});

	it("does not split an all-low-cadence segment (whole-segment demotion owns it)", () => {
		const seg = walk(T0, T0 + 45 * 60, 15);
		const ctx = { hr: [], steps: steps(0, 50, 1) };
		const out = splitWalksOnEvidence([seg], fixes(0, 45, 15), ctx);
		expect(out).toHaveLength(1);
		expect(out[0].mode).toBe("walking");
	});

	it("does not split without a fresh step stream (dead Fitbit)", () => {
		// Zero step rows anywhere near the segment: absence of data, not
		// evidence of sitting.
		const seg = walk(T0, T0 + 71 * 60, 20);
		const out = splitWalksOnEvidence([seg], fixes(0, 71, 20), { hr: [], steps: [] });
		expect(out).toHaveLength(1);
	});

	it("does not touch a genuine sustained walk", () => {
		const seg = walk(T0, T0 + 50 * 60, 25);
		const ctx = { hr: [], steps: steps(0, 55, 95) };
		const out = splitWalksOnEvidence([seg], fixes(0, 50, 25), ctx);
		expect(out).toEqual([seg]);
	});

	it("leaves non-walking segments and short walks untouched", () => {
		const stationary: TrackSegment = { ...walk(T0, T0 + 60 * 60, 10), mode: "stationary" };
		const short = walk(T0 + 61 * 60, T0 + 70 * 60, 5);
		const ctx = { hr: [], steps: steps(0, 75, 0) };
		const out = splitWalksOnEvidence([stationary, short], fixes(0, 70, 15), ctx);
		expect(out).toEqual([stationary, short]);
	});

	it("partitions the parent's fixes between the parts", () => {
		const seg = walk(T0, T0 + 71 * 60, 16);
		const ctx = { hr: [], steps: [...steps(0, 60, 0), ...steps(60, 75, 110)] };
		const pts = [...fixes(0, 5, 6), ...fixes(60, 71, 10)];
		const out = splitWalksOnEvidence([seg], pts, ctx);
		expect(out[0].pointCount).toBe(6);
		expect(out[1].pointCount).toBe(10);
	});
});

import { describe, expect, it } from "vitest";
import type { FilteredPoint } from "../src/geo/kalman.js";
import type { TrackSegment, TransportMode } from "../src/geo/segments.js";
import { claimStayArrivalFromWalk } from "../src/geo/stay-split.js";

// Synthetic scenarios. Movement is in latitude only; ~111,195 m per degree,
// so `at(m)` places a fix m metres north of a fixed origin.
const ORIGIN = 51.0;
const at = (m: number): number => ORIGIN + m / 111195;

function fix(ts: number, m: number, speed_kmh = 0): FilteredPoint {
	return { ts, lat: at(m), lon: 0, speed_kmh, bearing: 0 } as FilteredPoint;
}
function seg(startTs: number, endTs: number, mode: TransportMode): TrackSegment {
	return {
		startTs,
		endTs,
		mode,
		confidence: 0.8,
		confidenceMargin: 0.5,
		avgSpeed: mode === "stationary" ? 0.5 : 5,
		maxSpeed: mode === "stationary" ? 2 : 7,
		linearity: mode === "stationary" ? 0.1 : 0.9,
		pointCount: 0,
	} as TrackSegment;
}

/** The 2026-06-22 evening shape: a walk at ~5.5 km/h that arrives and then
 *  holds position for the rest of the segment, because the 300 s classifier
 *  window that straddled the arrival was scored as walking. */
function arrivalDay(dwellS: number, spreadM = 4): { segs: TrackSegment[]; points: FilteredPoint[] } {
	const t0 = 1_000_000;
	const points: FilteredPoint[] = [];
	// 10 minutes of walking, a fix every 28 s, ~43 m per step (5.5 km/h).
	let m = 0;
	let ts = t0;
	for (; ts < t0 + 600; ts += 28) {
		points.push(fix(ts, m, 5.5));
		m += 43;
	}
	const arrival = ts;
	// Then held position: tiny jitter inside `spreadM`, same cadence.
	for (let j = 0; ts <= arrival + dwellS; ts += 28, j++) points.push(fix(ts, m + (j % 2 === 0 ? 0 : spreadM), 0.2));
	const walkEnd = ts;
	return {
		segs: [seg(t0, walkEnd, "walking"), seg(walkEnd, walkEnd + 3600, "stationary")],
		points,
	};
}

describe("claimStayArrivalFromWalk", () => {
	it("moves the boundary back to where the walking stopped", () => {
		const { segs, points } = arrivalDay(140);
		const out = claimStayArrivalFromWalk(segs, points);
		const walk = out[0];
		// The walk ran 600 s then held for 140 s; the boundary belongs at ~600 s.
		expect(walk.endTs).toBeLessThan(segs[0].endTs);
		expect(walk.endTs - segs[0].startTs).toBeGreaterThanOrEqual(590);
		expect(walk.endTs - segs[0].startTs).toBeLessThanOrEqual(640);
	});

	it("hands the reclaimed time to the stay, leaving no gap", () => {
		const { segs, points } = arrivalDay(140);
		const out = claimStayArrivalFromWalk(segs, points);
		expect(out[1].startTs).toBe(out[0].endTs);
		// Total span is preserved — this moves a boundary, it does not drop time.
		expect(out[1].endTs).toBe(segs[1].endTs);
		expect(out[0].startTs).toBe(segs[0].startTs);
	});

	it("does NOT force the shortened walk to be re-derived", () => {
		// Tempting, because a walk trimmed of its arrival may belong to a
		// different street than the one it overran onto. But re-derivation
		// redoes the MODE as well as the name: on 2026-04-29 the shortened leg
		// came back `cycling` and repairVehicleHandoff absorbed 27 minutes of
		// it into the adjacent train as an impossible vehicle hand-off. The
		// window changed; what the segment IS did not.
		const { segs, points } = arrivalDay(140);
		const withName = [{ ...segs[0], wayName: "Barn Rise" }, segs[1]];
		const out = claimStayArrivalFromWalk(withName, points);
		expect((out[0] as { needsReenrich?: boolean }).needsReenrich).toBeFalsy();
		expect((out[0] as { wayName?: string }).wayName).toBe("Barn Rise");
	});

	it("leaves a walk that ends while still moving alone", () => {
		const t0 = 1_000_000;
		const points: FilteredPoint[] = [];
		let m = 0;
		for (let ts = t0; ts < t0 + 600; ts += 28, m += 43) points.push(fix(ts, m));
		const segs = [seg(t0, t0 + 600, "walking"), seg(t0 + 600, t0 + 4200, "stationary")];
		const out = claimStayArrivalFromWalk(segs, points);
		expect(out[0].endTs).toBe(segs[0].endTs);
	});

	it("does not fire on a pause too short to be an arrival", () => {
		// 56 s of standing — under FOOT_ARRIVAL_MIN_DWELL_S.
		const { segs, points } = arrivalDay(56);
		expect(claimStayArrivalFromWalk(segs, points)[0].endTs).toBe(segs[0].endTs);
	});

	it("does not fire when the tail drifts instead of holding", () => {
		// Same duration, but the 'still' run wanders 80 m — slow movement, not
		// an arrival, so where the walk ended is not readable from it.
		const { segs, points } = arrivalDay(140, 80);
		expect(claimStayArrivalFromWalk(segs, points)[0].endTs).toBe(segs[0].endTs);
	});

	it("never annihilates the walk", () => {
		// A 'walk' that is standing almost from its first fix must not be
		// reduced to nothing — reclassifying it is not this pass's decision.
		const t0 = 1_000_000;
		const points: FilteredPoint[] = [];
		for (let ts = t0, j = 0; ts <= t0 + 400; ts += 28, j++) points.push(fix(ts, j % 2 === 0 ? 0 : 3));
		const segs = [seg(t0, t0 + 400, "walking"), seg(t0 + 400, t0 + 4000, "stationary")];
		const out = claimStayArrivalFromWalk(segs, points);
		expect(out[0].endTs).toBe(segs[0].endTs);
	});

	it("recomputes the shortened walk's kinematics over its new window", () => {
		// The seconds this pass takes away are the standing ones, which is
		// exactly what was dragging the walk's average down. Leaving the old
		// numbers behind would report a slower walk than the rider walked.
		const { segs, points } = arrivalDay(140);
		const out = claimStayArrivalFromWalk(segs, points);
		expect(out[0].avgSpeed).toBeGreaterThan(5);
		// Only the fixes inside the new window count toward it.
		expect(out[0].pointCount).toBe(points.filter((p) => p.ts >= out[0].startTs && p.ts < out[0].endTs).length);
	});

	it("recomputes the stay's kinematics but keeps its enrichment", () => {
		const { segs, points } = arrivalDay(140);
		const withPlace = [segs[0], { ...segs[1], place: "Home", wayName: "Barn Rise" }];
		const out = claimStayArrivalFromWalk(withPlace, points);
		// The stay is the same place, merely entered earlier.
		expect((out[1] as { place?: string }).place).toBe("Home");
		expect(out[1].avgSpeed).toBeLessThan(1);
	});

	it("only acts on a walk followed by a stay", () => {
		const { segs, points } = arrivalDay(140);
		const toTrain: TrackSegment[] = [segs[0], { ...segs[1], mode: "train" as TransportMode }];
		expect(claimStayArrivalFromWalk(toTrain, points)[0].endTs).toBe(segs[0].endTs);
	});
});

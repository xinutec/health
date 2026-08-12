import { describe, expect, it } from "vitest";
import type { StepPoint } from "../src/geo/biometrics.js";
import { trimRideTailAtWalk } from "../src/geo/interchange-split.js";
import type { TransportMode } from "../src/geo/segments.js";

// Latitude-only motion; ~111,195 m per degree.
const ORIGIN = 51.0;
const north = (m: number): number => ORIGIN + m / 111195;

interface Seg {
	startTs: number;
	endTs: number;
	mode: TransportMode;
	refinedMode?: TransportMode;
	wayName?: string;
	confidence: number;
	confidenceMargin: number;
	avgSpeed: number;
	maxSpeed: number;
	linearity: number;
	pointCount: number;
	refinedReason?: string;
}

const T0 = 1_000_000;

function seg(startTs: number, endTs: number, mode: TransportMode = "train"): Seg {
	return {
		startTs,
		endTs,
		mode,
		wayName: "A → B · Metropolitan Line",
		confidence: 0.9,
		confidenceMargin: 0.5,
		avgSpeed: 40,
		maxSpeed: 90,
		linearity: 0.95,
		pointCount: 40,
	};
}

/** Per-minute step buckets over [from, to). */
function steps(from: number, to: number, spm: number): StepPoint[] {
	const out: StepPoint[] = [];
	for (let t = from; t < to; t += 60) out.push({ ts: t, steps: spm } as StepPoint);
	return out;
}

/** The measured 06-18 shape: ride at vehicle pace, then a walk out of the
 *  station, then STOPPED — all three inside one train leg. The stationary
 *  part matters: `findInterchangeBurst` discards a burst within
 *  BURST_EDGE_GUARD_S (3 min) of a leg edge, and on 06-18 the burst only
 *  clears that guard because the leg runs on past it into the stop. A
 *  fixture without the stop does not reproduce the defect. */
function rideThenWalk(
	rideEndS: number,
	walkS: number,
	stillS = 300,
): { segs: Seg[]; points: { ts: number; lat: number; lon: number }[] } {
	const points: { ts: number; lat: number; lon: number }[] = [];
	let m = 0;
	let ts = T0;
	for (; ts < T0 + rideEndS; ts += 14) {
		points.push({ ts, lat: north(m), lon: 0 });
		m += 250; // ~64 km/h
	}
	for (; ts < T0 + rideEndS + walkS; ts += 14) {
		points.push({ ts, lat: north(m), lon: 0 });
		m += 20; // ~5 km/h
	}
	for (; ts <= T0 + rideEndS + walkS + stillS; ts += 14) {
		points.push({ ts, lat: north(m), lon: 0 });
		m += 1; // stopped
	}
	return { segs: [seg(T0, T0 + rideEndS + walkS + stillS)], points };
}

describe("trimRideTailAtWalk", () => {
	it("moves the alight to where the walking starts", () => {
		const { segs, points } = rideThenWalk(420, 180);
		const st = steps(T0 + 430, T0 + 590, 93);
		const out = trimRideTailAtWalk(segs, points, st);
		expect(out[0].endTs).toBeLessThan(segs[0].endTs);
		// The ride ends around T0+420; allow a fix-interval of slack.
		expect(out[0].endTs - T0).toBeGreaterThanOrEqual(400);
		expect(out[0].endTs - T0).toBeLessThanOrEqual(440);
	});

	it("records why the boundary moved", () => {
		const { segs, points } = rideThenWalk(420, 180);
		const out = trimRideTailAtWalk(segs, points, steps(T0 + 430, T0 + 590, 93));
		expect(out[0].refinedReason).toMatch(/alight trimmed back/);
	});

	it("leaves a ride with no walking burst alone", () => {
		const { segs, points } = rideThenWalk(420, 180);
		// Same geometry, but the pedometer shows nobody walked.
		const out = trimRideTailAtWalk(segs, points, steps(T0 + 430, T0 + 590, 5));
		expect(out[0].endTs).toBe(segs[0].endTs);
	});

	it("does NOT trim when the ride resumes after the burst — that is an interchange", () => {
		// Ride, walking burst, then vehicle pace again. spliceInterchanges owns
		// this shape; trimming it would delete the second half of a real journey.
		const points: { ts: number; lat: number; lon: number }[] = [];
		let m = 0;
		let ts = T0;
		for (; ts < T0 + 300; ts += 14) {
			points.push({ ts, lat: north(m), lon: 0 });
			m += 250;
		}
		for (; ts < T0 + 480; ts += 14) {
			points.push({ ts, lat: north(m), lon: 0 });
			m += 20;
		}
		for (; ts <= T0 + 900; ts += 14) {
			points.push({ ts, lat: north(m), lon: 0 });
			m += 250;
		}
		const out = trimRideTailAtWalk([seg(T0, T0 + 900)], points, steps(T0 + 310, T0 + 470, 93));
		expect(out[0].endTs).toBe(T0 + 900);
	});

	it("never leaves a stub ride", () => {
		// Walking almost from the start: there is no ride to keep, so this is a
		// mislabelled leg, and reclassifying it is not this pass's decision.
		const { segs, points } = rideThenWalk(60, 400);
		const out = trimRideTailAtWalk(segs, points, steps(T0 + 70, T0 + 450, 93));
		expect(out[0].endTs).toBe(segs[0].endTs);
	});

	it("re-homes the trimmed time instead of leaving a hole", () => {
		const { segs, points } = rideThenWalk(420, 180);
		const out = trimRideTailAtWalk(segs, points, steps(T0 + 430, T0 + 590, 93));
		expect(out).toHaveLength(2);
		// Gapless, and the span is preserved end to end.
		expect(out[1].startTs).toBe(out[0].endTs);
		expect(out[1].endTs).toBe(segs[0].endTs);
		expect(out[1].mode).toBe("walking");
		// The station-side name described the ride, not this stretch.
		expect(out[1].wayName).toBeUndefined();
	});

	it("recomputes the carved walk's kinematics rather than inheriting or zeroing", () => {
		// Inheriting gives a walk the ride's 90 km/h; zeroing gives it 0 and
		// every later pass reads it as stationary. Both are lies a downstream
		// pass acts on — the same class as the stale-avgSpeed bug in #782.
		const { segs, points } = rideThenWalk(420, 180);
		const out = trimRideTailAtWalk(segs, points, steps(T0 + 430, T0 + 590, 93));
		expect(out[1].avgSpeed).toBeGreaterThan(0);
		expect(out[1].avgSpeed).toBeLessThan(15); // walking pace, not the ride's
		expect(out[1].pointCount).toBeLessThan(segs[0].pointCount);
		expect(out[1].pointCount).toBeGreaterThan(0);
	});

	it("does not read the train BRAKING as the ride resuming", () => {
		// Step buckets are per-minute, so the burst's first minute contains the
		// deceleration into the station. On 06-18 that is a 27.9 km/h fix
		// fifteen seconds in. Testing for resumption from the burst's START
		// instead of its END refuses every real tail.
		const points: { ts: number; lat: number; lon: number }[] = [];
		let m = 0;
		let ts = T0;
		for (; ts < T0 + 420; ts += 14) {
			points.push({ ts, lat: north(m), lon: 0 });
			m += 250;
		}
		points.push({ ts, lat: north(m), lon: 0 });
		m += 110;
		ts += 14; // braking, ~28 km/h
		for (; ts < T0 + 600; ts += 14) {
			points.push({ ts, lat: north(m), lon: 0 });
			m += 20;
		}
		for (; ts <= T0 + 900; ts += 14) {
			points.push({ ts, lat: north(m), lon: 0 });
			m += 1;
		}
		const out = trimRideTailAtWalk([seg(T0, T0 + 900)], points, steps(T0 + 420, T0 + 600, 93));
		expect(out.length).toBe(2);
		expect(out[0].endTs).toBeLessThan(T0 + 900);
	});

	it("only acts on train legs", () => {
		const { segs, points } = rideThenWalk(420, 180);
		const asDriving = [{ ...segs[0], mode: "driving" as TransportMode }];
		const out = trimRideTailAtWalk(asDriving, points, steps(T0 + 430, T0 + 590, 93));
		expect(out[0].endTs).toBe(segs[0].endTs);
	});
});

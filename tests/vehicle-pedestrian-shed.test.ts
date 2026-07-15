import { describe, expect, it } from "vitest";
import type { StepPoint } from "../src/geo/biometrics.js";
import type { FilteredPoint } from "../src/geo/kalman.js";
import type { TrackSegment } from "../src/geo/segments.js";
import { shedVehiclePedestrianEdges } from "../src/geo/stay-split.js";

// Synthetic scenarios. Movement is in latitude only; ~111,195 m per degree,
// so `at(m)` places a fix m metres north of a fixed origin.
const ORIGIN = 51.0;
const at = (m: number): number => ORIGIN + m / 111195;

function fix(ts: number, lat: number, speed_kmh: number): FilteredPoint {
	return { ts, lat, lon: 0, speed_kmh, bearing: 0 };
}
function seg(startTs: number, endTs: number, mode: string): TrackSegment {
	return {
		startTs,
		endTs,
		mode,
		confidence: 0.8,
		confidenceMargin: 0.5,
		avgSpeed: mode === "walking" ? 3 : 40,
		maxSpeed: mode === "walking" ? 6 : 70,
		linearity: 0.9,
		pointCount: 0,
	} as TrackSegment;
}
/** Per-minute step buckets covering [t0, t0 + minutes*60) at a cadence. */
function cadence(t0: number, minutes: number, stepsPerMin: number): StepPoint[] {
	return Array.from({ length: minutes }, (_, i) => ({ ts: t0 + i * 60, steps: stepsPerMin }));
}

// The 2026-07-14-evening shape: a ride at ~60 km/h whose final ~2 min are
// brisk-walk steps with walking cadence — the user is off the train and
// walking up the road, but the train leg still owns the fixes, so the
// following walking leg starts ~200 m from the station.
//
// ride: fixes every 14 s at ~250 m/step (64 km/h), t=0..140, reaching at(2500)
// tail: fixes every 14 s at ~25 m/step (6.4 km/h), t=140..280, reaching at(2750)
function tailScenario(): { pts: FilteredPoint[]; segs: TrackSegment[] } {
	const pts: FilteredPoint[] = [];
	for (let i = 0; i <= 10; i++) pts.push(fix(i * 14, at(i * 250), 64));
	for (let i = 1; i <= 10; i++) pts.push(fix(140 + i * 14, at(2500 + i * 25), 6));
	// following walk (280..400): continues on foot
	for (let i = 1; i <= 8; i++) pts.push(fix(280 + i * 15, at(2750 + i * 25), 6));
	return { pts, segs: [seg(0, 280, "train"), seg(280, 400, "walking")] };
}

describe("shedVehiclePedestrianEdges", () => {
	it("hands a train leg's pedestrian tail to the following walk (the stolen arrival walk)", () => {
		const { pts, segs } = tailScenario();
		const out = shedVehiclePedestrianEdges(segs, pts, cadence(0, 8, 110));
		expect(out.map((s) => s.mode)).toEqual(["train", "walking"]);
		// Boundary moves to the fix where the pedestrian suffix begins (t=140,
		// the fix the ride arrived on — the ride keeps its arrival fix).
		expect(out[0].endTs).toBe(140);
		expect(out[1].startTs).toBe(140);
		// The walk is rebuilt from its own (extended) fixes and flagged for
		// re-enrichment — its old way name is no longer evidence.
		expect((out[1] as { needsReenrich?: boolean }).needsReenrich).toBe(true);
	});

	it("does nothing without step data (a signal-crawl is indistinguishable from a walk)", () => {
		const { pts, segs } = tailScenario();
		expect(shedVehiclePedestrianEdges(segs, pts, [])).toEqual(segs);
	});

	it("does nothing when the wearer is not stepping (seated through a crawl)", () => {
		const { pts, segs } = tailScenario();
		expect(shedVehiclePedestrianEdges(segs, pts, cadence(0, 8, 5))).toEqual(segs);
	});

	it("does nothing when the next segment is not a walk (no receiver — never invent segments)", () => {
		const { pts } = tailScenario();
		const segs = [seg(0, 280, "train"), seg(280, 400, "stationary")];
		expect(shedVehiclePedestrianEdges(segs, pts, cadence(0, 8, 110))).toEqual(segs);
	});

	it("does nothing when the slow tail is too short to be a walk (a stop-signal crawl)", () => {
		// Only 3 slow steps (~42 s) at the end — under the duration floor.
		const pts: FilteredPoint[] = [];
		for (let i = 0; i <= 14; i++) pts.push(fix(i * 14, at(i * 250), 64));
		for (let i = 1; i <= 3; i++) pts.push(fix(196 + i * 14, at(3500 + i * 25), 6));
		const segs = [seg(0, 240, "train"), seg(240, 400, "walking")];
		expect(shedVehiclePedestrianEdges(segs, pts, cadence(0, 8, 110))).toEqual(segs);
	});

	it("hands a train leg's pedestrian head back to the preceding walk (the boarding-side mirror)", () => {
		// walk (0..100) then a train leg whose first ~2 min are still on foot.
		const pts: FilteredPoint[] = [];
		for (let i = 0; i <= 6; i++) pts.push(fix(i * 15, at(i * 25), 6));
		for (let i = 1; i <= 10; i++) pts.push(fix(100 + i * 14, at(150 + i * 25), 6)); // pedestrian head, 140 s / 250 m
		for (let i = 1; i <= 10; i++) pts.push(fix(240 + i * 14, at(400 + i * 250), 64)); // the actual ride
		const segs = [seg(0, 100, "walking"), seg(100, 380, "train")];
		const out = shedVehiclePedestrianEdges(segs, pts, cadence(0, 8, 110));
		expect(out.map((s) => s.mode)).toEqual(["walking", "train"]);
		// Boundary moves to the fix where the ride's first vehicle step departs.
		expect(out[0].endTs).toBe(240);
		expect(out[1].startTs).toBe(240);
	});

	it("never consumes the ride — a leg that is pedestrian throughout is left for classification to fix", () => {
		// All fixes at walking pace: shedding the maximal suffix would leave no
		// ride. The pass must not act (the leg's MODE is wrong, which is not a
		// boundary problem).
		const pts: FilteredPoint[] = [];
		for (let i = 0; i <= 20; i++) pts.push(fix(i * 14, at(i * 25), 6));
		const segs = [seg(0, 280, "train"), seg(280, 400, "walking")];
		expect(shedVehiclePedestrianEdges(segs, pts, cadence(0, 8, 110))).toEqual(segs);
	});
});

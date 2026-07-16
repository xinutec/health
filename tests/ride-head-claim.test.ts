import { describe, expect, it } from "vitest";
import type { StepPoint } from "../src/geo/biometrics.js";
import type { FilteredPoint } from "../src/geo/kalman.js";
import type { TrackSegment } from "../src/geo/segments.js";
import { claimRideHeadFromStay } from "../src/geo/stay-split.js";

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
		avgSpeed: mode === "stationary" ? 0.5 : 40,
		maxSpeed: mode === "stationary" ? 2 : 70,
		linearity: 0.2,
		pointCount: 0,
	} as TrackSegment;
}
/** Per-minute step buckets covering [t0, t0 + minutes*60) at a cadence. */
function cadence(t0: number, minutes: number, stepsPerMin: number): StepPoint[] {
	return Array.from({ length: minutes }, (_, i) => ({ ts: t0 + i * 60, steps: stepsPerMin }));
}

// The 2026-07-07 boarding shape: a long office stay whose TAIL holds the
// next ride's entire head — the walk out to the station, a platform wait,
// and the first tunnel-reacquire teleports — because GPS died in the tunnel
// before segmentation saw a boundary. The train leg only starts at the next
// clean fix, minutes into the ride.
//
// dwell:  t=0..1800, a fix per minute jittering within ~4 m of the origin
// march:  t=1800..2160, 35 m per 30 s step (4.2 km/h) out to at(420)
// wait:   t=2160..2280, still fixes at the platform (at ~420)
// hops:   t=2380 at(1320), t=2480 at(2720) — the tunnel-reacquire teleports
// stay:   (0, 2500) holds all of it; train (2600, 3600) follows.
function boardingScenario(): { pts: FilteredPoint[]; segs: TrackSegment[] } {
	const pts: FilteredPoint[] = [];
	for (let i = 0; i <= 30; i++) pts.push(fix(i * 60, at((i % 3) * 2), 0.5));
	for (let i = 1; i <= 12; i++) pts.push(fix(1800 + i * 30, at(i * 35), 4.5));
	for (let i = 1; i <= 4; i++) pts.push(fix(2160 + i * 30, at(420 + (i % 2)), 0.3));
	pts.push(fix(2380, at(1320), 30));
	pts.push(fix(2480, at(2720), 45));
	// the train leg's own fixes
	for (let i = 1; i <= 4; i++) pts.push(fix(2600 + i * 60, at(2720 + i * 900), 55));
	return { pts, segs: [seg(0, 2500, "stationary"), seg(2600, 3600, "train")] };
}

/** Walking cadence through the march, near-none elsewhere. */
function marchSteps(): StepPoint[] {
	return [...cadence(0, 30, 3), ...cadence(1800, 6, 110), ...cadence(2160, 6, 5)];
}

describe("claimRideHeadFromStay", () => {
	it("carves the boarding walk out of the stay and hands the reacquire fixes to the train", () => {
		const { pts, segs } = boardingScenario();
		const out = claimRideHeadFromStay(segs, pts, marchSteps());
		expect(out.map((s) => s.mode)).toEqual(["stationary", "walking", "train"]);
		// The stay ends at its last at-dwell fix; the walk covers the march;
		// the train extends back to the march's end, owning the platform wait
		// and the reacquire teleports.
		expect(out[0].endTs).toBe(1800);
		expect(out[1].startTs).toBe(1800);
		expect(out[1].endTs).toBe(2160);
		expect(out[2].startTs).toBe(2160);
		expect(out[2].endTs).toBe(3600);
		// The invented walk is rebuilt from its own fixes and flagged for
		// re-enrichment — the stay's place/way labels are not evidence about it.
		expect((out[1] as { needsReenrich?: boolean }).needsReenrich).toBe(true);
		expect(out[1].maxSpeed).toBeLessThan(10);
	});

	it("does nothing without step data (a crawling taxi from the door is indistinguishable)", () => {
		const { pts, segs } = boardingScenario();
		expect(claimRideHeadFromStay(segs, pts, [])).toEqual(segs);
	});

	it("does nothing when the wearer is not stepping through the march (a vehicle crawl)", () => {
		const { pts, segs } = boardingScenario();
		const seated = [...cadence(0, 30, 3), ...cadence(1800, 12, 5)];
		expect(claimRideHeadFromStay(segs, pts, seated)).toEqual(segs);
	});

	it("does nothing when the next segment is not a train", () => {
		const { pts, segs } = boardingScenario();
		const notTrain = [segs[0], seg(2600, 3600, "walking")];
		expect(claimRideHeadFromStay(notTrain, pts, marchSteps())).toEqual(notTrain);
	});

	it("does nothing when the tail has no vehicle-paced step (the walk-out was already segmented)", () => {
		const { segs } = boardingScenario();
		const pts: FilteredPoint[] = [];
		for (let i = 0; i <= 30; i++) pts.push(fix(i * 60, at((i % 3) * 2), 0.5));
		for (let i = 1; i <= 12; i++) pts.push(fix(1800 + i * 30, at(i * 35), 4.5));
		expect(claimRideHeadFromStay(segs, pts, marchSteps())).toEqual(segs);
	});

	it("does nothing on an errand-and-back (a teleport spike that returns to the dwell)", () => {
		// March out, one fast spike, then the fixes settle back AT the dwell —
		// the user never left for good, so nothing may be carved.
		const pts: FilteredPoint[] = [];
		for (let i = 0; i <= 30; i++) pts.push(fix(i * 60, at((i % 3) * 2), 0.5));
		for (let i = 1; i <= 12; i++) pts.push(fix(1800 + i * 30, at(i * 35), 4.5));
		pts.push(fix(2260, at(1320), 30)); // spike
		for (let i = 0; i <= 3; i++) pts.push(fix(2360 + i * 60, at((i % 3) * 2), 0.5)); // back home
		const segs = [seg(0, 2600, "stationary"), seg(2700, 3600, "train")];
		expect(claimRideHeadFromStay(segs, pts, marchSteps())).toEqual(segs);
	});

	it("does nothing when the march never leaves the dwell's neighbourhood (forecourt pacing)", () => {
		// 80 m of pacing, then the teleports: under the net-distance floor, so
		// there is no walk to surface — the head stays as counted ceiling debt.
		const pts: FilteredPoint[] = [];
		for (let i = 0; i <= 30; i++) pts.push(fix(i * 60, at((i % 3) * 2), 0.5));
		for (let i = 1; i <= 8; i++) pts.push(fix(1800 + i * 30, at(i * 10), 1.2));
		pts.push(fix(2140, at(980), 30));
		pts.push(fix(2240, at(2380), 45));
		const segs = [seg(0, 2300, "stationary"), seg(2400, 3600, "train")];
		expect(claimRideHeadFromStay(segs, pts, marchSteps())).toEqual(segs);
	});

	it("does nothing when the carve would leave a sliver of a stay (platform-wait scale)", () => {
		// Same tail shape but the stay only ever held ~5 min of dwell — that is
		// a platform wait, owned by the boarding-platform absorber, not here.
		const pts: FilteredPoint[] = [];
		for (let i = 0; i <= 5; i++) pts.push(fix(i * 60, at((i % 3) * 2), 0.5));
		for (let i = 1; i <= 12; i++) pts.push(fix(300 + i * 30, at(i * 35), 4.5));
		pts.push(fix(760, at(1320), 30));
		pts.push(fix(860, at(2720), 45));
		const segs = [seg(0, 900, "stationary"), seg(1000, 2000, "train")];
		const steps = [...cadence(0, 5, 3), ...cadence(300, 6, 110)];
		expect(claimRideHeadFromStay(segs, pts, steps)).toEqual(segs);
	});
});

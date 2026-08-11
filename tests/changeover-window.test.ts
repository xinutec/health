/**
 * The changeover window between two rides is `[ride tail][platform walk][ride
 * head]`, and only the middle is a walk (#444).
 *
 * The two corpus days this was written for have different shapes — 2026-07-02
 * strands a ride tail and no head, 2026-06-15 strands both — so each is pinned
 * as its own case rather than one standing in for the other. The fixtures below
 * are the real fix streams from `diag-infeasible-leg`, rounded to the printed
 * resolution: a synthetic ride would agree with the implementation about what a
 * train looks like, which is the one thing this must not assume.
 */

import { describe, expect, it } from "vitest";
import type { EnrichedSegment } from "../src/geo/enriched-segment.js";
import type { FilteredPoint } from "../src/geo/kalman.js";
import { splitChangeoverWindows } from "../src/geo/passes/rail-reconcile.js";

const pt = (ts: number, lat: number, lon: number): FilteredPoint => ({
	ts,
	lat,
	lon,
	speed_kmh: 0,
	bearing: 0,
});

const train = (startTs: number, endTs: number, wayName: string): EnrichedSegment => ({
	startTs,
	endTs,
	mode: "train",
	confidence: 1,
	confidenceMargin: 3,
	avgSpeed: 40,
	maxSpeed: 60,
	linearity: 0.9,
	pointCount: 5,
	wayName,
});

const walk = (startTs: number, endTs: number, wayName: string): EnrichedSegment => ({
	startTs,
	endTs,
	mode: "walking",
	confidence: 1,
	confidenceMargin: 3,
	avgSpeed: 4,
	maxSpeed: 8,
	linearity: 0.5,
	pointCount: 14,
	wayName,
});

/** 2026-07-02 08:05:57–08:09:45Z, the Finchley Road changeover. The ride runs
 *  to 08:09:13 calling at West Hampstead on the way (two short dwells INSIDE
 *  the ride), and the real cross-platform change is the last 32 s. */
const O702_BASE = 1_782_000_000;
const O702_FIXES: FilteredPoint[] = [
	pt(O702_BASE + 0, 51.546413, -0.1965), // 08:05:57
	pt(O702_BASE + 56, 51.54683, -0.191256), // 23.5 km/h
	pt(O702_BASE + 70, 51.546846, -0.191277), // West Hampstead dwell
	pt(O702_BASE + 84, 51.546828, -0.191067),
	pt(O702_BASE + 98, 51.546904, -0.189308), // 31.4 km/h
	pt(O702_BASE + 112, 51.546927, -0.189115), // second dwell
	pt(O702_BASE + 126, 51.546939, -0.189122),
	pt(O702_BASE + 140, 51.546976, -0.188115), // 18.0 km/h
	pt(O702_BASE + 154, 51.547132, -0.185938), // 39.0
	pt(O702_BASE + 168, 51.547453, -0.183219), // 49.3
	pt(O702_BASE + 182, 51.547405, -0.180961), // 40.2
	pt(O702_BASE + 196, 51.547345, -0.179954), // 18.0 — arrives Finchley Road
	pt(O702_BASE + 210, 51.547345, -0.180449), // the platform change begins
	pt(O702_BASE + 228, 51.547347, -0.180749),
];

/** 2026-06-15 11:56:10–12:00:10Z. Ride tail to Finchley Road, a 76 s platform
 *  dwell, then a ride head on to Swiss Cottage. */
const O615_BASE = 1_781_000_000;
const O615_FIXES: FilteredPoint[] = [
	pt(O615_BASE + 0, 51.546578, -0.1997), // 11:56:10
	pt(O615_BASE + 58, 51.547266, -0.184837), // 64.0 km/h
	pt(O615_BASE + 73, 51.547605, -0.181777), // 51.6
	pt(O615_BASE + 87, 51.547454, -0.179968), // 32.5 — arrives Finchley Road
	pt(O615_BASE + 101, 51.547342, -0.179676), // platform dwell begins
	pt(O615_BASE + 115, 51.547212, -0.180397),
	pt(O615_BASE + 129, 51.547246, -0.180439),
	pt(O615_BASE + 143, 51.547293, -0.180512),
	pt(O615_BASE + 158, 51.547346, -0.180723),
	pt(O615_BASE + 177, 51.547349, -0.18074), // dwell ends
	pt(O615_BASE + 202, 51.544097, -0.17548), // 73.9 — the departing ride
	pt(O615_BASE + 226, 51.543246, -0.17428), // 18.9
	pt(O615_BASE + 240, 51.543165, -0.174111),
];

describe("splitChangeoverWindows", () => {
	it("gives 2026-07-02's stranded ride tail back to the arriving leg", () => {
		const segs = [
			train(O702_BASE - 600, O702_BASE, "Wembley Park → Finchley Road · Jubilee Line"),
			walk(O702_BASE, O702_BASE + 228, "Finchley Road (interchange)"),
			train(O702_BASE + 228, O702_BASE + 900, "Finchley Road → Euston Square · Metropolitan Line"),
		];
		const [arrive, platform, depart] = splitChangeoverWindows(segs, O702_FIXES);

		// The ride now ends where the phone reaches Finchley Road, not 3.5
		// minutes before it.
		expect(arrive.endTs).toBe(O702_BASE + 196);
		expect(platform.startTs).toBe(O702_BASE + 196);
		// Nothing was taken from the departing side: this window has no head.
		expect(depart.startTs).toBe(O702_BASE + 228);
		expect(platform.endTs).toBe(O702_BASE + 228);
	});

	it("does not end the tail at an intermediate station stop", () => {
		// The failure mode a first-slow-step scan would have: West Hampstead is
		// 28 s of near-stillness INSIDE the ride, and stopping there would leave
		// most of the hop stranded and the walk still impossible.
		const [arrive] = splitChangeoverWindows(
			[
				train(O702_BASE - 600, O702_BASE, "A → B · Jubilee Line"),
				walk(O702_BASE, O702_BASE + 228, "B (interchange)"),
				train(O702_BASE + 228, O702_BASE + 900, "B → C · Metropolitan Line"),
			],
			O702_FIXES,
		);
		expect(arrive.endTs).toBeGreaterThan(O702_BASE + 84);
	});

	it("splits 2026-06-15 on BOTH sides of the platform dwell", () => {
		const segs = [
			train(O615_BASE - 600, O615_BASE, "Wembley Park → Swiss Cottage"),
			walk(O615_BASE, O615_BASE + 240, "Swiss Cottage (interchange)"),
			train(O615_BASE + 240, O615_BASE + 700, "Swiss Cottage → Green Park · Jubilee Line"),
		];
		const [arrive, platform, depart] = splitChangeoverWindows(segs, O615_FIXES);

		expect(arrive.endTs).toBe(O615_BASE + 87); // arrival at Finchley Road
		expect(depart.startTs).toBe(O615_BASE + 177); // the departing ride begins
		expect(platform.startTs).toBe(O615_BASE + 87);
		expect(platform.endTs).toBe(O615_BASE + 177);
	});

	it("leaves an honest platform walk alone", () => {
		// Same window shape, nothing in it faster than a walk.
		const slow = [0, 30, 60, 90, 120].map((d, i) => pt(O702_BASE + d, 51.5464 + i * 0.0001, -0.1965));
		const segs = [
			train(O702_BASE - 600, O702_BASE, "A → B · Jubilee Line"),
			walk(O702_BASE, O702_BASE + 120, "B (interchange)"),
			train(O702_BASE + 120, O702_BASE + 900, "B → C · Metropolitan Line"),
		];
		expect(splitChangeoverWindows(segs, slow)).toEqual(segs);
	});

	it("declines when the reclaimed ride is too short to be an inter-station hop", () => {
		// Fast steps, but the window covers 60 m end to end — a train easing to a
		// stop, not a hop. Moving the boundary here would buy a wrong label.
		const shuffle = [
			pt(O702_BASE + 0, 51.5464, -0.1965),
			pt(O702_BASE + 8, 51.5464, -0.19571),
			pt(O702_BASE + 60, 51.54641, -0.19566),
			pt(O702_BASE + 120, 51.54642, -0.19565),
		];
		const segs = [
			train(O702_BASE - 600, O702_BASE, "A → B · Jubilee Line"),
			walk(O702_BASE, O702_BASE + 120, "B (interchange)"),
			train(O702_BASE + 120, O702_BASE + 900, "B → C · Metropolitan Line"),
		];
		expect(splitChangeoverWindows(segs, shuffle)).toEqual(segs);
	});

	it("only touches a walk BETWEEN two station-pair trains", () => {
		// Same fixes, but the following leg is a stay. This is the anchors' case
		// (train → walk → not-train), and they own it.
		const segs = [
			train(O702_BASE - 600, O702_BASE, "Wembley Park → Finchley Road · Jubilee Line"),
			walk(O702_BASE, O702_BASE + 228, "Finchley Road (interchange)"),
			{ ...walk(O702_BASE + 228, O702_BASE + 900, "somewhere"), mode: "stationary" as const },
		];
		expect(splitChangeoverWindows(segs, O702_FIXES)).toEqual(segs);
	});
});

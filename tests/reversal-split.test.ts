/**
 * splitReversingLegs — a vehicle leg that doubles back is two rides.
 *
 * You cannot ride one train out to a station and back again without getting off
 * it, so a single leg whose track reverses is a reconstruction error, not a
 * journey. Left alone it reaches the rail-run and journey-assembly passes as one
 * span, and every gate there legitimately passes (one line serves both
 * directions, the labels agree, no interchange walk), producing a leg that
 * boards and alights at the same station — the 2026-07-07 Wembley Park
 * turnaround.
 */

import { describe, expect, it } from "vitest";
import type { EnrichedSegment } from "../src/geo/enriched-segment.js";
import type { FilteredPoint } from "../src/geo/kalman.js";
import { splitReversingLegs } from "../src/geo/passes/reversal.js";

function fix(min: number, lat: number, lon: number, speed = 60): FilteredPoint {
	return { ts: min * 60, lat, lon, speed_kmh: speed, bearing: 0 };
}

function seg(startMin: number, endMin: number, extra: Partial<EnrichedSegment> = {}): EnrichedSegment {
	return {
		startTs: startMin * 60,
		endTs: endMin * 60,
		mode: "driving",
		refinedMode: "train",
		confidence: 0.9,
		confidenceMargin: 5,
		avgSpeed: 50,
		maxSpeed: 80,
		linearity: 0.9,
		pointCount: 20,
		...extra,
	};
}

/** Out along a line of longitude and back over the same ground. 0.01° ≈ 1113 m
 *  at the equator, so the excursion below reaches ~6.7 km. */
function outAndBack(speed = 60): FilteredPoint[] {
	const pts: FilteredPoint[] = [];
	for (let m = 0; m <= 10; m++) pts.push(fix(m, 0, (0.06 * m) / 10, speed));
	for (let m = 11; m <= 20; m++) pts.push(fix(m, 0, 0.06 - (0.06 * (m - 10)) / 10, speed));
	return pts;
}

describe("splitReversingLegs", () => {
	it("splits a vehicle leg at its turnaround", () => {
		const out = splitReversingLegs([seg(0, 20)], outAndBack());
		expect(out).toHaveLength(2);
		// The cut lands at the furthest point, which the track reaches at minute 10.
		expect(out[0].startTs).toBe(0);
		expect(out[0].endTs).toBe(10 * 60);
		expect(out[1].startTs).toBe(10 * 60);
		expect(out[1].endTs).toBe(20 * 60);
	});

	it("records why it split, so the leg's history explains itself", () => {
		const out = splitReversingLegs([seg(0, 20)], outAndBack());
		expect(out[0].refinedReason).toMatch(/reverse|turn|doubl/i);
	});

	it("leaves a one-way vehicle leg alone", () => {
		const pts: FilteredPoint[] = [];
		for (let m = 0; m <= 20; m++) pts.push(fix(m, 0, (0.06 * m) / 20));
		expect(splitReversingLegs([seg(0, 20)], pts)).toHaveLength(1);
	});

	it("leaves a walk that doubles back alone — only a RIDE cannot reverse", () => {
		// An out-and-back stroll is a perfectly ordinary single walk. The
		// constraint being enforced is about trains, so it is gated on a
		// motorised peak rather than applied to every doubling-back track.
		const walk = seg(0, 20, { mode: "walking", refinedMode: "walking", maxSpeed: 6, avgSpeed: 4 });
		expect(splitReversingLegs([walk], outAndBack(5))).toHaveLength(1);
	});

	it("is not fooled by a single far-flung GPS spike", () => {
		// One bad fix 8 km off the track would be the furthest point of the leg
		// and the track "returns" from it, but the approach and departure
		// directions do not oppose — it is noise, not a turnaround.
		const pts: FilteredPoint[] = [];
		for (let m = 0; m <= 20; m++) pts.push(fix(m, 0, (0.06 * m) / 20));
		pts[10] = fix(10, 0.07, 0.03); // a spike due north, mid-leg
		expect(splitReversingLegs([seg(0, 20)], pts)).toHaveLength(1);
	});

	it("leaves a short excursion alone — platform scatter is not a round trip", () => {
		const pts: FilteredPoint[] = [];
		for (let m = 0; m <= 10; m++) pts.push(fix(m, 0, (0.005 * m) / 10)); // ~550 m out
		for (let m = 11; m <= 20; m++) pts.push(fix(m, 0, 0.005 - (0.005 * (m - 10)) / 10));
		expect(splitReversingLegs([seg(0, 20)], pts)).toHaveLength(1);
	});

	it("passes stationary segments through untouched", () => {
		const stay = seg(0, 20, { mode: "stationary", refinedMode: undefined, maxSpeed: 0 });
		expect(splitReversingLegs([stay], outAndBack())).toHaveLength(1);
	});
});

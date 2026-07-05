import { describe, expect, it } from "vitest";
import type { KnownPlaceProjection } from "../src/geo/classification-inputs.js";
import { applyDwellContinuation } from "../src/geo/dwell-continuation.js";
import type { EnrichedSegment } from "../src/geo/enriched-segment.js";
import type { DayState } from "../src/sleep/day-state.js";

const H = 3600;
const DAY_END = 24 * H;
const HOME = { lat: 51.5699, lon: -0.2791 };
const FAR = { lat: 51.55, lon: -0.279 };

const homePlace: KnownPlaceProjection = {
	id: 1,
	centroidLat: HOME.lat,
	centroidLon: HOME.lon,
	radiusM: 60,
	displayName: "Home",
	sleepHours: 8,
	amenityLabel: null,
	uniqueDays: 90,
	hourProfile: null,
	totalDwellSec: 900 * H, // mean dwell τ = 10h over 90 visits
	visitCount: 90,
};

function staySeg(lat: number, lon: number): EnrichedSegment {
	return {
		startTs: 8 * H,
		endTs: 17 * H,
		mode: "stationary",
		confidence: 1,
		confidenceMargin: 10,
		avgSpeed: 0,
		maxSpeed: 1,
		linearity: 0,
		pointCount: 20,
		centroidLat: lat,
		centroidLon: lon,
	};
}

function homeStay(startTs: number, endTs: number): DayState {
	return { startTs, endTs, mode: "stationary", place: "Home" };
}

describe("applyDwellContinuation", () => {
	it("anchors on the latest-ending in-day stay, not the array's last element", () => {
		// The next night's sleep sits LAST in the array but starts after dayEnd;
		// the real trailing edge is the 17:36 daytime home stay.
		const states: DayState[] = [
			homeStay(8 * H, 17.6 * H),
			{ startTs: 25 * H, endTs: 32 * H, mode: "sleeping", place: "Home" }, // next-day bracket
		];
		const out = applyDwellContinuation({
			states,
			segments: [staySeg(HOME.lat, HOME.lon)],
			knownPlaces: [homePlace],
			dayEndTs: DAY_END,
		});
		expect(out).toHaveLength(3);
		// Continuation spliced right after the daytime stay (index 1).
		expect(out[1]).toMatchObject({
			startTs: 17.6 * H,
			endTs: DAY_END,
			mode: "stationary",
			place: "Home",
			inferred: true,
		});
		// The next-day sleep is untouched and still last.
		expect(out[2].mode).toBe("sleeping");
	});

	it("does not fill when the last stay binds to no known place", () => {
		const states = [homeStay(8 * H, 17.6 * H)];
		const out = applyDwellContinuation({
			states,
			segments: [staySeg(FAR.lat, FAR.lon)],
			knownPlaces: [homePlace],
			dayEndTs: DAY_END,
		});
		expect(out).toHaveLength(1);
	});

	it("no-ops when every state starts at/after the day end", () => {
		const states: DayState[] = [{ startTs: 25 * H, endTs: 32 * H, mode: "sleeping", place: "Home" }];
		const out = applyDwellContinuation({
			states,
			segments: [staySeg(HOME.lat, HOME.lon)],
			knownPlaces: [homePlace],
			dayEndTs: DAY_END,
		});
		expect(out).toHaveLength(1);
	});

	it("no-ops when an evening stay already reaches the day end", () => {
		const states = [homeStay(20 * H, DAY_END)];
		const out = applyDwellContinuation({
			states,
			segments: [staySeg(HOME.lat, HOME.lon)],
			knownPlaces: [homePlace],
			dayEndTs: DAY_END,
		});
		expect(out).toHaveLength(1);
	});
});

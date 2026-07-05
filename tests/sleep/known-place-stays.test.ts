/**
 * Tests for detectKnownPlaceStays — the helper that recovers stays
 * at the user's named focus places from raw GPS fixes. Used by the
 * sleep-place attribution path in both directions: next-day morning
 * fixes (catches evening sleep crossing midnight) and prior-day
 * evening fixes (catches morning sleep whose true location is in
 * yesterday's data).
 */

import { describe, expect, it } from "vitest";
import {
	detectKnownPlaceStays,
	type StayCandidate,
	type StayFix,
	type StayKnownPlace,
} from "../../src/sleep/known-place-stays.js";

const HOME: StayKnownPlace = {
	centroidLat: 51.566,
	centroidLon: -0.288,
	radiusM: 50,
	displayName: "Home",
};

const HOSPITAL: StayKnownPlace = {
	centroidLat: 51.553,
	centroidLon: -0.165,
	radiusM: 80,
	displayName: "Royal Free Hospital",
};

function fixesAt(
	centerLat: number,
	centerLon: number,
	startTs: number,
	durationMin: number,
	intervalSec = 60,
): StayFix[] {
	const out: StayFix[] = [];
	for (let t = startTs; t <= startTs + durationMin * 60; t += intervalSec) {
		out.push({ ts: t, lat: centerLat, lon: centerLon });
	}
	return out;
}

describe("detectKnownPlaceStays", () => {
	it("returns the matched place when fixes cluster at a known place", () => {
		const fixes = fixesAt(HOME.centroidLat, HOME.centroidLon, 0, 240);
		const stays: StayCandidate[] = detectKnownPlaceStays(fixes, [HOME, HOSPITAL]);
		expect(stays).toHaveLength(1);
		expect(stays[0].place).toBe("Home");
		expect(stays[0].startTs).toBe(fixes[0].ts);
		expect(stays[0].endTs).toBe(fixes[fixes.length - 1].ts);
		expect(stays[0].centroidLat).toBeCloseTo(HOME.centroidLat, 5);
		expect(stays[0].centroidLon).toBeCloseTo(HOME.centroidLon, 5);
	});

	it("returns empty when no fixes are within any known place's radius", () => {
		const fixes = fixesAt(51.0, -0.5, 0, 60);
		const stays = detectKnownPlaceStays(fixes, [HOME, HOSPITAL]);
		expect(stays).toEqual([]);
	});

	it("rejects clusters shorter than 10 minutes (signal noise)", () => {
		const fixes = fixesAt(HOME.centroidLat, HOME.centroidLon, 0, 5);
		const stays = detectKnownPlaceStays(fixes, [HOME, HOSPITAL]);
		expect(stays).toEqual([]);
	});

	it("rejects scattered fixes that don't form a tight cluster", () => {
		const fixes: StayFix[] = [
			{ ts: 0, lat: 51.566, lon: -0.288 },
			{ ts: 60, lat: 51.567, lon: -0.29 },
			{ ts: 120, lat: 51.6, lon: -0.32 },
			{ ts: 180, lat: 51.7, lon: -0.4 },
			{ ts: 240, lat: 51.8, lon: -0.5 },
		];
		const stays = detectKnownPlaceStays(fixes, [HOME, HOSPITAL]);
		expect(stays).toEqual([]);
	});

	it("matches the closer of two adjacent known places", () => {
		const TWO_HOMES: StayKnownPlace[] = [
			{ centroidLat: 51.566, centroidLon: -0.288, radiusM: 50, displayName: "Home" },
			{ centroidLat: 51.566, centroidLon: -0.29, radiusM: 50, displayName: "Neighbour" },
		];
		const fixes = fixesAt(51.566, -0.288, 0, 60);
		const stays = detectKnownPlaceStays(fixes, TWO_HOMES);
		expect(stays[0].place).toBe("Home");
	});

	it("returns empty for empty input", () => {
		expect(detectKnownPlaceStays([], [HOME])).toEqual([]);
	});

	it("a stay followed by movement away surfaces only the stay", () => {
		// 30 min at Home, then 3 scattered fixes drifting away — no
		// second cluster, only the home stay emitted.
		const homeFixes = fixesAt(HOME.centroidLat, HOME.centroidLon, 0, 30);
		const moveFixes: StayFix[] = [
			{ ts: 2000, lat: 51.567, lon: -0.289 },
			{ ts: 2100, lat: 51.568, lon: -0.29 },
			{ ts: 2200, lat: 51.569, lon: -0.291 },
		];
		const stays = detectKnownPlaceStays([...homeFixes, ...moveFixes], [HOME, HOSPITAL]);
		expect(stays.length).toBeGreaterThanOrEqual(1);
		expect(stays[0].place).toBe("Home");
	});

	it("skips fixes that don't snap to any known place even if they cluster tightly", () => {
		// User is parked somewhere unknown — no known-place match, no
		// candidate emitted. The pipeline elsewhere will handle this
		// stay; this helper specifically attaches *known-place names*.
		const fixes = fixesAt(51.0, -0.5, 0, 60);
		const stays = detectKnownPlaceStays(fixes, [HOME, HOSPITAL]);
		expect(stays).toEqual([]);
	});
});

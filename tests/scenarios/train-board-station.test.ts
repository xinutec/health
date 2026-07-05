/**
 * Scenario: a user walks past one or two stations on their way to a
 * further station, then boards. The boarding-station picker should
 * land at the station where the user actually stopped (the platform-
 * wait cluster), not at an earlier station they walked past.
 *
 * Shape:
 *   walking past STATION_A:  fixes at ~5–7 km/h
 *   walking through middle:  fixes at ~5 km/h
 *   approaching STATION_B:   fixes at ~5 km/h slowing
 *   waiting on platform B:   ~0.1–1 km/h cluster (4–6 fixes)
 *   train kicks in:          first fast fix at ~70 km/h
 *
 * Fix: the boarding chain must require near-stationary fixes
 * (< BOARDING_STILL_KMH ≈ 3 km/h) rather than the looser
 * PLATFORM_SLOW_KMH (8 km/h). The earliest chain member is then
 * within the actual platform-wait cluster, near STATION_B.
 */

import { describe, expect, it } from "vitest";
import { findBoardingPlatformFix } from "../../src/geo/passes/rail-runs.js";

// Synthetic anchor: middle-of-nowhere coordinates. Two stations
// laid out ~165 m apart along an east-west line so the geometry of
// "walked past A, boarded at B" is preserved without using a real
// location.
const STATION_A: [number, number] = [50.0, 5.0]; // walked past
const STATION_B: [number, number] = [50.0, 5.0024]; // actual boarding (~165 m east)

const boardTs = 1_700_000_000;

const fixes = [
	// 14 min before board: walking past STATION_A
	{ ts: boardTs - 14 * 60, lat: STATION_A[0] - 0.00006, lon: STATION_A[1] - 0.0001, speed_kmh: 5.8 },
	{ ts: boardTs - 13 * 60, lat: STATION_A[0] - 0.00003, lon: STATION_A[1] - 0.00005, speed_kmh: 5.2 },
	{ ts: boardTs - 12 * 60, lat: STATION_A[0], lon: STATION_A[1], speed_kmh: 6.3 }, // closest pass STATION_A
	{ ts: boardTs - 11 * 60, lat: STATION_A[0] + 0.00005, lon: STATION_A[1] + 0.0005, speed_kmh: 4.7 },
	// Walking eastward between stations
	{ ts: boardTs - 10 * 60, lat: STATION_A[0] + 0.00008, lon: STATION_A[1] + 0.001, speed_kmh: 5.0 },
	{ ts: boardTs - 9 * 60, lat: STATION_A[0] + 0.00012, lon: STATION_A[1] + 0.0015, speed_kmh: 5.3 },
	// Approaching STATION_B
	{ ts: boardTs - 8 * 60, lat: STATION_B[0] - 0.00005, lon: STATION_B[1] - 0.0002, speed_kmh: 4.6 },
	{ ts: boardTs - 7 * 60, lat: STATION_B[0], lon: STATION_B[1] - 0.00005, speed_kmh: 3.9 },
	// Slowing onto the platform
	{ ts: boardTs - 6 * 60, lat: STATION_B[0], lon: STATION_B[1], speed_kmh: 1.0 },
	{ ts: boardTs - 5 * 60, lat: STATION_B[0], lon: STATION_B[1], speed_kmh: 0.2 }, // stopped
	{ ts: boardTs - 4 * 60, lat: STATION_B[0], lon: STATION_B[1], speed_kmh: 0.1 }, // stopped
	{ ts: boardTs - 3 * 60, lat: STATION_B[0] - 0.00001, lon: STATION_B[1], speed_kmh: 2.5 }, // shuffling
	{ ts: boardTs - 2 * 60, lat: STATION_B[0], lon: STATION_B[1], speed_kmh: 0.1 }, // stopped
	{ ts: boardTs - 60, lat: STATION_B[0], lon: STATION_B[1], speed_kmh: 1.3 },
	// Train starts (decelerating cruise position; the absolute lat/lon
	// of the train fix doesn't matter — only that it's >= PLATFORM_TRAIN_KMH).
	{ ts: boardTs, lat: STATION_B[0] - 0.002, lon: STATION_B[1] - 0.008, speed_kmh: 69.9, bearing: 270 },
].map((p) => ({ ...p, bearing: p.bearing ?? 0 }));

function distMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(a));
}

describe("scenario: walking past one station to board at another", () => {
	it("returns a fix near STATION_B (the actual platform-wait cluster), not STATION_A", () => {
		const result = findBoardingPlatformFix(fixes, boardTs);
		expect(result).not.toBeNull();
		if (!result) return;

		const dA = distMeters(result.lat, result.lon, STATION_A[0], STATION_A[1]);
		const dB = distMeters(result.lat, result.lon, STATION_B[0], STATION_B[1]);
		expect(
			dB < dA,
			`expected boarding fix nearer STATION_B than STATION_A; got dA=${Math.round(dA)}m dB=${Math.round(dB)}m`,
		).toBe(true);
		// And tighter: the chosen fix should be on the platform-wait
		// cluster, i.e. within ~50 m of STATION_B.
		expect(dB).toBeLessThan(50);
	});
});

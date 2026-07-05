/**
 * Per-minute mode-class lock — universal physical facts used to
 * narrow the decoder's hypothesis space upstream of scoring.
 *
 * Three locks, all derived from sustained signal across a 5-minute
 * window so a single noisy minute doesn't flip the verdict:
 *
 *   - **"foot"**: the watch reports sustained cadence above the
 *     walking threshold. Feet are moving in the user's reference
 *     frame. The user cannot simultaneously be in a moving vehicle
 *     or stationary.
 *   - **"vehicle"**: GPS displacement across the window implies a
 *     speed above the walking ceiling, AND no sustained cadence.
 *     The user is moving but not on foot. (Could be train, drive,
 *     bike — the mode-class lock doesn't disambiguate within the
 *     class.)
 *   - **"stationary"**: GPS observations cluster tightly across
 *     the window AND there's no sustained cadence.
 *
 * Otherwise: null (the lock is silent and the scorer decides).
 *
 * These thresholds are universal human-physiology / GPS-noise
 * facts, not user-specific: a human cannot sustain > 12 km/h
 * walking; > 30 spm wrist cadence is sustained walking; an 80 m
 * cluster spread is within consumer-GPS noise for stationary
 * activity.
 */

import { describe, expect, it } from "vitest";
import { computeModeClassLocks } from "../src/hmm/mode-class-lock.js";
import type { Observation } from "../src/hmm/observation.js";

function obs(over: Partial<Observation>): Observation {
	return {
		ts: 1_700_000_000,
		gps: null,
		hr: null,
		cadence: null,
		hourLocal: 12,
		dayOfWeekLocal: 1,
		inBed: false,
		prevGpsFix: null,
		nextGpsFix: null,
		...over,
	};
}

const HOME = { lat: 51.5635, lon: -0.2796 };

function buildWalkSequence(t0: number, durationMin: number): Observation[] {
	// Walking westward at ~5 km/h with cadence 100 spm.
	const out: Observation[] = [];
	for (let i = 0; i < durationMin; i++) {
		out.push(
			obs({
				ts: t0 + i * 60,
				gps: {
					lat: HOME.lat + i * 0.0005, // ~55m per minute north
					lon: HOME.lon,
					speedKmh: 5,
				},
				cadence: 100,
			}),
		);
	}
	return out;
}

function buildTrainSequence(t0: number, durationMin: number, startLat: number, endLat: number): Observation[] {
	// Train westward at high speed, cadence 0.
	const out: Observation[] = [];
	for (let i = 0; i < durationMin; i++) {
		const frac = i / Math.max(1, durationMin - 1);
		out.push(
			obs({
				ts: t0 + i * 60,
				gps: {
					lat: startLat + frac * (endLat - startLat),
					lon: HOME.lon,
					speedKmh: 50,
				},
				cadence: 0,
			}),
		);
	}
	return out;
}

function buildStationarySequence(t0: number, durationMin: number): Observation[] {
	const out: Observation[] = [];
	for (let i = 0; i < durationMin; i++) {
		out.push(
			obs({
				ts: t0 + i * 60,
				gps: { lat: HOME.lat + (i % 2) * 1e-6, lon: HOME.lon + (i % 2) * 1e-6, speedKmh: 0 },
				cadence: 0,
			}),
		);
	}
	return out;
}

describe("computeModeClassLocks", () => {
	it("returns an empty array for empty input", () => {
		expect(computeModeClassLocks({ observations: [] })).toEqual([]);
	});

	it("locks a sustained walking window as 'foot'", () => {
		const seq = buildWalkSequence(1_700_000_000, 10);
		const locks = computeModeClassLocks({ observations: seq });
		// The first and last minute may be null (insufficient window),
		// but the centre minutes must be foot.
		for (let i = 2; i < 8; i++) expect(locks[i], `lock at index ${i}`).toBe("foot");
	});

	it("locks a sustained train window (GPS moving fast, cadence 0) as 'vehicle'", () => {
		// Ashvale to a point ~5km south, at train speed.
		const seq = buildTrainSequence(1_700_000_000, 10, 51.55, 51.5);
		const locks = computeModeClassLocks({ observations: seq });
		for (let i = 2; i < 8; i++) expect(locks[i], `lock at index ${i}`).toBe("vehicle");
	});

	it("locks a sustained stationary window (tight GPS cluster, cadence 0) as 'stationary'", () => {
		const seq = buildStationarySequence(1_700_000_000, 10);
		const locks = computeModeClassLocks({ observations: seq });
		for (let i = 2; i < 8; i++) expect(locks[i], `lock at index ${i}`).toBe("stationary");
	});

	it("returns null where the signal is ambiguous (no cadence, no GPS)", () => {
		const t0 = 1_700_000_000;
		const seq: Observation[] = [];
		for (let i = 0; i < 10; i++) {
			seq.push(obs({ ts: t0 + i * 60 })); // null cadence, null gps
		}
		const locks = computeModeClassLocks({ observations: seq });
		for (let i = 0; i < 10; i++) expect(locks[i]).toBeNull();
	});

	it("does not lock a single-minute high-cadence spike as 'foot' (window-aggregated, not minute-instant)", () => {
		// 9 minutes of stationary + 1 minute of cadence 100 in the middle.
		// The minute-instant has high cadence but it isn't sustained.
		const seq = buildStationarySequence(1_700_000_000, 10);
		seq[5] = { ...seq[5], cadence: 100 };
		const locks = computeModeClassLocks({ observations: seq });
		// Should NOT be foot at the centre — only one minute has high
		// cadence in the window.
		expect(locks[5]).not.toBe("foot");
	});

	it("vehicle lock is suppressed when cadence is high (cycling-with-cadence is rare; user is walking)", () => {
		// User moves at 12 km/h with cadence 100 — this is running, not
		// driving. Foot lock takes precedence.
		const t0 = 1_700_000_000;
		const seq: Observation[] = [];
		for (let i = 0; i < 10; i++) {
			seq.push(
				obs({
					ts: t0 + i * 60,
					gps: { lat: HOME.lat + i * 0.001, lon: HOME.lon, speedKmh: 12 },
					cadence: 100,
				}),
			);
		}
		const locks = computeModeClassLocks({ observations: seq });
		for (let i = 2; i < 8; i++) expect(locks[i]).toBe("foot");
	});

	it("vehicle lock fires when GPS displacement is fast AND cadence is null (no Fitbit data)", () => {
		// Underground tube ride: GPS observed only at the bookends,
		// cadence null throughout. The displacement implies vehicle
		// speed. prev/nextGpsFix is set on every interior minute
		// (the observation tensor builder does this automatically).
		const t0 = 1_700_000_000;
		const ashvaleFix = { ts: t0, lat: 51.56, lon: HOME.lon };
		const bakerFix = { ts: t0 + 9 * 60, lat: 51.52, lon: HOME.lon };
		const seq: Observation[] = [];
		seq.push(obs({ ts: t0, gps: { lat: 51.56, lon: HOME.lon, speedKmh: 0 }, cadence: 0 }));
		for (let i = 1; i < 9; i++) {
			seq.push(obs({ ts: t0 + i * 60, prevGpsFix: ashvaleFix, nextGpsFix: bakerFix }));
		}
		seq.push(obs({ ts: t0 + 9 * 60, gps: { lat: 51.52, lon: HOME.lon, speedKmh: 0 }, cadence: 0 }));
		const locks = computeModeClassLocks({ observations: seq });
		const interiorVehicle = locks.slice(3, 7).some((l) => l === "vehicle");
		expect(interiorVehicle).toBe(true);
	});
});

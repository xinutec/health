/**
 * Scenario: a train ride where the watch picks up vehicle vibration as
 * step counts. Reproduces the bug shipped to prod on 2026-05-14 with the
 * initial cadence-veto deploy:
 *
 *   18:43-18:49 cycling (was driving) avg:108.1km/h max:120.6km/h
 *               [re-classified as cycling by biometric signature]
 *
 * Root cause: the cadence-veto was firing on any low-cadence-mode segment
 * (cycling, driving, train) whose observed cadence exceeded the floor.
 * Mid-train, watch vibration produced cadence > 30 spm, and the
 * alternative-picker chose cycling because every other low-cadence mode
 * also fails at 108 km/h speeds. The fix is a speed gate: don't fire the
 * cadence-veto when speed is too high for walking to be a plausible
 * alternative.
 *
 * This test pipes a synthetic train day through `classifySegments` and
 * `correctModeBySignature`. It MUST stay green — a cycling segment at
 * 100+ km/h is the bug class we're locking down.
 */

import { describe, expect, it } from "vitest";
import { cadenceForSegment, enrichSegmentWithBiometrics } from "../../src/geo/biometrics.js";
import { filterGpsTrack } from "../../src/geo/kalman.js";
import { correctModeBySignature, type ModeStats } from "../../src/geo/mode-biometrics.js";
import { classifySegments } from "../../src/geo/segments.js";
import { moveBearing, synthDay } from "./synth-day.js";

/** Per-user mode-biometric signatures (cf. tests/mode-biometrics.test.ts).
 *  Same fixture as the unit tests — keeps test data centralised mentally. */
const PIPPIJN_STATS: ModeStats[] = [
	{
		mode: "stationary",
		hrMean: 68.5,
		hrStd: 12.3,
		hrSampleCount: 50000,
		cadenceMean: 0,
		cadenceStd: 0.4,
		cadenceSampleCount: 50000,
		speedMean: 0.3,
		speedStd: 0.3,
		speedSampleCount: 50000,
		sampleCount: 51693,
	},
	{
		mode: "walking",
		hrMean: 108,
		hrStd: 14,
		hrSampleCount: 9000,
		cadenceMean: 107,
		cadenceStd: 11,
		cadenceSampleCount: 10000,
		speedMean: 5.1,
		speedStd: 1.1,
		speedSampleCount: 10000,
		sampleCount: 10034,
	},
	{
		mode: "driving",
		hrMean: 75,
		hrStd: 8,
		hrSampleCount: 4000,
		cadenceMean: 0,
		cadenceStd: 0.5,
		cadenceSampleCount: 4274,
		speedMean: 52,
		speedStd: 15,
		speedSampleCount: 4274,
		sampleCount: 4274,
	},
	{
		mode: "cycling",
		hrMean: 107,
		hrStd: 6,
		hrSampleCount: 60,
		cadenceMean: 0,
		cadenceStd: 0.8,
		cadenceSampleCount: 60,
		speedMean: 17.5,
		speedStd: 3.3,
		speedSampleCount: 60,
		sampleCount: 60,
	},
	{
		mode: "train",
		hrMean: 74,
		hrStd: 9,
		hrSampleCount: 4000,
		cadenceMean: 0,
		cadenceStd: 0.4,
		cadenceSampleCount: 4052,
		speedMean: 100,
		speedStd: 30,
		speedSampleCount: 4052,
		sampleCount: 4052,
	},
];

describe("scenario: train with watch-vibration cadence", () => {
	// Three legs:
	//   - 10 min walk to the station (HR ~95, cadence ~95)
	//   - 80 min train at ~100 km/h (HR ~80, but cadence 50 — vibration noise)
	//   - 10 min walk from the station (HR ~95, cadence ~95)
	const startTs = 1_700_000_000;
	const origin: [number, number] = [50.0, 5.0];
	const destination: [number, number] = [50.0, 6.5]; // ~107 km east

	const day = synthDay(startTs, [
		// Walk east at 5 km/h to the station.
		moveBearing({
			durationSec: 10 * 60,
			from: origin,
			speedKmh: 5,
			headingDeg: 90,
			hr: 95,
			cadence: 95,
		}),
		// Train: 80 min at ~100 km/h between origin and destination.
		// The exact path doesn't matter — what matters is the
		// sustained ~100 km/h speed and the vibration-cadence signal.
		{
			kind: "move",
			durationSec: 80 * 60,
			from: [origin[0], origin[1] + 0.005], // station, ~500m east of start
			to: destination,
			speedKmh: 100,
			hr: 80,
			cadence: 50, // **vibration registered as steps**
		},
		// Walk east at 5 km/h from destination.
		moveBearing({
			durationSec: 10 * 60,
			from: destination,
			speedKmh: 5,
			headingDeg: 90,
			hr: 95,
			cadence: 95,
		}),
	]);

	it("classifies the train leg as train, never as cycling at 100+ km/h", () => {
		const filtered = filterGpsTrack(day.points);
		const stayPoints = day.points.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon }));
		const segments = classifySegments(filtered, stayPoints);

		// Apply the same mode-correction pass the live pipeline does.
		const corrected = segments.map((seg) => {
			const bio = enrichSegmentWithBiometrics(seg, day.hr, day.sleep, day.steps);
			const cadence = cadenceForSegment(seg, day.steps);
			const result = correctModeBySignature(
				{
					mode: seg.mode,
					confidenceMargin: seg.confidenceMargin,
					obsHr: bio.hrMean,
					obsCadence: cadence,
					obsSpeed: seg.avgSpeed,
				},
				PIPPIJN_STATS,
			);
			return { ...seg, mode: result.mode as typeof seg.mode };
		});

		// The headline assertion: nothing at 100+ km/h is labelled cycling.
		// Cycling above ~30 km/h is biomechanically implausible regardless
		// of cadence noise.
		const fastCycling = corrected.filter((s) => s.mode === "cycling" && s.avgSpeed > 30);
		expect(fastCycling, `unexpected fast 'cycling' segments: ${JSON.stringify(fastCycling)}`).toHaveLength(0);

		// And: there should be at least one real train segment.
		const trainSegs = corrected.filter((s) => s.mode === "train");
		expect(trainSegs.length).toBeGreaterThan(0);
	});

	it("classifies the walking legs as walking (sanity-check the synth-day shape)", () => {
		const filtered = filterGpsTrack(day.points);
		const stayPoints = day.points.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon }));
		const segments = classifySegments(filtered, stayPoints);

		// First and last segments should be walking-paced.
		const walkingPaced = segments.filter((s) => s.avgSpeed >= 3 && s.avgSpeed <= 7);
		expect(walkingPaced.length).toBeGreaterThanOrEqual(2);
	});
});

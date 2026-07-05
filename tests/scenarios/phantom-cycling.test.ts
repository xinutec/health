/**
 * Scenario: a walk at moderate cadence + walking-borderline HR gets
 * classified as cycling because the per-window features (linearity,
 * heading-change-rate, speed) sit near the cycling/walking boundary
 * AND the HR is too close to cycling's mean for the HR-veto to fire.
 *
 * Reproduces the production bug pattern that motivated the cadence-veto:
 *   a walking segment with HR 97, cadence 80 spm, speed 5.7 km/h →
 *   labelled cycling at confidenceMargin 11.3. The cadence-veto must
 *   demote this to walking.
 *
 * Subsumes the prior unit-level pin in mode-biometrics.test.ts (which
 * hardcoded the exact confidenceMargin/HR/cadence trio). This test is
 * stronger — it drives the values through `classifySegments` from
 * realistic synthetic GPS, so the assertion catches changes to the
 * upstream classifier shape too.
 */

import { describe, expect, it } from "vitest";
import { cadenceForSegment, enrichSegmentWithBiometrics } from "../../src/geo/biometrics.js";
import { filterGpsTrack } from "../../src/geo/kalman.js";
import { correctModeBySignature, type ModeStats } from "../../src/geo/mode-biometrics.js";
import { classifySegments } from "../../src/geo/segments.js";
import { moveBearing, synthDay } from "./synth-day.js";

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
];

describe("scenario: walk with cycling-borderline HR + walking cadence", () => {
	// 20 minutes of walking at 5.7 km/h with HR 97 (cycling's veto floor is
	// 107 - 2*6 = 95, so HR 97 just-survives the HR-veto). Cadence 80 spm
	// is walking-band; the cadence-veto must catch it.
	const day = synthDay(1_700_000_000, [
		moveBearing({
			durationSec: 20 * 60,
			from: [50.0, 5.0],
			speedKmh: 5.7,
			headingDeg: 60,
			hr: 97,
			cadence: 80,
		}),
	]);

	it("ends up labelled walking after the biometric-correction pass", () => {
		const filtered = filterGpsTrack(day.points);
		const stayPoints = day.points.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon }));
		const segments = classifySegments(filtered, stayPoints);

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

		// No segment should be labelled cycling — this is a 20-min walk.
		const cyclingSegs = corrected.filter((s) => s.mode === "cycling");
		expect(cyclingSegs, `unexpected cycling segments: ${JSON.stringify(cyclingSegs)}`).toHaveLength(0);

		// At least one walking segment must survive.
		const walkingSegs = corrected.filter((s) => s.mode === "walking");
		expect(walkingSegs.length).toBeGreaterThan(0);
	});
});

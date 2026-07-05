/**
 * Scenario: a brief platform interchange at a station between two train
 * legs. The rail-run absorption logic should swallow the interchange as
 * part of the merged train journey.
 *
 * Reproduces the April 29 production case (interchange station, names
 * anonymised) where the live data was:
 *   - 81-min train arriving at the interchange
 *   - 5-min dwell labelled "driving (was walking)": avg 4.7 km/h,
 *     max 87.8 km/h, refinedReason "low cadence (1/min)"
 *   - 10-min train departing to the next destination
 *
 * The interesting feature of the real data: only 7 GPS fixes in 5 min
 * (sparse), with multiple Kalman-amplified speed spikes producing
 * 2.8 km of apparent path even though the user physically walked
 * ~50 m platform-to-platform. The pipeline can't reliably use GPS
 * geometry to confirm "this is a dwell"; the load-bearing signal is
 * duration + rail-like bookends.
 */

import { describe, expect, it } from "vitest";
import type { FilteredPoint } from "../../src/geo/kalman.js";
import type { NearbyStation } from "../../src/geo/osm.js";
import { annotateRailRuns } from "../../src/geo/passes/rail-runs.js";
import type { EnrichedSegment } from "../../src/geo/velocity.js";
import { tsAt } from "./synth-day.js";

// Anonymised interchange-station coordinates (anywhere in Europe; the
// actual lat/lon don't matter for the absorption decision).
const interchange: [number, number] = [50.0, 5.0];

/** Build a realistic-shape platform-interchange GPS sequence: sparse
 *  fixes (one every ~40 s instead of every 10 s — typical for a watch
 *  losing lock under a station roof), with Kalman-amplified speed
 *  spikes scattered through. The aggregate apparent path is hundreds
 *  of metres, even though the user physically walked ~50 m. Matches
 *  the prod April-29 shape probed against the live data. */
function realisticPlatformInterchangeFixes(startTs: number, center: [number, number]): FilteredPoint[] {
	const latDegPerMeter = 1 / 111000;
	const lonDegPerMeter = 1 / (111000 * Math.cos((center[0] * Math.PI) / 180));
	// Offsets (in metres) sampled to roughly match the prod fix sequence:
	// some clustered, one big outlier, sparse temporal coverage.
	const fixes: Array<{ ts: number; dLatM: number; dLonM: number; speed: number }> = [
		{ ts: startTs + 5, dLatM: 0, dLonM: 0, speed: 4.5 },
		{ ts: startTs + 48, dLatM: 30, dLonM: -10, speed: 5.1 },
		{ ts: startTs + 90, dLatM: 250, dLonM: 80, speed: 87.8 }, // spike
		{ ts: startTs + 135, dLatM: 60, dLonM: 0, speed: 4.0 },
		{ ts: startTs + 180, dLatM: -120, dLonM: 220, speed: 32.1 }, // spike
		{ ts: startTs + 240, dLatM: 40, dLonM: 20, speed: 4.8 },
		{ ts: startTs + 295, dLatM: 30, dLonM: 35, speed: 5.2 },
	];
	return fixes.map((f) => ({
		ts: f.ts,
		lat: center[0] + f.dLatM * latDegPerMeter,
		lon: center[1] + f.dLonM * lonDegPerMeter,
		speed_kmh: f.speed,
		bearing: 0,
	}));
}

/** Stationary fixes near a centre for the surrounding train segments —
 *  enough to satisfy any downstream code that scans `points` by ts. */
function trainPathFixes(startTs: number, durationSec: number, center: [number, number]): FilteredPoint[] {
	const out: FilteredPoint[] = [];
	for (let dt = 0; dt < durationSec; dt += 30) {
		out.push({ ts: startTs + dt, lat: center[0], lon: center[1], speed_kmh: 100, bearing: 0 });
	}
	return out;
}

const stationLookup = async (_lat: number, _lon: number): Promise<NearbyStation[]> => [
	{ name: "Interchange Central", subtype: "rail", distanceM: 50 },
];
const lineLookup = async (): Promise<Set<string>> => new Set<string>();

describe("scenario: station dwell with a single GPS-spike outlier", () => {
	const trainBefore: EnrichedSegment = {
		startTs: tsAt("2026-04-29T16:09:00Z"),
		endTs: tsAt("2026-04-29T17:30:00Z"),
		mode: "train",
		confidence: 0.98,
		confidenceMargin: 50,
		avgSpeed: 100,
		maxSpeed: 140,
		linearity: 0.88,
		pointCount: 500,
	};
	const dwellStart = tsAt("2026-04-29T17:32:00Z");
	const dwellEnd = tsAt("2026-04-29T17:37:00Z");
	const dwell: EnrichedSegment = {
		startTs: dwellStart,
		endTs: dwellEnd,
		mode: "driving", // post-correction label, matches the prod output
		refinedMode: "driving",
		refinedReason: "low cadence (1/min)",
		confidence: 0.84,
		confidenceMargin: 5.3,
		avgSpeed: 4.7,
		maxSpeed: 87.8,
		linearity: 0.93,
		pointCount: 30,
	};
	const trainAfter: EnrichedSegment = {
		startTs: tsAt("2026-04-29T17:38:00Z"),
		endTs: tsAt("2026-04-29T17:47:00Z"),
		mode: "train",
		confidence: 0.89,
		confidenceMargin: 50,
		avgSpeed: 107,
		maxSpeed: 142,
		linearity: 0.95,
		pointCount: 80,
	};

	// Dwell points: prod-shape — 7 sparse fixes spanning 5 min with
	// multiple Kalman speed spikes. Apparent path is hundreds of metres
	// even though the user physically walked ~50 m.
	const dwellPoints = realisticPlatformInterchangeFixes(dwellStart, interchange);
	const trainBeforePoints = trainPathFixes(trainBefore.startTs, trainBefore.endTs - trainBefore.startTs, interchange);
	const trainAfterPoints = trainPathFixes(trainAfter.startTs, trainAfter.endTs - trainAfter.startTs, interchange);
	const allPoints = [...trainBeforePoints, ...dwellPoints, ...trainAfterPoints];

	it("absorbs the prod-shape dwell (sparse fixes, multi-spike, ~2.8km apparent path)", async () => {
		const result = await annotateRailRuns([trainBefore, dwell, trainAfter], allPoints, stationLookup, lineLookup);

		// The whole journey should collapse to one merged-rail-run segment.
		expect(
			result,
			`expected 1 merged segment, got ${result.length}: ${JSON.stringify(result.map((s) => s.mode))}`,
		).toHaveLength(1);
		expect(result[0].mode).toBe("train");
		expect(result[0].refinedReason).toMatch(/merged rail run/);
		expect(result[0].startTs).toBe(trainBefore.startTs);
		expect(result[0].endTs).toBe(trainAfter.endTs);
	});

	it("does NOT absorb a long off-route segment between trains (e.g. went home, came back)", async () => {
		// Negative control: a much longer duration between trains is a
		// real activity (coffee, meeting, going home). The ≤5-min cap
		// blocks absorption.
		const longDwell: EnrichedSegment = { ...dwell, endTs: dwellStart + 30 * 60 }; // 30 min
		const longFixes = trainPathFixes(dwellStart, 30 * 60, interchange);
		const result = await annotateRailRuns(
			[trainBefore, longDwell, trainAfter],
			[...trainBeforePoints, ...longFixes, ...trainAfterPoints],
			stationLookup,
			lineLookup,
		);
		expect(result.length).toBeGreaterThanOrEqual(2);
	});
});

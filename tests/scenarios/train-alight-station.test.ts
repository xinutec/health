/**
 * Scenario: a tube ride where the segment classifier ends the train
 * segment too early — at a brief Kalman-detected stop mid-ride —
 * causing the alighting-station picker to label the segment with the
 * mid-ride station instead of the user's actual disembarking station.
 *
 * Reproduces today's production case (anonymised, but the geometry
 * matches): user took the tube from station A to station E. The
 * classifier ended the train segment at station C (a brief 1-minute
 * dwell mid-ride looked like the end). The alighting-station picker
 * found the first slow fix after that endTs — landing at station C —
 * and labelled the segment "A -> C" even though the train continued
 * for another 3 km to station E.
 *
 * The realistic fix-data sample (from prod):
 *   - cruise speeds 30-87 km/h
 *   - brief stop at (mid-ride station) — speed drops to 2.6 km/h
 *   - cruise resumes (52, 59 km/h)
 *   - another brief stop — speed 1.1 km/h
 *   - cruise again
 *   - final stop at (actual disembark) — walking pace
 *
 * Behaviour under test: the post-train fix sequence should be parsed
 * such that intermittent stops are recognised as mid-ride dwells (not
 * the final alight), and the labelled alight station is the one
 * where the user actually starts walking away from the rail line.
 */

import { describe, expect, it } from "vitest";
import type { FilteredPoint } from "../../src/geo/kalman.js";
import type { NearbyStation } from "../../src/geo/osm.js";
import { annotateRailRuns } from "../../src/geo/passes/rail-runs.js";
import type { EnrichedSegment } from "../../src/geo/velocity.js";
import { tsAt } from "./synth-day.js";

// Anonymised coordinates. Three stations along an east–west line:
//   STATION_A — boarding (far west)
//   STATION_C — intermediate, where the classifier prematurely ends
//                the train segment
//   STATION_E — final alight (the user's actual destination)
const STATION_A: [number, number] = [50.0, 5.0];
const STATION_C: [number, number] = [50.0, 5.1];
const STATION_E: [number, number] = [50.0, 5.2];

const stationLookup = async (lat: number, lon: number): Promise<NearbyStation[]> => {
	const dist = ([sLat, sLon]: [number, number]) =>
		Math.hypot((lat - sLat) * 111000, (lon - sLon) * 111000 * Math.cos((lat * Math.PI) / 180));
	const candidates: { coord: [number, number]; name: string }[] = [
		{ coord: STATION_A, name: "Station A" },
		{ coord: STATION_C, name: "Station C" },
		{ coord: STATION_E, name: "Station E" },
	];
	return candidates
		.map((c) => ({ name: c.name, subtype: "subway", distanceM: dist(c.coord) }))
		.filter((s) => s.distanceM < 500)
		.sort((a, b) => a.distanceM - b.distanceM);
};
const lineLookup = async (): Promise<Set<string>> => new Set<string>();

describe("scenario: train segment ends prematurely at a mid-ride dwell", () => {
	const boardTs = tsAt("2026-05-14T17:56:00Z");
	// Classifier's reported end (prematurely at Station C):
	const classifierEndTs = tsAt("2026-05-14T18:11:00Z");

	const train: EnrichedSegment = {
		startTs: boardTs,
		endTs: classifierEndTs,
		mode: "train",
		refinedMode: "train",
		confidence: 0.92,
		confidenceMargin: 50,
		avgSpeed: 44.3,
		maxSpeed: 87.9,
		linearity: 0.92,
		pointCount: 100,
	};

	// Fix sequence matches today's prod shape. After the (premature)
	// segment-end at classifierEndTs the data shows:
	//   - decelerating into Station C (still > 5 km/h)
	//   - stopped at Station C (< 5 km/h)  ← what current code picks
	//   - accelerating away from Station C (train continues)
	//   - approaching Station E (decelerating)
	//   - stopped at Station E  ← actual user disembark
	//   - walking away from Station E (this is the real "user got off"
	//     signal that the picker should hit)
	const points: FilteredPoint[] = [
		// Boarding fix (at Station A)
		{ ts: boardTs, lat: STATION_A[0], lon: STATION_A[1], speed_kmh: 5, bearing: 90 },
		// Cruise (sampled)
		{ ts: boardTs + 300, lat: 50.0, lon: 5.05, speed_kmh: 60, bearing: 90 },
		// Decelerating into Station C — still mid-ride
		{ ts: classifierEndTs + 20, lat: STATION_C[0], lon: STATION_C[1] - 0.0001, speed_kmh: 5.4, bearing: 90 },
		// Stopped briefly at Station C
		{ ts: classifierEndTs + 35, lat: STATION_C[0], lon: STATION_C[1], speed_kmh: 1.1, bearing: 90 },
		// Train continues — accelerating away from Station C
		{ ts: classifierEndTs + 80, lat: 50.0, lon: 5.15, speed_kmh: 60, bearing: 90 },
		// Decelerating into Station E (actual alight)
		{ ts: classifierEndTs + 130, lat: STATION_E[0], lon: STATION_E[1] - 0.0005, speed_kmh: 20, bearing: 90 },
		{ ts: classifierEndTs + 170, lat: STATION_E[0], lon: STATION_E[1], speed_kmh: 4.5, bearing: 0 },
		// User walks away from Station E
		{ ts: classifierEndTs + 240, lat: STATION_E[0] + 0.0003, lon: STATION_E[1] + 0.0003, speed_kmh: 4.5, bearing: 30 },
		{ ts: classifierEndTs + 300, lat: STATION_E[0] + 0.0006, lon: STATION_E[1] + 0.0006, speed_kmh: 4.8, bearing: 30 },
	];

	it("labels the alight station as the user's actual disembark, not the mid-ride dwell", async () => {
		const result = await annotateRailRuns([train], points, stationLookup, lineLookup);
		expect(result).toHaveLength(1);
		// The label format is "Boarding → Alight". Whatever the boarding
		// station picked, the alight must be the actual disembark
		// (Station E), not the mid-ride brief stop (Station C).
		expect(result[0].wayName, `expected alight = Station E, got wayName = ${result[0].wayName}`).toMatch(
			/(→|->) Station E$/,
		);
	});
});

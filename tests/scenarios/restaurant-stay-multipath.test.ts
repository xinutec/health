/**
 * Scenario: a continuous stay at a single place gets split into two
 * stays + a phantom "walking" segment when GPS multipath produces
 * an outlier mid-stay. The user never left the table.
 *
 * Reproduces today's production case (location anonymised): the
 * pipeline produced
 *   stationary @ Place X (20 min)
 *   walking on Some Street (5 min, "re-classified by biometric signature")
 *   stationary @ Place X (47 min)
 * where the user reported a single 72-min stay with no walk-out-and-back.
 *
 * The realistic fix-data sample (probed live from prod):
 *   - 20+ fixes clustered at the table centroid, speeds 0.0-1.3 km/h
 *   - 1-2 multipath spikes: one fix ~70 m N of centroid at 5.6 km/h,
 *     another fix ~40 m E of centroid at 5.8 km/h, both followed by
 *     a snap back to the table
 *   - Rest of fixes back at the table
 *
 * `classifySegments` reads "movement" from the spikes and emits a
 * walking segment between two stays. `mergeAdjacentStays` currently
 * only collapses DIRECTLY-adjacent stays at the same place — it
 * doesn't bridge a brief intervening segment.
 */

import { describe, expect, it } from "vitest";
import { mergeAdjacentStays } from "../../src/geo/passes/stays.js";
import type { EnrichedSegment } from "../../src/geo/velocity.js";
import { tsAt } from "./synth-day.js";

const PLACE = "Place X";
const stayStart = tsAt("2026-05-14T18:27:00Z");

const firstStay: EnrichedSegment = {
	startTs: stayStart,
	endTs: tsAt("2026-05-14T18:47:00Z"),
	mode: "stationary",
	confidence: 0.97,
	confidenceMargin: 1000,
	avgSpeed: 0.6,
	maxSpeed: 6.9,
	linearity: 0.19,
	pointCount: 20,
	place: PLACE,
};

// The phantom-walking segment between the two stays. Shape matches
// prod: short duration, low average speed (multipath-driven), labelled
// walking only because biometric correction re-classified it (its
// initial label was something else like driving).
const phantomWalk: EnrichedSegment = {
	startTs: tsAt("2026-05-14T18:48:00Z"),
	endTs: tsAt("2026-05-14T18:53:00Z"),
	mode: "walking",
	refinedMode: "walking",
	refinedReason: "re-classified as walking by biometric signature",
	confidence: 0.52,
	confidenceMargin: 1.1,
	avgSpeed: 0.7,
	maxSpeed: 5.6,
	linearity: 0.29,
	pointCount: 5,
	wayName: "Some Street",
};

const secondStay: EnrichedSegment = {
	startTs: tsAt("2026-05-14T18:53:00Z"),
	endTs: tsAt("2026-05-14T19:40:00Z"),
	mode: "stationary",
	confidence: 0.94,
	confidenceMargin: 1000,
	avgSpeed: 0.4,
	maxSpeed: 5.8,
	linearity: 0.21,
	pointCount: 47,
	place: PLACE,
};

describe("scenario: continuous stay split by GPS multipath spike", () => {
	it("collapses the two same-place stays + brief intervening segment into one stay", () => {
		const result = mergeAdjacentStays([firstStay, phantomWalk, secondStay]);

		expect(
			result,
			`expected 1 merged stay, got ${result.length}: ${JSON.stringify(result.map((s) => `${s.mode}@${s.place ?? "?"}`))}`,
		).toHaveLength(1);
		expect(result[0].mode).toBe("stationary");
		expect(result[0].place).toBe(PLACE);
		expect(result[0].startTs).toBe(firstStay.startTs);
		expect(result[0].endTs).toBe(secondStay.endTs);
	});

	it("does NOT collapse stays separated by a real walk to a different place", () => {
		// Negative control: a real walk between two different-place stays
		// (e.g. cafe → walk → restaurant). Must stay as three segments.
		const realWalk: EnrichedSegment = {
			startTs: tsAt("2026-05-14T18:48:00Z"),
			endTs: tsAt("2026-05-14T18:58:00Z"), // 10 min — real walk
			mode: "walking",
			confidence: 0.85,
			confidenceMargin: 9,
			avgSpeed: 5.2,
			maxSpeed: 7.1,
			linearity: 0.7,
			pointCount: 20,
			wayName: "Some Street",
		};
		const differentPlace: EnrichedSegment = { ...secondStay, place: "Place Y" };
		const result = mergeAdjacentStays([firstStay, realWalk, differentPlace]);
		expect(result.length).toBeGreaterThan(1);
	});

	it("does NOT collapse stays separated by a long intervening segment", () => {
		// Negative control: if you left a restaurant for an hour and came
		// back, those ARE two distinct stays — even at the same place.
		const longGap: EnrichedSegment = {
			...phantomWalk,
			endTs: phantomWalk.startTs + 60 * 60, // 1 h
		};
		const result = mergeAdjacentStays([firstStay, longGap, secondStay]);
		expect(result.length).toBeGreaterThan(1);
	});

	it("does NOT swallow a stepping errand: sustained cadence in the middle is a real excursion, not multipath", () => {
		// The errand class: a ~10-min walk to an adjacent building and into a
		// shop. Most of the errand is BROWSING, so the median per-fix speed
		// sits under the 2 km/h phantom ceiling — but the step counter shows
		// sustained walking cadence the whole window. A multipath phantom
		// happens while the user SITS: its step evidence is fidget-level.
		// Steps are the only direct movement evidence (module header); the
		// bridge must consult them before erasing a leg.
		const errandWalk: EnrichedSegment = {
			...phantomWalk,
			endTs: phantomWalk.startTs + 10 * 60, // right at the bridge duration cap
			avgSpeed: 0.9, // browse-heavy: median fix speed reads sub-walking
			pointCount: 40,
		};
		const steps = Array.from({ length: 10 }, (_, i) => ({
			ts: errandWalk.startTs + i * 60,
			steps: 55 + (i % 3) * 10, // sustained 55-75/min — unambiguous walking
		}));
		const result = mergeAdjacentStays([firstStay, errandWalk, secondStay], steps);
		expect(
			result.map((s) => s.mode),
			"a sustained-cadence middle must survive the phantom bridge",
		).toContain("walking");
	});

	it("still bridges the multipath phantom when the step stream shows only fidget-level activity", () => {
		// Same shape as the phantom, with the step context present: a couple
		// of fidget spikes while sitting must not block the bridge.
		const steps = [
			{ ts: phantomWalk.startTs + 60, steps: 12 },
			{ ts: phantomWalk.startTs + 200, steps: 25 },
		];
		const result = mergeAdjacentStays([firstStay, phantomWalk, secondStay], steps);
		expect(result).toHaveLength(1);
		expect(result[0].mode).toBe("stationary");
	});
});

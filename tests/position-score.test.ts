/**
 * Position eval scorer tests (Phase 0 of map-constrained positioning).
 *
 * The scorer is the source-of-truth test for *where the line is drawn* — so
 * it itself must be trustworthy. These synthetic cases pin the two metrics
 * and the exact failure mode that motivated the whole effort: the ±80 m
 * Kalman swing must register as a large cross-track, and a faithful track
 * must register as ~zero.
 */

import { describe, expect, it } from "vitest";
import {
	distStats,
	distToPolyline,
	reliableReference,
	type ScoredFix,
	scorePositioning,
} from "../src/eval/position-score.js";
import type { RoadGeometry } from "../src/geo/road-match.js";

/** A straight E–W road along lat 51.5600, lon −0.290 → −0.280. */
const ROAD: RoadGeometry = {
	ways: [
		{
			osmId: 1,
			name: "Larch Rise",
			subtype: "residential",
			coords: [
				[51.56, -0.29],
				[51.56, -0.28],
			],
		},
	],
};

function fixes(rows: Array<[number, number, number, number]>): ScoredFix[] {
	return rows.map(([ts, lat, lon, accuracy]) => ({ ts, lat, lon, accuracy }));
}

describe("distStats", () => {
	it("summarises a distance set", () => {
		const s = distStats([0, 10, 20, 30, 100]);
		expect(s.n).toBe(5);
		expect(s.median).toBe(20);
		expect(s.max).toBe(100);
		expect(s.mean).toBeCloseTo(32, 0);
	});
	it("is all-zero for empty", () => {
		expect(distStats([])).toEqual({ n: 0, median: 0, p90: 0, max: 0, mean: 0 });
	});
});

describe("reliableReference", () => {
	it("keeps only good-accuracy fixes, time-ordered", () => {
		const ref = reliableReference(
			fixes([
				[30, 51.56, -0.289, 10],
				[10, 51.56, -0.287, 8],
				[20, 51.56, -0.288, 80], // dropped: ±80 m
			]),
			30,
		);
		expect(ref).toHaveLength(2);
		expect(ref[0].lon).toBeCloseTo(-0.287, 5); // ts=10 first
		expect(ref[1].lon).toBeCloseTo(-0.289, 5); // ts=30 next
	});
});

describe("distToPolyline", () => {
	it("is the perpendicular distance to the nearest segment", () => {
		const poly = [
			{ lat: 51.56, lon: -0.29 },
			{ lat: 51.56, lon: -0.28 },
		];
		// ~22 m north of the line.
		expect(distToPolyline({ lat: 51.5602, lon: -0.285 }, poly)).toBeGreaterThan(18);
		expect(distToPolyline({ lat: 51.5602, lon: -0.285 }, poly)).toBeLessThan(26);
	});
});

describe("scorePositioning", () => {
	const goodFixes = fixes([
		[10, 51.56, -0.289, 10],
		[20, 51.56, -0.287, 9],
		[30, 51.56, -0.285, 8],
		[40, 51.56, -0.283, 10],
		[50, 51.56, -0.281, 7],
	]);

	it("scores a faithful on-road track ~zero on both metrics", () => {
		// Drawn line sits right on the road / reliable fixes.
		const drawn = [
			{ lat: 51.56, lon: -0.288 },
			{ lat: 51.56, lon: -0.284 },
			{ lat: 51.56, lon: -0.282 },
		];
		const s = scorePositioning(drawn, goodFixes, ROAD);
		expect(s.crossTrack.max).toBeLessThan(5);
		expect(s.onRoad.max).toBeLessThan(5);
	});

	it("flags an ±80 m smoothing swing as a large cross-track", () => {
		// One drawn vertex pushed ~80 m off the reliable track (the Kalman
		// failure), the rest faithful.
		const drawn = [
			{ lat: 51.56, lon: -0.288 },
			{ lat: 51.5607, lon: -0.286 }, // ~78 m north of the road/reliable line
			{ lat: 51.56, lon: -0.282 },
		];
		const s = scorePositioning(drawn, goodFixes, ROAD);
		expect(s.crossTrack.max).toBeGreaterThan(60);
		// And it is off the road too.
		expect(s.onRoad.max).toBeGreaterThan(60);
	});
});

/**
 * #234: the HSMM `train @ line` movement override is a WEIGHTED decision,
 * not a hard veto. It weighs the HSMM's temporal support for the line
 * against how much of the GPS trace runs nearer a road than rail. The
 * 2026-05-25 taxi (mislabelled "Circle Line") is the motivating case:
 * a thin line over a road-hugging trace must lose, while a confident line
 * over a rail-consistent trace — and an underground gap with no GPS to
 * contradict — must still win.
 */

import { describe, expect, it } from "vitest";
import type { NearbyWay } from "../src/geo/osm.js";
import { computeRoadNearestFraction } from "../src/geo/velocity.js";
import { decideHsmmTrainOverride } from "../src/hmm/place-override.js";

const road = (d: number): NearbyWay => ({ type: "highway", subtype: "primary", name: "A40", distanceM: d });
const rail = (d: number): NearbyWay => ({ type: "railway", subtype: "subway", name: "Circle Line", distanceM: d });

describe("decideHsmmTrainOverride (weighted, not a veto)", () => {
	it("declines for a road-hugging taxi with thin HSMM line support (2026-05-25)", () => {
		// 12 min of a 46 min segment labelled Circle Line, road-nearest the whole way.
		expect(decideHsmmTrainOverride({ avgSpeedKmh: 24.8, lineOverlapFraction: 0.26, roadCorridorFraction: 1.0 })).toBe(
			false,
		);
	});

	it("applies for a confident line over a rail-consistent trace (real surface train)", () => {
		expect(decideHsmmTrainOverride({ avgSpeedKmh: 45, lineOverlapFraction: 0.9, roadCorridorFraction: 0.1 })).toBe(
			true,
		);
	});

	it("applies for an underground gap (no GPS samples can contradict)", () => {
		expect(decideHsmmTrainOverride({ avgSpeedKmh: 25, lineOverlapFraction: 0.9, roadCorridorFraction: null })).toBe(
			true,
		);
	});

	it("a strong enough line still overcomes some road-following (not an absolute veto)", () => {
		// Train running beside a road: 60% road-nearest, but the HSMM is 80% sure → train.
		expect(decideHsmmTrainOverride({ avgSpeedKmh: 50, lineOverlapFraction: 0.8, roadCorridorFraction: 0.6 })).toBe(
			true,
		);
	});

	it("declines below walking-vs-vehicle speed floor", () => {
		expect(decideHsmmTrainOverride({ avgSpeedKmh: 5, lineOverlapFraction: 1.0, roadCorridorFraction: 0.0 })).toBe(
			false,
		);
	});

	it("declines when the HSMM names no known line", () => {
		expect(decideHsmmTrainOverride({ avgSpeedKmh: 40, lineOverlapFraction: 0, roadCorridorFraction: 0.0 })).toBe(false);
	});

	it("a tie does not promote to train (strict greater-than)", () => {
		expect(decideHsmmTrainOverride({ avgSpeedKmh: 30, lineOverlapFraction: 0.5, roadCorridorFraction: 0.5 })).toBe(
			false,
		);
	});
});

describe("computeRoadNearestFraction", () => {
	it("returns 1.0 when every sample is road-nearest with no rail (the taxi)", () => {
		const samples = [[road(4)], [road(0)], [road(16)], [road(8)], [road(2)]];
		expect(computeRoadNearestFraction(samples)).toBe(1);
	});

	it("returns 0.0 when every sample is rail-nearest (a real surface train)", () => {
		const samples = [
			[rail(3), road(40)],
			[rail(5), road(60)],
			[rail(2), road(30)],
		];
		expect(computeRoadNearestFraction(samples)).toBe(0);
	});

	it("computes a mixed fraction", () => {
		const samples = [[road(2), rail(40)], [road(50), rail(3)], [road(5), rail(60)], [rail(2)]];
		// road-nearest at samples 0 and 2 → 2/4
		expect(computeRoadNearestFraction(samples)).toBe(0.5);
	});

	it("returns null below the minimum usable-sample count", () => {
		expect(computeRoadNearestFraction([[road(4)], [road(8)]])).toBeNull();
	});

	it("skips samples with neither road nor rail in range", () => {
		const samples = [
			[road(4)],
			[{ type: "highway", subtype: "footway", distanceM: 5 } as NearbyWay],
			[road(8)],
			[road(2)],
		];
		// the footway sample is neither drivable road nor rail → skipped; 3 road-nearest of 3
		expect(computeRoadNearestFraction(samples)).toBe(1);
	});
});

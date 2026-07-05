/**
 * Unit tests for the corridor road-geometry sampler (`osm-corridor.ts`): the
 * polyline resampler and the union-by-osmId query fan-out. Pure and
 * deterministic — no DB.
 */

import { describe, expect, it, vi } from "vitest";
import type { OsmRoadWay } from "../src/geo/map-match-core.js";
import { corridorWays, resamplePolyline } from "../src/geo/osm-corridor.js";

// 0.001° latitude ≈ 111.32 m, so a track from lat 0 → 0.009 is ~1002 m north.
const NORTH_1KM = [
	{ lat: 0, lon: 0 },
	{ lat: 0.009, lon: 0 },
];

describe("resamplePolyline", () => {
	it("keeps both endpoints and samples at ~stepM spacing", () => {
		const s = resamplePolyline(NORTH_1KM, 300);
		expect(s[0]).toEqual({ lat: 0, lon: 0 });
		expect(s[s.length - 1].lat).toBeCloseTo(0.009, 6);
		// ~1002 m / 300 m ≈ 3 interior steps + 2 endpoints.
		expect(s.length).toBeGreaterThanOrEqual(4);
		expect(s.length).toBeLessThanOrEqual(6);
		// Monotonic, spacing never far above the step.
		for (let i = 1; i < s.length; i++) {
			const dM = (s[i].lat - s[i - 1].lat) * 111_320;
			expect(dM).toBeGreaterThan(0);
			expect(dM).toBeLessThanOrEqual(330);
		}
	});

	it("returns the single point for a one-point track", () => {
		expect(resamplePolyline([{ lat: 1, lon: 2 }], 300)).toEqual([{ lat: 1, lon: 2 }]);
	});

	it("caps the sample count for a pathologically long leg (widens the step)", () => {
		const veryLong = [
			{ lat: 0, lon: 0 },
			{ lat: 0.9, lon: 0 }, // ~100 km
		];
		const s = resamplePolyline(veryLong, 100, 10);
		expect(s.length).toBeLessThanOrEqual(10);
		expect(s[s.length - 1].lat).toBeCloseTo(0.9, 6);
	});
});

// A ~3 km leg: max fix-to-centroid distance ~1.5 km, past the single-disc
// threshold, so corridorWays samples it.
const NORTH_3KM = [
	{ lat: 0, lon: 0 },
	{ lat: 0.027, lon: 0 },
];

describe("corridorWays", () => {
	it("samples a long leg, unioning ways across samples and deduping by osmId", async () => {
		// Each sample returns a SHARED way (id 1) plus one UNIQUE way keyed on the
		// sample's latitude — so the union is 1 + (#distinct samples).
		const seenLats = new Set<number>();
		const query = vi.fn(async (lat: number, lon: number): Promise<OsmRoadWay[]> => {
			seenLats.add(Math.round(lat * 1e6));
			return [
				{ osmId: 1, name: "shared", subtype: "residential", coords: [[lat, lon]] },
				{ osmId: Math.round(lat * 1e6) + 1000, name: "u", subtype: "residential", coords: [[lat, lon]] },
			];
		});

		const ways = await corridorWays(NORTH_3KM, query, 300, 50);

		expect(query.mock.calls.length).toBeGreaterThanOrEqual(4);
		expect(ways.filter((w) => w.osmId === 1)).toHaveLength(1); // shared kept once
		expect(ways).toHaveLength(1 + seenLats.size);
	});

	it("passes the given per-sample radius through to the query (long leg)", async () => {
		const query = vi.fn(async (_lat: number, _lon: number, _radiusM: number): Promise<OsmRoadWay[]> => []);
		await corridorWays(NORTH_3KM, query, 300, 77);
		expect(query.mock.calls.length).toBeGreaterThan(1);
		for (const call of query.mock.calls) expect(call[2]).toBe(77);
	});

	it("uses a SINGLE centroid disc for a short leg (no sampling)", async () => {
		const query = vi.fn(async (_lat: number, _lon: number, _radiusM: number): Promise<OsmRoadWay[]> => []);
		await corridorWays(NORTH_1KM, query, 300, 50); // ~500 m max from centroid → single disc
		expect(query.mock.calls).toHaveLength(1);
		const [lat, lon, radius] = query.mock.calls[0];
		expect(lat).toBeCloseTo(0.0045, 4); // the centroid
		expect(lon).toBeCloseTo(0, 6);
		expect(radius).toBeGreaterThan(600); // ~maxDist(500) + slack(150)
		expect(radius).toBeLessThan(750);
	});
});

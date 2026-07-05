import { describe, expect, it } from "vitest";
import { matchImprovesDisplay, maxPolylineOffRoad, type RoadGeometry } from "../src/geo/road-match.js";

// A right-angle road network: one E–W road and one N–S road meeting at a
// corner, ~111,320 m per degree of latitude; longitude scaled by cos(lat).
// E–W road runs along lat 51.5000 from lon 0 to lon 0.0100 (~700 m).
// N–S road runs along lon 0.0100 from lat 51.5000 down to 51.4960 (~445 m).
const ROADS: RoadGeometry = {
	ways: [
		{
			osmId: 1,
			name: "East Street",
			subtype: "residential",
			coords: [
				[51.5, 0],
				[51.5, 0.01],
			],
		},
		{
			osmId: 2,
			name: "North Road",
			subtype: "residential",
			coords: [
				[51.5, 0.01],
				[51.496, 0.01],
			],
		},
	],
};

describe("maxPolylineOffRoad", () => {
	it("is ~0 for a line drawn along the road", () => {
		const onRoad = [
			{ lat: 51.5, lon: 0.001 },
			{ lat: 51.5, lon: 0.009 },
		];
		expect(maxPolylineOffRoad(onRoad, ROADS)).toBeLessThan(3);
	});

	it("catches a chord that cuts the corner even though both ENDPOINTS are on-road", () => {
		// Two fixes, each sitting on a road (one on East St near the corner,
		// one on North Rd near the corner), but the straight line between
		// them cuts diagonally across the block off both roads.
		const cornerCut = [
			{ lat: 51.5, lon: 0.002 },
			{ lat: 51.4965, lon: 0.01 },
		];
		// Both endpoints are essentially on a road…
		expect(maxPolylineOffRoad([cornerCut[0]], ROADS)).toBeLessThan(3);
		expect(maxPolylineOffRoad([cornerCut[1]], ROADS)).toBeLessThan(3);
		// …but the drawn chord strays well off-road mid-span.
		expect(maxPolylineOffRoad(cornerCut, ROADS)).toBeGreaterThan(60);
	});
});

describe("matchImprovesDisplay", () => {
	const NEEDS_MATCH_M = 25;
	const MAX_STRAY_M = 40;

	it("uses the match when the raw chord cuts a corner and the match follows the streets", () => {
		const rawFixes = [
			{ lat: 51.5, lon: 0.002 },
			{ lat: 51.4965, lon: 0.01 },
		];
		// Matched path goes along East St to the corner, then down North Rd.
		const matched = [
			{ lat: 51.5, lon: 0.002 },
			{ lat: 51.5, lon: 0.01 },
			{ lat: 51.4965, lon: 0.01 },
		];
		const d = matchImprovesDisplay(rawFixes, matched, ROADS, NEEDS_MATCH_M, MAX_STRAY_M);
		expect(d.rawOffRoadM).toBeGreaterThan(NEEDS_MATCH_M);
		expect(d.matchedOffRoadM).toBeLessThan(10);
		expect(d.use).toBe(true);
	});

	it("leaves a leg whose raw line already hugs the road alone", () => {
		const rawFixes = [
			{ lat: 51.5, lon: 0.002 },
			{ lat: 51.5, lon: 0.005 },
			{ lat: 51.5, lon: 0.009 },
		];
		const matched = rawFixes.map((p) => ({ ...p }));
		const d = matchImprovesDisplay(rawFixes, matched, ROADS, NEEDS_MATCH_M, MAX_STRAY_M);
		expect(d.use).toBe(false); // rawOffRoad ≤ needsMatch — nothing to gain
	});

	it("rejects a match that systematically snapped onto a far parallel road", () => {
		// Most fixes lie ~78 m from the candidate path: the match ran along a
		// road parallel to (and well away from) where the GPS actually was.
		// The p85 faithfulness guard must reject it.
		const rawFixes = Array.from({ length: 10 }, (_, i) => ({ lat: 51.5, lon: 0.001 + i * 0.0008 }));
		const parallel = rawFixes.map((p) => ({ lat: p.lat - 0.0007, lon: p.lon })); // ~78 m south, every fix
		const d = matchImprovesDisplay(rawFixes, parallel, ROADS, NEEDS_MATCH_M, MAX_STRAY_M);
		expect(d.strayM).toBeGreaterThan(MAX_STRAY_M);
		expect(d.use).toBe(false);
	});

	it("is NOT vetoed by a single outlier fix far from an otherwise-faithful match", () => {
		// 11 fixes hug the corner-cutting chord; one is a 72 m GPS outlier.
		// The match follows the streets and passes near all but the outlier —
		// exactly the bad fix map-matching exists to override. p85 ignores it.
		const onLine = Array.from({ length: 11 }, (_, i) => ({ lat: 51.5, lon: 0.001 + i * 0.0008 }));
		onLine[5] = { lat: 51.4994, lon: 0.0049 }; // ~72 m off — the outlier
		const matched = Array.from({ length: 11 }, (_, i) => ({ lat: 51.5, lon: 0.001 + i * 0.0008 }));
		const d = matchImprovesDisplay(onLine, matched, ROADS, NEEDS_MATCH_M, MAX_STRAY_M);
		expect(d.strayM).toBeLessThan(MAX_STRAY_M); // outlier excluded by p85
	});
});

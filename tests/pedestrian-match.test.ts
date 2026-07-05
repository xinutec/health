/**
 * Pedestrian map-matcher — pure, deterministic unit tests on synthetic walkable
 * geometry. Pins the four behaviours that distinguish the walk matcher from the
 * road matcher and guard the honest fallback:
 *   1. a leg whose raw chords cut a corner snaps onto the way;
 *   2. a leg with no nearby way bails (`null` → smoother), never invents a path;
 *   3. a turn across differently-named ways is followed (no way-continuity prior);
 *   4. a leg spanning a gap larger than the bridge bails (no invented connection).
 */
import { describe, expect, it } from "vitest";
import { maxPolylineOffRoad, type OsmRoadWay, type RoadFix } from "../src/geo/map-match-core.js";
import { matchWalkSegment } from "../src/geo/pedestrian-match.js";

const LAT0 = 51.5;
const LON0 = -0.1;
const LON_M = 111_320 * Math.cos((LAT0 * Math.PI) / 180);

/** A point `north`/`east` metres from the base, as [lat, lon]. */
function at(north: number, east: number): [number, number] {
	return [LAT0 + north / 111_320, LON0 + east / LON_M];
}

function way(id: number, name: string | null, pts: Array<[number, number]>): OsmRoadWay {
	return { osmId: id, name, subtype: "footway", coords: pts.map(([n, e]) => at(n, e)) };
}

function fix(north: number, east: number, ts: number): RoadFix {
	const [lat, lon] = at(north, east);
	return { lat, lon, ts };
}

describe("matchWalkSegment", () => {
	it("snaps a corner-cutting walk onto the way instead of chording across", () => {
		// L-shaped footway: east 200 m, then north 200 m (corner at east=200).
		const L = way(1, "Footway", [
			[0, 0],
			[0, 200],
			[200, 200],
		]);
		// Sparse fixes whose straight chord (f1→f2) cuts diagonally across the
		// inside of the corner; on-way they should route around it.
		const fixes = [fix(0, 20, 0), fix(0, 150, 60), fix(150, 200, 120), fix(200, 195, 180)];
		const result = matchWalkSegment(fixes, { ways: [L] });
		expect(result).not.toBeNull();
		const matched = result?.path ?? [];
		expect(matched.length).toBeGreaterThanOrEqual(2);

		const rawPts = fixes.map((f) => ({ lat: f.lat, lon: f.lon }));
		const rawOff = maxPolylineOffRoad(rawPts, { ways: [L] });
		const matchedOff = maxPolylineOffRoad(matched, { ways: [L] });
		// The raw chord cuts well off the way; the matched line hugs it.
		expect(rawOff).toBeGreaterThan(20);
		expect(matchedOff).toBeLessThan(8);
		expect(matchedOff).toBeLessThan(rawOff);
	});

	it("bails (null → smoother) when the walk is nowhere near a walkable way", () => {
		// One short footway far to the side; the walk crosses open ground.
		const sideWay = way(1, "Footway", [
			[0, 300],
			[100, 300],
		]);
		const fixes = [fix(0, 0, 0), fix(40, 0, 60), fix(80, 0, 120), fix(120, 0, 180)];
		expect(matchWalkSegment(fixes, { ways: [sideWay] })).toBeNull();
	});

	it("follows a turn across differently-named ways (no way-continuity prior)", () => {
		// Two footways with different names sharing the junction node at (0,200):
		// the road matcher's turn-prior would resist the name change; the walker
		// changes freely.
		const a = way(1, "Mill Road", [
			[0, 0],
			[0, 200],
		]);
		const b = way(2, "Queen's Walk", [
			[0, 200],
			[200, 200],
		]);
		const fixes = [fix(0, 30, 0), fix(0, 170, 60), fix(60, 200, 120), fix(160, 200, 180)];
		const result = matchWalkSegment(fixes, { ways: [a, b] });
		expect(result).not.toBeNull();
		// On-network the whole way (both footways), so the drawn line hugs them.
		const matchedOff = maxPolylineOffRoad(result?.path ?? [], { ways: [a, b] });
		expect(matchedOff).toBeLessThan(8);
	});

	it("bails when the leg spans a gap wider than the bridge (no invented link)", () => {
		// Two collinear footways separated by a 40 m gap (> gapBridgeM 18): the
		// graph is disconnected, so a leg crossing the gap cannot route honestly.
		const left = way(1, "Footway", [
			[0, 0],
			[0, 80],
		]);
		const right = way(2, "Footway", [
			[0, 120],
			[0, 200],
		]);
		const fixes = [fix(0, 20, 0), fix(0, 70, 60), fix(0, 130, 120), fix(0, 180, 180)];
		expect(matchWalkSegment(fixes, { ways: [left, right] })).toBeNull();
	});
});

import { describe, expect, it } from "vitest";
import { maxCorridorStall, walkPlausibility } from "../src/eval/walk-plausibility.js";
import type { RoadGeometry } from "../src/geo/road-match.js";

/**
 * `walk-plausibility` is the single multi-witness verdict for a drawn walk.
 * Coords run E along lon at lat 51.5 (~41.6 m per 0.0006° lon); a spur dips
 * ~111 m S in latitude.
 */
const at = (lat: number, lon: number) => ({ lat, lon });
const A = at(51.5, 0);
const B = at(51.5, 0.0006);
const C = at(51.5, 0.0012);

describe("maxCorridorStall", () => {
	it("is small for a drawn line that follows the fixes", () => {
		expect(maxCorridorStall([A, B, C], [A, B, C])).toBeLessThan(10);
	});
	it("spikes for an out-and-back the fixes don't make", () => {
		expect(maxCorridorStall([A, B, C], [A, B, at(51.499, 0.0006), B, C])).toBeGreaterThan(150);
	});
	it("stays small when the FIXES themselves walk out-and-back (same street twice)", () => {
		// A walk out to C and back along the same street. The drawn line follows
		// it faithfully but slightly smoothed (a few metres off the fixes). The
		// old greedy nearest-projection could snap an early drawn vertex onto the
		// RETURN pass, ratchet the corridor floor to the far arc, and read the
		// whole rest of the walk as one giant stall (measured on the corpus: a
		// line ≤ 12 m off a 118 m-stall line scored 2169 m). The min-cost
		// monotone assignment keeps each pass on the pass it follows.
		const outAndBack = [A, B, C, B, A];
		const smoothedNudge = 0.00002; // ~2 m N of the street on both passes
		const drawn = outAndBack.map((p) => at(p.lat + smoothedNudge, p.lon));
		expect(maxCorridorStall(outAndBack, drawn)).toBeLessThan(30);
	});
});

describe("walkPlausibility", () => {
	const WALKABLE: RoadGeometry = {
		ways: [
			{
				osmId: 1,
				name: "Path",
				subtype: "footway",
				coords: [
					[51.5, 0],
					[51.5, 0.0012],
				],
			},
		],
	};

	it("reports the raw-vs-matched over-route the drawn-only score can't see", () => {
		const drawn = [A, B, at(51.499, 0.0006), B, C]; // matcher invented an out-and-back
		const p = walkPlausibility([A, B, C], drawn, 0, 100, [], WALKABLE);
		expect(p.corridorStallM).toBeGreaterThan(150);
		expect(p.drawnLengthM).toBeGreaterThan(p.rawLengthM); // the detour lengthened it
		expect(p.offWalkableP90M).not.toBeNull(); // scored against the walkable way
	});

	it("a faithful line stalls ~0 and matches the raw length", () => {
		const p = walkPlausibility([A, B, C], [A, B, C], 0, 100, [], WALKABLE);
		expect(p.corridorStallM).toBeLessThan(10);
		expect(p.drawnLengthM).toBeCloseTo(p.rawLengthM, 0);
	});

	it("flags an implausible walking speed the off-walkable score can't see", () => {
		// ~1386 m drawn E over a 131 s leg = ~38 km/h — the underground-teleport
		// signature (a real walk is < ~9). All on the walkable way, so p90 is fine.
		const far = at(51.5, 0.02);
		const teleport = walkPlausibility([A, far], [A, far], 0, 131, [], WALKABLE);
		expect(teleport.avgDrawnSpeedKmh).toBeGreaterThan(20);

		// 83 m over a 300 s (5 min) stroll = ~1 km/h — a plausible walk.
		const stroll = walkPlausibility([A, B, C], [A, B, C], 0, 300, [], WALKABLE);
		expect(stroll.avgDrawnSpeedKmh).toBeLessThan(7);
	});
});

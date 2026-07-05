import { describe, expect, it } from "vitest";
import { pedometerDistanceM, scoreWalk } from "../src/eval/walk-score.js";
import type { RoadGeometry } from "../src/geo/road-match.js";

const O = 51.5;
const dLat = (m: number): number => O + m / 111_320;
const dLon = (m: number): number => -0.1 + m / (111_320 * Math.cos((O * Math.PI) / 180));

describe("pedometerDistanceM", () => {
	it("distributes per-minute steps by time overlap", () => {
		// 60 steps in minute [0,60); a 15 s window gets ~1/4 → 15 steps × 0.72.
		expect(pedometerDistanceM([{ ts: 0, steps: 60 }], 0, 15, 0.72)).toBeCloseTo(15 * 0.72, 1);
		expect(pedometerDistanceM([{ ts: 0, steps: 60 }], 0, 60, 0.72)).toBeCloseTo(60 * 0.72, 1);
	});
});

describe("scoreWalk", () => {
	it("a straight faithful walk scores tortuosity ~1", () => {
		const drawn = Array.from({ length: 5 }, (_, i) => ({ lat: O, lon: dLon(i * 15) }));
		const s = scoreWalk(drawn, 0, 60);
		expect(s.tortuosity).toBeLessThan(1.05);
	});

	it("a jittery walk scores high tortuosity", () => {
		const drawn = [
			{ lat: dLat(0), lon: dLon(0) },
			{ lat: dLat(18), lon: dLon(15) },
			{ lat: dLat(-15), lon: dLon(30) },
			{ lat: dLat(16), lon: dLon(45) },
			{ lat: dLat(0), lon: dLon(60) },
		];
		expect(scoreWalk(drawn, 0, 60).tortuosity).toBeGreaterThan(1.8);
	});

	it("step-distance error is low when drawn length matches the pedometer", () => {
		// drawn ~60 m straight; pedometer ~60 m (≈83 steps × 0.72).
		const drawn = [
			{ lat: O, lon: dLon(0) },
			{ lat: O, lon: dLon(60) },
		];
		const steps = [{ ts: 0, steps: 83 }];
		const s = scoreWalk(drawn, 0, 60, steps);
		expect(s.pedometerM).toBeCloseTo(60, 0);
		expect(s.stepDistanceError).toBeLessThan(0.05);
	});

	it("off-walkable ignores vertices far from any path (open ground)", () => {
		// One vertex 10 m off a footway (counted), one 80 m off (open ground,
		// excluded by the openness radius).
		const roads: RoadGeometry = {
			ways: [
				{
					osmId: 1,
					name: "P",
					subtype: "footway",
					coords: [
						[dLat(0), dLon(0)],
						[dLat(0), dLon(100)],
					],
				},
			],
		};
		const drawn = [
			{ lat: dLat(10), lon: dLon(20) }, // 10 m off → counted
			{ lat: dLat(80), lon: dLon(50) }, // 80 m off → excluded
		];
		const s = scoreWalk(drawn, 0, 60, [], roads);
		expect(s.offWalkableMeanM).toBeGreaterThan(8);
		expect(s.offWalkableMeanM).toBeLessThan(15); // only the 10 m vertex counts
	});
});

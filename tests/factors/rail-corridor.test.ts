/**
 * Tests for the rail-corridor factor — discriminates train from
 * driving via the per-segment mean fix-distance to rails vs roads.
 *
 * The motivating real case is 2026-05-22 13:16-13:26 (Ashvale →
 * Carfax on the Jubilee Line), where every fix sits 0-6 m from
 * a rail-only OSM way and 25-90 m from the nearest drivable road.
 * Without this factor, the cascade picked "Driving on Middlefield"
 * for the first half of the journey.
 */

import { describe, expect, it } from "vitest";
import { railCorridor } from "../../src/geo/factors/rail-corridor.js";
import type { ModeCandidate } from "../../src/geo/factors/types.js";

const trainCandidate: ModeCandidate = { mode: "train" };
const drivingCandidate: ModeCandidate = { mode: "driving" };

describe("railCorridor", () => {
	it("bonuses train and penalises driving by the same magnitude when rails are closer", () => {
		const ctx = { meanRailDistM: 2, meanDrivableRoadDistM: 40 };
		const train = railCorridor(trainCandidate, ctx);
		const driving = railCorridor(drivingCandidate, ctx);
		expect(train).not.toBeNull();
		expect(driving).not.toBeNull();
		expect(train?.score).toBeGreaterThan(0);
		expect(driving?.score).toBeLessThan(0);
		expect(train?.score).toBeCloseTo(-(driving?.score ?? 0), 9);
	});

	it("bonuses driving and penalises train when roads are closer", () => {
		const ctx = { meanRailDistM: 50, meanDrivableRoadDistM: 5 };
		const train = railCorridor(trainCandidate, ctx);
		const driving = railCorridor(drivingCandidate, ctx);
		expect(train?.score).toBeLessThan(0);
		expect(driving?.score).toBeGreaterThan(0);
	});

	it("scores ~zero when rail and road are equidistant", () => {
		const ctx = { meanRailDistM: 30, meanDrivableRoadDistM: 30 };
		const train = railCorridor(trainCandidate, ctx);
		expect(Math.abs(train?.score ?? 1)).toBeLessThan(0.001);
	});

	it("the 2026-05-22 13:16-13:26 case (mean rail 2 m, mean road 40 m) prefers train clearly", () => {
		const ctx = { meanRailDistM: 2, meanDrivableRoadDistM: 40 };
		const train = railCorridor(trainCandidate, ctx);
		// Expect bonus > 0.5 nats — enough to flip a close call.
		expect(train?.score).toBeGreaterThan(0.5);
	});

	it("magnitude is bounded — extreme ratios don't blow up", () => {
		const ctx = { meanRailDistM: 0.1, meanDrivableRoadDistM: 1000 };
		const train = railCorridor(trainCandidate, ctx);
		// log((1000+25)/(0.1+25)) ≈ log(40.8) ≈ 3.7 nats — significant
		// but not catastrophic for the other factors to overcome.
		expect(train?.score).toBeLessThan(5);
		expect(train?.score).toBeGreaterThan(3);
	});

	it("returns null for walking / cycling candidates (signal doesn't apply)", () => {
		const ctx = { meanRailDistM: 2, meanDrivableRoadDistM: 40 };
		expect(railCorridor({ mode: "walking" }, ctx)).toBeNull();
		expect(railCorridor({ mode: "cycling" }, ctx)).toBeNull();
		expect(railCorridor({ mode: "stationary" }, ctx)).toBeNull();
	});

	it("returns null when railDistance is unavailable", () => {
		expect(railCorridor(trainCandidate, { meanRailDistM: null, meanDrivableRoadDistM: 30 })).toBeNull();
		expect(railCorridor(trainCandidate, { meanDrivableRoadDistM: 30 })).toBeNull();
	});

	it("returns null when roadDistance is unavailable", () => {
		expect(railCorridor(trainCandidate, { meanRailDistM: 5, meanDrivableRoadDistM: null })).toBeNull();
		expect(railCorridor(trainCandidate, { meanRailDistM: 5 })).toBeNull();
	});
});

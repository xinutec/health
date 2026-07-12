/**
 * Scenario: a tube journey labelled as driving because the rail line
 * runs underneath a trunk road and the legacy `refineMode` cascade
 * prefers the road over the rail at this segment-summary speed.
 *
 * Bursts to ~98 km/h are biomechanically + legally impossible on UK
 * urban surface roads (30-50 mph limit), but the segment-level avg
 * is in driving range, so the cascade picks driving. The fix
 * (`rejectImplausibleDriving`) demotes to train when a subway is
 * also parallel.
 *
 * This test calls `refineMode` directly with synthesised NearbyWay
 * data shaped like the prod situation: a trunk highway (the surface
 * road) and a subway rail line (the underground tube) both near the
 * segment's path.
 *
 * Phase 1 (this test, RED): legacy cascade picks driving. Document
 * the bug; expectation = train.
 *
 * Phase 2 (follow-up): turn on factor scorer (USE_FACTOR_SCORER=1)
 * AND extend refineMode's call site to pass maxSpeed in addition
 * to avgSpeed -- the speed-emission factor needs to see the 98 km/h
 * burst to rule driving out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NearbyWay } from "../../src/geo/osm.js";
import { refineMode, rejectImplausibleDriving } from "../../src/geo/osm.js";

// Two ways near the segment, matching the prod-shape:
//   1. A trunk highway (London A-road class). The surface road above
//      the tube tunnel. GPS surface fix is ~10 m from it horizontally.
//   2. A subway railway line. The Underground line below. The GPS
//      track *follows* this line for the segment's whole length, but
//      vertically it's tens of metres below the GPS sample.
const trunkAbove: NearbyWay = {
	type: "highway",
	subtype: "trunk",
	name: "Underpass Road",
	distanceM: 8,
};
const subwayBelow: NearbyWay = {
	type: "railway",
	subtype: "subway",
	name: "Metropolitan Line",
	distanceM: 25,
};

describe("scenario: tube journey labelled as driving", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("(legacy cascade): demonstrates the bug — picks driving on the trunk road", () => {
		// Today's prod behaviour: USE_FACTOR_SCORER not set, the legacy
		// cascade preferentially picks the closer highway over the
		// railway. Even with a subway in range, the cascade goes road.
		vi.stubEnv("USE_FACTOR_SCORER", "");
		const result = refineMode("driving", 27.4, [trunkAbove, subwayBelow]);
		// This is the wrong outcome -- documenting it.
		expect(result.mode).toBe("driving");
		expect(result.wayName).toBe("Underpass Road");
	});

	it("(factor scorer @ avgSpeed only): still picks driving, because avg 27 km/h fits driving's distribution", () => {
		// Demonstrates that simply turning on USE_FACTOR_SCORER doesn't
		// fix the bug: the speed-emission factor at avgSpeed 27.4 km/h
		// gives driving (mean 52, std 15) ~ -1.3 log-lik vs train
		// (mean 100, std 30) ~ -2.9. Plus driving is on a closer way.
		// Driving wins.
		vi.stubEnv("USE_FACTOR_SCORER", "1");
		const result = refineMode("driving", 27.4, [trunkAbove, subwayBelow]);
		// Documenting current behaviour. Phase 2 will need to also
		// plumb maxSpeed through so speed-emission can rule driving
		// out on the 98 km/h burst.
		expect(result.mode).toBe("driving");
	});

	describe("rejectImplausibleDriving (post-refineMode physical-plausibility rule)", () => {
		it("demotes driving → train when maxSpeed > 80 km/h on a non-motorway road with subway nearby", () => {
			// The actual tube-as-driving prod shape: trunk highway picked
			// by refineMode, but maxSpeed 98.9 km/h is implausible on UK
			// urban surface roads (30-50 mph limit) and a subway is
			// within 25 m. The rule overrides the refineMode pick.
			const refined = { mode: "driving" as const, wayName: "Underpass Road" };
			const result = rejectImplausibleDriving(refined, 98.9, [trunkAbove, subwayBelow]);
			expect(result.mode).toBe("train");
			expect(result.wayName).toBe("Metropolitan Line");
		});

		it("leaves driving alone on a motorway even at autobahn speeds", () => {
			const motorway: NearbyWay = { type: "highway", subtype: "motorway", name: "M1", distanceM: 5 };
			const result = rejectImplausibleDriving({ mode: "driving", wayName: "M1" }, 110, [motorway, subwayBelow]);
			expect(result.mode).toBe("driving");
			expect(result.wayName).toBe("M1");
		});

		it("leaves driving alone when no subway is in range", () => {
			// Fast on a trunk road without a parallel tube = real fast drive.
			const result = rejectImplausibleDriving({ mode: "driving", wayName: "Underpass Road" }, 98.9, [trunkAbove]);
			expect(result.mode).toBe("driving");
		});

		it("does not fire below the urban-speed threshold", () => {
			const result = rejectImplausibleDriving({ mode: "driving", wayName: "Underpass Road" }, 60, [
				trunkAbove,
				subwayBelow,
			]);
			expect(result.mode).toBe("driving");
		});

		it("does not fire if the segment isn't labelled driving", () => {
			// Don't touch already-labelled train, walking, etc.
			const result = rejectImplausibleDriving({ mode: "train", wayName: "Some Line" }, 98.9, [trunkAbove, subwayBelow]);
			expect(result.mode).toBe("train");
			expect(result.wayName).toBe("Some Line");
		});
	});
});

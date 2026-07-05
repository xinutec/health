/**
 * Phase 1 smoke tests for the `ClassificationInputs` shape.
 *
 * The integration test — "loader output equals previous inline reads"
 * — will land in Phase 2 when `computeVelocity` is refactored to
 * consume the inputs value. For now these tests just pin the shape
 * so additive evolution in later phases stays additive.
 */

import { describe, expect, it } from "vitest";
import type {
	BiometricsSnapshot,
	ClassificationInputs,
	DayIdentity,
	KnownPlaceProjection,
	PhonetrackWindows,
} from "../src/geo/classification-inputs.js";
import type { OsmAdapter } from "../src/geo/osm-adapter.js";

describe("ClassificationInputs shape", () => {
	it("requires all eleven closure fields", () => {
		// This test exists to make the type a load-bearing contract: any
		// future change that drops a field breaks the build here. The
		// shape evolved across Phases 1, 4, 5, 6b–6c and Phase A (the
		// homeTz / sleepWindows / emptyDayBracket tail lifts) — every
		// required field must be constructible from an empty/null
		// baseline.
		const inputs: ClassificationInputs = {
			identity: minimalIdentity(),
			phonetrack: emptyPhonetrack(),
			knownPlaces: [],
			biometrics: emptyBiometrics(),
			modeBiometrics: [],
			hsmmDecode: null,
			railRouteCache: [],
			osm: stubOsmAdapter(),
			homeTz: "Europe/Amsterdam",
			sleepWindows: [],
			emptyDayBracket: null,
		};
		expect(inputs.identity.userId).toBe("pippijn");
	});

	it("KnownPlaceProjection extends the KnownPlace geometry contract", () => {
		const p: KnownPlaceProjection = {
			centroidLat: 51.5,
			centroidLon: -0.1,
			radiusM: 50,
			id: 42,
			displayName: "Home",
			sleepHours: 12,
			amenityLabel: null,
			uniqueDays: 30,
			hourProfile: null,
		};
		// snap consumers only look at centroidLat/centroidLon/radiusM —
		// these must remain the contract.
		expect(p.centroidLat).toBe(51.5);
		expect(p.centroidLon).toBe(-0.1);
		expect(p.radiusM).toBe(50);
	});

	it("PhonetrackWindows carries the three windows the pipeline fetches", () => {
		const w: PhonetrackWindows = {
			today: [],
			morning: [],
			priorEvening: [],
		};
		// Naming reflects the three calls at velocity.ts:540-543.
		expect(Object.keys(w).sort()).toEqual(["morning", "priorEvening", "today"]);
	});
});

function minimalIdentity(): DayIdentity {
	return { userId: "pippijn", date: "2026-05-15", displayTz: "Europe/London" };
}

function emptyPhonetrack(): PhonetrackWindows {
	return { today: [], morning: [], priorEvening: [] };
}

function emptyBiometrics(): BiometricsSnapshot {
	return { hr: [], sleep: [], steps: [] };
}

/** A throw-on-call OsmAdapter for the shape test. Tests that need a
 *  real adapter use `FixtureOsmAdapter` (Phase 6e). */
function stubOsmAdapter(): OsmAdapter {
	const unreached = () => {
		throw new Error("stub OsmAdapter — shape test only");
	};
	return {
		nearbyWays: unreached,
		nearbyStations: unreached,
		nearbyLandmarks: unreached,
		linesAtPoint: unreached,
		reverseGeocode: unreached,
		nearbyTransitStops: unreached,
		stationsOnLine: unreached,
		drivableRoads: unreached,
		walkableRoads: unreached,
		buildingsNear: unreached,
	};
}

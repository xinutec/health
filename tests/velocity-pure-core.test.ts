/**
 * Phase B of `docs/proposals/2026-06-deterministic-fixtures.md`: prove
 * `computeVelocityFromInputs` is pure in its `ClassificationInputs`.
 *
 * The contract is "no DB, no HTTP — given the inputs, produce the
 * output". We can't unit-test the absence of a DB call directly, but we
 * can give the core an input closure that needs no OSM access (an empty
 * day) together with a throw-on-call OSM adapter: if the core reaches for
 * the adapter — or, by extension, any external read routed through it —
 * the stub throws and the test fails. An empty day exercises the whole
 * skeleton (segmentation, merge, rail annotation, sleep composition,
 * empty-day inference) without producing any work that needs a lookup.
 */

import { describe, expect, it } from "vitest";
import type { ClassificationInputs } from "../src/geo/classification-inputs.js";
import type { OsmAdapter } from "../src/geo/osm-adapter.js";
import { computeVelocityFromInputs } from "../src/geo/velocity.js";

/** An OsmAdapter that throws if any method is called. A pure run over an
 *  empty day must never touch it. */
function throwingOsmAdapter(): OsmAdapter {
	const boom = (): never => {
		throw new Error("OSM adapter called — core is not pure for an empty day");
	};
	return {
		nearbyWays: boom,
		nearbyStations: boom,
		nearbyLandmarks: boom,
		linesAtPoint: boom,
		reverseGeocode: boom,
		nearbyTransitStops: boom,
		stationsOnLine: boom,
		drivableRoads: boom,
		walkableRoads: boom,
		buildingsNear: boom,
	};
}

/** A minimal empty-day input closure: no fixes, no biometrics, no places,
 *  no HSMM decode, no bracket. The day is genuinely blank. */
function emptyInputs(): ClassificationInputs {
	return {
		identity: { userId: "pippijn", date: "2026-05-15", displayTz: "Europe/London" },
		phonetrack: { today: [], morning: [], priorEvening: [] },
		knownPlaces: [],
		biometrics: { hr: [], sleep: [], steps: [] },
		modeBiometrics: [],
		hsmmDecode: null,
		railRouteCache: [],
		osm: throwingOsmAdapter(),
		homeTz: "Europe/Amsterdam",
		sleepWindows: [],
		emptyDayBracket: null,
	};
}

describe("computeVelocityFromInputs purity", () => {
	it("runs an empty day to completion without touching the OSM adapter", async () => {
		const result = await computeVelocityFromInputs(emptyInputs());
		expect(result.points).toEqual([]);
		expect(result.segments).toEqual([]);
		expect(result.states).toEqual([]);
		expect(result.battery).toEqual([]);
	});

	it("honours the enrich:false fast path on the same inputs", async () => {
		const result = await computeVelocityFromInputs(emptyInputs(), { enrich: false });
		expect(result.segments).toEqual([]);
		expect(result.states).toEqual([]);
	});
});

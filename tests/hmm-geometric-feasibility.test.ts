import { describe, expect, it } from "vitest";
import { buildGeometricFeasibility } from "../src/hmm/geometric-feasibility.js";
import type { Observation } from "../src/hmm/observation.js";
import type { State } from "../src/hmm/state-space.js";

/**
 * `buildGeometricFeasibility` penalises stationary @ knownPlace
 * states when the implied teleport speed between the most recent
 * (or next) observed GPS fix and the place's centroid exceeds the
 * plausible speed of any bridging mode.
 *
 * Pure function — synthetic observations + place coords, no DB.
 */

const PLACE_COORDS = new Map<number, { lat: number; lon: number }>([
	[1, { lat: 51.557, lon: -0.281 }], // "Home" — Ashvale
	[2, { lat: 51.531, lon: -0.119 }], // "Pizza Union" — Elmford area
]);

function stationary(placeId: number | null): State {
	return { mode: "stationary", placeId, lineName: null, trainEdgeId: null };
}

function obs(over: Partial<Observation>): Observation {
	return {
		ts: 1_700_000_000,
		gps: null,
		hr: null,
		cadence: null,
		hourLocal: 12,
		dayOfWeekLocal: 1,
		inBed: false,
		prevGpsFix: null,
		nextGpsFix: null,
		...over,
	};
}

describe("buildGeometricFeasibility", () => {
	it("returns 0 for non-stationary states", () => {
		const fn = buildGeometricFeasibility({ placeCoords: PLACE_COORDS });
		expect(fn({ mode: "walking", placeId: null, lineName: null, trainEdgeId: null }, obs({}))).toBe(0);
		expect(fn({ mode: "train", placeId: null, lineName: "Met", trainEdgeId: null }, obs({}))).toBe(0);
	});

	it("returns 0 for off-network stationary (placeId=null)", () => {
		const fn = buildGeometricFeasibility({ placeCoords: PLACE_COORDS });
		expect(fn(stationary(null), obs({}))).toBe(0);
	});

	it("returns 0 when no nearby GPS fix exists in either direction", () => {
		const fn = buildGeometricFeasibility({ placeCoords: PLACE_COORDS });
		expect(fn(stationary(1), obs({}))).toBe(0);
	});

	it("returns 0 when implied speed is plausible (foot, bike, slow car)", () => {
		const fn = buildGeometricFeasibility({ placeCoords: PLACE_COORDS });
		// User at Home centroid 5 minutes ago; now checking stat@Home.
		// Implied speed: 0 km/h.
		const ts = 1_700_000_000;
		const o = obs({
			ts,
			prevGpsFix: { ts: ts - 300, lat: 51.557, lon: -0.281 },
		});
		expect(fn(stationary(1), o)).toBe(0);
	});

	it("penalises implied teleport that exceeds plausible bridging speed", () => {
		const fn = buildGeometricFeasibility({ placeCoords: PLACE_COORDS });
		// User at Pizza Union (Elmford) 6 min ago; now claiming
		// stat@Home (Ashvale, ~10 km away). Implied ~100 km/h.
		const ts = 1_700_000_000;
		const o = obs({
			ts,
			prevGpsFix: { ts: ts - 360, lat: 51.531, lon: -0.119 },
		});
		expect(fn(stationary(1), o)).toBeLessThan(-1);
	});

	it("penalty worsens as implied speed increases", () => {
		const fn = buildGeometricFeasibility({ placeCoords: PLACE_COORDS });
		const ts = 1_700_000_000;
		// Same source fix, but checked at progressively shorter elapsed
		// — the implied speed gets HIGHER as elapsed shrinks.
		const o3 = obs({ ts, prevGpsFix: { ts: ts - 180, lat: 51.531, lon: -0.119 } }); // 3 min ago
		const o6 = obs({ ts, prevGpsFix: { ts: ts - 360, lat: 51.531, lon: -0.119 } }); // 6 min ago
		const o20 = obs({ ts, prevGpsFix: { ts: ts - 1200, lat: 51.531, lon: -0.119 } }); // 20 min ago
		const p3 = fn(stationary(1), o3);
		const p6 = fn(stationary(1), o6);
		const p20 = fn(stationary(1), o20);
		expect(p3).toBeLessThan(p6); // shorter elapsed → worse penalty
		expect(p6).toBeLessThan(p20);
	});

	it("uses the worst of forward and backward implied speeds", () => {
		const fn = buildGeometricFeasibility({ placeCoords: PLACE_COORDS });
		const ts = 1_700_000_000;
		// Prev fix consistent with Home (low implied speed). Next fix
		// far away in 1 minute (very high implied speed). The factor
		// should penalise on the next-fix direction.
		const o = obs({
			ts,
			prevGpsFix: { ts: ts - 60, lat: 51.557, lon: -0.281 }, // at Home 1 min ago, ~0 km/h
			nextGpsFix: { ts: ts + 60, lat: 51.531, lon: -0.119 }, // 10km away in 1 min, ~600 km/h
		});
		expect(fn(stationary(1), o)).toBeLessThan(-5);
	});

	it("returns 0 when the place is not in the coords map", () => {
		const fn = buildGeometricFeasibility({ placeCoords: PLACE_COORDS });
		const ts = 1_700_000_000;
		const o = obs({
			ts,
			prevGpsFix: { ts: ts - 360, lat: 51.531, lon: -0.119 },
		});
		expect(fn(stationary(999), o)).toBe(0); // place 999 unknown
	});
});

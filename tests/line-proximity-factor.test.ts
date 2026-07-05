import { describe, expect, it } from "vitest";
import { buildRouteGraph, type RawOsmLine } from "../src/geo/route-graph.js";
import { buildLineProximityFactor, scoreLineProximity } from "../src/hmm/line-proximity-factor.js";
import type { Observation } from "../src/hmm/observation.js";
import type { State } from "../src/hmm/state-space.js";

/**
 * `buildLineProximityFactor` complements `route-rail-evidence`:
 * route-rail-evidence fires only at GPS-NULL minutes (gap bookended
 * by underground L). This factor fires at GPS-PRESENT minutes,
 * scoring train @ L by whether L's actual track geometry passes
 * near the observed GPS fix.
 *
 * The two are disjoint by design: at a GPS-present minute the
 * route-rail-evidence returns 0; at a GPS-null minute this factor
 * returns 0.
 */

function line(over: Partial<RawOsmLine>): RawOsmLine {
	return {
		osm_id: 1n,
		osm_type: "way",
		feature_type: "railway",
		subtype: "rail",
		name: null,
		tags_json: null,
		geom: "LINESTRING(-0.1 51.5, -0.11 51.51)",
		...over,
	};
}

function train(lineName: string | null): State {
	return { mode: "train", placeId: null, lineName, trainEdgeId: null };
}

function obs(over: Partial<Observation> = {}): Observation {
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

// Two parallel line geometries. JUB runs north-south through (-0.140, 51.535);
// MET runs east-west through (-0.135, 51.520), well clear of JUB's corridor.
const JUB_GEOM = "LINESTRING(-0.140 51.525, -0.140 51.540)";
const MET_GEOM = "LINESTRING(-0.150 51.520, -0.120 51.520)";

const ON_JUB_LAT = 51.535;
const ON_JUB_LON = -0.14;

describe("buildLineProximityFactor", () => {
	it("returns 0 for non-train states", () => {
		const graph = buildRouteGraph([line({ osm_id: 1n, name: "Jubilee Line", subtype: "subway", geom: JUB_GEOM })], []);
		const fn = buildLineProximityFactor({ routeGraph: graph });
		const o = obs({ gps: { lat: ON_JUB_LAT, lon: ON_JUB_LON, speedKmh: 25 } });
		expect(fn({ mode: "walking", placeId: null, lineName: null, trainEdgeId: null }, o)).toBe(0);
		expect(fn({ mode: "stationary", placeId: 1, lineName: null, trainEdgeId: null }, o)).toBe(0);
	});

	it("returns 0 for train @ unknown_rail", () => {
		const graph = buildRouteGraph([line({ osm_id: 1n, name: "Jubilee Line", subtype: "subway", geom: JUB_GEOM })], []);
		const fn = buildLineProximityFactor({ routeGraph: graph });
		const o = obs({ gps: { lat: ON_JUB_LAT, lon: ON_JUB_LON, speedKmh: 25 } });
		expect(fn(train("unknown_rail"), o)).toBe(0);
	});

	it("returns 0 when GPS is null (route-rail-evidence's domain, not ours)", () => {
		const graph = buildRouteGraph([line({ osm_id: 1n, name: "Jubilee Line", subtype: "subway", geom: JUB_GEOM })], []);
		const fn = buildLineProximityFactor({ routeGraph: graph });
		const o = obs({ gps: null });
		expect(fn(train("Jubilee Line"), o)).toBe(0);
	});

	it("BOOSTS train @ L when GPS is on L's track", () => {
		const graph = buildRouteGraph(
			[
				line({ osm_id: 1n, name: "Jubilee Line", subtype: "subway", geom: JUB_GEOM }),
				line({ osm_id: 2n, name: "Metropolitan Line", subtype: "subway", geom: MET_GEOM }),
			],
			[],
		);
		const fn = buildLineProximityFactor({ routeGraph: graph });
		const o = obs({ gps: { lat: ON_JUB_LAT, lon: ON_JUB_LON, speedKmh: 25 } });
		expect(fn(train("Jubilee Line"), o)).toBeGreaterThan(0);
	});

	it("PENALISES train @ L when GPS is far from any L edge in the graph", () => {
		const graph = buildRouteGraph(
			[
				line({ osm_id: 1n, name: "Jubilee Line", subtype: "subway", geom: JUB_GEOM }),
				line({ osm_id: 2n, name: "Metropolitan Line", subtype: "subway", geom: MET_GEOM }),
			],
			[],
		);
		const fn = buildLineProximityFactor({ routeGraph: graph });
		// User is on Jubilee's corridor — Met track is ~1.7 km away.
		const o = obs({ gps: { lat: ON_JUB_LAT, lon: ON_JUB_LON, speedKmh: 25 } });
		expect(fn(train("Metropolitan Line"), o)).toBeLessThan(0);
	});

	it("returns 0 when graph has no edges for line L at all (no Victoria edges in graph)", () => {
		// Sole purpose: NEVER unfairly penalise a line that the graph
		// doesn't model. If the L doesn't appear in the local route
		// graph (e.g. partial download), we shouldn't pretend distance
		// is meaningful.
		const graph = buildRouteGraph([line({ osm_id: 1n, name: "Jubilee Line", subtype: "subway", geom: JUB_GEOM })], []);
		const fn = buildLineProximityFactor({ routeGraph: graph });
		const o = obs({ gps: { lat: ON_JUB_LAT, lon: ON_JUB_LON, speedKmh: 25 } });
		expect(fn(train("Victoria Line"), o)).toBe(0);
	});

	it("on shared track, both lines get the BOOST (composite tag membership)", () => {
		// Single way carrying both Met and Jubilee — Ashvale → Brookden.
		const graph = buildRouteGraph(
			[
				line({
					osm_id: 1n,
					name: "Jubilee and Metropolitan Lines",
					subtype: "subway",
					geom: JUB_GEOM,
				}),
			],
			[],
		);
		const fn = buildLineProximityFactor({ routeGraph: graph });
		const o = obs({ gps: { lat: ON_JUB_LAT, lon: ON_JUB_LON, speedKmh: 25 } });
		const jubScore = fn(train("Jubilee Line"), o);
		const metScore = fn(train("Metropolitan Line"), o);
		expect(jubScore).toBeGreaterThan(0);
		expect(metScore).toBeGreaterThan(0);
		expect(jubScore).toBe(metScore);
	});

	// The #238 root fix: a fix that sits on L's track BUT is nearer a
	// drivable road than any rail is road-following (driving past the
	// line), not riding it — the central-London-taxi-on-the-Circle-Line
	// case. The boost is withheld even though L's track is within range.
	it("PENALISES train @ L when the fix is nearer a road than the rail (taxi case)", () => {
		const graph = buildRouteGraph([line({ osm_id: 1n, name: "Circle Line", subtype: "subway", geom: JUB_GEOM })], []);
		const fn = buildLineProximityFactor({ routeGraph: graph });
		// On Circle's corridor, but the fix sits 8 m from a road and 120 m
		// from the rail — a car on the street, not a train on the track.
		const o = obs({ gps: { lat: ON_JUB_LAT, lon: ON_JUB_LON, speedKmh: 25 }, roadDistM: 8, railDistM: 120 });
		expect(fn(train("Circle Line"), o)).toBeLessThan(0);
	});

	it("still BOOSTS train @ L when the rail is nearer than the road (real train)", () => {
		const graph = buildRouteGraph([line({ osm_id: 1n, name: "Circle Line", subtype: "subway", geom: JUB_GEOM })], []);
		const fn = buildLineProximityFactor({ routeGraph: graph });
		// Fix hugs the track: 12 m from rail, 90 m from the nearest road.
		const o = obs({ gps: { lat: ON_JUB_LAT, lon: ON_JUB_LON, speedKmh: 25 }, roadDistM: 90, railDistM: 12 });
		expect(fn(train("Circle Line"), o)).toBeGreaterThan(0);
	});

	it("BOOSTS (unchanged) when no road/rail proximity was captured (backward compat)", () => {
		const graph = buildRouteGraph([line({ osm_id: 1n, name: "Circle Line", subtype: "subway", geom: JUB_GEOM })], []);
		const fn = buildLineProximityFactor({ routeGraph: graph });
		// No roadDistM/railDistM on the obs — older fixtures. The road-vs-
		// rail test is skipped; original near→boost behaviour stands.
		const o = obs({ gps: { lat: ON_JUB_LAT, lon: ON_JUB_LON, speedKmh: 25 } });
		expect(fn(train("Circle Line"), o)).toBeGreaterThan(0);
	});
});

describe("scoreLineProximity (pure decision)", () => {
	it("returns 0 for a line the graph doesn't model", () => {
		expect(scoreLineProximity({ lineModeled: false, lineNear: false, roadDistM: 5, railDistM: 200 })).toBe(0);
		expect(scoreLineProximity({ lineModeled: false, lineNear: true, roadDistM: null, railDistM: null })).toBe(0);
	});

	it("penalises a modeled line whose track is not near the fix", () => {
		expect(scoreLineProximity({ lineModeled: true, lineNear: false, roadDistM: null, railDistM: null })).toBeLessThan(
			0,
		);
	});

	it("boosts when near and rail is at least as close as the road", () => {
		expect(scoreLineProximity({ lineModeled: true, lineNear: true, roadDistM: 100, railDistM: 20 })).toBeGreaterThan(0);
		// Tie (road == rail) keeps the boost — only a strictly nearer road withholds it.
		expect(scoreLineProximity({ lineModeled: true, lineNear: true, roadDistM: 30, railDistM: 30 })).toBeGreaterThan(0);
	});

	it("withholds the boost (penalty) when near but the road is strictly nearer", () => {
		expect(scoreLineProximity({ lineModeled: true, lineNear: true, roadDistM: 10, railDistM: 150 })).toBeLessThan(0);
	});

	it("ignores the road test when either distance is missing (backward compat)", () => {
		expect(scoreLineProximity({ lineModeled: true, lineNear: true, roadDistM: null, railDistM: 150 })).toBeGreaterThan(
			0,
		);
		expect(scoreLineProximity({ lineModeled: true, lineNear: true, roadDistM: 10, railDistM: null })).toBeGreaterThan(
			0,
		);
		expect(
			scoreLineProximity({ lineModeled: true, lineNear: true, roadDistM: undefined, railDistM: undefined }),
		).toBeGreaterThan(0);
	});
});

describe("buildLineProximityFactor — unknown_rail road guard", () => {
	const graph = buildRouteGraph([], []);
	const fn = buildLineProximityFactor({ routeGraph: graph });
	const here = { lat: 51.5, lon: -0.1, speedKmh: 18 };

	it("penalises train @ unknown_rail when the fix is road-nearer than rail", () => {
		const score = fn(train("unknown_rail"), obs({ gps: here, roadDistM: 8, railDistM: 240 }));
		expect(score).toBeLessThan(0);
	});

	it("does not penalise unknown_rail when rail is nearer (a real surface ride)", () => {
		expect(fn(train("unknown_rail"), obs({ gps: here, roadDistM: 200, railDistM: 6 }))).toBe(0);
	});

	it("does not fire on a GPS-null minute (a real underground ride)", () => {
		expect(fn(train("unknown_rail"), obs({ gps: null, roadDistM: 8, railDistM: 240 }))).toBe(0);
	});

	it("does not fire when road/rail proximity is unknown", () => {
		expect(fn(train("unknown_rail"), obs({ gps: here }))).toBe(0);
	});
});

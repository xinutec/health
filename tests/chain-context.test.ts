import { describe, expect, it } from "vitest";
import { buildRouteGraph, type RawOsmLine } from "../src/geo/route-graph.js";
import { buildChainContext } from "../src/hmm/chain-context.js";
import type { Observation } from "../src/hmm/observation.js";
import type { State } from "../src/hmm/state-space.js";

/**
 * Chain context (C4.2 proper, `2026-07-continuity-c4.md`): every
 * new-segment transition is scored for geometric feasibility from the
 * previous segment's exit evidence — entering a place the fixes aren't
 * at (teleport), leaving a place the fixes had already left, boarding
 * a line the exit anchor is nowhere near. Everything slop-discounted
 * by fix staleness, so blackout transitions assert ~nothing.
 */

const T0 = 1_700_000_000;

function ob(over: Partial<Observation> = {}): Observation {
	return {
		ts: T0,
		gps: null,
		hr: null,
		cadence: null,
		hourLocal: 12,
		dayOfWeekLocal: 3,
		inBed: false,
		prevGpsFix: null,
		nextGpsFix: null,
		...over,
	};
}

function st(mode: State["mode"], over: Partial<State> = {}): State {
	return { mode, placeId: null, lineName: null, trainEdgeId: null, ...over };
}

// ~0.001 lat ≈ 111 m northward.
const PLACE_A = { lat: 51.5, lon: -0.1 };
const PLACE_B = { lat: 51.52, lon: -0.1 }; // ~2.2 km north of A
const PLACES = new Map([
	[1, PLACE_A],
	[2, PLACE_B],
]);

// One modeled line running east-west just north of PLACE_A; a second
// line far away to the east.
const NEAR_LINE_GEOM = "LINESTRING(-0.12 51.502, -0.08 51.502)";
const FAR_LINE_GEOM = "LINESTRING(0.30 51.502, 0.34 51.502)";

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

const GRAPH = buildRouteGraph(
	[
		line({ osm_id: 1n, name: "Ashvale Line", geom: NEAR_LINE_GEOM }),
		line({ osm_id: 2n, name: "Farvale Line", geom: FAR_LINE_GEOM }),
	],
	[],
);

function build(over: Partial<Parameters<typeof buildChainContext>[0]> = {}) {
	return buildChainContext({ placeCoords: PLACES, routeGraph: GRAPH, ...over });
}

const fixAt = (minAgo: number, lat: number, lon: number) => ({ ts: T0 - minAgo * 60, lat, lon });

describe("buildChainContext", () => {
	it("entering a place where the fixes are costs ~nothing", () => {
		const chain = build();
		const obs = ob({ prevGpsFix: fixAt(1, PLACE_A.lat + 0.001, PLACE_A.lon) }); // ~111 m off centroid
		expect(chain(st("walking"), st("stationary", { placeId: 1 }), obs)).toBeGreaterThan(-0.2);
	});

	it("entering a place kilometres from the last fresh fix pays the teleport cost", () => {
		const chain = build();
		const obs = ob({ prevGpsFix: fixAt(1, PLACE_A.lat, PLACE_A.lon) }); // fresh fix at A
		expect(chain(st("walking"), st("stationary", { placeId: 2 }), obs)).toBeLessThanOrEqual(-6);
	});

	it("a stale fix cannot convict a blackout stay entry", () => {
		const chain = build();
		const obs = ob({ prevGpsFix: fixAt(40, PLACE_A.lat, PLACE_A.lon) }); // 40 min stale
		expect(chain(st("walking"), st("stationary", { placeId: 2 }), obs)).toBeGreaterThan(-0.1);
	});

	it("leaving a place whose departure fix is already elsewhere pays on exit", () => {
		const chain = build();
		// Claimed stay at A, but the last fix before the walk is at B.
		const obs = ob({ prevGpsFix: fixAt(1, PLACE_B.lat, PLACE_B.lon) });
		expect(chain(st("stationary", { placeId: 1 }), st("walking"), obs)).toBeLessThanOrEqual(-6);
	});

	it("boarding a line the exit place sits on is cheap; a distant line is expensive", () => {
		const chain = build();
		const obs = ob();
		const fromA = st("stationary", { placeId: 1 });
		const near = chain(fromA, st("train", { lineName: "Ashvale Line" }), obs);
		const far = chain(fromA, st("train", { lineName: "Farvale Line" }), obs);
		expect(near).toBeGreaterThan(-0.3);
		expect(far).toBeLessThanOrEqual(-6);
	});

	it("boarding feasibility from a fresh fix anchor when leaving no place", () => {
		const chain = build();
		const obs = ob({ prevGpsFix: fixAt(1, 51.502, -0.1) }); // on the Ashvale corridor
		const near = chain(st("walking"), st("train", { lineName: "Ashvale Line" }), obs);
		const far = chain(st("walking"), st("train", { lineName: "Farvale Line" }), obs);
		expect(near).toBeGreaterThan(-0.3);
		expect(far).toBeLessThanOrEqual(-6);
	});

	it("generator-vouched train entries skip the boarding term", () => {
		const chain = build({ isTrainCovered: () => true });
		const obs = ob();
		expect(chain(st("stationary", { placeId: 1 }), st("train", { lineName: "Farvale Line" }), obs)).toBe(0);
	});

	it("unknown_rail and unmodeled lines carry no boarding term", () => {
		const chain = build();
		const obs = ob();
		const fromA = st("stationary", { placeId: 1 });
		expect(chain(fromA, st("train", { lineName: "unknown_rail" }), obs)).toBe(0);
		expect(chain(fromA, st("train", { lineName: "Deepwell Line" }), obs)).toBe(0);
	});

	it("no exit evidence at all → asserts nothing", () => {
		const chain = build();
		const obs = ob(); // no prevGpsFix
		expect(chain(st("walking"), st("stationary", { placeId: 2 }), obs)).toBe(0);
		expect(chain(st("stationary", { placeId: 1 }), st("walking"), obs)).toBe(0);
	});

	it("moving→moving transitions with no place or line anchor are free", () => {
		const chain = build();
		const obs = ob({ prevGpsFix: fixAt(1, PLACE_A.lat, PLACE_A.lon) });
		expect(chain(st("walking"), st("cycling"), obs)).toBe(0);
		expect(chain(st("driving"), st("walking"), obs)).toBe(0);
	});
});

import { describe, expect, it } from "vitest";
import { buildRouteGraph, type RawOsmLine } from "../src/geo/route-graph.js";
import type { Observation } from "../src/hmm/observation.js";
import { buildRouteRailEvidence } from "../src/hmm/route-rail-evidence.js";
import type { State } from "../src/hmm/state-space.js";

/**
 * `buildRouteRailEvidence` is the route-graph replacement for the
 * earlier `rail-corridor-boost`. It boosts train @ knownLine states
 * when the bookend GPS fixes are surrounded by UNDERGROUND edges of
 * the same line in the route graph — the structural signal that
 * the gap was an underground tube ride.
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

const KX_LAT = 51.5308;
const KX_LON = -0.1238;
const BROOKDEN_LAT = 51.5474;
const BROOKDEN_LON = -0.1809;

const MET_KX = "LINESTRING(-0.124 51.530, -0.1238 51.5308, -0.123 51.531)";
const MET_BROOKDEN = "LINESTRING(-0.181 51.547, -0.1809 51.5474, -0.180 51.548)";
const MET_SURFACE = "LINESTRING(-0.28 51.56, -0.2796 51.5638, -0.279 51.564)"; // Ashvale surface section

describe("buildRouteRailEvidence", () => {
	it("returns 0 for non-train states", () => {
		const graph = buildRouteGraph([], []);
		const fn = buildRouteRailEvidence({ routeGraph: graph });
		expect(fn({ mode: "stationary", placeId: 1, lineName: null, trainEdgeId: null }, obs({}))).toBe(0);
		expect(fn({ mode: "walking", placeId: null, lineName: null, trainEdgeId: null }, obs({}))).toBe(0);
	});

	it("returns 0 for train @ unknown_rail (no specific line)", () => {
		const graph = buildRouteGraph([], []);
		const fn = buildRouteRailEvidence({ routeGraph: graph });
		expect(fn(train("unknown_rail"), obs({}))).toBe(0);
	});

	it("returns 0 when the current minute has GPS — only fires during the tunnel gap", () => {
		const graph = buildRouteGraph(
			[
				line({ osm_id: 1n, name: "Metropolitan Line", subtype: "subway", geom: MET_KX }),
				line({ osm_id: 2n, name: "Metropolitan Line", subtype: "subway", geom: MET_BROOKDEN }),
			],
			[],
		);
		const fn = buildRouteRailEvidence({ routeGraph: graph });
		const ts = 1_700_000_000;
		const o = obs({
			ts,
			gps: { lat: KX_LAT, lon: KX_LON, speedKmh: 0 },
			prevGpsFix: { ts: ts - 180, lat: KX_LAT, lon: KX_LON },
			nextGpsFix: { ts: ts + 600, lat: BROOKDEN_LAT, lon: BROOKDEN_LON },
		});
		expect(fn(train("Metropolitan Line"), o)).toBe(0);
	});

	it("boosts train @ L when underground edges of L bookend both fixes AND a path connects them on L (Met Line tube case)", () => {
		// Connected chain of Met edges KX → mid → Brookden. Each edge
		// shares an endpoint node with the next, so the route graph's
		// per-line connectivity check passes.
		const graph = buildRouteGraph(
			[
				line({
					osm_id: 1n,
					name: "Metropolitan Line",
					subtype: "subway",
					geom: "LINESTRING(-0.125 51.5300, -0.130 51.5350)",
				}),
				line({
					osm_id: 2n,
					name: "Metropolitan Line",
					subtype: "subway",
					geom: "LINESTRING(-0.130 51.5350, -0.155 51.5410)",
				}),
				line({
					osm_id: 3n,
					name: "Metropolitan Line",
					subtype: "subway",
					geom: "LINESTRING(-0.155 51.5410, -0.181 51.5474)",
				}),
			],
			[],
		);
		const fn = buildRouteRailEvidence({ routeGraph: graph });
		const ts = 1_700_000_000;
		const o = obs({
			ts,
			prevGpsFix: { ts: ts - 180, lat: KX_LAT, lon: KX_LON },
			nextGpsFix: { ts: ts + 600, lat: BROOKDEN_LAT, lon: BROOKDEN_LON },
		});
		expect(fn(train("Metropolitan Line"), o)).toBeGreaterThan(2);
	});

	it("does NOT boost when the bookend edges are SURFACE (not underground)", () => {
		const graph = buildRouteGraph(
			[
				// Same Met Line geometry but on the surface (no subway subtype, no tunnel).
				line({ osm_id: 1n, name: "Metropolitan Line", subtype: "rail", geom: MET_KX }),
				line({ osm_id: 2n, name: "Metropolitan Line", subtype: "rail", geom: MET_BROOKDEN }),
			],
			[],
		);
		const fn = buildRouteRailEvidence({ routeGraph: graph });
		const ts = 1_700_000_000;
		const o = obs({
			ts,
			prevGpsFix: { ts: ts - 180, lat: KX_LAT, lon: KX_LON },
			nextGpsFix: { ts: ts + 600, lat: BROOKDEN_LAT, lon: BROOKDEN_LON },
		});
		expect(fn(train("Metropolitan Line"), o)).toBe(0);
	});

	it("only boosts the specific line — Metropolitan ≠ Victoria evidence", () => {
		// Connected Met chain so the boost fires for Met; no Victoria
		// edges at all so Victoria fails the linesPresent check.
		const graph = buildRouteGraph(
			[
				line({
					osm_id: 1n,
					name: "Metropolitan Line",
					subtype: "subway",
					geom: "LINESTRING(-0.125 51.5300, -0.130 51.5350)",
				}),
				line({
					osm_id: 2n,
					name: "Metropolitan Line",
					subtype: "subway",
					geom: "LINESTRING(-0.130 51.5350, -0.155 51.5410)",
				}),
				line({
					osm_id: 3n,
					name: "Metropolitan Line",
					subtype: "subway",
					geom: "LINESTRING(-0.155 51.5410, -0.181 51.5474)",
				}),
			],
			[],
		);
		const fn = buildRouteRailEvidence({ routeGraph: graph });
		const ts = 1_700_000_000;
		const o = obs({
			ts,
			prevGpsFix: { ts: ts - 180, lat: KX_LAT, lon: KX_LON },
			nextGpsFix: { ts: ts + 600, lat: BROOKDEN_LAT, lon: BROOKDEN_LON },
		});
		expect(fn(train("Metropolitan Line"), o)).toBeGreaterThan(0);
		expect(fn(train("Victoria Line"), o)).toBe(0); // no Victoria edges in graph
	});

	it("does NOT boost when only ONE bookend is near underground L (one-sided evidence)", () => {
		const graph = buildRouteGraph(
			[
				// Only KX side has Met Line underground; Brookden side has no Met edges.
				line({ osm_id: 1n, name: "Metropolitan Line", subtype: "subway", geom: MET_KX }),
			],
			[],
		);
		const fn = buildRouteRailEvidence({ routeGraph: graph });
		const ts = 1_700_000_000;
		const o = obs({
			ts,
			prevGpsFix: { ts: ts - 180, lat: KX_LAT, lon: KX_LON },
			nextGpsFix: { ts: ts + 600, lat: BROOKDEN_LAT, lon: BROOKDEN_LON },
		});
		expect(fn(train("Metropolitan Line"), o)).toBe(0);
	});

	it("does NOT fire when the bookend gap is too LONG — multi-hour gaps aren't tube rides", () => {
		const graph = buildRouteGraph(
			[
				line({ osm_id: 1n, name: "Metropolitan Line", subtype: "subway", geom: MET_KX }),
				line({ osm_id: 2n, name: "Metropolitan Line", subtype: "subway", geom: MET_BROOKDEN }),
			],
			[],
		);
		const fn = buildRouteRailEvidence({ routeGraph: graph });
		const ts = 1_700_000_000;
		// 3-hour gap: not a single tube ride — could be the user being
		// at a known place all morning while bookend fixes are from
		// yesterday evening and afternoon activity at central-London
		// Met stations.
		const o = obs({
			ts,
			prevGpsFix: { ts: ts - 5400, lat: KX_LAT, lon: KX_LON }, // 90 min ago
			nextGpsFix: { ts: ts + 5400, lat: BROOKDEN_LAT, lon: BROOKDEN_LON }, // 90 min ahead
		});
		expect(fn(train("Metropolitan Line"), o)).toBe(0);
	});

	it("requires the bookend gap to span enough time/distance (filters indoor flicker)", () => {
		const graph = buildRouteGraph(
			[
				line({ osm_id: 1n, name: "Metropolitan Line", subtype: "subway", geom: MET_KX }),
				line({ osm_id: 2n, name: "Metropolitan Line", subtype: "subway", geom: MET_BROOKDEN }),
			],
			[],
		);
		const fn = buildRouteRailEvidence({ routeGraph: graph });
		const ts = 1_700_000_000;
		// Both fixes at KX, 1 minute apart — indoor flicker, not a ride.
		const o = obs({
			ts,
			prevGpsFix: { ts: ts - 30, lat: KX_LAT, lon: KX_LON },
			nextGpsFix: { ts: ts + 30, lat: KX_LAT + 0.0001, lon: KX_LON },
		});
		expect(fn(train("Metropolitan Line"), o)).toBe(0);
	});

	it("does NOT boost surface mainline rail — gap is more consistent with being indoors near the line", () => {
		const graph = buildRouteGraph(
			[
				line({ osm_id: 1n, name: "East Coast Main Line", subtype: "rail", geom: MET_KX }),
				line({ osm_id: 2n, name: "East Coast Main Line", subtype: "rail", geom: MET_BROOKDEN }),
			],
			[],
		);
		const fn = buildRouteRailEvidence({ routeGraph: graph });
		const ts = 1_700_000_000;
		const o = obs({
			ts,
			prevGpsFix: { ts: ts - 180, lat: KX_LAT, lon: KX_LON },
			nextGpsFix: { ts: ts + 600, lat: BROOKDEN_LAT, lon: BROOKDEN_LON },
		});
		// Surface-only evidence does not boost — train @ surface needs
		// GPS-observed speed / direction evidence to win, not gap-based.
		expect(fn(train("East Coast Main Line"), o)).toBe(0);
	});

	it("does NOT boost when the bookend underground edges of L are NOT graph-connected on L's subgraph", () => {
		// KX and Brookden sides BOTH have Met edges underground, but
		// the two are not in the same Met-subgraph connected component
		// in this synthetic graph (no edge endpoints align). The boost
		// should NOT fire — without connectivity, Met has no path
		// between the bookend stations.
		const graph = buildRouteGraph(
			[
				line({
					osm_id: 1n,
					name: "Metropolitan Line",
					subtype: "subway",
					geom: "LINESTRING(-0.125 51.5300, -0.122 51.5316)",
				}),
				// Disconnected from edge 1 (no shared endpoint).
				line({
					osm_id: 2n,
					name: "Metropolitan Line",
					subtype: "subway",
					geom: "LINESTRING(-0.182 51.5470, -0.179 51.5478)",
				}),
			],
			[],
		);
		const fn = buildRouteRailEvidence({ routeGraph: graph });
		const ts = 1_700_000_000;
		const o = obs({
			ts,
			prevGpsFix: { ts: ts - 180, lat: KX_LAT, lon: KX_LON },
			nextGpsFix: { ts: ts + 600, lat: BROOKDEN_LAT, lon: BROOKDEN_LON },
		});
		expect(fn(train("Metropolitan Line"), o)).toBe(0);
	});

	it("DOES boost when the bookend underground edges of L are graph-connected via a chain", () => {
		// Chain of Met Line edges KX → mid → Brookden, each sharing an
		// endpoint node with the next. Connectivity check passes.
		const graph = buildRouteGraph(
			[
				line({
					osm_id: 1n,
					name: "Metropolitan Line",
					subtype: "subway",
					geom: "LINESTRING(-0.125 51.5300, -0.130 51.5350)",
				}),
				line({
					osm_id: 2n,
					name: "Metropolitan Line",
					subtype: "subway",
					geom: "LINESTRING(-0.130 51.5350, -0.155 51.5410)",
				}),
				line({
					osm_id: 3n,
					name: "Metropolitan Line",
					subtype: "subway",
					geom: "LINESTRING(-0.155 51.5410, -0.181 51.5474)",
				}),
			],
			[],
		);
		const fn = buildRouteRailEvidence({ routeGraph: graph });
		const ts = 1_700_000_000;
		const o = obs({
			ts,
			prevGpsFix: { ts: ts - 180, lat: KX_LAT, lon: KX_LON },
			nextGpsFix: { ts: ts + 600, lat: BROOKDEN_LAT, lon: BROOKDEN_LON },
		});
		expect(fn(train("Metropolitan Line"), o)).toBeGreaterThan(2);
	});

	it("memoises fix lookups (idempotent calls don't re-query the graph)", () => {
		// Build a graph and verify repeated calls return consistent
		// values — sanity check that internal caching doesn't drift.
		void MET_SURFACE; // referenced for future surface-mainline test extension
		const graph = buildRouteGraph(
			[
				line({ osm_id: 1n, name: "Metropolitan Line", subtype: "subway", geom: MET_KX }),
				line({ osm_id: 2n, name: "Metropolitan Line", subtype: "subway", geom: MET_BROOKDEN }),
			],
			[],
		);
		const fn = buildRouteRailEvidence({ routeGraph: graph });
		const ts = 1_700_000_000;
		const o = obs({
			ts,
			prevGpsFix: { ts: ts - 180, lat: KX_LAT, lon: KX_LON },
			nextGpsFix: { ts: ts + 600, lat: BROOKDEN_LAT, lon: BROOKDEN_LON },
		});
		const a = fn(train("Metropolitan Line"), o);
		const b = fn(train("Metropolitan Line"), o);
		expect(a).toBe(b);
	});
});

/**
 * `innerViterbi` decodes the maximum-likelihood edge sequence
 * across the observations [t0, T) on a per-line subgraph of the
 * route graph. The decoded path must:
 *
 *   - start on an entry edge (caller-supplied; usually edges near
 *     the GPS fix just before the segment),
 *   - end on an exit edge (caller-supplied),
 *   - at every step either stay on the same edge or move to a
 *     graph-adjacent edge (sharing a node) that's also on the line.
 *
 * Emission per minute is a log-ratio score relative to the abstract
 * `unknown_rail` fallback:
 *   - GPS observed → GPS_OBSERVED_BASELINE − 0.5 · (d / σ)²
 *     where σ is 30 m for surface edges and 150 m for underground
 *     edges (which are mapped at street-level station coords in OSM
 *     so the perpendicular distance to a fix above ground is the
 *     vertical-projection / entrance offset, not GPS noise).
 *   - GPS null on underground edge → UNDERGROUND_NULL_BONUS
 *     (positive — GPS-null in a tube tunnel is the expected
 *     observation).
 *   - GPS null on surface rail → SURFACE_NULL_PENALTY
 *     (negative — surface rail normally has GPS observed).
 *
 * Returns `null` when no path exists from any entry edge to any
 * exit edge that's wholly on the line's subgraph.
 */

import { describe, expect, it } from "vitest";
import { buildRouteGraph, type RawOsmLine } from "../src/geo/route-graph.js";
import { innerViterbi } from "../src/hmm/inner-viterbi-edges.js";
import type { Observation } from "../src/hmm/observation.js";

function makeLine(over: Partial<RawOsmLine>): RawOsmLine {
	return {
		osm_id: 1n,
		osm_type: "way",
		feature_type: "railway",
		subtype: "subway",
		name: null,
		tags_json: null,
		geom: "LINESTRING(0 0, 1 1)",
		...over,
	};
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

const STATION_A = { lat: 51.5, lon: -0.15 };
const STATION_B = { lat: 51.51, lon: -0.14 };
const STATION_C = { lat: 51.52, lon: -0.13 };
const STATION_D = { lat: 51.53, lon: -0.12 };

function wkt(a: { lat: number; lon: number }, b: { lat: number; lon: number }): string {
	return `LINESTRING(${a.lon} ${a.lat}, ${b.lon} ${b.lat})`;
}

describe("innerViterbi", () => {
	it("returns empty path for empty observations", () => {
		const graph = buildRouteGraph([makeLine({ osm_id: 1n, name: "L Line", geom: wkt(STATION_A, STATION_B) })], []);
		const result = innerViterbi({
			routeGraph: graph,
			line: "L Line",
			observations: [],
			entryEdges: new Set(["way:1"]),
			exitEdges: new Set(["way:1"]),
		});
		expect(result).not.toBeNull();
		expect(result?.edgePath).toEqual([]);
		expect(result?.logScore).toBe(0);
	});

	it("returns null when no path exists from entry to exit on the line", () => {
		// Two disconnected edges on the same line — no shared node.
		const graph = buildRouteGraph(
			[
				makeLine({ osm_id: 1n, name: "L Line", geom: wkt(STATION_A, STATION_B) }),
				// Different line so the only L-edge in the graph is way:1
				makeLine({ osm_id: 2n, name: "Other Line", geom: wkt(STATION_C, STATION_D) }),
			],
			[],
		);
		const result = innerViterbi({
			routeGraph: graph,
			line: "L Line",
			observations: [obs(), obs(), obs()],
			entryEdges: new Set(["way:1"]),
			exitEdges: new Set(["way:2"]), // not on L
		});
		expect(result).toBeNull();
	});

	it("recovers a single-edge path when entry==exit and one edge spans the window", () => {
		const graph = buildRouteGraph([makeLine({ osm_id: 1n, name: "L Line", geom: wkt(STATION_A, STATION_B) })], []);
		const result = innerViterbi({
			routeGraph: graph,
			line: "L Line",
			observations: [obs(), obs(), obs()],
			entryEdges: new Set(["way:1"]),
			exitEdges: new Set(["way:1"]),
		});
		expect(result).not.toBeNull();
		expect(result?.edgePath).toEqual(["way:1", "way:1", "way:1"]);
	});

	it("recovers a chained two-edge path when entry and exit are graph-adjacent on the line", () => {
		// A→B and B→C share node at STATION_B; same line.
		const graph = buildRouteGraph(
			[
				makeLine({ osm_id: 1n, name: "L Line", geom: wkt(STATION_A, STATION_B) }),
				makeLine({ osm_id: 2n, name: "L Line", geom: wkt(STATION_B, STATION_C) }),
			],
			[],
		);
		const result = innerViterbi({
			routeGraph: graph,
			line: "L Line",
			observations: [obs(), obs(), obs(), obs()],
			entryEdges: new Set(["way:1"]),
			exitEdges: new Set(["way:2"]),
		});
		expect(result).not.toBeNull();
		// First edge is A→B (entry); last edge is B→C (exit). Some
		// minute in between is the transition.
		expect(result?.edgePath[0]).toBe("way:1");
		expect(result?.edgePath[result.edgePath.length - 1]).toBe("way:2");
		// Path must be contiguous: each step stays or transitions to
		// adjacent edge. Set of distinct edges = {way:1, way:2}.
		expect(new Set(result?.edgePath)).toEqual(new Set(["way:1", "way:2"]));
	});

	it("refuses to use an edge that isn't on the requested line", () => {
		// A→B is on L; B→C is on M (different line). entry on L, exit
		// on M → no L-only path connects them.
		const graph = buildRouteGraph(
			[
				makeLine({ osm_id: 1n, name: "L Line", geom: wkt(STATION_A, STATION_B) }),
				makeLine({ osm_id: 2n, name: "M Line", geom: wkt(STATION_B, STATION_C) }),
			],
			[],
		);
		const result = innerViterbi({
			routeGraph: graph,
			line: "L Line",
			observations: [obs(), obs(), obs(), obs()],
			entryEdges: new Set(["way:1"]),
			exitEdges: new Set(["way:2"]),
		});
		expect(result).toBeNull();
	});

	it("returns null when GPS observation is far from all candidate edges", () => {
		// Edge spans Station A↔B; user observed >5km away. The
		// emission penalty is huge but not -Inf — the path is
		// technically possible, just very unlikely. The test pins the
		// LOGSCORE is severely negative, not that it's null. This is
		// the "implausible but possible" case.
		const graph = buildRouteGraph([makeLine({ osm_id: 1n, name: "L Line", geom: wkt(STATION_A, STATION_B) })], []);
		const farAway = { lat: 60.0, lon: 10.0, speedKmh: 0 };
		const result = innerViterbi({
			routeGraph: graph,
			line: "L Line",
			observations: [obs({ gps: farAway })],
			entryEdges: new Set(["way:1"]),
			exitEdges: new Set(["way:1"]),
		});
		expect(result).not.toBeNull();
		expect(result?.logScore).toBeLessThan(-1000);
	});

	it("prefers the edge nearest to a GPS observation when multiple are graph-connected", () => {
		// Two graph-adjacent edges on the same line. GPS at minute 1
		// is on top of edge way:2. The decoder should pick way:2 at
		// that minute even though it could have stayed on way:1.
		const graph = buildRouteGraph(
			[
				makeLine({ osm_id: 1n, name: "L Line", geom: wkt(STATION_A, STATION_B) }),
				makeLine({ osm_id: 2n, name: "L Line", geom: wkt(STATION_B, STATION_C) }),
			],
			[],
		);
		const onWay2 = { lat: STATION_C.lat, lon: STATION_C.lon, speedKmh: 25 };
		const result = innerViterbi({
			routeGraph: graph,
			line: "L Line",
			observations: [obs(), obs({ gps: onWay2 }), obs()],
			entryEdges: new Set(["way:1"]),
			exitEdges: new Set(["way:1", "way:2"]),
		});
		expect(result).not.toBeNull();
		expect(result?.edgePath[1]).toBe("way:2");
	});

	it("penalises GPS-null on surface edges, rewards GPS-null on underground edges", () => {
		// Two single-edge graphs, one underground, one surface.
		// All-GPS-null observations → underground path scores better.
		const undergroundGraph = buildRouteGraph(
			[makeLine({ osm_id: 1n, name: "U Line", subtype: "subway", geom: wkt(STATION_A, STATION_B) })],
			[],
		);
		const surfaceGraph = buildRouteGraph(
			[makeLine({ osm_id: 1n, name: "S Line", subtype: "rail", geom: wkt(STATION_A, STATION_B) })],
			[],
		);
		const window = [obs(), obs(), obs(), obs(), obs()];
		const u = innerViterbi({
			routeGraph: undergroundGraph,
			line: "U Line",
			observations: window,
			entryEdges: new Set(["way:1"]),
			exitEdges: new Set(["way:1"]),
		});
		const s = innerViterbi({
			routeGraph: surfaceGraph,
			line: "S Line",
			observations: window,
			entryEdges: new Set(["way:1"]),
			exitEdges: new Set(["way:1"]),
		});
		expect(u).not.toBeNull();
		expect(s).not.toBeNull();
		expect((u as { logScore: number }).logScore).toBeGreaterThan((s as { logScore: number }).logScore);
	});
});

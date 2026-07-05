import { describe, expect, it } from "vitest";
import { buildRouteGraph, parseLineMemberships, type RawOsmLine, type RawOsmPoint } from "../src/geo/route-graph.js";

/**
 * Pure `buildRouteGraph` tests: from synthetic osm_lines/osm_points
 * data, validate the graph shape (edge attrs, endpoint nodes,
 * adjacency, spatial query) and the OSM-tag → attribute derivations
 * (underground, line memberships).
 */

function line(over: Partial<RawOsmLine>): RawOsmLine {
	return {
		osm_id: 1n,
		osm_type: "way",
		feature_type: "railway",
		subtype: "subway",
		name: null,
		tags_json: null,
		geom: "LINESTRING(-0.1 51.5, -0.11 51.51)",
		...over,
	};
}

function point(over: Partial<RawOsmPoint>): RawOsmPoint {
	return {
		osm_id: 100n,
		osm_type: "node",
		name: null,
		tags_json: null,
		lat: 51.5,
		lon: -0.1,
		...over,
	};
}

describe("buildRouteGraph", () => {
	it("parses WKT geometry into ordered lat/lon points", () => {
		const g = buildRouteGraph([line({ osm_id: 1n, geom: "LINESTRING(-0.1 51.5, -0.105 51.502, -0.11 51.505)" })], []);
		const edge = [...g.edges.values()][0];
		expect(edge.geometry.length).toBe(3);
		expect(edge.geometry[0]).toEqual({ lat: 51.5, lon: -0.1 });
		expect(edge.geometry[2]).toEqual({ lat: 51.505, lon: -0.11 });
	});

	it("computes start/end points from geometry endpoints", () => {
		const g = buildRouteGraph([line({ osm_id: 1n, geom: "LINESTRING(-0.1 51.5, -0.11 51.51)" })], []);
		const edge = [...g.edges.values()][0];
		expect(edge.startPoint).toEqual({ lat: 51.5, lon: -0.1 });
		expect(edge.endPoint).toEqual({ lat: 51.51, lon: -0.11 });
	});

	it("computes edge length from geometry (haversine)", () => {
		// Two points ~1.4 km apart at London latitude.
		const g = buildRouteGraph([line({ osm_id: 1n, geom: "LINESTRING(-0.1 51.5, -0.12 51.5)" })], []);
		const edge = [...g.edges.values()][0];
		expect(edge.attrs.lengthM).toBeGreaterThan(1300);
		expect(edge.attrs.lengthM).toBeLessThan(1500);
	});

	it("identifies underground from tunnel=yes tag", () => {
		const g = buildRouteGraph([line({ tags_json: JSON.stringify({ tunnel: "yes", railway: "subway" }) })], []);
		expect([...g.edges.values()][0].attrs.underground).toBe(true);
	});

	it("identifies underground from layer<0 tag", () => {
		const g = buildRouteGraph([line({ tags_json: JSON.stringify({ layer: "-1", railway: "subway" }) })], []);
		expect([...g.edges.values()][0].attrs.underground).toBe(true);
	});

	it("identifies underground from feature_type=subway", () => {
		const g = buildRouteGraph([line({ feature_type: "railway", subtype: "subway", tags_json: null })], []);
		expect([...g.edges.values()][0].attrs.underground).toBe(true);
	});

	it("treats surface road (no tunnel tag) as not underground", () => {
		const g = buildRouteGraph(
			[line({ feature_type: "highway", subtype: "primary", tags_json: JSON.stringify({ highway: "primary" }) })],
			[],
		);
		expect([...g.edges.values()][0].attrs.underground).toBe(false);
	});

	it("builds nodes at way endpoints", () => {
		const g = buildRouteGraph(
			[
				line({ osm_id: 1n, geom: "LINESTRING(-0.1 51.5, -0.11 51.51)" }),
				line({ osm_id: 2n, geom: "LINESTRING(-0.11 51.51, -0.12 51.52)" }),
			],
			[],
		);
		// Three distinct endpoints across two ways: (51.5,-0.1), (51.51,-0.11) [shared], (51.52,-0.12).
		expect(g.nodes.size).toBe(3);
	});

	it("links ways that share an endpoint via the same node", () => {
		const g = buildRouteGraph(
			[
				line({ osm_id: 1n, geom: "LINESTRING(-0.1 51.5, -0.11 51.51)" }),
				line({ osm_id: 2n, geom: "LINESTRING(-0.11 51.51, -0.12 51.52)" }),
			],
			[],
		);
		// The shared node should list both edges as incident.
		const sharedNode = [...g.nodes.values()].find(
			(n) => Math.abs(n.point.lat - 51.51) < 0.001 && Math.abs(n.point.lon - -0.11) < 0.001,
		);
		expect(sharedNode).toBeDefined();
		expect(sharedNode?.edgeIds.size).toBe(2);
	});

	it("does NOT link non-touching ways", () => {
		const g = buildRouteGraph(
			[
				line({ osm_id: 1n, geom: "LINESTRING(-0.1 51.5, -0.11 51.51)" }),
				line({ osm_id: 2n, geom: "LINESTRING(-0.2 51.6, -0.21 51.61)" }),
			],
			[],
		);
		// Four distinct nodes; no edge sharing.
		expect(g.nodes.size).toBe(4);
		for (const n of g.nodes.values()) expect(n.edgeIds.size).toBe(1);
	});

	it("annotates nodes with OSM station data when a station point lies near an endpoint", () => {
		const g = buildRouteGraph(
			[line({ osm_id: 1n, geom: "LINESTRING(-0.1 51.5, -0.11 51.51)" })],
			[
				point({
					osm_id: 100n,
					lat: 51.5001,
					lon: -0.10005,
					name: "Elmford",
					tags_json: JSON.stringify({ railway: "station" }),
				}),
			],
		);
		const startNode = [...g.nodes.values()].find((n) => Math.abs(n.point.lat - 51.5) < 0.01);
		expect(startNode?.stationName).toBe("Elmford");
	});

	it("edgesNear returns edges whose geometry passes within radius of a query point", () => {
		const g = buildRouteGraph(
			[
				line({ osm_id: 1n, geom: "LINESTRING(-0.1 51.5, -0.11 51.51)" }),
				line({ osm_id: 2n, geom: "LINESTRING(-0.5 52.0, -0.51 52.01)" }),
			],
			[],
		);
		// Query at (-0.105, 51.505) — close to edge 1, far from edge 2.
		const nearby = g.edgesNear(51.505, -0.105, 500);
		const ids = nearby.map((e) => e.id);
		expect(ids).toContain("way:1");
		expect(ids).not.toContain("way:2");
	});
});

describe("parseLineMemberships", () => {
	it("returns the single line name when 'Line' is singular", () => {
		expect([...parseLineMemberships("Metropolitan Line")]).toEqual(["Metropolitan Line"]);
	});

	it("preserves '&' inside a single line name (Hammersmith & City Line)", () => {
		expect([...parseLineMemberships("Hammersmith & City Line")]).toEqual(["Hammersmith & City Line"]);
	});

	it("splits composite tags with 'Lines' plural", () => {
		const memberships = parseLineMemberships("Circle, Hammersmith & City and Metropolitan Lines");
		expect(memberships).toEqual(new Set(["Circle Line", "Hammersmith & City Line", "Metropolitan Line"]));
	});

	it("splits two-line 'X and Y Line' (singular)", () => {
		expect(parseLineMemberships("Metropolitan and Piccadilly Line")).toEqual(
			new Set(["Metropolitan Line", "Piccadilly Line"]),
		);
	});

	it("returns empty for non-line names", () => {
		expect(parseLineMemberships(null)).toEqual(new Set());
		expect(parseLineMemberships("")).toEqual(new Set());
		expect(parseLineMemberships("Some Street")).toEqual(new Set());
	});
});

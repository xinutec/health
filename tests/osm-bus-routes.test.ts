import { describe, expect, it } from "vitest";
import { buildBusRouteOverpassQuery, extractBusRoutes } from "../src/geo/osm-bus-routes.js";

describe("buildBusRouteOverpassQuery", () => {
	it("emits a route=bus relation query with members + member nodes for the bbox", () => {
		const q = buildBusRouteOverpassQuery({ minLat: 51.5, minLon: -0.2, maxLat: 51.6, maxLon: -0.1 });
		expect(q).toContain("relation[route=bus](51.5,-0.2,51.6,-0.1)");
		expect(q).toContain("out body;");
		expect(q).toContain("node(r);"); // pulls member nodes (coords + names)
		expect(q).toContain("[out:json]");
	});
});

/**
 * `extractBusRoutes` parses OSM `route=bus` relations into ordered stop
 * lists for the bus-route matcher. Pins: member order is preserved as
 * route direction, only `ref`-bearing routes with ≥2 resolvable stops are
 * kept, stop names join from the member nodes, and platform members are a
 * fallback when stop_position nodes are absent. Synthetic Overpass JSON.
 */

// A node element (id + coords + optional name).
function node(id: number, lat: number, lon: number, name?: string) {
	return { type: "node", id, lat, lon, ...(name ? { tags: { name } } : {}) };
}

// A route=bus relation with ordered stop members (role "stop").
function busRelation(
	id: number,
	ref: string | undefined,
	name: string | undefined,
	stopRefs: Array<{ ref: number; role?: string }>,
) {
	return {
		type: "relation",
		id,
		tags: { type: "route", route: "bus", ...(ref ? { ref } : {}), ...(name ? { name } : {}) },
		members: stopRefs.map((s) => ({ type: "node", ref: s.ref, role: s.role ?? "stop" })),
	};
}

describe("extractBusRoutes", () => {
	it("returns no routes for an empty response", () => {
		expect(extractBusRoutes({})).toEqual([]);
		expect(extractBusRoutes({ elements: [] })).toEqual([]);
	});

	it("parses a route's stops in member order with names joined from nodes", () => {
		const data = {
			elements: [
				node(101, 51.5, -0.14, "Farvale"),
				node(102, 51.5, -0.13, "Hyde Park Corner"),
				node(103, 51.5, -0.12, "Victoria"),
				busRelation(9, "38", "Clapton Pond – Victoria", [{ ref: 101 }, { ref: 102 }, { ref: 103 }]),
			],
		};
		const routes = extractBusRoutes(data);
		expect(routes).toHaveLength(1);
		expect(routes[0].routeRef).toBe("38");
		expect(routes[0].routeName).toBe("Clapton Pond – Victoria");
		expect(routes[0].osmRelationId).toBe(9);
		expect(routes[0].stops.map((s) => s.name)).toEqual(["Farvale", "Hyde Park Corner", "Victoria"]);
		expect(routes[0].stops.map((s) => s.seq)).toEqual([0, 1, 2]);
	});

	it("drops a relation with no route ref (can't label it)", () => {
		const data = {
			elements: [
				node(1, 51.5, -0.14, "A"),
				node(2, 51.5, -0.13, "B"),
				busRelation(9, undefined, "Unnumbered", [{ ref: 1 }, { ref: 2 }]),
			],
		};
		expect(extractBusRoutes(data)).toEqual([]);
	});

	it("drops a route that resolves to fewer than two stops", () => {
		const data = {
			elements: [
				node(1, 51.5, -0.14, "Only stop"),
				// ref 2 has no matching node element → unresolvable.
				busRelation(9, "38", "Route 38", [{ ref: 1 }, { ref: 2 }]),
			],
		};
		expect(extractBusRoutes(data)).toEqual([]);
	});

	it("keeps two directions as separate routes with opposite stop order", () => {
		const data = {
			elements: [
				node(1, 51.5, -0.14, "West End"),
				node(2, 51.5, -0.12, "East End"),
				busRelation(10, "38", "38 outbound", [{ ref: 1 }, { ref: 2 }]),
				busRelation(11, "38", "38 inbound", [{ ref: 2 }, { ref: 1 }]),
			],
		};
		const routes = extractBusRoutes(data);
		expect(routes).toHaveLength(2);
		expect(routes[0].stops.map((s) => s.name)).toEqual(["West End", "East End"]);
		expect(routes[1].stops.map((s) => s.name)).toEqual(["East End", "West End"]);
	});

	it("falls back to platform members when the route has no stop_position nodes", () => {
		const data = {
			elements: [
				node(1, 51.5, -0.14, "P1"),
				node(2, 51.5, -0.12, "P2"),
				busRelation(9, "38", "Route 38", [
					{ ref: 1, role: "platform" },
					{ ref: 2, role: "platform" },
				]),
			],
		};
		const routes = extractBusRoutes(data);
		expect(routes).toHaveLength(1);
		expect(routes[0].stops.map((s) => s.name)).toEqual(["P1", "P2"]);
	});

	it("ignores non-bus route relations and way members", () => {
		const data = {
			elements: [
				node(1, 51.5, -0.14, "A"),
				node(2, 51.5, -0.12, "B"),
				// A rail route — not bus.
				{
					type: "relation",
					id: 5,
					tags: { type: "route", route: "subway", ref: "Jubilee" },
					members: [
						{ type: "node", ref: 1, role: "stop" },
						{ type: "node", ref: 2, role: "stop" },
					],
				},
				// A bus relation whose stops are way members (no node coords).
				{
					type: "relation",
					id: 6,
					tags: { type: "route", route: "bus", ref: "X" },
					members: [
						{ type: "way", ref: 999, role: "" },
						{ type: "way", ref: 998, role: "" },
					],
				},
			],
		};
		expect(extractBusRoutes(data)).toEqual([]);
	});

	it("leaves stop name null when the member node carries no name tag", () => {
		const data = {
			elements: [
				node(1, 51.5, -0.14),
				node(2, 51.5, -0.12, "Named"),
				busRelation(9, "38", "Route 38", [{ ref: 1 }, { ref: 2 }]),
			],
		};
		const routes = extractBusRoutes(data);
		expect(routes[0].stops[0].name).toBeNull();
		expect(routes[0].stops[1].name).toBe("Named");
	});
});

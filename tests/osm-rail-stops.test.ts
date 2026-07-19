import { describe, expect, it } from "vitest";
import { buildRailStopsOverpassQuery, extractRailStopRelations } from "../src/geo/osm-rail-stops.js";

/**
 * `extractRailStopRelations` parses OSM rail route relations
 * (subway/train/light_rail/tram) into ordered stop lists — the
 * served-station data foundation (#364). Pins: member order is preserved,
 * a relation is kept when it carries a `ref` OR a `name` (rail relations
 * often lack `ref`, unlike buses), unnamed stop_position nodes survive
 * with `name: null` (their coords still resolve against station
 * footprints), platform members are the fallback role set, and non-rail
 * route types are ignored. Synthetic Overpass JSON.
 */

function node(id: number, lat: number, lon: number, name?: string) {
	return { type: "node", id, lat, lon, ...(name ? { tags: { name } } : {}) };
}

function railRelation(
	id: number,
	route: string,
	tags: { ref?: string; name?: string },
	stopRefs: Array<{ ref: number; role?: string }>,
) {
	return {
		type: "relation",
		id,
		tags: { type: "route", route, ...tags },
		members: stopRefs.map((s) => ({ type: "node", ref: s.ref, role: s.role ?? "stop" })),
	};
}

describe("buildRailStopsOverpassQuery", () => {
	it("emits a rail route-relation query with members + member nodes for the bbox", () => {
		const q = buildRailStopsOverpassQuery({ minLat: 51.5, minLon: -0.2, maxLat: 51.6, maxLon: -0.1 });
		expect(q).toContain('relation[route~"^(subway|train|light_rail|tram)$"](51.5,-0.2,51.6,-0.1)');
		expect(q).toContain("out body;");
		expect(q).toContain("node(r);"); // pulls member nodes (coords + names)
		expect(q).toContain("[out:json]");
	});
});

describe("extractRailStopRelations", () => {
	it("returns nothing for an empty response", () => {
		expect(extractRailStopRelations({})).toEqual([]);
		expect(extractRailStopRelations({ elements: [] })).toEqual([]);
	});

	it("parses a subway relation's stops in member order with names joined from nodes", () => {
		const data = {
			elements: [
				node(101, 51.56, -0.28, "Wembley Park"),
				node(102, 51.55, -0.25, "Neasden"),
				node(103, 51.52, -0.16, "Baker Street"),
				railRelation(9, "subway", { name: "Jubilee line: Stanmore → Stratford" }, [
					{ ref: 101 },
					{ ref: 102 },
					{ ref: 103 },
				]),
			],
		};
		const rels = extractRailStopRelations(data);
		expect(rels).toHaveLength(1);
		expect(rels[0].osmRelationId).toBe(9);
		expect(rels[0].routeType).toBe("subway");
		expect(rels[0].lineRef).toBeNull();
		expect(rels[0].lineName).toBe("Jubilee line: Stanmore → Stratford");
		expect(rels[0].stops.map((s) => s.name)).toEqual(["Wembley Park", "Neasden", "Baker Street"]);
		expect(rels[0].stops.map((s) => s.seq)).toEqual([0, 1, 2]);
	});

	it("keeps a relation that has a ref but no name", () => {
		const data = {
			elements: [
				node(1, 51.5, -0.14, "A"),
				node(2, 51.5, -0.13, "B"),
				railRelation(9, "train", { ref: "TL" }, [{ ref: 1 }, { ref: 2 }]),
			],
		};
		const rels = extractRailStopRelations(data);
		expect(rels).toHaveLength(1);
		expect(rels[0].lineRef).toBe("TL");
		expect(rels[0].lineName).toBeNull();
	});

	it("drops a relation with neither ref nor name (nothing to match a line against)", () => {
		const data = {
			elements: [
				node(1, 51.5, -0.14, "A"),
				node(2, 51.5, -0.13, "B"),
				railRelation(9, "subway", {}, [{ ref: 1 }, { ref: 2 }]),
			],
		};
		expect(extractRailStopRelations(data)).toEqual([]);
	});

	it("keeps unnamed stop_position nodes with name null (coords still usable)", () => {
		const data = {
			elements: [
				node(1, 51.5, -0.14),
				node(2, 51.5, -0.13, "Named"),
				railRelation(9, "subway", { name: "L" }, [{ ref: 1 }, { ref: 2 }]),
			],
		};
		const rels = extractRailStopRelations(data);
		expect(rels[0].stops[0].name).toBeNull();
		expect(rels[0].stops[1].name).toBe("Named");
	});

	it("drops a relation that resolves to fewer than two stops", () => {
		const data = {
			elements: [
				node(1, 51.5, -0.14, "Only stop"),
				// ref 2 has no matching node element → unresolvable.
				railRelation(9, "subway", { name: "L" }, [{ ref: 1 }, { ref: 2 }]),
			],
		};
		expect(extractRailStopRelations(data)).toEqual([]);
	});

	it("falls back to platform members when the relation has no stop_position nodes", () => {
		const data = {
			elements: [
				node(1, 51.5, -0.14, "P1"),
				node(2, 51.5, -0.12, "P2"),
				railRelation(9, "light_rail", { name: "DLR: Bank → Lewisham" }, [
					{ ref: 1, role: "platform" },
					{ ref: 2, role: "platform" },
				]),
			],
		};
		const rels = extractRailStopRelations(data);
		expect(rels).toHaveLength(1);
		expect(rels[0].stops.map((s) => s.name)).toEqual(["P1", "P2"]);
	});

	it("keeps two directions as separate relations with opposite stop order", () => {
		const data = {
			elements: [
				node(1, 51.5, -0.14, "West"),
				node(2, 51.5, -0.12, "East"),
				railRelation(10, "subway", { name: "L: out" }, [{ ref: 1 }, { ref: 2 }]),
				railRelation(11, "subway", { name: "L: back" }, [{ ref: 2 }, { ref: 1 }]),
			],
		};
		const rels = extractRailStopRelations(data);
		expect(rels).toHaveLength(2);
		expect(rels[0].stops.map((s) => s.name)).toEqual(["West", "East"]);
		expect(rels[1].stops.map((s) => s.name)).toEqual(["East", "West"]);
	});

	it("ignores bus relations and route_master relations", () => {
		const data = {
			elements: [
				node(1, 51.5, -0.14, "A"),
				node(2, 51.5, -0.12, "B"),
				railRelation(5, "bus", { ref: "38" }, [{ ref: 1 }, { ref: 2 }]),
				{
					type: "relation",
					id: 6,
					tags: { type: "route_master", route_master: "subway", name: "Jubilee line" },
					members: [
						{ type: "relation", ref: 10, role: "" },
						{ type: "relation", ref: 11, role: "" },
					],
				},
			],
		};
		expect(extractRailStopRelations(data)).toEqual([]);
	});
});

import { describe, expect, it } from "vitest";
import { type BusRouteCacheRow, parseBusRouteRow, serializeBusRoute } from "../src/geo/bus-route-cache.js";
import type { BusRoute } from "../src/geo/bus-route-match.js";

/**
 * `bus_route_cache` row⇄BusRoute round-trip. Pins: serialize/parse is
 * lossless (incl. stop order), a BIGINT relation id narrows to number,
 * and malformed/short rows degrade to null rather than throwing on the
 * request path.
 */

const route: BusRoute = {
	routeRef: "38",
	routeName: "Clapton Pond – Victoria",
	osmRelationId: 17_413,
	stops: [
		{ name: "Farvale", lat: 51.5, lon: -0.14, seq: 0 },
		{ name: null, lat: 51.5, lon: -0.13, seq: 1 },
		{ name: "Victoria", lat: 51.5, lon: -0.12, seq: 2 },
	],
};

describe("bus_route_cache (de)serialization", () => {
	it("round-trips a route through serialize → parse losslessly", () => {
		const row = serializeBusRoute(route);
		const back = parseBusRouteRow(row);
		expect(back).toEqual(route);
	});

	it("preserves stop order (route direction) across the round-trip", () => {
		const back = parseBusRouteRow(serializeBusRoute(route));
		expect(back?.stops.map((s) => s.seq)).toEqual([0, 1, 2]);
		expect(back?.stops.map((s) => s.name)).toEqual(["Farvale", null, "Victoria"]);
	});

	it("narrows a BIGINT relation id (bigint) to number", () => {
		const row: BusRouteCacheRow = { ...serializeBusRoute(route), osm_relation_id: 17_413n };
		expect(parseBusRouteRow(row)?.osmRelationId).toBe(17_413);
	});

	it("returns null on malformed stops_json instead of throwing", () => {
		const row: BusRouteCacheRow = { ...serializeBusRoute(route), stops_json: "{not json" };
		expect(parseBusRouteRow(row)).toBeNull();
	});

	it("returns null when stops_json is not an array", () => {
		const row: BusRouteCacheRow = { ...serializeBusRoute(route), stops_json: '{"a":1}' };
		expect(parseBusRouteRow(row)).toBeNull();
	});

	it("drops a row that deserializes to fewer than two stops", () => {
		const row: BusRouteCacheRow = {
			...serializeBusRoute(route),
			stops_json: JSON.stringify([{ name: "Solo", lat: 51.5, lon: -0.14, seq: 0 }]),
		};
		expect(parseBusRouteRow(row)).toBeNull();
	});
});

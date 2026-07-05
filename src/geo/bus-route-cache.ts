/**
 * `bus_route_cache` (de)serialization + read — the storage seam between
 * the offline mirror (refresh-bus-routes CLI writes rows) and the request
 * path (velocity reads `BusRoute[]` for the matcher). The row⇄`BusRoute`
 * conversion is pure and round-trip-tested; the DB read is a thin wrapper.
 */

import { db } from "../db/pool.js";
import type { BusRoute, BusStop } from "./bus-route-match.js";

/** The cache columns this module reads/writes (subset of the table). */
export interface BusRouteCacheRow {
	osm_relation_id: number | bigint;
	route_ref: string;
	route_name: string | null;
	stops_json: string;
}

/** A `BusRoute` flattened to its cache row. `stops_json` is the ordered
 *  stop array verbatim — the matcher relies on that order for direction. */
export function serializeBusRoute(route: BusRoute): {
	osm_relation_id: number;
	route_ref: string;
	route_name: string | null;
	stops_json: string;
} {
	return {
		osm_relation_id: route.osmRelationId,
		route_ref: route.routeRef,
		route_name: route.routeName,
		stops_json: JSON.stringify(route.stops),
	};
}

/** Rebuild a `BusRoute` from a cache row. Narrows the BIGINT relation id
 *  (returned as bigint) to number — relation ids are well under 2^53.
 *  Returns null on malformed `stops_json` or a route left with < 2 stops,
 *  so a corrupt row degrades to "no candidate", never a throw on the
 *  request path. */
export function parseBusRouteRow(row: BusRouteCacheRow): BusRoute | null {
	let stops: BusStop[];
	try {
		const parsed = JSON.parse(row.stops_json);
		if (!Array.isArray(parsed)) return null;
		stops = parsed as BusStop[];
	} catch {
		return null;
	}
	if (stops.length < 2) return null;
	return {
		routeRef: row.route_ref,
		routeName: row.route_name,
		osmRelationId: Number(row.osm_relation_id),
		stops,
	};
}

/** Load every mirrored bus route. The table is global (not user-scoped)
 *  and small — a city's routes are a few thousand stops of JSON in total.
 *  Malformed rows are dropped (see `parseBusRouteRow`). */
export async function loadAllBusRoutes(): Promise<BusRoute[]> {
	let rows: BusRouteCacheRow[];
	try {
		rows = await db()
			.selectFrom("bus_route_cache")
			.select(["osm_relation_id", "route_ref", "route_name", "stops_json"])
			.execute();
	} catch (e: unknown) {
		// The bus mirror is a pure, optional cache: a missing table (e.g. a
		// fresh deploy whose migration hasn't run) or any read error must
		// degrade to "no routes" — bus naming is purely additive, and it
		// must NEVER take down the whole day's timeline. Mirrors the
		// defensive posture of the biometrics/venue-prior loaders.
		console.warn(`loadAllBusRoutes failed — treating as no bus routes: ${e}`);
		return [];
	}
	const routes: BusRoute[] = [];
	for (const r of rows) {
		const route = parseBusRouteRow(r);
		if (route) routes.push(route);
	}
	return routes;
}

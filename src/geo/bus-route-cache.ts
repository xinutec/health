/**
 * `bus_route_cache` (de)serialization + read — the storage seam between
 * the offline mirror (refresh-bus-routes CLI writes rows) and the request
 * path (velocity reads `BusRoute[]` for the matcher). The row⇄`BusRoute`
 * conversion is pure and round-trip-tested; the DB read is a thin wrapper.
 */

import { db } from "../db/pool.js";
import { errorText } from "../util/error-text.js";
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
		console.warn(`loadAllBusRoutes failed — treating as no bus routes: ${errorText(e)}`);
		return [];
	}
	const routes: BusRoute[] = [];
	for (const r of rows) {
		const route = parseBusRouteRow(r);
		if (route) routes.push(route);
	}
	return routes;
}

/** A rebuild may not drop the mirror below this fraction of what it already
 *  held WHEN TILES FAILED. A shrink is legitimate data — routes leave OSM, the
 *  home region moves — but only a run that fetched everything it asked for can
 *  claim it. */
const SHRINK_FLOOR = 0.8;

/**
 * Should this rebuild be refused, and why?
 *
 * The rebuild is a DELETE + INSERT of the whole table, so a bad run does not
 * degrade the mirror gracefully — it replaces it. The original guard refused
 * only when EVERY tile failed, which is the one case that cannot happen
 * quietly: a run where 90 of 100 tiles fail returns a plausible-looking handful
 * of routes and overwrites a healthy 995 with them, and nothing in the output
 * says the mirror just lost 90% of its content.
 *
 * That mattered little while the cron was suspended and every run was watched.
 * It is the whole risk once the job runs unattended at 05:30, which is what
 * #255 asks for. So: a shrink past {@link SHRINK_FLOOR} is refused when any
 * tile failed, and allowed when none did.
 *
 * Exported and pure so the decision is testable without a DB or Overpass.
 */
export function rebuildRefusal(existing: number, fetched: number, tileFailures: number): string | null {
	if (tileFailures === 0) return null; // a complete run is authoritative, whatever it found
	if (fetched === 0) return `Every tile failed and the cache holds ${existing} route(s)`;
	if (existing > 0 && fetched < existing * SHRINK_FLOOR)
		return `${tileFailures} tile(s) failed and the rebuild would cut the mirror ${existing} -> ${fetched} route(s)`;
	return null;
}

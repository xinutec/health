/**
 * Parse OSM `route=bus` relations into ordered `BusRoute` stop lists —
 * the mirror-ingestion half of C-bus (`bus-route-match.ts` is the matcher
 * that consumes them). Pure, like `extractLineNames` in `osm.ts`: it takes
 * a decoded Overpass response and returns routes, so the parsing is
 * testable without a network or a database.
 *
 * The expected Overpass query outputs each route relation (ordered
 * members + tags) followed by the relation's member nodes (id + lat/lon +
 * tags):
 *
 *     [out:json][timeout:90];
 *     relation[route=bus]({{bbox}});
 *     out body;
 *     node(r);
 *     out body;
 *
 * A relation's stop sequence is read from its members IN ORDER — that
 * order is the route direction the matcher relies on. OSM models each
 * direction as its own relation, so an outbound and a return route arrive
 * as two `BusRoute`s with opposite stop orders, exactly what the matcher
 * wants.
 */

import type { BusRoute, BusStop } from "./bus-route-match.js";

/** Build the Overpass QL that the refresh-bus-routes mirror runs: every
 *  `route=bus` relation intersecting the bbox, its ordered members, then
 *  the member nodes (coords + name tags). `node(r)` returns the FULL stop
 *  list of any route that merely touches the bbox, so a route the user
 *  rides is mirrored end to end even when only its middle passes nearby.
 *  Pure string builder — kept here so the query shape is unit-testable. */
export function buildBusRouteOverpassQuery(bbox: {
	minLat: number;
	minLon: number;
	maxLat: number;
	maxLon: number;
}): string {
	const box = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`;
	return `[out:json][timeout:180];relation[route=bus](${box});out body;node(r);out body;`;
}

interface OverpassMember {
	type?: string;
	ref?: number;
	role?: string;
}

interface OverpassElement {
	type?: string;
	id?: number;
	lat?: number;
	lon?: number;
	tags?: Record<string, string | undefined>;
	members?: readonly OverpassMember[];
}

/** PT-v2 member roles that mark where riders board/alight (the node the
 *  vehicle actually stops at). Platforms are the fallback when a route is
 *  mapped without `stop_position` nodes. */
const STOP_ROLES = new Set(["stop", "stop_entry_only", "stop_exit_only"]);
const PLATFORM_ROLES = new Set(["platform", "platform_entry_only", "platform_exit_only"]);

interface ResolvedNode {
	lat: number;
	lon: number;
	name: string | null;
}

/** Collect the ordered, resolvable stop nodes for one relation under a
 *  given set of accepted roles. */
function stopsForRoles(
	members: readonly OverpassMember[],
	nodes: ReadonlyMap<number, ResolvedNode>,
	roles: ReadonlySet<string>,
): BusStop[] {
	const stops: BusStop[] = [];
	for (const m of members) {
		if (m.type !== "node" || m.ref === undefined || m.role === undefined) continue;
		if (!roles.has(m.role)) continue;
		const node = nodes.get(m.ref);
		if (!node) continue;
		stops.push({ name: node.name, lat: node.lat, lon: node.lon, seq: stops.length });
	}
	return stops;
}

/**
 * Extract every nameable bus route from an Overpass response. A relation
 * is kept only when it carries a route `ref` (the rider-facing number,
 * e.g. "38") and resolves to ≥ 2 ordered stops — a route we can neither
 * name nor anchor a ride to is dropped, never guessed.
 */
export function extractBusRoutes(data: { elements?: readonly OverpassElement[] }): BusRoute[] {
	const elements = data.elements ?? [];

	// Pass 1: index member nodes by id (lat/lon + name).
	const nodes = new Map<number, ResolvedNode>();
	for (const el of elements) {
		if (el.type !== "node" || el.id === undefined || el.lat === undefined || el.lon === undefined) continue;
		nodes.set(el.id, { lat: el.lat, lon: el.lon, name: el.tags?.name ?? null });
	}

	// Pass 2: build a route per qualifying relation.
	const routes: BusRoute[] = [];
	for (const el of elements) {
		if (el.type !== "relation" || el.id === undefined || !el.members) continue;
		const tags = el.tags ?? {};
		if (tags.type !== "route" || tags.route !== "bus") continue;
		const routeRef = tags.ref;
		if (!routeRef) continue;

		// Prefer stop_position nodes; fall back to platforms when a route
		// is mapped without them.
		let stops = stopsForRoles(el.members, nodes, STOP_ROLES);
		if (stops.length < 2) stops = stopsForRoles(el.members, nodes, PLATFORM_ROLES);
		if (stops.length < 2) continue;

		routes.push({
			routeRef,
			routeName: tags.name ?? null,
			osmRelationId: el.id,
			stops,
		});
	}
	return routes;
}

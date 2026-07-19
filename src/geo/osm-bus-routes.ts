/**
 * Parse OSM `route=bus` relations into ordered `BusRoute` stop lists —
 * the mirror-ingestion half of C-bus (`bus-route-match.ts` is the matcher
 * that consumes them). Pure, like `extractLineNames` in `osm.ts`: it takes
 * a decoded Overpass response and returns routes, so the parsing is
 * testable without a network or a database. The member-walk itself
 * (node indexing, stop-role preference, platform fallback) lives in
 * `osm-route-members.ts`, shared with the rail-stops extractor.
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

import type { BusRoute } from "./bus-route-match.js";
import { indexMemberNodes, type OverpassElement, resolveOrderedStops } from "./osm-route-members.js";

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

/**
 * Extract every nameable bus route from an Overpass response. A relation
 * is kept only when it carries a route `ref` (the rider-facing number,
 * e.g. "38") and resolves to ≥ 2 ordered stops — a route we can neither
 * name nor anchor a ride to is dropped, never guessed.
 */
export function extractBusRoutes(data: { elements?: readonly OverpassElement[] }): BusRoute[] {
	const elements = data.elements ?? [];
	const nodes = indexMemberNodes(elements);

	const routes: BusRoute[] = [];
	for (const el of elements) {
		if (el.type !== "relation" || el.id === undefined || !el.members) continue;
		const tags = el.tags ?? {};
		if (tags.type !== "route" || tags.route !== "bus") continue;
		const routeRef = tags.ref;
		if (!routeRef) continue;

		const stops = resolveOrderedStops(el.members, nodes);
		if (stops.length === 0) continue;

		routes.push({
			routeRef,
			routeName: tags.name ?? null,
			osmRelationId: el.id,
			stops,
		});
	}
	return routes;
}

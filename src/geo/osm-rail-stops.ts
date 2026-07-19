/**
 * Parse OSM rail route relations (subway / train / light_rail / tram)
 * into ordered stop lists — the served-station data foundation (#364).
 *
 * # Why this exists
 *
 * "Does line L serve station S" has so far been inferred by proximity
 * (`stationsOnLine`, 300 m to any way of the line). That is deliberately
 * over-inclusive and structurally cannot express passing-without-stopping:
 * Dollis Hill lies within 300 m of the Metropolitan's fast tracks, but the
 * Met does not stop there — exactly the shared-corridor ambiguity behind
 * the 2026-07-16 wrong-line case. A route relation's `stop`-role members
 * are the ground truth: the ordered stations the service actually calls
 * at.
 *
 * Pure, like `extractBusRoutes`: takes a decoded Overpass response,
 * returns relations. The member-walk (node indexing, stop-role
 * preference, platform fallback) is shared via `osm-route-members.ts`.
 *
 * A relation's stop sequence is read from its members IN ORDER; OSM
 * models each direction (and each service variant) as its own relation,
 * so consumers see one row per variant and union or sequence-match as
 * they need. Unlike buses, rail relations are kept on `ref` OR `name` —
 * tube route relations often carry only a name ("Jubilee line: Stanmore →
 * Stratford") — and unnamed stop_position nodes are kept with
 * `name: null`, because their coords still resolve against station
 * footprints (the 150 m merge radius in the route graph).
 */

import { indexMemberNodes, type OverpassElement, type RouteStop, resolveOrderedStops } from "./osm-route-members.js";

/** The OSM `route=*` values that are rail services. Tram is included:
 *  several systems the pipeline labels as rail (e.g. DLR-like light
 *  metro) are tagged `tram`, and over-mirroring an unused mode costs a
 *  few rows, while under-mirroring silently loses a network. */
export const RAIL_ROUTE_TYPES = ["subway", "train", "light_rail", "tram"] as const;

export interface RailStopRelation {
	osmRelationId: number;
	/** The relation's `route=` value: subway | train | light_rail | tram. */
	routeType: string;
	/** The relation's `ref` tag (e.g. "TL"), when present. */
	lineRef: string | null;
	/** The relation's `name` tag (e.g. "Jubilee line: Stanmore →
	 *  Stratford"), when present. At least one of lineRef / lineName is
	 *  non-null — a relation with neither is dropped (nothing to match a
	 *  pipeline line label against). */
	lineName: string | null;
	/** Ordered stops (route direction), ≥ 2. */
	stops: RouteStop[];
}

/** Build the Overpass QL the refresh-rail-stops mirror runs: every rail
 *  route relation intersecting the bbox, its ordered members, then the
 *  member nodes (coords + name tags). `node(r)` returns the FULL stop
 *  list of any relation that merely touches the bbox, so a line the user
 *  rides is mirrored end to end. Pure string builder — unit-testable. */
export function buildRailStopsOverpassQuery(bbox: {
	minLat: number;
	minLon: number;
	maxLat: number;
	maxLon: number;
}): string {
	const box = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`;
	const routeRe = `^(${RAIL_ROUTE_TYPES.join("|")})$`;
	return `[out:json][timeout:180];relation[route~"${routeRe}"](${box});out body;node(r);out body;`;
}

/**
 * Extract every matchable rail route relation from an Overpass response.
 * A relation is kept only when it carries a `ref` or a `name` (something
 * to match a pipeline line label against) and resolves to ≥ 2 ordered
 * stops — a relation that can't identify a line or anchor a call pattern
 * is dropped, never guessed.
 */
export function extractRailStopRelations(data: { elements?: readonly OverpassElement[] }): RailStopRelation[] {
	const elements = data.elements ?? [];
	const nodes = indexMemberNodes(elements);
	const railTypes = new Set<string>(RAIL_ROUTE_TYPES);

	const relations: RailStopRelation[] = [];
	for (const el of elements) {
		if (el.type !== "relation" || el.id === undefined || !el.members) continue;
		const tags = el.tags ?? {};
		if (tags.type !== "route" || tags.route === undefined || !railTypes.has(tags.route)) continue;
		const lineRef = tags.ref ?? null;
		const lineName = tags.name ?? null;
		if (lineRef === null && lineName === null) continue;

		const stops = resolveOrderedStops(el.members, nodes);
		if (stops.length === 0) continue;

		relations.push({ osmRelationId: el.id, routeType: tags.route, lineRef, lineName, stops });
	}
	return relations;
}

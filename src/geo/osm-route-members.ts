/**
 * Shared member-resolution core for OSM `route=*` relation parsing —
 * the common half of the bus (`osm-bus-routes.ts`) and rail
 * (`osm-rail-stops.ts`) mirror extractors. Both walk a decoded Overpass
 * response the same way: index the member nodes by id, then read each
 * relation's stop sequence from its members IN ORDER (that order is the
 * route direction), preferring PT-v2 `stop_position` roles and falling
 * back to platforms when a route is mapped without them. Pure — no
 * network, no database.
 */

export interface OverpassMember {
	type?: string;
	ref?: number;
	role?: string;
}

export interface OverpassElement {
	type?: string;
	id?: number;
	lat?: number;
	lon?: number;
	tags?: Record<string, string | undefined>;
	members?: readonly OverpassMember[];
}

/** An ordered stop resolved from a relation member node. `seq` is the
 *  position within the relation's stop sequence (route direction). */
export interface RouteStop {
	name: string | null;
	lat: number;
	lon: number;
	seq: number;
}

/** PT-v2 member roles that mark where riders board/alight (the node the
 *  vehicle actually stops at). Platforms are the fallback when a route is
 *  mapped without `stop_position` nodes. */
export const STOP_ROLES: ReadonlySet<string> = new Set(["stop", "stop_entry_only", "stop_exit_only"]);
export const PLATFORM_ROLES: ReadonlySet<string> = new Set(["platform", "platform_entry_only", "platform_exit_only"]);

export interface ResolvedNode {
	lat: number;
	lon: number;
	name: string | null;
}

/** Index an Overpass response's node elements by id (coords + name). */
export function indexMemberNodes(elements: readonly OverpassElement[]): Map<number, ResolvedNode> {
	const nodes = new Map<number, ResolvedNode>();
	for (const el of elements) {
		if (el.type !== "node" || el.id === undefined || el.lat === undefined || el.lon === undefined) continue;
		nodes.set(el.id, { lat: el.lat, lon: el.lon, name: el.tags?.name ?? null });
	}
	return nodes;
}

/** Collect the ordered, resolvable stop nodes for one relation under a
 *  given set of accepted roles. */
export function stopsForRoles(
	members: readonly OverpassMember[],
	nodes: ReadonlyMap<number, ResolvedNode>,
	roles: ReadonlySet<string>,
): RouteStop[] {
	const stops: RouteStop[] = [];
	for (const m of members) {
		if (m.type !== "node" || m.ref === undefined || m.role === undefined) continue;
		if (!roles.has(m.role)) continue;
		const node = nodes.get(m.ref);
		if (!node) continue;
		stops.push({ name: node.name, lat: node.lat, lon: node.lon, seq: stops.length });
	}
	return stops;
}

/** A relation's ordered stops: `stop_position` members when present,
 *  platform members otherwise. Returns `[]` when neither role set
 *  resolves ≥ 2 stops — a route that can't anchor anything. */
export function resolveOrderedStops(
	members: readonly OverpassMember[],
	nodes: ReadonlyMap<number, ResolvedNode>,
): RouteStop[] {
	let stops = stopsForRoles(members, nodes, STOP_ROLES);
	if (stops.length < 2) stops = stopsForRoles(members, nodes, PLATFORM_ROLES);
	return stops.length < 2 ? [] : stops;
}

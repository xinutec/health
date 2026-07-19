/**
 * `rail_stops_cache` (de)serialization + read — the storage seam between
 * the offline mirror (refresh-rail-stops CLI writes rows) and consumers
 * of served-station membership (#364). The row ⇄ `RailStopRelation`
 * conversion is pure and round-trip-tested; the DB read is a thin
 * wrapper, defensive like the bus loader: a missing table or corrupt row
 * degrades to "no data", never a throw on a read path.
 *
 * Matching a pipeline line label ("Metropolitan Line") to relations uses
 * the same base-token normalization as `stationsOnLine`
 * (`lineBaseToken`): a relation matches when its `ref` or `name`
 * contains the label's base token, case-insensitively. Compound labels
 * ("Circle and District lines") match no single-line relation and return
 * empty — consumers must treat an empty result as "no membership data",
 * NOT as "serves no stations".
 */

import { db } from "../db/pool.js";
import { lineBaseToken } from "./line-stations.js";
import type { RailStopRelation } from "./osm-rail-stops.js";
import type { RouteStop } from "./osm-route-members.js";

/** The cache columns this module reads/writes (subset of the table). */
export interface RailStopsCacheRow {
	osm_relation_id: number | bigint;
	route_type: string;
	line_ref: string | null;
	line_name: string | null;
	stops_json: string;
}

/** A `RailStopRelation` flattened to its cache row. `stops_json` is the
 *  ordered stop array verbatim — order is the route direction. */
export function serializeRailStopRelation(rel: RailStopRelation): {
	osm_relation_id: number;
	route_type: string;
	line_ref: string | null;
	line_name: string | null;
	stops_json: string;
} {
	return {
		osm_relation_id: rel.osmRelationId,
		route_type: rel.routeType,
		line_ref: rel.lineRef,
		line_name: rel.lineName,
		stops_json: JSON.stringify(rel.stops),
	};
}

/** Rebuild a `RailStopRelation` from a cache row. Narrows the BIGINT
 *  relation id (returned as bigint) to number — relation ids are well
 *  under 2^53. Returns null on malformed `stops_json` or a row left with
 *  < 2 stops, so a corrupt row degrades to "no data". */
export function parseRailStopsRow(row: RailStopsCacheRow): RailStopRelation | null {
	let stops: RouteStop[];
	try {
		const parsed = JSON.parse(row.stops_json);
		if (!Array.isArray(parsed)) return null;
		stops = parsed as RouteStop[];
	} catch {
		return null;
	}
	if (stops.length < 2) return null;
	return {
		osmRelationId: Number(row.osm_relation_id),
		routeType: row.route_type,
		lineRef: row.line_ref,
		lineName: row.line_name,
		stops,
	};
}

/** Load every mirrored rail stop relation. The table is global (not
 *  user-scoped) and small — a metro area's rail relations are a few
 *  hundred rows. Malformed rows are dropped (see `parseRailStopsRow`). */
export async function loadAllRailStopRelations(): Promise<RailStopRelation[]> {
	let rows: RailStopsCacheRow[];
	try {
		rows = await db()
			.selectFrom("rail_stops_cache")
			.select(["osm_relation_id", "route_type", "line_ref", "line_name", "stops_json"])
			.execute();
	} catch (e: unknown) {
		// The mirror is a pure, optional cache: a missing table (fresh
		// deploy pre-migration) or any read error must degrade to "no
		// data" — served-station membership is additive evidence and must
		// never take down a decode or a timeline.
		console.warn(`loadAllRailStopRelations failed — treating as no rail stop data: ${e}`);
		return [];
	}
	const relations: RailStopRelation[] = [];
	for (const r of rows) {
		const rel = parseRailStopsRow(r);
		if (rel) relations.push(rel);
	}
	return relations;
}

/**
 * The relations serving a pipeline line label: `ref` or `name` contains
 * the label's base token, case-insensitively. Empty when nothing matches
 * — including compound labels ("Circle and District lines") and labels
 * that strip to an empty base. Empty means "no membership data", never
 * "serves nothing".
 */
export function railRelationsForLine(relations: readonly RailStopRelation[], lineName: string): RailStopRelation[] {
	const base = lineBaseToken(lineName).toLowerCase();
	if (base.length === 0) return [];
	return relations.filter(
		(r) => (r.lineRef?.toLowerCase().includes(base) ?? false) || (r.lineName?.toLowerCase().includes(base) ?? false),
	);
}

/** Union of the named stops across relations (a line's served-station
 *  set, across all direction/service variants). Unnamed stop nodes are
 *  skipped — coordinate-based consumers read `stops` directly. */
export function servedStationNames(relations: readonly RailStopRelation[]): Set<string> {
	const names = new Set<string>();
	for (const rel of relations) {
		for (const s of rel.stops) if (s.name !== null) names.add(s.name);
	}
	return names;
}

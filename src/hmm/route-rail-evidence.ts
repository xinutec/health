/**
 * Route-graph rail evidence — replaces the station-list
 * rail-corridor-boost with a check that uses actual OSM track
 * geometry.
 *
 * Phase 1A of the route-aware decoder
 * (`docs/design/probabilistic-principles.md`). The earlier
 * station-list approach was blind to inner-London Tube stations
 * tagged under composite line names ("Circle, Hammersmith & City
 * and Metropolitan Lines"). This module uses the RouteGraph's
 * line-membership-aware edges, which DO know about the inner-London
 * track.
 *
 * Mechanic:
 *
 *   For state = `train @ L` (L != unknown_rail) on a GPS-null
 *   minute, look at the most recent (prev) and next observed GPS
 *   fixes. Query the route graph for edges on line L within walking
 *   distance of each fix. If both ends have nearby L edges AND
 *   the gap meets minimum duration / distance, return a positive
 *   boost. Underground edges get a stronger boost than surface
 *   edges — GPS-null is more expected in a tube tunnel than on a
 *   surface line where GPS would normally be observed.
 *
 * Composes additively with the base emission via the CLI wiring.
 * Pure with respect to RouteGraph state — the graph is built once,
 * then queried memoised.
 */

import type { RouteEdge, RouteGraph } from "../geo/route-graph.js";
import type { Observation } from "./observation.js";
import type { State } from "./state-space.js";

export interface BuildRouteRailEvidenceOpts {
	routeGraph: RouteGraph;
	/** When set, this factor yields (returns 0) for `train` states on
	 *  minutes the train generator covers — the per-segment generator entry
	 *  prior owns line attribution there. See `train-generator-prior.ts`. */
	isCovered?: (ts: number) => boolean;
}

export type RouteRailEvidenceFn = (state: State, obs: Observation) => number;

/** Search radius (m) for "edges near this fix" — how close an L edge
 *  must pass to a GPS fix to count as supporting evidence. Tube
 *  stations are tagged at the entrance, but the underground edges
 *  themselves can run 100-200 m off the surface street GPS fix; 600 m
 *  is conservative. */
const EDGE_PROXIMITY_M = 600;

/** Minimum bookend gap duration for the boost to fire. Below this,
 *  the gap is more consistent with indoor flicker than a tube ride. */
const MIN_GAP_DURATION_S = 5 * 60;

/** Maximum bookend gap duration for the boost to fire. Above this,
 *  the gap is too long to be a single tube ride — picking it as
 *  train @ L would conflate the user's entire morning at home (with
 *  bookend fixes from yesterday evening and afternoon activity) with
 *  a fictional multi-hour Met Line ride. 90 min is generous: a real
 *  long underground ride (e.g. end-to-end Met from Aldgate to
 *  Amersham) is ~70 min. */
const MAX_GAP_DURATION_S = 90 * 60;

/** Minimum bookend gap distance for the boost to fire. Below this,
 *  the user hasn't actually moved enough for the gap to be a ride. */
const MIN_GAP_DISTANCE_M = 1_000;

/** Underground rail boost — the strongest evidence: GPS-null is the
 *  EXPECTED observation on an underground line, so the bookend
 *  underground L edges are decisive.
 *
 *  Surface-rail boost is intentionally zero. On a surface mainline,
 *  GPS would normally be observed; a GPS-null minute near surface
 *  rail is more consistent with the user being indoors next to the
 *  line than on a train (which would have observed GPS). Train @
 *  surface-rail identification should rely on speed / mode-coherence
 *  factors that fire when GPS IS observed, not on the gap. */
const UNDERGROUND_BOOST = 3.5;

/** Cap on the BFS exploration to keep the connectivity check
 *  bounded. London Tube lines have ~200-400 edges each; a generous
 *  cap of 1000 covers cross-line interchange checks while preventing
 *  pathological loops or open-ended sprawl. */
const MAX_BFS_EDGES = 1_000;

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** What we cache per (rounded fix coord): for each line name present
 *  near that fix, whether ANY edge is underground. */
interface FixLineEvidence {
	/** Lines that have at least one edge within proximity. */
	linesPresent: ReadonlySet<string>;
	/** Lines that have at least one UNDERGROUND edge within proximity. */
	linesUnderground: ReadonlySet<string>;
}

function fixCacheKey(lat: number, lon: number): string {
	// Round to ~10m precision — fixes the user produces are noisier
	// than this, so finer-grained keys just waste memory.
	return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

function computeFixLineEvidence(routeGraph: RouteGraph, lat: number, lon: number): FixLineEvidence {
	const linesPresent = new Set<string>();
	const linesUnderground = new Set<string>();
	const edges = routeGraph.edgesNear(lat, lon, EDGE_PROXIMITY_M);
	for (const edge of edges) {
		for (const line of edge.attrs.lineMemberships) {
			linesPresent.add(line);
			if (edge.attrs.underground) linesUnderground.add(line);
		}
	}
	return { linesPresent, linesUnderground };
}

/** Find edge ids near a fix that have the given line in their
 *  line memberships. */
function edgesNearOnLine(routeGraph: RouteGraph, line: string, lat: number, lon: number): Set<string> {
	const result = new Set<string>();
	for (const edge of routeGraph.edgesNear(lat, lon, EDGE_PROXIMITY_M)) {
		if (edge.attrs.lineMemberships.has(line)) result.add(edge.id);
	}
	return result;
}

/** Node id keyed off endpoint coords — must match `nodeKey` in
 *  route-graph.ts. */
function endpointNodeId(p: { lat: number; lon: number }): string {
	return `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
}

/** BFS in the subgraph of edges that all carry the given line
 *  membership. Returns true when any path of L-only edges exists
 *  from `startEdges` to any edge in `goalEdges`.
 *
 *  Adjacency: two edges share a node iff their endpoint coords
 *  collapse to the same `nodeKey`. RouteGraph already indexes
 *  nodeId → incident edges, so we look up adjacency in O(1) per
 *  edge. */
function pathExistsOnLine(
	routeGraph: RouteGraph,
	line: string,
	startEdges: ReadonlySet<string>,
	goalEdges: ReadonlySet<string>,
): boolean {
	if (startEdges.size === 0 || goalEdges.size === 0) return false;
	// Quick wins: the start set overlaps the goal set.
	for (const id of startEdges) if (goalEdges.has(id)) return true;

	const visited = new Set<string>(startEdges);
	const queue: string[] = [...startEdges];
	while (queue.length > 0 && visited.size < MAX_BFS_EDGES) {
		const edgeId = queue.shift();
		if (edgeId === undefined) break;
		const edge = routeGraph.edges.get(edgeId);
		if (edge === undefined) continue;
		for (const endpoint of [edge.startPoint, edge.endPoint]) {
			const node = routeGraph.nodes.get(endpointNodeId(endpoint));
			if (node === undefined) continue;
			for (const adjId of node.edgeIds) {
				if (visited.has(adjId)) continue;
				const adjEdge = routeGraph.edges.get(adjId);
				if (adjEdge === undefined) continue;
				if (!adjEdge.attrs.lineMemberships.has(line)) continue;
				if (goalEdges.has(adjId)) return true;
				visited.add(adjId);
				queue.push(adjId);
			}
		}
	}
	return false;
}

export function buildRouteRailEvidence(opts: BuildRouteRailEvidenceOpts): RouteRailEvidenceFn {
	const routeGraph = opts.routeGraph;
	const isCovered = opts.isCovered;
	const evidenceCache = new Map<string, FixLineEvidence>();
	const connectivityCache = new Map<string, boolean>();

	function evidenceAt(lat: number, lon: number): FixLineEvidence {
		const key = fixCacheKey(lat, lon);
		let v = evidenceCache.get(key);
		if (v === undefined) {
			v = computeFixLineEvidence(routeGraph, lat, lon);
			evidenceCache.set(key, v);
		}
		return v;
	}

	function connectivityFor(line: string, prevLat: number, prevLon: number, nextLat: number, nextLon: number): boolean {
		const key = `${line}|${fixCacheKey(prevLat, prevLon)}|${fixCacheKey(nextLat, nextLon)}`;
		let v = connectivityCache.get(key);
		if (v === undefined) {
			const startEdges = edgesNearOnLine(routeGraph, line, prevLat, prevLon);
			const goalEdges = edgesNearOnLine(routeGraph, line, nextLat, nextLon);
			v = pathExistsOnLine(routeGraph, line, startEdges, goalEdges);
			connectivityCache.set(key, v);
		}
		return v;
	}

	return (state: State, obs: Observation): number => {
		if (state.mode !== "train") return 0;
		if (isCovered?.(obs.ts)) return 0; // generator entry prior owns line here
		if (state.lineName === null || state.lineName === "unknown_rail") return 0;
		if (obs.gps !== null) return 0;
		const prev = obs.prevGpsFix;
		const next = obs.nextGpsFix;
		if (prev === null || next === null) return 0;
		if (next.ts - prev.ts < MIN_GAP_DURATION_S) return 0;
		if (next.ts - prev.ts > MAX_GAP_DURATION_S) return 0;
		if (haversineMeters(prev.lat, prev.lon, next.lat, next.lon) < MIN_GAP_DISTANCE_M) return 0;

		const prevEvidence = evidenceAt(prev.lat, prev.lon);
		const nextEvidence = evidenceAt(next.lat, next.lon);
		const line = state.lineName;
		if (!prevEvidence.linesPresent.has(line) || !nextEvidence.linesPresent.has(line)) return 0;

		const prevUnderground = prevEvidence.linesUnderground.has(line);
		const nextUnderground = nextEvidence.linesUnderground.has(line);
		if (!prevUnderground || !nextUnderground) return 0;

		// Connectivity check: there must be a path on the per-line
		// subgraph from an edge near prev_fix to an edge near
		// next_fix. Without this, lines like Met "win" the boost for
		// every London tube ride because Met has underground edges
		// everywhere near central stations — even when Met can't
		// actually connect the two bookend stations (e.g. Baker St ↔
		// Green Park; Met goes north out of Baker St, not south
		// to Green Park).
		if (!connectivityFor(line, prev.lat, prev.lon, next.lat, next.lon)) return 0;

		return UNDERGROUND_BOOST;
	};
}

// Re-export for callers that want to inspect the cache shape from
// tests / diagnostics. Not part of the runtime API.
export type { FixLineEvidence, RouteEdge };

/**
 * Inner Viterbi over per-line edge subgraph — Phase 1 of the
 * route-aware decoder (`docs/design/probabilistic-principles.md`).
 *
 * Given a window of observations and a line L, decode the
 * maximum-likelihood edge sequence on L's subgraph that:
 *
 *   - starts on a caller-supplied entry edge (edges near the GPS
 *     fix at or just before the window's first minute);
 *   - ends on a caller-supplied exit edge (edges near the GPS fix
 *     at or just after the window's last minute);
 *   - at every minute either stays on the same edge or moves to a
 *     graph-adjacent edge that's also on L (sharing a node in the
 *     route graph).
 *
 * Used as the per-segment emission for `train @ L` states by the
 * outer HSMM Viterbi. The decoded `logScore` REPLACES the sum of
 * per-minute emissions for that segment; the decoded `edgePath`
 * becomes the `trainEdgeId` of each State the outer decoder emits.
 *
 * Pure function — no I/O, deterministic given inputs. The caller
 * owns the route graph; this module only reads it.
 */

import { nodeKey, type RouteEdge, type RouteGraph } from "../geo/route-graph.js";
import type { Observation } from "./observation.js";

export interface InnerViterbiInput {
	routeGraph: RouteGraph;
	/** Line name to constrain the subgraph to. Only edges with
	 *  `lineMemberships.has(line)` are considered. */
	line: string;
	/** Observations for the segment window. Each entry corresponds
	 *  to one decoded position in `edgePath`. */
	observations: readonly Observation[];
	/** The decoded path's first minute must land on one of these
	 *  edge ids. Typically the edges within proximity of the GPS
	 *  fix immediately preceding the segment. Pass `null` to leave
	 *  unconstrained — the decoder will pick any line edge as the
	 *  starting position (useful when no nearby GPS context exists,
	 *  e.g. an interior segment of a long underground gap). */
	entryEdges: ReadonlySet<string> | null;
	/** The decoded path's last minute must land on one of these
	 *  edge ids. Typically the edges within proximity of the GPS
	 *  fix immediately following the segment. Pass `null` for
	 *  unconstrained. */
	exitEdges: ReadonlySet<string> | null;
}

export interface InnerViterbiResult {
	/** One edge id per observation. Empty when `observations` is
	 *  empty. */
	edgePath: readonly string[];
	/** Sum of per-minute log-emission scores along the decoded
	 *  path. Higher is better. Returned as 0 for an empty window. */
	logScore: number;
}

/** GPS noise scale for the perpendicular distance Gaussian when
 *  the candidate edge is SURFACE rail. 30m absorbs the consumer
 *  GPS noise floor plus the typical OSM tagging offset along the
 *  rail centreline. Smaller than the urban-canyon worst case (which
 *  is rare on surface rail) so parallel lines like Met and Jubilee
 *  fast/slow tracks (separated by ~5–15 m in OSM) actually
 *  discriminate at the divergence points. */
const GPS_SIGMA_SURFACE_M = 30;

/** GPS noise scale for UNDERGROUND edges. In OSM, tunnelled rails
 *  are tagged at street-level coordinates of the station entrance,
 *  not at the platform below ground. The "distance from a surface
 *  GPS fix to the underground rail centreline" is dominated by
 *  this vertical-projection / station-entrance offset, not by GPS
 *  noise. 150m is calibrated against the typical Green Park /
 *  Baker St offset (~50-150m measured against the day's tube fixes
 *  in 2026-05-22) so legitimate on-line fixes don't blow up the
 *  emission. */
const GPS_SIGMA_UNDERGROUND_M = 150;

/** Log-probability *ratio* (vs the abstract `unknown_rail`
 *  fallback) for a GPS-observed minute landing on a known line's
 *  edge geometry. The full per-minute score is
 *   `GPS_OBSERVED_BASELINE − 0.5 · (d / GPS_SIGMA_M)²`
 *  so a fix sitting on the line is positive evidence (+~2.3 nat,
 *  reflecting the tighter localisation than the broad `unknown`
 *  prior) and a fix 200 m off is negative (−0.7).
 *
 *  This isn't a tuning knob — it's the log of the ratio
 *  `σ_unknown / σ_known` where the unknown prior is implicitly a
 *  broad Gaussian over the rail bbox. ~10× the rail-noise sigma
 *  is generous; gives log 10 ≈ 2.3. */
const GPS_OBSERVED_BASELINE = 2.3;

/** Log-probability ratio for a GPS-NULL minute on an underground
 *  edge. GPS-null in a tube tunnel is the EXPECTED observation
 *  (~95% of minutes), so being on an underground line is positive
 *  evidence compared to the unknown_rail fallback (which doesn't
 *  predict GPS-null preferentially). */
const UNDERGROUND_NULL_BONUS = 1.5;

/** Log-probability ratio for a GPS-NULL minute on a surface rail
 *  edge. A GPS-null minute on the open is unusual; surface rail is
 *  POOR evidence for being on this line. */
const SURFACE_NULL_PENALTY = -2.5;

/** Per-minute log-prob ceiling on GPS-projection penalty. Caps the
 *  Gaussian tail so an outlier fix doesn't dominate the trellis
 *  with a huge negative; a path that's wrong on one minute but
 *  right elsewhere should still recoverable. */
const GPS_MAX_PENALTY = -2_000;

/** Spatial query radius for candidate-edge generation. Edges
 *  passing within this many meters of any GPS fix in the window
 *  become candidates. Larger than EDGE_PROXIMITY in route-rail-
 *  evidence (600m) because we want to enumerate the corridor, not
 *  just confirm presence. */
const CANDIDATE_RADIUS_M = 800;

/** Cap on the BFS expansion from entry/exit edges to capture
 *  candidates not near any GPS fix (the tunnel case where the
 *  window has NO observed GPS). 15 hops covers a typical
 *  inner-London tube ride end-to-end. Wider used to be 30 but
 *  blows up per-call work for full-day decoding without
 *  meaningfully changing decoded paths. */
const CANDIDATE_BFS_MAX_HOPS = 15;

/** Approximate planar distance from point (px,py) to segment
 *  ((ax,ay)-(bx,by)) in meters. (lat, lon) treated as planar over
 *  small distances using cos(lat) longitude scaling. Good enough
 *  for GPS-noise-scale judgments. */
function pointToSegmentMeters(
	pLat: number,
	pLon: number,
	aLat: number,
	aLon: number,
	bLat: number,
	bLon: number,
): number {
	const M_PER_DEG = 111_320;
	const cosLat = Math.cos(((aLat + bLat) / 2) * (Math.PI / 180));
	const dx = (bLon - aLon) * M_PER_DEG * cosLat;
	const dy = (bLat - aLat) * M_PER_DEG;
	const ex = (pLon - aLon) * M_PER_DEG * cosLat;
	const ey = (pLat - aLat) * M_PER_DEG;
	const segLen2 = dx * dx + dy * dy;
	if (segLen2 === 0) return Math.sqrt(ex * ex + ey * ey);
	let t = (ex * dx + ey * dy) / segLen2;
	if (t < 0) t = 0;
	if (t > 1) t = 1;
	const cx = t * dx;
	const cy = t * dy;
	return Math.sqrt((ex - cx) ** 2 + (ey - cy) ** 2);
}

function pointToEdgeMeters(p: { lat: number; lon: number }, edge: RouteEdge): number {
	let minDist = Number.POSITIVE_INFINITY;
	const g = edge.geometry;
	for (let i = 0; i < g.length - 1; i++) {
		const a = g[i];
		const b = g[i + 1];
		const d = pointToSegmentMeters(p.lat, p.lon, a.lat, a.lon, b.lat, b.lon);
		if (d < minDist) minDist = d;
	}
	return minDist;
}

function edgeEmission(edge: RouteEdge, ob: Observation): number {
	if (ob.gps !== null) {
		const d = pointToEdgeMeters(ob.gps, edge);
		const sigma = edge.attrs.underground ? GPS_SIGMA_UNDERGROUND_M : GPS_SIGMA_SURFACE_M;
		const score = GPS_OBSERVED_BASELINE - 0.5 * (d / sigma) ** 2;
		return score < GPS_MAX_PENALTY ? GPS_MAX_PENALTY : score;
	}
	return edge.attrs.underground ? UNDERGROUND_NULL_BONUS : SURFACE_NULL_PENALTY;
}

/** Edges on the line that are within `radius` meters of `(lat,
 *  lon)`. */
function edgesNearOnLine(routeGraph: RouteGraph, line: string, lat: number, lon: number, radius: number): string[] {
	const out: string[] = [];
	for (const edge of routeGraph.edgesNear(lat, lon, radius)) {
		if (edge.attrs.lineMemberships.has(line)) out.push(edge.id);
	}
	return out;
}

/** Neighbours of an edge that share a node and are on the same
 *  line. */
function lineAdjacents(routeGraph: RouteGraph, edge: RouteEdge, line: string): string[] {
	const out: string[] = [];
	for (const endpoint of [edge.startPoint, edge.endPoint]) {
		const node = routeGraph.nodes.get(nodeKey(endpoint.lat, endpoint.lon));
		if (node === undefined) continue;
		for (const adjId of node.edgeIds) {
			if (adjId === edge.id) continue;
			const adj = routeGraph.edges.get(adjId);
			if (adj === undefined) continue;
			if (!adj.attrs.lineMemberships.has(line)) continue;
			out.push(adjId);
		}
	}
	return out;
}

/** Generate the candidate-edge set for the inner Viterbi. Start
 *  from entry+exit edges plus any edges near observed GPS fixes,
 *  then BFS-expand along the line to ensure connectivity.
 *
 *  All candidates are required to carry the requested line in
 *  their `lineMemberships` — an entry/exit edge that isn't on the
 *  line is silently dropped (which makes the inner Viterbi return
 *  null when no entry or no exit survives). */
function generateCandidates(input: InnerViterbiInput): Set<string> {
	const candidates = new Set<string>();
	const onLine = (id: string): boolean => {
		const e = input.routeGraph.edges.get(id);
		return e?.attrs.lineMemberships.has(input.line) ?? false;
	};
	if (input.entryEdges !== null) for (const id of input.entryEdges) if (onLine(id)) candidates.add(id);
	if (input.exitEdges !== null) for (const id of input.exitEdges) if (onLine(id)) candidates.add(id);
	// When entry or exit is unconstrained, seed with every on-line
	// edge so the candidate set covers the full line subgraph.
	if (input.entryEdges === null || input.exitEdges === null) {
		for (const [id, edge] of input.routeGraph.edges) {
			if (edge.attrs.lineMemberships.has(input.line)) candidates.add(id);
		}
	}
	for (const ob of input.observations) {
		if (ob.gps === null) continue;
		for (const id of edgesNearOnLine(input.routeGraph, input.line, ob.gps.lat, ob.gps.lon, CANDIDATE_RADIUS_M)) {
			candidates.add(id);
		}
	}
	// BFS expansion to capture intermediate corridor edges between
	// the GPS-anchored seeds. `lineAdjacents` already filters to
	// on-line edges, so candidates stay line-pure.
	let frontier = [...candidates];
	for (let hop = 0; hop < CANDIDATE_BFS_MAX_HOPS && frontier.length > 0; hop++) {
		const next: string[] = [];
		for (const id of frontier) {
			const edge = input.routeGraph.edges.get(id);
			if (edge === undefined) continue;
			for (const adjId of lineAdjacents(input.routeGraph, edge, input.line)) {
				if (candidates.has(adjId)) continue;
				candidates.add(adjId);
				next.push(adjId);
			}
		}
		frontier = next;
	}
	return candidates;
}

export function innerViterbi(input: InnerViterbiInput): InnerViterbiResult | null {
	const T = input.observations.length;
	if (T === 0) return { edgePath: [], logScore: 0 };

	const candidates = generateCandidates(input);
	if (candidates.size === 0) return null;

	let entryIds: string[];
	if (input.entryEdges === null) {
		entryIds = [...candidates];
	} else {
		entryIds = [];
		for (const id of input.entryEdges) if (candidates.has(id)) entryIds.push(id);
	}
	let exitIds: string[];
	if (input.exitEdges === null) {
		exitIds = [...candidates];
	} else {
		exitIds = [];
		for (const id of input.exitEdges) if (candidates.has(id)) exitIds.push(id);
	}
	if (entryIds.length === 0 || exitIds.length === 0) return null;

	const edgeIds = [...candidates];
	const E = edgeIds.length;
	const edgeIdx = new Map<string, number>();
	for (let i = 0; i < E; i++) edgeIdx.set(edgeIds[i], i);

	// Precompute adjacency on the line for each candidate edge.
	const adj: number[][] = new Array(E);
	for (let i = 0; i < E; i++) {
		const edge = input.routeGraph.edges.get(edgeIds[i]);
		if (edge === undefined) {
			adj[i] = [];
			continue;
		}
		const nbIds = lineAdjacents(input.routeGraph, edge, input.line);
		const nbIdxs: number[] = [];
		for (const nbId of nbIds) {
			const idx = edgeIdx.get(nbId);
			if (idx !== undefined) nbIdxs.push(idx);
		}
		adj[i] = nbIdxs;
	}

	// trellis[t] = best log-prob ending at minute t on each candidate edge.
	let prevRow = new Float64Array(E).fill(Number.NEGATIVE_INFINITY);
	let curRow = new Float64Array(E).fill(Number.NEGATIVE_INFINITY);

	// Backpointers: at minute t, the edge index at minute t-1 that
	// produced the best score for each edge at t.
	const back: Int32Array[] = new Array(T);
	for (let t = 0; t < T; t++) back[t] = new Int32Array(E).fill(-1);

	// t=0: each entry edge starts a fresh path with its own emission.
	const entryEdgeSet = new Set(entryIds);
	for (let i = 0; i < E; i++) {
		if (!entryEdgeSet.has(edgeIds[i])) continue;
		const edge = input.routeGraph.edges.get(edgeIds[i]);
		if (edge === undefined) continue;
		prevRow[i] = edgeEmission(edge, input.observations[0]);
	}

	// t=1..T-1: extend.
	for (let t = 1; t < T; t++) {
		curRow.fill(Number.NEGATIVE_INFINITY);
		const ob = input.observations[t];
		for (let i = 0; i < E; i++) {
			const edge = input.routeGraph.edges.get(edgeIds[i]);
			if (edge === undefined) continue;
			const emit = edgeEmission(edge, ob);

			// Best predecessor: stay on edge or transition from a
			// graph-adjacent edge on the line.
			let bestPrev = prevRow[i];
			let bestPrevIdx = bestPrev !== Number.NEGATIVE_INFINITY ? i : -1;
			for (const nbIdx of adj[i]) {
				const v = prevRow[nbIdx];
				if (v > bestPrev) {
					bestPrev = v;
					bestPrevIdx = nbIdx;
				}
			}

			if (bestPrev !== Number.NEGATIVE_INFINITY) {
				curRow[i] = bestPrev + emit;
				back[t][i] = bestPrevIdx;
			}
		}
		const tmp = prevRow;
		prevRow = curRow;
		curRow = tmp;
	}

	// Final: pick best edge in exit set.
	const exitEdgeSet = new Set(exitIds);
	let bestFinal = Number.NEGATIVE_INFINITY;
	let bestFinalIdx = -1;
	for (let i = 0; i < E; i++) {
		if (!exitEdgeSet.has(edgeIds[i])) continue;
		if (prevRow[i] > bestFinal) {
			bestFinal = prevRow[i];
			bestFinalIdx = i;
		}
	}
	if (bestFinalIdx === -1) return null;

	// Backtrack.
	const path: string[] = new Array(T);
	path[T - 1] = edgeIds[bestFinalIdx];
	let curIdx = bestFinalIdx;
	for (let t = T - 1; t > 0; t--) {
		const prevIdx = back[t][curIdx];
		if (prevIdx === -1) return null; // path broken
		path[t - 1] = edgeIds[prevIdx];
		curIdx = prevIdx;
	}

	return { edgePath: path, logScore: bestFinal };
}

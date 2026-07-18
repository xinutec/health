/**
 * Rail-snap — draw a confident train journey on the rail track.
 *
 * # Why this exists
 *
 * On the Map tab a train ride renders as a wild GPS zigzag: underground
 * and in cuttings the phone falls back to cell-tower positioning and the
 * fixes scatter hundreds of metres off the track. We want to draw the
 * ride on the *actual rail line* instead.
 *
 * # Why this is station-anchored, not fix-driven
 *
 * The first attempt projected each raw GPS fix onto a route polyline.
 * It failed three times: real train-run GPS has platform dwell-clumps,
 * fixes that lie about their accuracy, and coarse cell-tower scatter,
 * and each defeats a different route-fit metric. Fix positions cannot
 * drive the geometry.
 *
 * What *is* reliable for a confident train segment is the segment's
 * station-pair label — `"<board> → <alight>"`, optionally ` · <line>`.
 * So this module does not look at fix positions at all. It:
 *
 *   1. parses the boarding and alighting station names from the label,
 *   2. resolves their coordinates from the local OSM station mirror,
 *   3. builds a graph of the rail network from `osm_lines` geometry,
 *   4. finds the shortest rail path between the two stations,
 *   5. interpolates the segment's time window linearly along that path.
 *
 * Dwell-clumps, lying accuracy, and coarse scatter can only corrupt fix
 * *positions*, and fix positions are no longer load-bearing — so this
 * approach is structurally immune to all three.
 *
 * The `osm_way_routes` route-relation mirror is accepted in the geometry
 * input for a future refinement (restricting the search to the named
 * line, to disambiguate parallel routes). v1 relies on plain shortest
 * path between the correct two stations.
 */

import { parseLineMemberships } from "./route-graph.js";

/** A rail way from the OSM mirror. `coords` is an ordered `[lat, lon]`
 *  polyline. */
export interface OsmLine {
	osmId: number;
	name: string | null;
	subtype: string | null;
	coords: Array<[number, number]>;
}

/** A way → route-relation membership row from `osm_way_routes`. Carried
 *  through for future line-restricted search; unused in v1. */
export interface OsmWayRoute {
	wayId: number;
	routeName: string;
	routeType: string;
}

/** A railway POINT (station / halt / stop / entrance) from the mirror. */
export interface OsmStation {
	name: string | null;
	subtype: string | null;
	lat: number;
	lon: number;
}

/** The OSM rail geometry the snapper works against — a self-contained
 *  bundle, so the algorithm needs neither DB nor network. */
export interface RailGeometry {
	lines: OsmLine[];
	wayRoutes: OsmWayRoute[];
	stations: OsmStation[];
}

/** The minimal slice of a classified train segment the snapper needs. */
export interface TrainSegment {
	startTs: number;
	endTs: number;
	/** Station-pair label: `"<board> → <alight>"`, optionally ` · <line>`. */
	wayName: string;
}

/** One vertex of the snapped path, with an interpolated timestamp. */
export interface SnappedPoint {
	lat: number;
	lon: number;
	ts: number;
}

export interface SnapResult {
	board: { name: string; lat: number; lon: number };
	alight: { name: string; lat: number; lon: number };
	/** The line name from the label, if it carried one. Informational. */
	line: string | null;
	/** The rail path from boarding to alighting station, time-interpolated. */
	path: SnappedPoint[];
}

/** OSM `railway` way subtypes that carry real train traffic. `tram` is
 *  excluded (not a train); `disused`/`abandoned` are excluded (no
 *  service runs on them). */
const RAIL_SUBTYPES = new Set(["rail", "subway", "light_rail", "narrow_gauge"]);

/** Two rail vertices within this distance (m) but not sharing an OSM
 *  node are bridged with an edge. OSM ways frequently fail to share a
 *  node at junctions and dataset-tile borders; without bridging the
 *  rail graph is spuriously disconnected. */
const GAP_BRIDGE_M = 15;

/** A station whose nearest rail vertex is further than this (m) is not
 *  meaningfully on the network — bail rather than snap to a wrong line. */
const MAX_STATION_TO_RAIL_M = 600;

/** Coordinate decimal places used to key graph vertices. OSM exports
 *  identical coordinates for a node shared by two ways, so rounding at
 *  ~1 cm makes shared nodes collapse to one vertex (= graph connectivity)
 *  without merging genuinely distinct nodes. */
const VERTEX_DP = 7;

/** Equirectangular metres between two lat/lon points — accurate enough
 *  at the city scale this module operates on. */
function metersBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const dLat = (bLat - aLat) * 111_320;
	const dLon = (bLon - aLon) * 111_320 * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
}

/** Fix-cloud weighting — see {@link snapTrainSegment}. Within
 *  CLOUD_NEAR_M of a historic fix an edge is unpenalised; beyond
 *  CLOUD_FAR_M it carries the full CLOUD_MAX_PENALTY multiplier;
 *  it ramps linearly between. */
const CLOUD_NEAR_M = 150;
const CLOUD_FAR_M = 500;
const CLOUD_MAX_PENALTY = 25;

/** Below this many historic fixes the corridor is too thin to trust —
 *  the run is left un-snapped and the map draws the raw track. */
const MIN_CLOUD_FIXES = 12;

/** A grid-hashed cloud of historic GPS fixes for fast nearest-fix
 *  distance queries. The cell is CLOUD_FAR_M, so the 3×3 neighbourhood
 *  of any point contains every fix within CLOUD_FAR_M of it. */
export class FixCloud {
	private readonly cLat: number;
	private readonly cLon: number;
	private readonly buckets = new Map<string, Array<{ lat: number; lon: number }>>();

	constructor(fixes: ReadonlyArray<{ lat: number; lon: number }>) {
		const lat0 = fixes.length > 0 ? fixes[0].lat : 0;
		this.cLat = CLOUD_FAR_M / 111_320;
		this.cLon = CLOUD_FAR_M / (111_320 * Math.cos((lat0 * Math.PI) / 180));
		for (const f of fixes) {
			const key = `${Math.floor(f.lat / this.cLat)},${Math.floor(f.lon / this.cLon)}`;
			const b = this.buckets.get(key);
			if (b) b.push(f);
			else this.buckets.set(key, [f]);
		}
	}

	/** Distance (m) to the nearest historic fix, capped at CLOUD_FAR_M. */
	nearestDist(lat: number, lon: number): number {
		const baseLat = Math.floor(lat / this.cLat);
		const baseLon = Math.floor(lon / this.cLon);
		let best = CLOUD_FAR_M;
		for (let dLat = -1; dLat <= 1; dLat++) {
			for (let dLon = -1; dLon <= 1; dLon++) {
				const b = this.buckets.get(`${baseLat + dLat},${baseLon + dLon}`);
				if (!b) continue;
				for (const f of b) {
					const d = metersBetween(lat, lon, f.lat, f.lon);
					if (d < best) best = d;
				}
			}
		}
		return best;
	}
}

/** Edge-weight multiplier from how far an edge sits from the historic
 *  fix cloud. This is what routes the graph search down the line the
 *  user's past journeys actually traced rather than the geometrically
 *  shortest path between the two stations. */
function cloudPenalty(distToCloudM: number): number {
	if (distToCloudM <= CLOUD_NEAR_M) return 1;
	if (distToCloudM >= CLOUD_FAR_M) return CLOUD_MAX_PENALTY;
	return 1 + (CLOUD_MAX_PENALTY - 1) * ((distToCloudM - CLOUD_NEAR_M) / (CLOUD_FAR_M - CLOUD_NEAR_M));
}

/** Metric length of an edge multiplied by its fix-cloud penalty — the
 *  weight Dijkstra minimises. The raw metric length is still used for
 *  gap-bridging thresholds and time interpolation. */
function edgeWeight(aLat: number, aLon: number, bLat: number, bLon: number, cloud: FixCloud): number {
	const dist = metersBetween(aLat, aLon, bLat, bLon);
	return dist * cloudPenalty(cloud.nearestDist((aLat + bLat) / 2, (aLon + bLon) / 2));
}

/**
 * Parse a train segment's station-pair `wayName` into its parts.
 *
 * The label format is `"<board> → <alight>"` with an optional
 * ` · <line>` suffix (e.g. produced by underground-run reconstruction).
 * Station names themselves may contain ` & ` and other punctuation, so
 * only the ` → ` and ` · ` separators are structural. Returns null when
 * the string is not a station pair.
 */
export function parseRailWayName(wayName: string): { board: string; alight: string; line: string | null } | null {
	let rest = wayName;
	let line: string | null = null;
	const dotIdx = rest.indexOf(" · ");
	if (dotIdx >= 0) {
		line = rest.slice(dotIdx + 3).trim() || null;
		rest = rest.slice(0, dotIdx);
	}
	const arrowIdx = rest.indexOf(" → ");
	if (arrowIdx < 0) return null;
	const board = rest.slice(0, arrowIdx).trim();
	const alight = rest.slice(arrowIdx + 3).trim();
	if (!board || !alight) return null;
	return { board, alight, line };
}

/**
 * Resolve a station name to a coordinate. A station appears in OSM as
 * several nodes (platforms, stop positions, entrances) all carrying the
 * same `name`; the centroid of the exact-name matches is a stable
 * anchor. Returns null when no node carries that exact name.
 */
export function resolveStation(
	name: string,
	stations: OsmStation[],
): { name: string; lat: number; lon: number } | null {
	const matches = stations.filter((s) => s.name === name);
	if (matches.length === 0) return null;
	const lat = matches.reduce((a, s) => a + s.lat, 0) / matches.length;
	const lon = matches.reduce((a, s) => a + s.lon, 0) / matches.length;
	return { name, lat, lon };
}

export interface RailGraph {
	vertices: Array<{ lat: number; lon: number }>;
	adj: Array<Array<{ to: number; w: number }>>;
}

/**
 * Build an undirected graph of the rail network from OSM way geometry.
 *
 * Vertices are way nodes (deduplicated by rounded coordinate, so a node
 * shared by two ways is one vertex — that is what connects ways into a
 * network). Edges are consecutive node pairs within a way, plus
 * gap-bridge edges between nearby vertices of different ways (see
 * {@link GAP_BRIDGE_M}). Only train-carrying subtypes are included.
 */
export function buildRailGraph(lines: OsmLine[], cloud: FixCloud): RailGraph {
	const vertices: Array<{ lat: number; lon: number }> = [];
	const adj: Array<Array<{ to: number; w: number }>> = [];
	const idByKey = new Map<string, number>();

	const vertexId = (lat: number, lon: number): number => {
		const key = `${lat.toFixed(VERTEX_DP)},${lon.toFixed(VERTEX_DP)}`;
		let id = idByKey.get(key);
		if (id === undefined) {
			id = vertices.length;
			idByKey.set(key, id);
			vertices.push({ lat, lon });
			adj.push([]);
		}
		return id;
	};
	const addEdge = (a: number, b: number, w: number): void => {
		if (a === b) return;
		adj[a].push({ to: b, w });
		adj[b].push({ to: a, w });
	};

	for (const line of lines) {
		if (!RAIL_SUBTYPES.has(line.subtype ?? "")) continue;
		let prev = -1;
		let prevLat = 0;
		let prevLon = 0;
		for (const [lat, lon] of line.coords) {
			const id = vertexId(lat, lon);
			if (prev >= 0) addEdge(prev, id, edgeWeight(prevLat, prevLon, lat, lon, cloud));
			prev = id;
			prevLat = lat;
			prevLon = lon;
		}
	}

	bridgeGaps(vertices, adj, cloud);
	return { vertices, adj };
}

/**
 * Add edges between vertices of different ways that sit within
 * {@link GAP_BRIDGE_M} of each other but do not share an OSM node.
 * Candidate pairs are found via a coarse grid hash so this stays linear
 * in vertex count rather than quadratic.
 */
function bridgeGaps(
	vertices: Array<{ lat: number; lon: number }>,
	adj: Array<Array<{ to: number; w: number }>>,
	cloud: FixCloud,
): void {
	if (vertices.length === 0) return;
	// Grid cell ≈ GAP_BRIDGE_M on a side. A pair within the threshold is
	// always in the same or an adjacent cell.
	const cellLat = GAP_BRIDGE_M / 111_320;
	const midLat = vertices[0].lat;
	const cellLon = GAP_BRIDGE_M / (111_320 * Math.cos((midLat * Math.PI) / 180));
	const cellOf = (v: { lat: number; lon: number }): string =>
		`${Math.floor(v.lat / cellLat)},${Math.floor(v.lon / cellLon)}`;

	const buckets = new Map<string, number[]>();
	for (let i = 0; i < vertices.length; i++) {
		const c = cellOf(vertices[i]);
		const b = buckets.get(c);
		if (b) b.push(i);
		else buckets.set(c, [i]);
	}

	for (let i = 0; i < vertices.length; i++) {
		const v = vertices[i];
		const baseLatCell = Math.floor(v.lat / cellLat);
		const baseLonCell = Math.floor(v.lon / cellLon);
		for (let dLat = -1; dLat <= 1; dLat++) {
			for (let dLon = -1; dLon <= 1; dLon++) {
				const b = buckets.get(`${baseLatCell + dLat},${baseLonCell + dLon}`);
				if (!b) continue;
				for (const j of b) {
					// Each unordered pair once; skip vertices already adjacent.
					if (j <= i) continue;
					const gap = metersBetween(v.lat, v.lon, vertices[j].lat, vertices[j].lon);
					if (gap > GAP_BRIDGE_M) continue;
					if (adj[i].some((e) => e.to === j)) continue;
					const w = edgeWeight(v.lat, v.lon, vertices[j].lat, vertices[j].lon, cloud);
					adj[i].push({ to: j, w });
					adj[j].push({ to: i, w });
				}
			}
		}
	}
}

/** A binary min-heap keyed on a numeric priority — the Dijkstra queue. */
class MinHeap {
	private readonly heap: Array<{ p: number; v: number }> = [];
	get size(): number {
		return this.heap.length;
	}
	push(p: number, v: number): void {
		const h = this.heap;
		h.push({ p, v });
		let i = h.length - 1;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (h[parent].p <= h[i].p) break;
			[h[parent], h[i]] = [h[i], h[parent]];
			i = parent;
		}
	}
	pop(): { p: number; v: number } | undefined {
		const h = this.heap;
		const top = h[0];
		if (top === undefined) return undefined;
		const last = h.pop();
		if (last !== undefined && h.length > 0) {
			h[0] = last;
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				const r = 2 * i + 2;
				let s = i;
				if (l < h.length && h[l].p < h[s].p) s = l;
				if (r < h.length && h[r].p < h[s].p) s = r;
				if (s === i) break;
				[h[s], h[i]] = [h[i], h[s]];
				i = s;
			}
		}
		return top;
	}
}

/** Dijkstra shortest path between two vertices. Returns the vertex-id
 *  sequence from `from` to `to`, or null when they are disconnected. */
export function shortestPath(graph: RailGraph, from: number, to: number): number[] | null {
	const n = graph.vertices.length;
	const dist = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
	const prev = new Int32Array(n).fill(-1);
	const done = new Uint8Array(n);
	dist[from] = 0;
	const heap = new MinHeap();
	heap.push(0, from);

	while (heap.size > 0) {
		const cur = heap.pop();
		if (cur === undefined) break;
		const u = cur.v;
		if (done[u]) continue;
		done[u] = 1;
		if (u === to) break;
		for (const e of graph.adj[u]) {
			const nd = cur.p + e.w;
			if (nd < dist[e.to]) {
				dist[e.to] = nd;
				prev[e.to] = u;
				heap.push(nd, e.to);
			}
		}
	}

	if (!Number.isFinite(dist[to])) return null;
	const path: number[] = [];
	for (let v = to; v !== -1; v = prev[v]) path.push(v);
	path.reverse();
	return path;
}

/** Find the rail-graph vertex nearest a point. */
export function nearestVertex(graph: RailGraph, p: { lat: number; lon: number }): { id: number; distM: number } | null {
	let bestId = -1;
	let bestD = Number.POSITIVE_INFINITY;
	for (let i = 0; i < graph.vertices.length; i++) {
		const v = graph.vertices[i];
		const d = metersBetween(p.lat, p.lon, v.lat, v.lon);
		if (d < bestD) {
			bestD = d;
			bestId = i;
		}
	}
	return bestId < 0 ? null : { id: bestId, distM: bestD };
}

/**
 * Interpolate the segment's `[startTs, endTs]` window linearly along
 * the path by cumulative distance: endpoints land exactly on the
 * window bounds, interior points fall by how far along they are.
 *
 * Exported so the velocity pipeline can apply a precomputed route
 * geometry (which has no timestamps of its own) to a specific train
 * segment's time window.
 */
export function interpolateTimes(
	coords: Array<{ lat: number; lon: number }>,
	startTs: number,
	endTs: number,
): SnappedPoint[] {
	const cum: number[] = [0];
	for (let i = 1; i < coords.length; i++) {
		cum.push(cum[i - 1] + metersBetween(coords[i - 1].lat, coords[i - 1].lon, coords[i].lat, coords[i].lon));
	}
	const total = cum[cum.length - 1];
	return coords.map((c, i) => ({
		lat: c.lat,
		lon: c.lon,
		ts: total > 0 ? Math.round(startTs + (endTs - startTs) * (cum[i] / total)) : startTs,
	}));
}

/**
 * Snap a confident train segment onto the rail network.
 *
 * `corridorFixes` is the cloud of historic GPS fixes for this route —
 * the union of every past journey between the same two stations. The
 * graph search is weighted to follow that cloud (see {@link cloudPenalty}),
 * so the snapped path traces the line actually ridden rather than the
 * geometrically-shortest path, which would happily cut across a line
 * the user never takes.
 *
 * Returns the rail path from the boarding to the alighting station,
 * time-interpolated across the segment window — or null when the
 * segment cannot be snapped: the historic corridor is too thin
 * ({@link MIN_CLOUD_FIXES}), the label is not a station pair, a station
 * name is unknown to the OSM mirror, a station is too far from any rail
 * line, or the two stations are disconnected in the captured geometry.
 * A null result means "draw the raw fixes" — never a degenerate or
 * confidently-wrong path.
 */
export function snapTrainSegment(
	seg: TrainSegment,
	geo: RailGeometry,
	corridorFixes: ReadonlyArray<{ lat: number; lon: number }>,
): SnapResult | null {
	const parsed = parseRailWayName(seg.wayName);
	if (!parsed) return null;

	const board = resolveStation(parsed.board, geo.stations);
	const alight = resolveStation(parsed.alight, geo.stations);
	if (!board || !alight || board.name === alight.name) return null;

	// Without enough historic fixes there is no trustworthy corridor —
	// leave the run un-snapped rather than draw a guessed line.
	if (corridorFixes.length < MIN_CLOUD_FIXES) return null;
	const cloud = new FixCloud(corridorFixes);

	const graph = buildRailGraph(geo.lines, cloud);
	if (graph.vertices.length === 0) return null;

	const fromV = nearestVertex(graph, board);
	const toV = nearestVertex(graph, alight);
	if (!fromV || !toV) return null;
	if (fromV.distM > MAX_STATION_TO_RAIL_M || toV.distM > MAX_STATION_TO_RAIL_M) return null;
	if (fromV.id === toV.id) return null;

	const idPath = shortestPath(graph, fromV.id, toV.id);
	if (!idPath || idPath.length < 2) return null;

	const coords = idPath.map((i) => graph.vertices[i]);
	return { board, alight, line: parsed.line, path: interpolateTimes(coords, seg.startTs, seg.endTs) };
}

/** True when an OSM way's name places it on `line` — the canonical
 *  `"<Name> Line"` form. Handles shared-track ways tagged with several lines
 *  ("Circle, Hammersmith & City and Metropolitan Lines") and directional
 *  suffixes ("Metropolitan Line Westbound") via {@link parseLineMemberships}. */
function wayOnLine(osmName: string | null, line: string): boolean {
	return parseLineMemberships(osmName).has(line);
}

/**
 * Snap a confident train leg onto its KNOWN line, routing between the two
 * named stations over ONLY that line's ways — with NO historic fix cloud.
 *
 * {@link snapTrainSegment} needs a dense pooled fix cloud
 * ({@link MIN_CLOUD_FIXES}) both to trust the run and to disambiguate parallel
 * lines. When the leg's label carries a line name (e.g. from underground-run
 * reconstruction), the LINE itself is the disambiguator: restrict the graph to
 * that line's ways and the geometric shortest path between the two stations IS
 * the ridden route. This lets a thin / one-off underground ride still render on
 * the track (the map's dotted "snapped" style), which the cloud-gated snap
 * refuses. It is the intended v2 refinement flagged in this module's header.
 *
 * Returns null when the label has no line, a station is unknown or off the
 * line-restricted network, or the two stations are disconnected on that line —
 * i.e. "draw the raw fixes", never a guessed path.
 */
export function snapTrainSegmentOnLine(seg: TrainSegment, geo: RailGeometry): SnapResult | null {
	const parsed = parseRailWayName(seg.wayName);
	if (!parsed?.line) return null;
	const line = parsed.line;

	const board = resolveStation(parsed.board, geo.stations);
	const alight = resolveStation(parsed.alight, geo.stations);
	if (!board || !alight || board.name === alight.name) return null;

	const lineLines = geo.lines.filter((l) => wayOnLine(l.name, line));
	if (lineLines.length === 0) return null;

	// Empty fix cloud → every edge carries the same uniform penalty, so Dijkstra
	// returns the geometric shortest path; within a single line's ways that is
	// the route between the two stations.
	const graph = buildRailGraph(lineLines, new FixCloud([]));
	if (graph.vertices.length === 0) return null;

	const fromV = nearestVertex(graph, board);
	const toV = nearestVertex(graph, alight);
	if (!fromV || !toV) return null;
	if (fromV.distM > MAX_STATION_TO_RAIL_M || toV.distM > MAX_STATION_TO_RAIL_M) return null;
	if (fromV.id === toV.id) return null;

	const idPath = shortestPath(graph, fromV.id, toV.id);
	if (!idPath || idPath.length < 2) return null;

	const coords = idPath.map((i) => graph.vertices[i]);
	return { board, alight, line, path: interpolateTimes(coords, seg.startTs, seg.endTs) };
}

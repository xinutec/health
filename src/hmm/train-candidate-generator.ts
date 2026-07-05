/**
 * Train (board, line, alight) candidate generator — Phase 1 of the
 * constraint-first decoder
 * (`docs/proposals/decoder-roadmap.md`).
 *
 * Hard generator: produces only physically valid `train @ L`
 * segments. A candidate `(start, end, line, board, alight)` is
 * emitted iff:
 *
 *   - The window `[start, end]` has GPS observations consistent
 *     with a train ride (peak speed ≥ V_train_peak; average speed
 *     ≥ V_train_avg over the window, ignoring null-GPS minutes).
 *   - The GPS context at `start` lies within R_station of a station
 *     node on `line`.
 *   - The GPS context at `end` lies within R_station of a station
 *     node on `line`.
 *   - Board and alight are distinct stations.
 *   - Board and alight are graph-connected on `line`'s per-line
 *     edge subgraph.
 *
 * The HSMM scores ONLY candidates this generator emits. Any
 * (mode=train, line=L) hypothesis outside this set has -∞ score
 * and is not considered. That's the structural fix the
 * per-minute factor stack couldn't achieve: physically impossible
 * train hypotheses (e.g. a Met train alighting at Green Park,
 * which has no Met station) are filtered upstream rather than
 * soft-penalised downstream.
 *
 * Pure module with respect to its inputs.
 */

import { nodeKey, type RouteGraph, type RouteNode } from "../geo/route-graph.js";
import type { Observation } from "./observation.js";

export interface TrainCandidate {
	/** First minute of the candidate window (inclusive, index into
	 *  `observations`). */
	startMin: number;
	/** Last minute of the candidate window (inclusive). */
	endMin: number;
	line: string;
	boardStationId: string;
	alightStationId: string;
	boardStationName?: string;
	alightStationName?: string;
}

export interface EnumerateTrainCandidatesInput {
	observations: readonly Observation[];
	routeGraph: RouteGraph;
	knownLines: readonly string[];
}

/** Peak GPS speed (km/h) required to consider a window train-like. */
const V_TRAIN_PEAK_KMH = 25;
/** Average GPS speed over observed (non-null) GPS minutes in the
 *  window required to consider it train-like. */
const V_TRAIN_AVG_KMH = 12;
/** Minimum window length in minutes to consider a train segment. */
const MIN_WINDOW_MIN = 2;
/** A train-tagged run shorter than `MIN_WINDOW_MIN` is normally GPS
 *  jitter — but a one-stop underground hop is a single-minute event:
 *  a fix at the boarding platform, one train-speed reacquisition near
 *  the alighting platform, then walking. It surfaces below the floor.
 *  We rescue such a sub-floor run only when the fixes bracketing it
 *  show a genuine station-to-station displacement at train speed — the
 *  reacquisition signature — distinguishing a real hop from a lone
 *  jittery reading that returns to where it started. */
const STATION_HOP_MIN_DISPLACEMENT_M = 400;
/** Maximum window length in minutes. */
const MAX_WINDOW_MIN = 90;
/** Radius (m) within which the GPS context at the window boundary
 *  must lie of a station node for it to be a board/alight
 *  candidate. */
const R_STATION_M = 250;

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Radius (m) within which a rail edge counts as "passing the
 *  station" for line-membership purposes. Wider than the node-
 *  merge radius because OSM tube station POIs are tagged at the
 *  street entrance, often 30-150 m off the underground way
 *  endpoint at the platform. */
const STATION_LINE_RADIUS_M = 250;

/** Which lines pass within `STATION_LINE_RADIUS_M` of the station
 *  node. Uses the edge spatial index — robust to the OSM gap
 *  between station-entrance coords and underground-way endpoint
 *  coords. */
function stationLineMemberships(routeGraph: RouteGraph, node: RouteNode): Set<string> {
	const out = new Set<string>();
	for (const edge of routeGraph.edgesNear(node.point.lat, node.point.lon, STATION_LINE_RADIUS_M)) {
		for (const line of edge.attrs.lineMemberships) out.add(line);
	}
	return out;
}

/** Station nodes within `radiusM` of `(lat, lon)`. Only nodes with
 *  station metadata count — we don't accept arbitrary way-endpoint
 *  nodes as boarding/alighting points. */
function stationsNear(
	routeGraph: RouteGraph,
	lat: number,
	lon: number,
	radiusM: number,
): { node: RouteNode; distM: number }[] {
	const result: { node: RouteNode; distM: number }[] = [];
	for (const node of routeGraph.nodes.values()) {
		if (node.stationName === undefined) continue;
		const d = haversineMeters(lat, lon, node.point.lat, node.point.lon);
		if (d <= radiusM) result.push({ node, distM: d });
	}
	return result;
}

/** Station-footprint radius (m): nodes within this distance of a
 *  station's POI coordinate count as "in the station's footprint"
 *  for the purpose of starting / ending a connectivity BFS. The
 *  station POI sits at the entrance; the underground way endpoints
 *  (where the track is graph-connected) are typically 50–150 m
 *  away at platform level. Without this, the BFS starts only from
 *  the single 150-m-merged node, which may not have the right
 *  line's edges incident — disconnecting the station from its own
 *  tracks. */
const STATION_FOOTPRINT_M = 200;

/** Every node within `STATION_FOOTPRINT_M` of `station.point`,
 *  including the station's own merged node. */
function stationFootprintNodes(routeGraph: RouteGraph, station: RouteNode): Set<string> {
	const out = new Set<string>([station.id]);
	const stationLat = station.point.lat;
	const stationLon = station.point.lon;
	for (const edge of routeGraph.edgesNear(stationLat, stationLon, STATION_FOOTPRINT_M)) {
		for (const endpoint of [edge.startPoint, edge.endPoint]) {
			const d = haversineMeters(stationLat, stationLon, endpoint.lat, endpoint.lon);
			if (d <= STATION_FOOTPRINT_M) out.add(nodeKey(endpoint.lat, endpoint.lon));
		}
	}
	return out;
}

/** BFS on the per-line edge subgraph. Returns true when any path
 *  on L's edges connects a node in `start` to a node in `goal`. */
function nodesConnectedOnLine(
	routeGraph: RouteGraph,
	line: string,
	startNodeIds: ReadonlySet<string>,
	goalNodeIds: ReadonlySet<string>,
	maxExpand = 10_000,
): boolean {
	if (startNodeIds.size === 0 || goalNodeIds.size === 0) return false;
	for (const id of startNodeIds) if (goalNodeIds.has(id)) return true;
	const visited = new Set<string>(startNodeIds);
	const queue: string[] = [...startNodeIds];
	while (queue.length > 0 && visited.size < maxExpand) {
		const nodeId = queue.shift();
		if (nodeId === undefined) break;
		const node = routeGraph.nodes.get(nodeId);
		if (node === undefined) continue;
		for (const edgeId of node.edgeIds) {
			const edge = routeGraph.edges.get(edgeId);
			if (edge === undefined) continue;
			if (!edge.attrs.lineMemberships.has(line)) continue;
			for (const endpoint of [edge.startPoint, edge.endPoint]) {
				const nextId = nodeKey(endpoint.lat, endpoint.lon);
				if (visited.has(nextId)) continue;
				if (goalNodeIds.has(nextId)) return true;
				visited.add(nextId);
				queue.push(nextId);
			}
		}
	}
	return false;
}

/** GPS context at minute `t`: the GPS fix at `t` if observed, else
 *  the nearest observed fix in time. Returns null when none exist
 *  in the observation sequence. */
function gpsContextAt(observations: readonly Observation[], t: number): { lat: number; lon: number } | null {
	if (t < 0 || t >= observations.length) return null;
	const here = observations[t].gps;
	if (here !== null) return { lat: here.lat, lon: here.lon };
	// Search outward.
	for (let d = 1; d < observations.length; d++) {
		const left = t - d;
		const right = t + d;
		if (left >= 0) {
			const lg = observations[left].gps;
			if (lg !== null) return { lat: lg.lat, lon: lg.lon };
		}
		if (right < observations.length) {
			const rg = observations[right].gps;
			if (rg !== null) return { lat: rg.lat, lon: rg.lon };
		}
	}
	// Fall back to prev/nextGpsFix on this minute (set by callers).
	const ob = observations[t];
	if (ob.prevGpsFix !== null) return { lat: ob.prevGpsFix.lat, lon: ob.prevGpsFix.lon };
	if (ob.nextGpsFix !== null) return { lat: ob.nextGpsFix.lat, lon: ob.nextGpsFix.lon };
	return null;
}

/** The fix observed (or bracketing) just outside a window edge.
 *  Looks for the last/first GPS-observed minute strictly before
 *  `start` / after `end`; falls back to the prev/next-fix bookends
 *  recorded on the boundary minutes. Returns null when none exist. */
function boundaryFix(
	observations: readonly Observation[],
	idx: number,
	dir: -1 | 1,
): { lat: number; lon: number; ts: number } | null {
	for (let t = idx; t >= 0 && t < observations.length; t += dir) {
		const g = observations[t].gps;
		if (g !== null) return { lat: g.lat, lon: g.lon, ts: observations[t].ts };
	}
	// No observed fix on that side — use the bookend recorded on the
	// edge minute (set by callers for GPS-null underground runs).
	const edge = observations[Math.max(0, Math.min(observations.length - 1, idx))];
	const book = dir === -1 ? edge.prevGpsFix : edge.nextGpsFix;
	return book === null ? null : { lat: book.lat, lon: book.lon, ts: book.ts };
}

/** Whether a sub-floor train-tagged run `[start, end]` carries the
 *  reacquisition signature of a one-stop hop: the fixes bracketing it
 *  show a genuine station-to-station displacement
 *  (≥ STATION_HOP_MIN_DISPLACEMENT_M) covered at train speed
 *  (≥ V_TRAIN_AVG_KMH). A lone jittery fast fix that returns to its
 *  origin has near-zero net displacement and fails this. */
function bracketedStationHop(observations: readonly Observation[], start: number, end: number): boolean {
	const before = boundaryFix(observations, start - 1, -1);
	const after = boundaryFix(observations, end + 1, 1);
	if (before === null || after === null) return false;
	const distM = haversineMeters(before.lat, before.lon, after.lat, after.lon);
	if (distM < STATION_HOP_MIN_DISPLACEMENT_M) return false;
	const hrs = (after.ts - before.ts) / 3600;
	const implicitKmh = distM / 1000 / Math.max(hrs, 1 / 3600);
	return implicitKmh >= V_TRAIN_AVG_KMH;
}

/** Identify contiguous time windows where the user is likely on a
 *  train. Two pathways:
 *
 *  (a) **Observed train speed.** A maximal run of minutes where
 *      either GPS speed ≥ V_TRAIN_AVG_KMH or GPS is null while
 *      bracketed by train-speed observations on both sides, with
 *      at least one peak ≥ V_TRAIN_PEAK_KMH and average over
 *      observed minutes ≥ V_TRAIN_AVG_KMH.
 *
 *  (b) **Bracketed-displacement tube ride.** A run of GPS-null
 *      minutes bracketed by two GPS-observed fixes whose
 *      displacement implies an average velocity ≥ V_TRAIN_AVG_KMH
 *      over the gap. The user's position moved kilometres between
 *      observations even though no speed was observed — the only
 *      plausible mode is an underground or sparse-fix vehicle
 *      ride. Underground tube rides surface this way (no GPS
 *      between boarding and alighting, but the alight fix is far
 *      from the boarding fix).
 *
 *  Returns disjoint `[start, end]` pairs sorted by start time. */
function findTrainWindows(observations: readonly Observation[]): { start: number; end: number }[] {
	const T = observations.length;
	if (T === 0) return [];

	type Tag = "train" | "unknown" | "not-train";
	const tag = new Array<Tag>(T);
	for (let t = 0; t < T; t++) {
		const g = observations[t].gps;
		if (g === null) tag[t] = "unknown";
		else if (g.speedKmh >= V_TRAIN_AVG_KMH) tag[t] = "train";
		else tag[t] = "not-train";
	}

	// Bracketed-displacement pass: when a GPS-observed minute is
	// followed (eventually) by another GPS-observed minute and the
	// gap between them implies train velocity, mark every minute in
	// the gap (and its boundaries) as "train".
	let lastObservedIdx = -1;
	for (let t = 0; t < T; t++) {
		if (observations[t].gps === null) continue;
		if (lastObservedIdx === -1 || lastObservedIdx === t - 1) {
			lastObservedIdx = t;
			continue;
		}
		const left = observations[lastObservedIdx].gps;
		const right = observations[t].gps;
		if (left === null || right === null) {
			lastObservedIdx = t;
			continue;
		}
		const elapsedH = (t - lastObservedIdx) / 60;
		const distKm = haversineMeters(left.lat, left.lon, right.lat, right.lon) / 1000;
		const implicitKmh = distKm / Math.max(elapsedH, 1 / 3600);
		if (implicitKmh >= V_TRAIN_AVG_KMH) {
			for (let k = lastObservedIdx; k <= t; k++) tag[k] = "train";
		}
		lastObservedIdx = t;
	}

	const windows: { start: number; end: number }[] = [];
	let i = 0;
	while (i < T) {
		if (tag[i] === "not-train") {
			i++;
			continue;
		}
		let j = i;
		while (j < T && tag[j] !== "not-train") j++;
		let start = i;
		let end = j - 1;
		while (start <= end && tag[start] === "unknown") start++;
		while (end >= start && tag[end] === "unknown") end--;
		// A run at/above the floor qualifies on its own; a shorter run
		// qualifies only with the station-to-station reacquisition
		// signature (a one-stop underground hop is a single minute).
		const longEnough = end - start + 1 >= MIN_WINDOW_MIN;
		const isStationHop = !longEnough && bracketedStationHop(observations, start, end);
		if (start <= end && (longEnough || isStationHop)) {
			// Verify the window meets train-velocity threshold by
			// either observed speed OR implied displacement.
			let peak = 0;
			let sumSpeed = 0;
			let nObs = 0;
			let firstObs: { lat: number; lon: number; t: number } | null = null;
			let lastObs: { lat: number; lon: number; t: number } | null = null;
			for (let t = start; t <= end; t++) {
				const g = observations[t].gps;
				if (g === null) continue;
				if (g.speedKmh > peak) peak = g.speedKmh;
				sumSpeed += g.speedKmh;
				nObs++;
				if (firstObs === null) firstObs = { lat: g.lat, lon: g.lon, t };
				lastObs = { lat: g.lat, lon: g.lon, t };
			}
			const avg = nObs > 0 ? sumSpeed / nObs : 0;
			let implicitKmh = 0;
			if (firstObs !== null && lastObs !== null && lastObs.t > firstObs.t) {
				const distKm = haversineMeters(firstObs.lat, firstObs.lon, lastObs.lat, lastObs.lon) / 1000;
				const hrs = (lastObs.t - firstObs.t) / 60;
				implicitKmh = distKm / Math.max(hrs, 1 / 3600);
			} else if (firstObs === null) {
				// No observed GPS in the window itself — fall back to the
				// prev/next-fix bookends recorded on the minutes.
				const startCtxPrev = observations[start].prevGpsFix;
				const endCtxNext = observations[end].nextGpsFix;
				if (startCtxPrev !== null && endCtxNext !== null && endCtxNext.ts > startCtxPrev.ts) {
					const distKm = haversineMeters(startCtxPrev.lat, startCtxPrev.lon, endCtxNext.lat, endCtxNext.lon) / 1000;
					const hrs = (endCtxNext.ts - startCtxPrev.ts) / 3600;
					implicitKmh = distKm / Math.max(hrs, 1 / 3600);
				}
			}
			// The window qualifies when observed evidence OR implied
			// inter-fix displacement is consistent with train speed.
			// The implied check catches underground rides where speed
			// is never directly observed.
			const meetsPeak = peak >= V_TRAIN_PEAK_KMH || implicitKmh >= V_TRAIN_AVG_KMH;
			const meetsAvg = avg >= V_TRAIN_AVG_KMH || implicitKmh >= V_TRAIN_AVG_KMH;
			if (meetsPeak && meetsAvg) {
				const windowLen = Math.min(end - start + 1, MAX_WINDOW_MIN);
				windows.push({ start, end: start + windowLen - 1 });
			}
		}
		i = j + 1;
	}
	return windows;
}

export function enumerateTrainCandidates(input: EnumerateTrainCandidatesInput): TrainCandidate[] {
	const windows = findTrainWindows(input.observations);
	const knownLineSet = new Set(input.knownLines);

	const candidates: TrainCandidate[] = [];

	for (const window of windows) {
		// Board station: where the user was AT the platform before
		// the moving train started — the last observed GPS fix
		// strictly before the window began. (Inside the window
		// they're already on the moving train, not at the station.)
		const startCtx =
			gpsContextAt(input.observations, window.start - 1) ?? gpsContextAt(input.observations, window.start);
		// Alight station: where the user is AT the platform after
		// the train stopped — the first observed GPS fix strictly
		// after the window ended.
		const endCtx = gpsContextAt(input.observations, window.end + 1) ?? gpsContextAt(input.observations, window.end);
		if (startCtx === null || endCtx === null) continue;

		const boardCandidates = stationsNear(input.routeGraph, startCtx.lat, startCtx.lon, R_STATION_M);
		const alightCandidates = stationsNear(input.routeGraph, endCtx.lat, endCtx.lon, R_STATION_M);
		if (boardCandidates.length === 0 || alightCandidates.length === 0) continue;

		for (const line of input.knownLines) {
			if (!knownLineSet.has(line)) continue;
			const boards = boardCandidates.filter((c) => stationLineMemberships(input.routeGraph, c.node).has(line));
			const alights = alightCandidates.filter((c) => stationLineMemberships(input.routeGraph, c.node).has(line));
			if (boards.length === 0 || alights.length === 0) continue;

			// Try every (board, alight) pair on the line. Most days
			// produce 1-3 stations per side, so this is cheap.
			for (const b of boards) {
				const boardFootprint = stationFootprintNodes(input.routeGraph, b.node);
				for (const a of alights) {
					if (b.node.id === a.node.id) continue;
					const alightFootprint = stationFootprintNodes(input.routeGraph, a.node);
					if (!nodesConnectedOnLine(input.routeGraph, line, boardFootprint, alightFootprint)) {
						continue;
					}
					candidates.push({
						startMin: window.start,
						endMin: window.end,
						line,
						boardStationId: b.node.id,
						alightStationId: a.node.id,
						boardStationName: b.node.stationName,
						alightStationName: a.node.stationName,
					});
				}
			}
		}
	}

	return candidates;
}

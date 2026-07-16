/**
 * Exit→entry chain context for the HSMM (C4.2 proper,
 * `docs/proposals/2026-07-continuity-c4.md`).
 *
 * The transition matrix knows mode adjacency but not *place*
 * continuity: nothing asks whether a segment change is geometrically
 * feasible from where the previous segment actually ended. This factor
 * scores every new-segment transition with the exit evidence the
 * observation tensor already carries (`prevGpsFix` — the last fix
 * at-or-before the transition minute):
 *
 *   - **entering `stationary @ P`**: the exit position must be near P.
 *     A stay claimed kilometres from the last fix is a teleport and
 *     pays; a stay entered where the fixes are costs ~nothing. This is
 *     the roadmap's `position-teleport` check as a graduated term.
 *   - **leaving `stationary @ P` into a moving state**: the departure
 *     position (last fix before the move) must be near P — a stay
 *     hypothesis whose tail is demonstrably elsewhere pays on exit.
 *   - **entering `train @ L`** (boarding feasibility): the exit anchor
 *     — P's coordinates when leaving a known place (no GPS needed),
 *     else the last fix — must be near L's track. Boarding a line the
 *     user is nowhere near is expensive; gated off where the train
 *     generator vouches the window (it owns line attribution there,
 *     mirroring `line-proximity-factor`).
 *
 * Staleness discipline (same shape as `segment-evidence.ts`): a fix
 * `m` minutes older than the transition widens σ by
 * `SLOP_SPEED_M_PER_MIN·m` in quadrature — deep in a GPS blackout the
 * exit position is unknowable and the factor asserts ~nothing, so dark
 * rides are not convicted by stale anchors.
 *
 * Shape discipline (probabilistic-principles): pure z²/2 penalties,
 * clamped, no normalization constants — geometric consistency scores
 * ~0, teleports score negative, nothing is a veto.
 *
 * Pure module. No DB, no IO, no flags (the caller gates it).
 */

import { pointToPolylineMeters, type RouteEdge, type RouteGraph } from "../geo/route-graph.js";
import type { Observation } from "./observation.js";
import type { State } from "./state-space.js";

/** σ on "the exit fix sits at place P" (m): fix scatter + place extent. */
const PLACE_NOISE_M = 300;
/** σ on "the exit anchor can board line L here" (m): walk-to-station
 *  reach around the anchor. */
const LINE_NOISE_M = 800;
/** Unattributable-motion spread per minute of fix staleness (m/min) —
 *  see `segment-evidence.ts`. */
const SLOP_SPEED_M_PER_MIN = 500;
/** Hard clamp — evidence, never a veto. */
const CLAMP_NATS = -6;

/** Distances beyond this are all "nowhere near the line" — the exact
 *  value stops mattering once the penalty has clamped, so the per-line
 *  scan can stop early. */
const LINE_MISS_DIST_M = 5000;

const MOVING_MODES: ReadonlySet<string> = new Set(["walking", "cycling", "driving", "train", "plane"]);

export interface BuildChainContextOpts {
	/** focus_places.id → centroid. */
	placeCoords: ReadonlyMap<number, { lat: number; lon: number }>;
	routeGraph: RouteGraph;
	/** Train-generator coverage: when the generator vouches the entry
	 *  minute, the boarding-feasibility term yields (no double-count). */
	isTrainCovered?: (ts: number) => boolean;
}

export type ChainContextFn = (from: State, to: State, obs: Observation) => number;

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** −z²/2 with σ widened in quadrature by fix staleness, clamped. */
function slopZPenalty(distM: number, sigmaM: number, slopMin: number): number {
	const sigma = Math.sqrt(sigmaM * sigmaM + (SLOP_SPEED_M_PER_MIN * slopMin) ** 2);
	const z = distM / sigma;
	return Math.max(CLAMP_NATS, -0.5 * z * z);
}

/** Per-line edge lists with bounding boxes for cheap rejection — the
 *  grid behind `edgesNear` only reaches ~750 m, far too short for a
 *  "you are nowhere near this line" verdict, so the boarding term
 *  scans the line's own edges directly. A line absent from the map
 *  can't be scored (mirrors `line-proximity-factor`). */
interface LineEdge {
	edge: RouteEdge;
	minLat: number;
	maxLat: number;
	minLon: number;
	maxLon: number;
}

function edgesByLine(routeGraph: RouteGraph): Map<string, LineEdge[]> {
	const byLine = new Map<string, LineEdge[]>();
	for (const edge of routeGraph.edges.values()) {
		if (edge.attrs.lineMemberships.size === 0) continue;
		let minLat = Number.POSITIVE_INFINITY;
		let maxLat = Number.NEGATIVE_INFINITY;
		let minLon = Number.POSITIVE_INFINITY;
		let maxLon = Number.NEGATIVE_INFINITY;
		for (const p of edge.geometry) {
			if (p.lat < minLat) minLat = p.lat;
			if (p.lat > maxLat) maxLat = p.lat;
			if (p.lon < minLon) minLon = p.lon;
			if (p.lon > maxLon) maxLon = p.lon;
		}
		const entry: LineEdge = { edge, minLat, maxLat, minLon, maxLon };
		for (const line of edge.attrs.lineMemberships) {
			let list = byLine.get(line);
			if (list === undefined) {
				list = [];
				byLine.set(line, list);
			}
			list.push(entry);
		}
	}
	return byLine;
}

/** ~metres per degree latitude; used only for coarse bbox rejection. */
const M_PER_DEG = 111_320;

function minDistToLineM(anchor: { lat: number; lon: number }, lineEdges: readonly LineEdge[]): number {
	let best = LINE_MISS_DIST_M;
	const cosLat = Math.cos((anchor.lat * Math.PI) / 180);
	for (const le of lineEdges) {
		// Bbox lower bound: skip edges that cannot beat the current best.
		const dLat = Math.max(0, le.minLat - anchor.lat, anchor.lat - le.maxLat) * M_PER_DEG;
		const dLon = Math.max(0, le.minLon - anchor.lon, anchor.lon - le.maxLon) * M_PER_DEG * cosLat;
		if (Math.max(dLat, dLon) >= best) continue;
		const d = pointToPolylineMeters(anchor.lat, anchor.lon, le.edge.geometry);
		if (d < best) best = d;
	}
	return best;
}

/** Per-minute memo — the new-segment loop calls the factor O(S²) times
 *  per minute with the SAME observation, so all geometry resolves to
 *  cheap map lookups after the first call at each minute. */
interface MinuteMemo {
	/** placeId → place-anchored penalty (dist(prevGpsFix, P), slopped). */
	stayPenalty: Map<number, number>;
	/** lineName → fix-anchored boarding penalty (slopped). */
	lineFromFixPenalty: Map<string, number>;
}

export function buildChainContext(opts: BuildChainContextOpts): ChainContextFn {
	const { placeCoords, routeGraph, isTrainCovered } = opts;
	const lineEdgeIndex = edgesByLine(routeGraph);

	const minuteMemo = new WeakMap<Observation, MinuteMemo>();
	// (placeId, line) boarding penalties are time-independent — one
	// lazy matrix for the whole day. placeId → (line → penalty).
	const lineFromPlacePenalty = new Map<number, Map<string, number>>();

	function memoFor(obs: Observation): MinuteMemo {
		let m = minuteMemo.get(obs);
		if (m === undefined) {
			m = { stayPenalty: new Map(), lineFromFixPenalty: new Map() };
			minuteMemo.set(obs, m);
		}
		return m;
	}

	function stayPenalty(obs: Observation, fix: { ts: number; lat: number; lon: number }, placeId: number): number {
		const memo = memoFor(obs);
		let pen = memo.stayPenalty.get(placeId);
		if (pen === undefined) {
			const p = placeCoords.get(placeId);
			if (p === undefined) {
				pen = 0;
			} else {
				const d = haversineMeters(fix.lat, fix.lon, p.lat, p.lon);
				pen = slopZPenalty(d, PLACE_NOISE_M, Math.max(0, obs.ts - fix.ts) / 60);
			}
			memo.stayPenalty.set(placeId, pen);
		}
		return pen;
	}

	function boardingFromPlace(placeId: number, line: string, lineEdges: readonly LineEdge[]): number {
		let byLine = lineFromPlacePenalty.get(placeId);
		if (byLine === undefined) {
			byLine = new Map();
			lineFromPlacePenalty.set(placeId, byLine);
		}
		let pen = byLine.get(line);
		if (pen === undefined) {
			const p = placeCoords.get(placeId);
			pen = p === undefined ? 0 : slopZPenalty(minDistToLineM(p, lineEdges), LINE_NOISE_M, 0);
			byLine.set(line, pen);
		}
		return pen;
	}

	function boardingFromFix(
		obs: Observation,
		fix: { ts: number; lat: number; lon: number },
		line: string,
		lineEdges: readonly LineEdge[],
	): number {
		const memo = memoFor(obs);
		let pen = memo.lineFromFixPenalty.get(line);
		if (pen === undefined) {
			const d = minDistToLineM(fix, lineEdges);
			pen = slopZPenalty(d, LINE_NOISE_M, Math.max(0, obs.ts - fix.ts) / 60);
			memo.lineFromFixPenalty.set(line, pen);
		}
		return pen;
	}

	return (from: State, to: State, obs: Observation): number => {
		const fix = obs.prevGpsFix;
		let score = 0;

		if (to.mode === "stationary") {
			// Entering a known place: the exit position must be near it.
			if (fix !== null && to.placeId !== null) score += stayPenalty(obs, fix, to.placeId);
		} else {
			// Leaving a known place into a moving state: the departure
			// position must be near it.
			if (fix !== null && from.mode === "stationary" && from.placeId !== null && MOVING_MODES.has(to.mode)) {
				score += stayPenalty(obs, fix, from.placeId);
			}
			// Boarding feasibility: entering train @ L must be reachable
			// from the exit anchor. Skips unknown_rail (no track to test)
			// and generator-vouched windows (the entry prior owns line
			// there).
			if (to.mode === "train" && to.lineName !== null && to.lineName !== "unknown_rail") {
				const lineEdges = lineEdgeIndex.get(to.lineName);
				if (lineEdges !== undefined && !(isTrainCovered?.(obs.ts) ?? false)) {
					if (from.placeId !== null && placeCoords.has(from.placeId)) {
						// Place anchor: exact, no staleness.
						score += boardingFromPlace(from.placeId, to.lineName, lineEdges);
					} else if (fix !== null) {
						score += boardingFromFix(obs, fix, to.lineName, lineEdges);
					}
				}
			}
		}

		return score;
	};
}

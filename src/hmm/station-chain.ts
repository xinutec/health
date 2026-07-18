/**
 * C4.3 — chained train triples (`docs/proposals/2026-07-continuity-c4.md`).
 *
 * Post-decode station resolution: given the day's decoded segments, assign
 * each named-line train leg a (board, alight) station pair, scored JOINTLY
 * along the journey chain instead of per-leg in isolation. This is the
 * anchors' legitimate evidence (walked-to-station endpoints, platform
 * dwells, reacquisition fixes) recast as likelihood terms over a
 * physically-valid candidate set — replacing the post-hoc label rewrites
 * that could overwrite a correct answer (#351).
 *
 * Terms, all in nats, all clamped (evidence, never a veto):
 *
 *   - **Anchor distance.** The board candidate is scored against the last
 *     fix before the leg; the alight candidate against the first fix
 *     after it. σ widens in quadrature with fix staleness
 *     (`SLOP_SPEED_M_PER_MIN`, the C4.2 discipline) — deep in a blackout
 *     an anchor asserts ~nothing, and the candidate radius widens
 *     symmetrically so a stale anchor doesn't exclude the true station.
 *   - **Ride duration.** Observed leg minutes vs the along-line path
 *     length between the candidate pair (Dijkstra on the line's own
 *     edges — which also enforces connectivity: an unreachable pair is
 *     not a candidate).
 *   - **Terminal-dwell consistency.** Alighting at A means the ride
 *     reaches A at the leg's END; boarding at B means it leaves B at
 *     the START. An in-leg fix near a candidate long before/after that
 *     implies a train dwelling minutes at a through station —
 *     implausible, and it is exactly how a mid-ride station where
 *     "clean GPS ended" (the surface→tunnel portal) would otherwise
 *     masquerade as the alight.
 *   - **Chain feasibility.** Consecutive legs of a journey must hand
 *     over: alight(N−1) at/near board(N), or a transfer walkable within
 *     the observed gap. This is what recovers an interchange the GPS
 *     never saw.
 *   - **Trajectory coherence (v2).** In-leg fixes projected onto the
 *     line's own track vote on each side: for a candidate, the fixes'
 *     along-line distances to it must fall to ~zero at the leg boundary.
 *     A Theil–Sen fit (median of pairwise slopes) extrapolates the
 *     approach, so a MINORITY of corrupted fixes — the stale
 *     reacquire jump-back class — cannot steer it, and a candidate the
 *     ride sailed past extrapolates kilometres NEGATIVE and pays.
 *     Trajectory also ADMITS candidates the anchor cannot see: stations
 *     along-line reachable from a near-boundary on-track fix within the
 *     remaining ride time (the anchor may be km-wrong; the track isn't).
 *
 * A small Viterbi over pairs per journey maximises the joint score;
 * emission is **confidence-gated per side** via max-marginals: a side is
 * emitted only when every alternative station is at least `MARGIN_NATS`
 * worse (the scoreboard treats a wrong station as worse than a missing
 * one, so ambiguity must yield null, not a guess), at least one evidence
 * channel (anchor or trajectory) actively supports the winner, and the
 * winner is not terminal-dwell-disqualified (fixes prove the ride passed
 * it mid-leg).
 *
 * Pure module. No DB, no IO, no flags.
 */

import { projectPointToSegment } from "../geo/map-match-core.js";
import type { RouteEdge, RouteGraph, RouteNode } from "../geo/route-graph.js";
import { nodeKey } from "../geo/route-graph.js";
import type { Observation } from "./observation.js";
import type { HmmSegment } from "./persist.js";
import { stationFootprintNodes, stationLineMemberships, stationsNear } from "./train-candidate-generator.js";

/** σ (m) on "the anchor fix is at this station": platform-to-entrance
 *  offset + fix scatter. */
const STATION_SIGMA_M = 200;
/** Unattributable-motion spread per minute of anchor staleness (m/min)
 *  — same constant as `segment-evidence.ts` / `chain-context.ts`. */
const SLOP_SPEED_M_PER_MIN = 500;
/** Candidate-station search radius around a fresh anchor (m); widens
 *  linearly with staleness so a stale anchor admits rather than
 *  excludes. */
const CAND_BASE_RADIUS_M = 800;
/** Keep the candidate set bounded under very stale anchors. */
const MAX_CANDIDATES_PER_SIDE = 12;
/** Typical in-service tube speed (incl. intermediate stops), km/h. */
const TUBE_SPEED_KMH = 32;
/** Fixed boarding/alighting overhead added to the expected ride (min). */
const STOP_OVERHEAD_MIN = 0.8;
/** Duration σ: max(2 min, 35% of the expected ride). */
const DURATION_SIGMA_FRAC = 0.35;
const DURATION_SIGMA_MIN = 2;
/** Same-station handover distance (m): station complexes span this. */
const SAME_STATION_M = 250;
/** A comfortable intra-station transfer pace (m/min); pace demanded
 *  above this starts paying. */
const TRANSFER_WALK_M_PER_MIN = 75;
const TRANSFER_Z_SCALE = 40;
/** Legs further apart than this are separate journeys — no chain term. */
const CHAIN_GAP_MAX_S = 12 * 60;
/** An in-leg fix within this distance of a candidate station counts as
 *  the ride being AT that station (terminal-dwell consistency). */
const STATION_PASS_M = 300;
/** Arrival/departure tolerance (min) before an implied terminal dwell
 *  at a through station starts paying. In-service tube dwells are
 *  measured in tens of seconds, so past the tolerance the z-scale is
 *  a single minute — reaching the candidate many minutes before the
 *  leg ends is close to disqualifying. */
const TERMINAL_DWELL_TOL_MIN = 3;
const TERMINAL_DWELL_Z_MIN = 1;
/** Minimum along-line path (m) for a (board, alight) pair to be a
 *  ride. Station complexes carry several differently-named OSM
 *  stations a couple hundred metres apart (King's Cross St Pancras /
 *  London King's Cross / London St Pancras), and proximity-inferred
 *  line membership lets them fabricate sub-station "hops". */
const MIN_PATH_M = 400;
/** Per-term clamps: evidence, never a veto. */
const ANCHOR_CLAMP = -6;
const DURATION_CLAMP = -6;
const DWELL_CLAMP = -6;
const CHAIN_CLAMP = -8;
/** A side is emitted only when every alternative station scores at
 *  least this much worse (max-marginal margin). */
const MARGIN_NATS = 1.0;
/** Anchor staleness (min) beyond which the leg boundary is deep in a
 *  GPS blackout: the observed leg duration is then only a LOWER BOUND
 *  on the ride (it extends into the dark), so the duration term goes
 *  one-sided — a decoded bright fragment must not be read as the whole
 *  ride's length. */
const BOUNDARY_UNOBSERVED_MIN = 5;
/** A side whose WINNING candidate is still this implausible against a
 *  fresh anchor is not resolvable — the evidence contradicts every
 *  candidate (typically: the leg's line label is wrong, so the true
 *  station was never in the candidate set). Emit nothing. */
const ABS_ANCHOR_FLOOR = -4;
/** An in-leg fix further off the line's track than this does not project
 *  onto the trajectory (surface street reacquires, scatter). */
const TRAJ_OFFLINE_MAX_M = 400;
/** A trajectory fit needs at least this many on-track fixes spanning at
 *  least this long — below it, the term asserts nothing. */
const TRAJ_MIN_FIXES = 4;
const TRAJ_MIN_SPAN_MIN = 5;
/** The fit only asserts a boundary within this extrapolation horizon of
 *  the nearest on-track fix — a leg dark near its boundary is dark
 *  (C4.2 discipline), no matter how clean the earlier progression. */
const TRAJ_MAX_EXTRAP_MIN = 4;
/** σ floor (m) on the predicted boundary miss; widened by the fit's own
 *  residual spread so a polluted fit asserts weakly. */
const TRAJ_SIGMA_BASE_M = 500;
const TRAJ_MAD_SCALE = 2.5;
const TRAJ_CLAMP = -6;
/** Trajectory support strong enough to rescue a side whose anchor is
 *  contradicted (the corrupted-reacquire case): the predicted miss must
 *  be within ~1.7σ. */
const TRAJ_SUPPORT_FLOOR = -1.5;
/** Trajectory candidate admission: an on-track fix within this many
 *  minutes of the leg boundary admits stations along-line reachable at
 *  an upper-bound tube pace in the time that remains. */
const TRAJ_ADMIT_WINDOW_MIN = 6;
const TRAJ_ADMIT_SPEED_M_PER_MIN = 1_000;
/** A side whose winner carries a terminal-dwell penalty past this is
 *  disqualified outright: fixes prove the ride passed it minutes before
 *  the boundary, so however good its anchor looks, it is not the
 *  boundary station (the stale-anchor-at-a-passed-station class). */
const DWELL_DISQUALIFY = -3;

export interface ResolvedStations {
	board: string | null;
	alight: string | null;
}

export interface ResolveStationChainOpts {
	segments: readonly HmmSegment[];
	observations: readonly Observation[];
	routeGraph: RouteGraph;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** −z²/2 with σ widened in quadrature by anchor staleness, clamped. */
function slopZPenalty(distM: number, sigmaM: number, slopMin: number, clamp: number): number {
	const sigma = Math.sqrt(sigmaM * sigmaM + (SLOP_SPEED_M_PER_MIN * slopMin) ** 2);
	const z = distM / sigma;
	return Math.max(clamp, -0.5 * z * z);
}

interface Anchor {
	lat: number;
	lon: number;
	/** Minutes between the fix and the leg boundary it anchors. */
	slopMin: number;
}

/** Last observed fix strictly before the leg (board side). */
function boardAnchor(observations: readonly Observation[], firstIdx: number, legStartTs: number): Anchor | null {
	for (let i = firstIdx - 1; i >= 0; i--) {
		const g = observations[i].gps;
		if (g !== null) return { lat: g.lat, lon: g.lon, slopMin: Math.max(0, (legStartTs - observations[i].ts) / 60) };
	}
	const book = observations[firstIdx]?.prevGpsFix ?? null;
	return book === null ? null : { lat: book.lat, lon: book.lon, slopMin: Math.max(0, (legStartTs - book.ts) / 60) };
}

/** First observed fix at/after the leg end (alight side). */
function alightAnchor(observations: readonly Observation[], lastIdx: number, legEndTs: number): Anchor | null {
	for (let i = lastIdx + 1; i < observations.length; i++) {
		const g = observations[i].gps;
		if (g !== null) return { lat: g.lat, lon: g.lon, slopMin: Math.max(0, (observations[i].ts - legEndTs) / 60) };
	}
	const book = observations[lastIdx]?.nextGpsFix ?? null;
	return book === null ? null : { lat: book.lat, lon: book.lon, slopMin: Math.max(0, (book.ts - legEndTs) / 60) };
}

interface SideCandidate {
	node: RouteNode;
	anchorPenalty: number;
}

/** Stations on `line` admissible for one side of a leg, scored against
 *  the anchor and DEDUPED BY NAME — one real station is several OSM
 *  nodes (entrances, merged endpoints), and the margin gate compares
 *  stations, not nodes. Keeps the best-scoring node per name. A missing
 *  anchor admits every station on the line with a flat penalty — the
 *  chain and duration terms then carry the choice. Trajectory-admitted
 *  stations (`extra`) join AFTER the anchor-plausibility cap — an
 *  anchor-implausible candidate the track vouches for must not be
 *  crowded out; that is the point of trajectory admission. */
function sideCandidates(
	routeGraph: RouteGraph,
	line: string,
	anchor: Anchor | null,
	extra: readonly RouteNode[],
): SideCandidate[] {
	const byName = new Map<string, SideCandidate>();
	const admit = (node: RouteNode, anchorPenalty: number): void => {
		const name = node.stationName;
		if (name === undefined) return;
		const prev = byName.get(name);
		if (prev === undefined || anchorPenalty > prev.anchorPenalty) byName.set(name, { node, anchorPenalty });
	};
	if (anchor === null) {
		for (const node of routeGraph.nodes.values()) {
			if (node.stationName === undefined) continue;
			if (!stationLineMemberships(routeGraph, node).has(line)) continue;
			admit(node, 0);
		}
	} else {
		const radius = CAND_BASE_RADIUS_M + SLOP_SPEED_M_PER_MIN * anchor.slopMin;
		for (const { node, distM } of stationsNear(routeGraph, anchor.lat, anchor.lon, radius)) {
			if (!stationLineMemberships(routeGraph, node).has(line)) continue;
			admit(node, slopZPenalty(distM, STATION_SIGMA_M, anchor.slopMin, ANCHOR_CLAMP));
		}
	}
	const all = [...byName.values()];
	all.sort((a, b) => b.anchorPenalty - a.anchorPenalty);
	const merged = new Map<string, SideCandidate>();
	for (const c of all.slice(0, MAX_CANDIDATES_PER_SIDE)) merged.set(c.node.stationName ?? "", c);
	for (const node of extra) {
		const name = node.stationName;
		if (name === undefined || merged.has(name)) continue;
		const anchorPenalty =
			anchor === null
				? 0
				: slopZPenalty(
						haversineMeters(anchor.lat, anchor.lon, node.point.lat, node.point.lon),
						STATION_SIGMA_M,
						anchor.slopMin,
						ANCHOR_CLAMP,
					);
		merged.set(name, { node, anchorPenalty });
	}
	return [...merged.values()];
}

/** Dijkstra over `line`'s own edges from arbitrary seed nodes (node id →
 *  initial distance, m). Returns distances for every reached node.
 *  Linear-scan extraction — line subgraphs are small. */
function lineSssp(routeGraph: RouteGraph, line: string, seeds: ReadonlyMap<string, number>): Map<string, number> {
	const dist = new Map<string, number>(seeds);
	const done = new Set<string>();
	for (;;) {
		let bestId: string | null = null;
		let bestD = Number.POSITIVE_INFINITY;
		for (const [id, d] of dist) {
			if (!done.has(id) && d < bestD) {
				bestD = d;
				bestId = id;
			}
		}
		if (bestId === null) return dist;
		done.add(bestId);
		const node = routeGraph.nodes.get(bestId);
		if (node === undefined) continue;
		for (const edgeId of node.edgeIds) {
			const edge = routeGraph.edges.get(edgeId);
			if (edge === undefined || !edge.attrs.lineMemberships.has(line)) continue;
			for (const endpoint of [edge.startPoint, edge.endPoint]) {
				const nextId = nodeKey(endpoint.lat, endpoint.lon);
				if (done.has(nextId)) continue;
				const nd = bestD + edge.attrs.lengthM;
				const cur = dist.get(nextId);
				if (cur === undefined || nd < cur) dist.set(nextId, nd);
			}
		}
	}
}

/** Shortest along-line path length (m) between two stations' footprints
 *  on `line`'s edge subgraph, or null when unreachable. Doubles as the
 *  connectivity constraint. */
function linePathMeters(routeGraph: RouteGraph, line: string, from: RouteNode, to: RouteNode): number | null {
	const start = stationFootprintNodes(routeGraph, from);
	const goal = stationFootprintNodes(routeGraph, to);
	if (start.size === 0 || goal.size === 0) return null;
	for (const id of start) if (goal.has(id)) return 0;

	const seeds = new Map<string, number>();
	for (const id of start) seeds.set(id, 0);
	const dist = lineSssp(routeGraph, line, seeds);
	let best: number | null = null;
	for (const id of goal) {
		const d = dist.get(id);
		if (d !== undefined && (best === null || d < best)) best = d;
	}
	return best;
}

/** An in-leg fix projected onto the leg line's track. */
interface TrackFix {
	ts: number;
	edge: RouteEdge;
	/** Arc distance (m) from the edge geometry's first vertex to the
	 *  projected point. */
	alongM: number;
}

/** Project each in-leg fix onto the nearest point of `line`'s track,
 *  dropping fixes further than `TRAJ_OFFLINE_MAX_M` off it. Scans the
 *  line's own edge set directly — `edgesNear`'s grid only indexes
 *  geometry vertices, which goes blind mid-span of a sparse edge. */
function projectFixesToLine(routeGraph: RouteGraph, line: string, fixes: readonly InLegFix[]): TrackFix[] {
	const lineEdges: RouteEdge[] = [];
	for (const edge of routeGraph.edges.values()) {
		if (edge.attrs.lineMemberships.has(line)) lineEdges.push(edge);
	}
	const out: TrackFix[] = [];
	for (const f of fixes) {
		let best: TrackFix | null = null;
		let bestDist = TRAJ_OFFLINE_MAX_M;
		for (const edge of lineEdges) {
			const g = edge.geometry;
			let arc = 0;
			for (let i = 1; i < g.length; i++) {
				const segLen = haversineMeters(g[i - 1].lat, g[i - 1].lon, g[i].lat, g[i].lon);
				const proj = projectPointToSegment({ lat: f.lat, lon: f.lon }, g[i - 1], g[i]);
				if (proj.distM < bestDist) {
					bestDist = proj.distM;
					best = { ts: f.ts, edge, alongM: arc + proj.t * segLen };
				}
				arc += segLen;
			}
		}
		if (best !== null) out.push(best);
	}
	return out;
}

/** Along-line distance (m) from a projected fix to the SSSP's seed
 *  station, entering the fix's edge at whichever endpoint is closer. */
function trackFixDistM(sssp: ReadonlyMap<string, number>, tf: TrackFix): number | null {
	const du = sssp.get(nodeKey(tf.edge.startPoint.lat, tf.edge.startPoint.lon));
	const dv = sssp.get(nodeKey(tf.edge.endPoint.lat, tf.edge.endPoint.lon));
	const viaU = du === undefined ? null : du + tf.alongM;
	const viaV = dv === undefined ? null : dv + Math.max(0, tf.edge.attrs.lengthM - tf.alongM);
	if (viaU === null) return viaV;
	if (viaV === null) return viaU;
	return Math.min(viaU, viaV);
}

function median(xs: readonly number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Theil–Sen robust line fit d = v·t + c: slope = median of pairwise
 *  slopes, intercept and residual scale = medians. A minority of
 *  corrupted fixes (the stale jump-back class) cannot steer it. */
function theilSen(pts: readonly { t: number; d: number }[]): { v: number; c: number; madM: number } {
	const slopes: number[] = [];
	for (let i = 0; i < pts.length; i++) {
		for (let j = i + 1; j < pts.length; j++) {
			if (pts[j].t !== pts[i].t) slopes.push((pts[j].d - pts[i].d) / (pts[j].t - pts[i].t));
		}
	}
	const v = slopes.length === 0 ? 0 : median(slopes);
	const c = median(pts.map((p) => p.d - v * p.t));
	const madM = median(pts.map((p) => Math.abs(p.d - (v * p.t + c))));
	return { v, c, madM };
}

/** Trajectory-coherence term for one side of a leg: fit the on-track
 *  fixes' along-line distances to the candidate over time and score how
 *  far from the candidate the fit lands at the leg boundary. ~0 when the
 *  trajectory arrives at (board: departs from) the candidate on time;
 *  kilometres of predicted miss — including a NEGATIVE overshoot past a
 *  station the ride sailed through — pay quadratically. Null = the fixes
 *  cannot support a fit (too few, too clustered, boundary too dark):
 *  the term asserts nothing. */
function trajectoryPenalty(
	trackFixes: readonly TrackFix[],
	sssp: ReadonlyMap<string, number>,
	legStartTs: number,
	legEndTs: number,
	side: "board" | "alight",
): number | null {
	const pts: { t: number; d: number }[] = [];
	let firstTs = Number.POSITIVE_INFINITY;
	let lastTs = Number.NEGATIVE_INFINITY;
	for (const tf of trackFixes) {
		const d = trackFixDistM(sssp, tf);
		if (d === null) continue;
		pts.push({ t: (tf.ts - legStartTs) / 60, d });
		if (tf.ts < firstTs) firstTs = tf.ts;
		if (tf.ts > lastTs) lastTs = tf.ts;
	}
	if (pts.length < TRAJ_MIN_FIXES) return null;
	if ((lastTs - firstTs) / 60 < TRAJ_MIN_SPAN_MIN) return null;
	if (side === "alight" && (legEndTs - lastTs) / 60 > TRAJ_MAX_EXTRAP_MIN) return null;
	if (side === "board" && (firstTs - legStartTs) / 60 > TRAJ_MAX_EXTRAP_MIN) return null;
	const { v, c, madM } = theilSen(pts);
	const targetT = side === "alight" ? (legEndTs - legStartTs) / 60 : 0;
	const predictedM = v * targetT + c;
	const sigma = Math.max(TRAJ_SIGMA_BASE_M, TRAJ_MAD_SCALE * madM);
	const z = Math.abs(predictedM) / sigma;
	return Math.max(TRAJ_CLAMP, -0.5 * z * z);
}

/** Stations admissible for one side purely from the trajectory: along-
 *  line reachable from a near-boundary on-track fix within the ride time
 *  that boundary leaves. This is what gets the true station into the
 *  candidate set when the anchor fix is km-wrong. */
function trajectoryAdmits(
	routeGraph: RouteGraph,
	line: string,
	trackFixes: readonly TrackFix[],
	legStartTs: number,
	legEndTs: number,
	side: "board" | "alight",
): RouteNode[] {
	const byName = new Map<string, RouteNode>();
	for (const tf of trackFixes) {
		const boundaryMin = side === "alight" ? (legEndTs - tf.ts) / 60 : (tf.ts - legStartTs) / 60;
		if (boundaryMin < 0 || boundaryMin > TRAJ_ADMIT_WINDOW_MIN) continue;
		const seeds = new Map<string, number>();
		seeds.set(nodeKey(tf.edge.startPoint.lat, tf.edge.startPoint.lon), tf.alongM);
		const endKey = nodeKey(tf.edge.endPoint.lat, tf.edge.endPoint.lon);
		const endSeed = Math.max(0, tf.edge.attrs.lengthM - tf.alongM);
		const cur = seeds.get(endKey);
		if (cur === undefined || endSeed < cur) seeds.set(endKey, endSeed);
		const reachM = boundaryMin * TRAJ_ADMIT_SPEED_M_PER_MIN + CAND_BASE_RADIUS_M;
		for (const [id, d] of lineSssp(routeGraph, line, seeds)) {
			if (d > reachM) continue;
			const node = routeGraph.nodes.get(id);
			if (node?.stationName === undefined) continue;
			if (!stationLineMemberships(routeGraph, node).has(line)) continue;
			if (!byName.has(node.stationName)) byName.set(node.stationName, node);
		}
	}
	return [...byName.values()];
}

/** One side's candidate with every side-local evidence term, kept for
 *  the per-side emission gates. */
interface SideEval {
	node: RouteNode;
	anchorPen: number;
	dwellPen: number;
	/** Null = the trajectory cannot support a fit for this side. */
	trajPen: number | null;
}

interface PairCandidate {
	board: SideEval;
	alight: SideEval;
	/** Anchor + trajectory + dwell + duration terms — everything local
	 *  to the leg. */
	legScore: number;
}

interface ChainLeg {
	segIndex: number;
	startTs: number;
	endTs: number;
	pairs: PairCandidate[];
}

function durationPenalty(observedMin: number, pathM: number, boundaryUnobserved: boolean): number {
	const expectedMin = (pathM / 1000 / TUBE_SPEED_KMH) * 60 + STOP_OVERHEAD_MIN;
	const sigma = Math.max(DURATION_SIGMA_MIN, DURATION_SIGMA_FRAC * expectedMin);
	// A boundary lost in a blackout means the ride extends beyond the
	// observed window: a pair expecting LONGER than observed is
	// consistent, only a pair expecting SHORTER contradicts.
	if (boundaryUnobserved && expectedMin >= observedMin) return 0;
	const z = (observedMin - expectedMin) / sigma;
	return Math.max(DURATION_CLAMP, -0.5 * z * z);
}

interface InLegFix {
	ts: number;
	lat: number;
	lon: number;
}

/** Terminal-dwell consistency. Alighting at A means the trajectory
 *  reaches A at the leg's END: an in-leg fix near A minutes earlier
 *  implies the "train" then dwelt at a through station, which real
 *  services don't. Symmetrically for boards: fixes near B belong at
 *  the leg's START. The excess beyond an arrival/departure tolerance
 *  pays quadratically. Legs that are dark near the candidate assert
 *  nothing (no fix → no term). */
function terminalDwellPenalty(
	fixes: readonly InLegFix[],
	station: RouteNode,
	legStartTs: number,
	legEndTs: number,
	side: "board" | "alight",
): number {
	let firstNear: number | null = null;
	let lastNear: number | null = null;
	for (const f of fixes) {
		if (haversineMeters(f.lat, f.lon, station.point.lat, station.point.lon) > STATION_PASS_M) continue;
		if (firstNear === null) firstNear = f.ts;
		lastNear = f.ts;
	}
	let excessMin: number;
	if (side === "alight") {
		if (firstNear === null) return 0;
		excessMin = (legEndTs - firstNear) / 60 - TERMINAL_DWELL_TOL_MIN;
	} else {
		if (lastNear === null) return 0;
		excessMin = (lastNear - legStartTs) / 60 - TERMINAL_DWELL_TOL_MIN;
	}
	if (excessMin <= 0) return 0;
	const z = excessMin / TERMINAL_DWELL_Z_MIN;
	return Math.max(DWELL_CLAMP, -0.5 * z * z);
}

/** Handover feasibility between consecutive legs: same station complex
 *  (by name or proximity) is free; anything else must be walkable in
 *  the observed gap. */
function chainPenalty(prevAlight: RouteNode, board: RouteNode, gapMin: number): number {
	if (prevAlight.stationName === board.stationName) return 0;
	const d = haversineMeters(prevAlight.point.lat, prevAlight.point.lon, board.point.lat, board.point.lon);
	if (d <= SAME_STATION_M) return 0;
	const requiredPace = d / Math.max(gapMin, 0.5);
	const z = Math.max(0, requiredPace - TRANSFER_WALK_M_PER_MIN) / TRANSFER_Z_SCALE;
	return Math.max(CHAIN_CLAMP, -0.5 * z * z);
}

/**
 * Resolve stations for every named-line train leg in `segments`.
 * Returns a map from segment index to the resolved pair; a side that
 * cannot be resolved confidently is null, and legs with neither side
 * resolved are absent from the map.
 */
export function resolveStationChain(opts: ResolveStationChainOpts): Map<number, ResolvedStations> {
	const { segments, observations, routeGraph } = opts;
	const result = new Map<number, ResolvedStations>();
	if (observations.length === 0) return result;

	const idxByTs = new Map<number, number>();
	for (let i = 0; i < observations.length; i++) idxByTs.set(observations[i].ts, i);

	// Along-line path cache — pairs repeat across the candidate cross
	// product and across legs on the same line.
	const pathCache = new Map<string, number | null>();
	const cachedPathMeters = (line: string, a: RouteNode, b: RouteNode): number | null => {
		const key = `${line}|${a.id}|${b.id}`;
		let v = pathCache.get(key);
		if (v === undefined) {
			v = linePathMeters(routeGraph, line, a, b);
			pathCache.set(key, v);
		}
		return v;
	};
	// Single-source along-line distances from a candidate station's
	// footprint — the trajectory term's lookup table, shared across legs.
	const ssspCache = new Map<string, Map<string, number>>();
	const cachedSssp = (line: string, node: RouteNode): Map<string, number> => {
		const key = `${line}|${node.id}`;
		let v = ssspCache.get(key);
		if (v === undefined) {
			const seeds = new Map<string, number>();
			for (const id of stationFootprintNodes(routeGraph, node)) seeds.set(id, 0);
			v = lineSssp(routeGraph, line, seeds);
			ssspCache.set(key, v);
		}
		return v;
	};

	// Build the resolvable legs with their local candidate pairs.
	const legs: ChainLeg[] = [];
	for (let s = 0; s < segments.length; s++) {
		const seg = segments[s];
		if (seg.mode !== "train" || seg.lineName === null || seg.lineName === "unknown_rail") continue;
		const firstIdx = idxByTs.get(seg.startTs);
		const lastIdx = idxByTs.get(seg.endTs - 60);
		if (firstIdx === undefined || lastIdx === undefined) continue;

		const bAnchor = boardAnchor(observations, firstIdx, seg.startTs);
		const aAnchor = alightAnchor(observations, lastIdx, seg.endTs);
		const observedMin = (seg.endTs - seg.startTs) / 60;
		const boundaryUnobserved =
			bAnchor === null ||
			aAnchor === null ||
			bAnchor.slopMin > BOUNDARY_UNOBSERVED_MIN ||
			aAnchor.slopMin > BOUNDARY_UNOBSERVED_MIN;
		const inLegFixes: InLegFix[] = [];
		for (let i = firstIdx; i <= lastIdx; i++) {
			const g = observations[i].gps;
			if (g !== null) inLegFixes.push({ ts: observations[i].ts, lat: g.lat, lon: g.lon });
		}
		const line = seg.lineName;
		const trackFixes = projectFixesToLine(routeGraph, line, inLegFixes);
		const boards = sideCandidates(
			routeGraph,
			line,
			bAnchor,
			trajectoryAdmits(routeGraph, line, trackFixes, seg.startTs, seg.endTs, "board"),
		);
		const alights = sideCandidates(
			routeGraph,
			line,
			aAnchor,
			trajectoryAdmits(routeGraph, line, trackFixes, seg.startTs, seg.endTs, "alight"),
		);
		const evalSide = (c: SideCandidate, side: "board" | "alight"): SideEval => ({
			node: c.node,
			anchorPen: c.anchorPenalty,
			dwellPen: terminalDwellPenalty(inLegFixes, c.node, seg.startTs, seg.endTs, side),
			trajPen:
				trackFixes.length === 0
					? null
					: trajectoryPenalty(trackFixes, cachedSssp(line, c.node), seg.startTs, seg.endTs, side),
		});
		const boardEvals = boards.map((c) => evalSide(c, "board"));
		const alightEvals = alights.map((c) => evalSide(c, "alight"));

		const pairs: PairCandidate[] = [];
		for (const b of boardEvals) {
			for (const a of alightEvals) {
				if (b.node.stationName === a.node.stationName) continue;
				const pathM = cachedPathMeters(line, b.node, a.node);
				if (pathM === null || pathM < MIN_PATH_M) continue;
				pairs.push({
					board: b,
					alight: a,
					legScore:
						b.anchorPen +
						b.dwellPen +
						(b.trajPen ?? 0) +
						a.anchorPen +
						a.dwellPen +
						(a.trajPen ?? 0) +
						durationPenalty(observedMin, pathM, boundaryUnobserved),
				});
			}
		}
		// A leg with no valid pair stays unresolved AND breaks the chain —
		// its neighbours must not hand over across an opaque ride.
		legs.push({ segIndex: s, startTs: seg.startTs, endTs: seg.endTs, pairs });
	}

	// Split into chains at unresolvable legs and over-large gaps.
	const chains: ChainLeg[][] = [];
	let current: ChainLeg[] = [];
	for (const leg of legs) {
		const prev = current[current.length - 1];
		const breaks = leg.pairs.length === 0 || (prev !== undefined && leg.startTs - prev.endTs > CHAIN_GAP_MAX_S);
		if (breaks && current.length > 0) {
			chains.push(current);
			current = [];
		}
		if (leg.pairs.length > 0) current.push(leg);
	}
	if (current.length > 0) chains.push(current);

	for (const chain of chains) {
		// Forward/backward Viterbi over pairs → max-marginal per (leg, pair).
		const n = chain.length;
		const forward: number[][] = [];
		const backward: number[][] = [];
		for (let i = 0; i < n; i++) {
			forward.push(new Array<number>(chain[i].pairs.length).fill(0));
			backward.push(new Array<number>(chain[i].pairs.length).fill(0));
		}
		for (let i = 0; i < n; i++) {
			const leg = chain[i];
			for (let p = 0; p < leg.pairs.length; p++) {
				let best = 0;
				if (i > 0) {
					const gapMin = (leg.startTs - chain[i - 1].endTs) / 60;
					best = Number.NEGATIVE_INFINITY;
					for (let q = 0; q < chain[i - 1].pairs.length; q++) {
						const via =
							forward[i - 1][q] + chainPenalty(chain[i - 1].pairs[q].alight.node, leg.pairs[p].board.node, gapMin);
						if (via > best) best = via;
					}
				}
				forward[i][p] = leg.pairs[p].legScore + best;
			}
		}
		for (let i = n - 1; i >= 0; i--) {
			const leg = chain[i];
			for (let p = 0; p < leg.pairs.length; p++) {
				let best = 0;
				if (i < n - 1) {
					const gapMin = (chain[i + 1].startTs - leg.endTs) / 60;
					best = Number.NEGATIVE_INFINITY;
					for (let q = 0; q < chain[i + 1].pairs.length; q++) {
						const via =
							backward[i + 1][q] + chainPenalty(leg.pairs[p].alight.node, chain[i + 1].pairs[q].board.node, gapMin);
						if (via > best) best = via;
					}
				}
				backward[i][p] = leg.pairs[p].legScore + best;
			}
		}

		for (let i = 0; i < n; i++) {
			const leg = chain[i];
			// Max-marginal: the best chain total passing through pair p.
			const through = leg.pairs.map((pair, p) => forward[i][p] + backward[i][p] - pair.legScore);
			let bestP = 0;
			for (let p = 1; p < through.length; p++) if (through[p] > through[bestP]) bestP = p;
			const best = leg.pairs[bestP];

			// Per-side margins: the best alternative with a DIFFERENT station
			// on that side must trail by MARGIN_NATS, else stay silent.
			let bestAltBoard = Number.NEGATIVE_INFINITY;
			let bestAltAlight = Number.NEGATIVE_INFINITY;
			for (let p = 0; p < leg.pairs.length; p++) {
				if (leg.pairs[p].board.node.stationName !== best.board.node.stationName && through[p] > bestAltBoard)
					bestAltBoard = through[p];
				if (leg.pairs[p].alight.node.stationName !== best.alight.node.stationName && through[p] > bestAltAlight)
					bestAltAlight = through[p];
			}
			// A side emits only when (a) every alternative trails by the
			// margin, (b) at least one evidence channel actively supports
			// the winner — anchor plausibility, or trajectory support
			// strong enough to out-vote a corrupted anchor — and (c) the
			// winner is not terminal-dwell-disqualified (fixes prove the
			// ride passed it mid-leg). A "best of an implausible field"
			// (wrong line label, true station absent from the candidate
			// set) must stay silent.
			const sidePlausible = (s: SideEval): boolean =>
				(s.anchorPen > ABS_ANCHOR_FLOOR || (s.trajPen !== null && s.trajPen > TRAJ_SUPPORT_FLOOR)) &&
				s.dwellPen > DWELL_DISQUALIFY;
			const board =
				(bestAltBoard === Number.NEGATIVE_INFINITY || through[bestP] - bestAltBoard >= MARGIN_NATS) &&
				sidePlausible(best.board)
					? (best.board.node.stationName ?? null)
					: null;
			const alight =
				(bestAltAlight === Number.NEGATIVE_INFINITY || through[bestP] - bestAltAlight >= MARGIN_NATS) &&
				sidePlausible(best.alight)
					? (best.alight.node.stationName ?? null)
					: null;
			if (board !== null || alight !== null) result.set(leg.segIndex, { board, alight });
		}
	}

	return result;
}

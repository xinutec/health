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
 *
 * A small Viterbi over pairs per journey maximises the joint score;
 * emission is **confidence-gated per side** via max-marginals: a side is
 * emitted only when every alternative station is at least `MARGIN_NATS`
 * worse (the scoreboard treats a wrong station as worse than a missing
 * one, so ambiguity must yield null, not a guess).
 *
 * Pure module. No DB, no IO, no flags.
 */

import type { RouteGraph, RouteNode } from "../geo/route-graph.js";
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
 *  chain and duration terms then carry the choice. */
function sideCandidates(routeGraph: RouteGraph, line: string, anchor: Anchor | null): SideCandidate[] {
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
	return all.slice(0, MAX_CANDIDATES_PER_SIDE);
}

/** Shortest along-line path length (m) between two stations' footprints
 *  on `line`'s edge subgraph, or null when unreachable. Dijkstra over
 *  the line's own edges — doubles as the connectivity constraint. */
function linePathMeters(routeGraph: RouteGraph, line: string, from: RouteNode, to: RouteNode): number | null {
	const start = stationFootprintNodes(routeGraph, from);
	const goal = stationFootprintNodes(routeGraph, to);
	if (start.size === 0 || goal.size === 0) return null;
	for (const id of start) if (goal.has(id)) return 0;

	const dist = new Map<string, number>();
	const done = new Set<string>();
	for (const id of start) dist.set(id, 0);
	for (;;) {
		let bestId: string | null = null;
		let bestD = Number.POSITIVE_INFINITY;
		for (const [id, d] of dist) {
			if (!done.has(id) && d < bestD) {
				bestD = d;
				bestId = id;
			}
		}
		if (bestId === null) return null;
		if (goal.has(bestId)) return bestD;
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

interface PairCandidate {
	board: RouteNode;
	alight: RouteNode;
	/** Anchor + duration + dwell terms — everything local to the leg. */
	legScore: number;
	/** Per-side anchor penalties, kept for the absolute-plausibility
	 *  emission gate. */
	boardAnchorPen: number;
	alightAnchorPen: number;
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
		const boards = sideCandidates(routeGraph, seg.lineName, bAnchor);
		const alights = sideCandidates(routeGraph, seg.lineName, aAnchor);
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

		const pairs: PairCandidate[] = [];
		for (const b of boards) {
			for (const a of alights) {
				if (b.node.stationName === a.node.stationName) continue;
				const pathM = cachedPathMeters(seg.lineName, b.node, a.node);
				if (pathM === null || pathM < MIN_PATH_M) continue;
				pairs.push({
					board: b.node,
					alight: a.node,
					legScore:
						b.anchorPenalty +
						a.anchorPenalty +
						durationPenalty(observedMin, pathM, boundaryUnobserved) +
						terminalDwellPenalty(inLegFixes, b.node, seg.startTs, seg.endTs, "board") +
						terminalDwellPenalty(inLegFixes, a.node, seg.startTs, seg.endTs, "alight"),
					boardAnchorPen: b.anchorPenalty,
					alightAnchorPen: a.anchorPenalty,
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
						const via = forward[i - 1][q] + chainPenalty(chain[i - 1].pairs[q].alight, leg.pairs[p].board, gapMin);
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
						const via = backward[i + 1][q] + chainPenalty(leg.pairs[p].alight, chain[i + 1].pairs[q].board, gapMin);
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
				if (leg.pairs[p].board.stationName !== best.board.stationName && through[p] > bestAltBoard)
					bestAltBoard = through[p];
				if (leg.pairs[p].alight.stationName !== best.alight.stationName && through[p] > bestAltAlight)
					bestAltAlight = through[p];
			}
			// A side emits only when (a) every alternative trails by the
			// margin AND (b) the winner itself is plausible against its
			// anchor — a "best of an implausible field" (wrong line label,
			// true station absent from the candidate set) must stay silent.
			const board =
				(bestAltBoard === Number.NEGATIVE_INFINITY || through[bestP] - bestAltBoard >= MARGIN_NATS) &&
				best.boardAnchorPen > ABS_ANCHOR_FLOOR
					? (best.board.stationName ?? null)
					: null;
			const alight =
				(bestAltAlight === Number.NEGATIVE_INFINITY || through[bestP] - bestAltAlight >= MARGIN_NATS) &&
				best.alightAnchorPen > ABS_ANCHOR_FLOOR
					? (best.alight.stationName ?? null)
					: null;
			if (board !== null || alight !== null) result.set(leg.segIndex, { board, alight });
		}
	}

	return result;
}

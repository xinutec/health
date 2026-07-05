/**
 * Route-aware HSMM decoder — Phase 1 hierarchical inner/outer
 * Viterbi (`docs/design/probabilistic-principles.md`).
 *
 * Outer state space stays `(mode, place, line)` to keep today's
 * duration model + entry priors intact. For `train @ line` states
 * the per-segment emission is computed by the inner Viterbi over
 * the per-line edge subgraph — no per-minute sum, no rail-corridor
 * boost, just the structural geometry of the line's track.
 *
 * Algorithm:
 *
 *   α(t, s) = max over (s', τ) of
 *               α(t - τ, s')
 *             + transition(s', s)
 *             + duration(s, τ)
 *             + entry_prior(s, segment_start)
 *             + segment_emission(s, segment_start, t)
 *
 * `segment_emission` is:
 *   - For train@L (L != unknown_rail) on a graph with edges for L:
 *       inner_viterbi(L, window).logScore
 *   - For everything else:
 *       Σ per_minute_emission(s, obs[k]) for k in segment
 *
 * Per-minute emission for non-train states is the existing
 * `buildEmissionFn` from `emissions.ts` (mode prior + place-distance
 * Gaussian + sleep / nighttime priors). The transition, duration,
 * entry, and initial priors are the existing factor library too —
 * the route-aware decoder is a NEW SHELL around the SAME factor
 * library, plus per-edge geometry for train segments.
 *
 * Output: each minute's `State` has `trainEdgeId` populated for
 * train minutes (the inner-Viterbi edge for that minute), null
 * otherwise.
 */

import type { RouteGraph } from "../geo/route-graph.js";
import { DEFAULT_MIN_DURATION_BY_MODE, type GammaFit, logDurationProb } from "./duration-dist.js";
import { buildEmissionFn } from "./emissions.js";
import { buildEntryPrior } from "./entry-prior.js";
import { buildInitialStatePrior } from "./initial-state.js";
import { type InnerViterbiResult, innerViterbi } from "./inner-viterbi-edges.js";
import { computeModeClassLocks, type ModeClass } from "./mode-class-lock.js";
import type { Observation } from "./observation.js";
import { buildStateSpace, type FocusPlaceRef, type State, stateKey } from "./state-space.js";
import { buildTransitionMatrix } from "./transitions.js";

export interface RouteAwareDecodeInput {
	observations: readonly Observation[];
	routeGraph: RouteGraph;
	knownLines: readonly string[];
	focusPlaces: readonly (FocusPlaceRef & { lat?: number; lon?: number })[];
	/** Per-place hour-of-day visit profile (24 entries summing to ~1).
	 *  Used by the entry prior to score arrival times. Caller can omit
	 *  for a uniform prior (tests). */
	placeHourProfiles?: ReadonlyMap<number, readonly number[]>;
	/** Per-place visit frequency weight (fraction of total dwell time
	 *  across all known places). Used by the entry prior. Caller can
	 *  omit for uniform. */
	placeVisitWeights?: ReadonlyMap<number, number>;
	/** Max segment duration (minutes) considered by the outer HSMM.
	 *  Caps O(T²) work. Defaults to 240 (4 h). */
	maxDurationMinutes?: number;
}

export interface RouteAwareDecodeResult {
	states: readonly State[];
}

/** Baseline per-mode Gamma duration fits — mirror the production
 *  CLI defaults. Real callers should pass user-fitted values; the
 *  baseline is fine for tests and first-day decodes. */
const BASELINE_DURATION_FITS: Record<State["mode"], GammaFit> = {
	stationary: { alpha: 0.85, beta: 0.0043, sampleCount: 132 },
	walking: { alpha: 1.07, beta: 0.034, sampleCount: 60 },
	cycling: { alpha: 1.0, beta: 0.05, sampleCount: 0 },
	driving: { alpha: 0.42, beta: 0.008, sampleCount: 24 },
	train: { alpha: 1.74, beta: 0.053, sampleCount: 24 },
	plane: { alpha: 1.0, beta: 0.011, sampleCount: 0 },
	unknown: { alpha: 0.45, beta: 0.0034, sampleCount: 15 },
};

/** Per-mode maximum segment duration (minutes) considered by the
 *  outer HSMM. Caps the τ loop. Trains cap at 90 — no single rail
 *  ride lasts longer in practice; long-haul mainline is unusual
 *  for our user and even Met end-to-end is ~75 min. */
const MAX_DURATION_BY_MODE: Record<State["mode"], number> = {
	stationary: 720, // up to 12 h for overnight sleep blocks
	walking: 120,
	cycling: 90,
	driving: 180,
	train: 90,
	plane: 720,
	unknown: 180,
};

/** Search radius (m) for the train@L short-circuit. A candidate
 *  train@L window must have at least one minute whose observed GPS
 *  fix lies within this many metres of an edge on L; otherwise
 *  inner Viterbi is skipped (returns null) without running.
 *  Looser than the inner-Viterbi candidate radius — we just need
 *  ONE minute in the window to make the line plausible. */
const TRAIN_LINE_PRESENCE_RADIUS_M = 1_500;

/** Radius (m) used to derive entry / exit edge sets from the GPS
 *  context at a segment boundary. Wider than the inner Viterbi's
 *  candidate radius — we want to capture interchange edges at a
 *  station even when the GPS lands a few hundred metres off the
 *  platform centre. */
const BOUNDARY_RADIUS_M = 600;

// No flat per-minute "on a known line" bonus is needed: the inner
// Viterbi emission in `inner-viterbi-edges.ts` is already calibrated
// as a log-ratio against the abstract `unknown_rail` fallback —
// positive when GPS lands on the line's track, negative when it's
// far off. See `GPS_OBSERVED_BASELINE` / `UNDERGROUND_NULL_BONUS`.

/** Look backward from `t` (inclusive) to the most recent
 *  observation with GPS observed. Returns null when none found. */
function gpsAtOrBefore(observations: readonly Observation[], t: number): { lat: number; lon: number } | null {
	for (let i = t; i >= 0; i--) {
		const ob = observations[i];
		if (ob.gps !== null) return { lat: ob.gps.lat, lon: ob.gps.lon };
		if (ob.prevGpsFix !== null) return { lat: ob.prevGpsFix.lat, lon: ob.prevGpsFix.lon };
	}
	return null;
}

/** Look forward from `t` (inclusive) to the next observation with
 *  GPS observed. Returns null when none found. */
function gpsAtOrAfter(observations: readonly Observation[], t: number): { lat: number; lon: number } | null {
	for (let i = t; i < observations.length; i++) {
		const ob = observations[i];
		if (ob.gps !== null) return { lat: ob.gps.lat, lon: ob.gps.lon };
		if (ob.nextGpsFix !== null) return { lat: ob.nextGpsFix.lat, lon: ob.nextGpsFix.lon };
	}
	return null;
}

/** Edges on `line` within `radius` m of `(lat, lon)`. */
function edgesNearOnLine(routeGraph: RouteGraph, line: string, lat: number, lon: number, radius: number): Set<string> {
	const out = new Set<string>();
	for (const edge of routeGraph.edgesNear(lat, lon, radius)) {
		if (edge.attrs.lineMemberships.has(line)) out.add(edge.id);
	}
	return out;
}

/** Entry-edge set for an inner-Viterbi call covering segment
 *  `[t1, t2]` on line L. Anchored to the GPS context at the
 *  segment's start (`t1`); falls back to unconstrained when no
 *  GPS context within reach has the line on it. */
function entryEdgesFor(
	routeGraph: RouteGraph,
	observations: readonly Observation[],
	t1: number,
	line: string,
): ReadonlySet<string> | null {
	const anchor = gpsAtOrBefore(observations, t1);
	if (anchor === null) return null;
	const edges = edgesNearOnLine(routeGraph, line, anchor.lat, anchor.lon, BOUNDARY_RADIUS_M);
	return edges.size > 0 ? edges : null;
}

function exitEdgesFor(
	routeGraph: RouteGraph,
	observations: readonly Observation[],
	t2: number,
	line: string,
): ReadonlySet<string> | null {
	const anchor = gpsAtOrAfter(observations, t2);
	if (anchor === null) return null;
	const edges = edgesNearOnLine(routeGraph, line, anchor.lat, anchor.lon, BOUNDARY_RADIUS_M);
	return edges.size > 0 ? edges : null;
}

/** Whether `state` should use inner-Viterbi for segment emission.
 *  Train@line states with a known line use the inner; train@
 *  unknown_rail and all non-train states use the per-minute sum. */
function usesInnerViterbi(state: State, knownLines: ReadonlySet<string>): boolean {
	return state.mode === "train" && state.lineName !== null && knownLines.has(state.lineName);
}

export function routeAwareDecode(input: RouteAwareDecodeInput): RouteAwareDecodeResult {
	const T = input.observations.length;
	if (T === 0) return { states: [] };

	const states = buildStateSpace({
		focusPlaces: input.focusPlaces,
		knownLines: input.knownLines,
	});
	const S = states.length;
	const knownLineSet = new Set(input.knownLines);

	const placeCoords = new Map<number, { lat: number; lon: number }>();
	for (const p of input.focusPlaces) {
		if (p.lat !== undefined && p.lon !== undefined) placeCoords.set(p.id, { lat: p.lat, lon: p.lon });
	}

	const perMinEmission = buildEmissionFn({ placeCoords });
	const transitionFn = buildTransitionMatrix({
		states,
		// No station-graph constraint in the route-aware decoder —
		// the route graph itself is the structural constraint via
		// the inner Viterbi.
		placeNearLine: () => true,
	});
	const initialFn = buildInitialStatePrior();
	const entryFn = buildEntryPrior({
		placeHourProfiles: input.placeHourProfiles ?? new Map(),
		placeVisitWeights: input.placeVisitWeights ?? new Map(),
	});

	// Prefix sums of per-minute emission per state — O(T × S)
	// precompute lets segment emission for non-train states be O(1).
	const prefix = new Array<Float64Array>(S);
	for (let s = 0; s < S; s++) {
		const arr = new Float64Array(T + 1);
		arr[0] = 0;
		for (let t = 0; t < T; t++) arr[t + 1] = arr[t] + perMinEmission(states[s], input.observations[t]);
		prefix[s] = arr;
	}

	// Per-minute physical-fact mode-class locks. Used as a hard
	// segment-emission filter: a segment whose mode is incompatible
	// with the lock on any of its minutes scores -∞. See
	// `mode-class-lock.ts`. The constraint encodes universal physical
	// facts (sustained cadence = walking; window-displacement faster
	// than walking ceiling = vehicle; tight GPS cluster = stationary)
	// not user-specific behaviour.
	const modeClassLocks = computeModeClassLocks({ observations: input.observations });

	/** Whether `mode` is compatible with a given physical lock. The
	 *  lock encodes what the user MUST be doing; the mode must be
	 *  consistent with that. `null` lock is unconstrained. */
	function modeCompatibleWithLock(mode: State["mode"], lock: ModeClass): boolean {
		if (lock === null) return true;
		switch (lock) {
			case "foot":
				// Cadence-confirmed walking; only walking can match.
				return mode === "walking";
			case "vehicle":
				// Window-displacement-confirmed vehicle motion; only
				// vehicle-class modes match.
				return mode === "train" || mode === "driving" || mode === "cycling" || mode === "plane";
			case "stationary":
				return mode === "stationary";
		}
	}

	/** Does any minute in `[t1, t2]` carry a lock incompatible with
	 *  `mode`? If so, the segment is not a physically valid
	 *  hypothesis. */
	function segmentViolatesLock(mode: State["mode"], t1: number, t2: number): boolean {
		for (let t = t1; t <= t2; t++) {
			if (!modeCompatibleWithLock(mode, modeClassLocks[t])) return true;
		}
		return false;
	}

	// Pre-compute, for each minute, the set of known lines that have
	// at least one edge within TRAIN_LINE_PRESENCE_RADIUS_M of the
	// observation's GPS fix. Minutes with no GPS contribute nothing.
	// Used to short-circuit inner Viterbi calls for (t1, t2, line)
	// windows where the line isn't plausibly present at any minute —
	// expensive Viterbi avoided for the bulk of overnight/at-home
	// candidate segments the outer HSMM enumerates.
	const linePresentAt: ReadonlyArray<ReadonlySet<string>> = (() => {
		const arr = new Array<Set<string>>(T);
		for (let t = 0; t < T; t++) arr[t] = new Set<string>();
		for (let t = 0; t < T; t++) {
			const ob = input.observations[t];
			if (ob.gps === null) continue;
			for (const edge of input.routeGraph.edgesNear(ob.gps.lat, ob.gps.lon, TRAIN_LINE_PRESENCE_RADIUS_M)) {
				for (const line of edge.attrs.lineMemberships) {
					if (knownLineSet.has(line)) arr[t].add(line);
				}
			}
		}
		return arr;
	})();

	// Cached inner Viterbi per (line, t1, t2).
	const innerCache = new Map<string, InnerViterbiResult | null>();
	function inner(line: string, t1: number, t2: number): InnerViterbiResult | null {
		const key = `${line}|${t1}|${t2}`;
		const hit = innerCache.get(key);
		if (hit !== undefined) return hit;
		// Short-circuit: if no minute in [t1, t2] has L within
		// presence radius of its GPS, skip the Viterbi entirely.
		let plausible = false;
		for (let t = t1; t <= t2; t++) {
			if (linePresentAt[t].has(line)) {
				plausible = true;
				break;
			}
		}
		if (!plausible) {
			innerCache.set(key, null);
			return null;
		}
		const result = innerViterbi({
			routeGraph: input.routeGraph,
			line,
			observations: input.observations.slice(t1, t2 + 1),
			entryEdges: entryEdgesFor(input.routeGraph, input.observations, t1, line),
			exitEdges: exitEdgesFor(input.routeGraph, input.observations, t2, line),
		});
		innerCache.set(key, result);
		return result;
	}

	function segmentEmission(s: number, t1: number, t2: number): number {
		const state = states[s];
		// Hard physical-fact filter: reject any segment whose mode
		// contradicts the per-minute mode-class lock at any minute it
		// covers. Cadence / GPS displacement / stationarity are
		// universal facts about the world; the decoder doesn't get to
		// override them.
		if (segmentViolatesLock(state.mode, t1, t2)) return Number.NEGATIVE_INFINITY;
		const perMinSum = prefix[s][t2 + 1] - prefix[s][t1];
		if (usesInnerViterbi(state, knownLineSet)) {
			const r = inner(state.lineName as string, t1, t2);
			if (r === null) return Number.NEGATIVE_INFINITY;
			return r.logScore + perMinSum;
		}
		return perMinSum;
	}

	const MAX_D_DEFAULT = input.maxDurationMinutes ?? 240;
	const NEG_INF = Number.NEGATIVE_INFINITY;

	// alpha[t][s] = best log-prob of any path covering observations[0..t]
	//               such that a segment in state s ends exactly at t.
	// We also need backpointers: which (prevState, segStart) produced
	// the best alpha[t][s].
	const alpha = new Array<Float64Array>(T);
	const backState = new Array<Int32Array>(T);
	const backSegStart = new Array<Int32Array>(T);
	for (let t = 0; t < T; t++) {
		alpha[t] = new Float64Array(S).fill(NEG_INF);
		backState[t] = new Int32Array(S).fill(-2);
		backSegStart[t] = new Int32Array(S).fill(-1);
	}

	for (let t = 0; t < T; t++) {
		for (let s = 0; s < S; s++) {
			const state = states[s];
			const modeMaxD = Math.min(MAX_DURATION_BY_MODE[state.mode], MAX_D_DEFAULT);
			const maxTau = Math.min(modeMaxD, t + 1);
			for (let tau = 1; tau <= maxTau; tau++) {
				const segStart = t - tau + 1;
				const dlp = logDurationProb(
					tau,
					state.mode,
					BASELINE_DURATION_FITS[state.mode],
					DEFAULT_MIN_DURATION_BY_MODE[state.mode],
				);
				if (dlp === NEG_INF) continue;
				const segEmit = segmentEmission(s, segStart, t);
				if (segEmit === NEG_INF) continue;
				const ep = entryFn(state, input.observations[segStart]);

				if (segStart === 0) {
					const init = initialFn(state);
					const score = init + ep + segEmit + dlp;
					if (score > alpha[t][s]) {
						alpha[t][s] = score;
						backState[t][s] = -1;
						backSegStart[t][s] = 0;
					}
					continue;
				}

				const prevEnd = segStart - 1;
				let bestPrev = NEG_INF;
				let bestPrevState = -1;
				for (let sp = 0; sp < S; sp++) {
					if (sp === s) continue;
					const a = alpha[prevEnd][sp];
					if (a === NEG_INF) continue;
					const trans = transitionFn(states[sp], state);
					if (trans === NEG_INF) continue;
					const v = a + trans;
					if (v > bestPrev) {
						bestPrev = v;
						bestPrevState = sp;
					}
				}
				if (bestPrev === NEG_INF) continue;
				const score = bestPrev + ep + segEmit + dlp;
				if (score > alpha[t][s]) {
					alpha[t][s] = score;
					backState[t][s] = bestPrevState;
					backSegStart[t][s] = segStart;
				}
			}
		}
	}

	// Final: best alpha[T-1][s].
	let bestS = -1;
	let bestScore = NEG_INF;
	for (let s = 0; s < S; s++) {
		if (alpha[T - 1][s] > bestScore) {
			bestScore = alpha[T - 1][s];
			bestS = s;
		}
	}
	if (bestS === -1) {
		throw new Error(
			"routeAwareDecode: no valid path through HSMM trellis. " +
				"Check that observations have at least one state with finite duration/emission score.",
		);
	}

	// Backtrack to produce per-minute states.
	const decoded: State[] = new Array(T);
	let curT = T - 1;
	let curS = bestS;
	while (curT >= 0) {
		const segStart = backSegStart[curT][curS];
		const state = states[curS];

		// For train@L segments, populate trainEdgeId from inner Viterbi.
		const segLen = curT - segStart + 1;
		const edgeIds = new Array<string | null>(segLen).fill(null);
		if (usesInnerViterbi(state, knownLineSet)) {
			const r = inner(state.lineName as string, segStart, curT);
			if (r !== null) {
				for (let i = 0; i < segLen; i++) edgeIds[i] = r.edgePath[i];
			}
		}

		for (let k = segStart; k <= curT; k++) {
			decoded[k] = {
				mode: state.mode,
				placeId: state.placeId,
				lineName: state.lineName,
				trainEdgeId: edgeIds[k - segStart],
			};
		}

		const prevS = backState[curT][curS];
		if (prevS < 0) break;
		curS = prevS;
		curT = segStart - 1;
	}

	return { states: decoded };
}

// Re-export for callers that want to look up by state-key (e.g.
// test assertions). Mirrors the existing decoder modules' export
// surface.
export { stateKey };

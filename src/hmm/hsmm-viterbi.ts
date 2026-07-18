/**
 * Hidden Semi-Markov Model (HSMM) MAP-sequence decoder.
 *
 * Extends the per-minute Markov Viterbi with explicit per-state
 * duration distributions, encoding minimum-duration constraints
 * that the Markov framework can't represent (a 1-minute plane
 * flight is physically impossible; a 1-minute stationary detour
 * to a different focus place is heuristic noise).
 *
 * Algorithm (Yu / Rabiner explicit-duration formulation):
 *
 *   trellis[t][s][τ] = max log-prob of a partial path that ends
 *                      at time t with state s in segment τ minutes long
 *
 * Recurrence:
 *   continue:  trellis[t][s][τ]
 *              = trellis[t-1][s][τ-1] + emission(o_t | s)    (τ ≥ 2)
 *
 *   new-segment:
 *     For each prev state s' with its segment ending at t-1,
 *     close the s' segment by adding log P_d(τ_prev | s'), then
 *     transition to s at t with segment-start (τ=1).
 *     trellis[t][s][1]
 *       = max_{s', τ_prev} [
 *           trellis[t-1][s'][τ_prev]
 *           + log P_d(τ_prev | s')
 *           + log T(s', s)
 *         ]
 *         + emission(o_t | s)
 *
 *   At t=0:  trellis[0][s][1] = initialLogProb(s) + emission(o_0 | s)
 *
 * Final-segment duration is closed at t=T: pick the (s, τ_final)
 * that maximises `trellis[T-1][s][τ_final] + log P_d(τ_final | s)`.
 *
 * Complexity:
 *   - Continue step:    O(T × |S| × MAX_D)
 *   - New-segment step: O(T × |S|²) after pre-computing the
 *     argmax over τ_prev for each (s', t-1)
 *   For T=1440, |S|=150, MAX_D=120: ~60M ops, ~3-5s in TS.
 *
 * Pure function. No DB, no IO, no globals.
 */

export interface HsmmInput<State, Obs> {
	observations: readonly Obs[];
	states: readonly State[];
	/** `log T(from, to)` evaluated at the destination observation
	 *  (allows obs-conditional transitions, matching the existing
	 *  Markov Viterbi signature). Return -Infinity for hard-zero
	 *  transitions. */
	transitionLogProb: (from: State, to: State, toObs: Obs) => number;
	emissionLogProb: (state: State, obs: Obs) => number;
	/** `log P_d(d | state)` — duration prior for a segment of state
	 *  with length d minutes. Should be very low (e.g. -10) for
	 *  physically impossible short durations. `segEndIndex` is the
	 *  observation index of the segment's last minute, so the prior
	 *  can condition on position-specific evidence (e.g. a
	 *  generator-vouched train window relaxing the short-duration
	 *  floor). Callbacks that don't need it may ignore it. */
	durationLogProb: (state: State, durationMinutes: number, segEndIndex: number) => number;
	/** Optional initial-state log-prob at t=0. Default uniform 0. */
	initialLogProb?: (state: State) => number;
	/** Optional per-segment-entry log-prior, applied at t=0 and at
	 *  every new-segment transition (when a fresh segment of state s
	 *  begins at time t). Use for factors that should fire ONCE per
	 *  segment rather than per-minute — e.g. hour-of-day arrival
	 *  rate. Default 0 (no entry prior). */
	entryLogProb?: (state: State, obs: Obs) => number;
	/** Cap on the within-trellis duration counter. Segments
	 *  effectively can't exceed this length. Default 240 (4 hours)
	 *  — should be at least longer than the realistic max stay
	 *  the decoder might want to emit. Caps total work. */
	maxDurationMinutes?: number;
}

export const DEFAULT_MAX_DURATION = 240;

export function hsmmViterbi<State, Obs>(input: HsmmInput<State, Obs>): State[] {
	const { observations, states, transitionLogProb, emissionLogProb, durationLogProb, initialLogProb, entryLogProb } =
		input;
	const T = observations.length;
	const S = states.length;
	const MAX_D = input.maxDurationMinutes ?? DEFAULT_MAX_DURATION;
	if (T === 0 || S === 0) return [];
	const initFn = initialLogProb ?? ((): number => 0);
	const entryFn = entryLogProb ?? ((): number => 0);

	// trellis[s][τ] = max log-prob ending now in state s with segment-length τ.
	// Rolling: keep current and previous time step.
	// Encoded as flat Float64Array of size S*MAX_D for cache locality.
	const idx = (s: number, tau: number): number => s * MAX_D + (tau - 1); // tau 1-indexed
	let prev = new Float64Array(S * MAX_D);
	let cur = new Float64Array(S * MAX_D);
	prev.fill(Number.NEGATIVE_INFINITY);
	cur.fill(Number.NEGATIVE_INFINITY);

	// Backpointers: for each (t, s), what was the predecessor (s', τ_prev)
	// that won the new-segment transition into state s starting at t?
	// Stored only for segment STARTS (τ=1 entries) — within-segment
	// continues don't need backpointers since the state and continuity
	// are implicit.
	const backPrev: Int32Array[] = new Array(T);
	const backTau: Int32Array[] = new Array(T);
	for (let t = 0; t < T; t++) {
		backPrev[t] = new Int32Array(S);
		backTau[t] = new Int32Array(S);
		backPrev[t].fill(-1);
		backTau[t].fill(0);
	}

	// t = 0: initial state. Only τ=1 entries are valid; rest stay at -∞.
	for (let s = 0; s < S; s++) {
		const emit = emissionLogProb(states[s], observations[0]);
		prev[idx(s, 1)] = initFn(states[s]) + entryFn(states[s], observations[0]) + emit;
		// no backpointer needed at t=0
	}

	for (let t = 1; t < T; t++) {
		const obs = observations[t];
		cur.fill(Number.NEGATIVE_INFINITY);

		// Pre-compute, for each prev state s', the best "close-segment"
		// score: max_{τ_prev} [prev[s'][τ_prev] + log P_d(τ_prev | s')].
		// This is the best score for ending a segment of s' at time t-1.
		// O(S × MAX_D) per t; lets the new-segment loop be O(S²) instead
		// of O(S² × MAX_D).
		const closeBestScore = new Float64Array(S);
		const closeBestTau = new Int32Array(S);
		for (let sp = 0; sp < S; sp++) {
			let bestScore = Number.NEGATIVE_INFINITY;
			let bestTau = 0;
			for (let tau = 1; tau <= MAX_D; tau++) {
				const score = prev[idx(sp, tau)];
				if (score === Number.NEGATIVE_INFINITY) continue;
				// This segment of `sp` (length tau) ends at t-1 — it's being
				// closed so a new segment can begin at t.
				const dlp = durationLogProb(states[sp], tau, t - 1);
				if (dlp === Number.NEGATIVE_INFINITY) continue;
				const total = score + dlp;
				if (total > bestScore) {
					bestScore = total;
					bestTau = tau;
				}
			}
			closeBestScore[sp] = bestScore;
			closeBestTau[sp] = bestTau;
		}

		// For each new state s at time t:
		//   continue (τ ≥ 2): cur[s][τ] = prev[s][τ-1] + emission(t)
		//   new-segment (τ = 1): cur[s][1] = max_{s' ≠ s} [closeBestScore[s'] + T(s', s)] + emission(t)
		for (let s = 0; s < S; s++) {
			const emit = emissionLogProb(states[s], obs);
			if (emit === Number.NEGATIVE_INFINITY) continue;

			// continue
			for (let tau = 2; tau <= MAX_D; tau++) {
				const prevScore = prev[idx(s, tau - 1)];
				if (prevScore === Number.NEGATIVE_INFINITY) continue;
				cur[idx(s, tau)] = prevScore + emit;
			}

			// new-segment
			let bestNewScore = Number.NEGATIVE_INFINITY;
			let bestPrevState = -1;
			let bestPrevTau = 0;
			for (let sp = 0; sp < S; sp++) {
				if (sp === s) continue;
				const cb = closeBestScore[sp];
				if (cb === Number.NEGATIVE_INFINITY) continue;
				const trans = transitionLogProb(states[sp], states[s], obs);
				if (trans === Number.NEGATIVE_INFINITY) continue;
				const score = cb + trans;
				if (score > bestNewScore) {
					bestNewScore = score;
					bestPrevState = sp;
					bestPrevTau = closeBestTau[sp];
				}
			}
			if (bestNewScore !== Number.NEGATIVE_INFINITY) {
				cur[idx(s, 1)] = bestNewScore + entryFn(states[s], obs) + emit;
				backPrev[t][s] = bestPrevState;
				backTau[t][s] = bestPrevTau;
			}
		}

		// Swap rolling buffers.
		const tmp = prev;
		prev = cur;
		cur = tmp;
	}

	// Final: close the last segment. Pick (s, τ_final) maximising
	// prev[s][τ_final] + log P_d(τ_final | s).
	let bestFinalScore = Number.NEGATIVE_INFINITY;
	let bestFinalState = 0;
	let bestFinalTau = 1;
	for (let s = 0; s < S; s++) {
		for (let tau = 1; tau <= MAX_D; tau++) {
			const score = prev[idx(s, tau)];
			if (score === Number.NEGATIVE_INFINITY) continue;
			// Final segment closes at the last observation, T-1.
			const dlp = durationLogProb(states[s], tau, T - 1);
			if (dlp === Number.NEGATIVE_INFINITY) continue;
			const total = score + dlp;
			if (total > bestFinalScore) {
				bestFinalScore = total;
				bestFinalState = s;
				bestFinalTau = tau;
			}
		}
	}

	// All paths underflowed to -Infinity: degenerate input. Return
	// first state for all minutes — caller can detect if needed.
	if (bestFinalScore === Number.NEGATIVE_INFINITY) {
		const path: State[] = new Array(T);
		for (let t = 0; t < T; t++) path[t] = states[0];
		return path;
	}

	// Backtrack: walk segments from the end. Each segment runs from
	// (segEnd - tau + 1) to segEnd inclusive, all the same state.
	const path: State[] = new Array(T);
	let curState = bestFinalState;
	let curTau = bestFinalTau;
	let segEnd = T - 1; // last minute of the current segment

	while (segEnd >= 0) {
		const segStart = segEnd - curTau + 1;
		for (let i = segStart; i <= segEnd; i++) path[i] = states[curState];
		if (segStart === 0) break;
		// Move to the previous segment via the backpointer stored at
		// the current segment's START time.
		const prevSt = backPrev[segStart][curState];
		const prevTa = backTau[segStart][curState];
		if (prevSt === -1) break; // no predecessor (degenerate)
		curState = prevSt;
		curTau = prevTa;
		segEnd = segStart - 1;
	}

	return path;
}

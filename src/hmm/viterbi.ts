/**
 * Viterbi decoder — finds the MAP (maximum a posteriori) state
 * sequence over a discrete HMM via dynamic programming in log-space.
 *
 * `viterbi(input)` returns the most-likely state sequence given the
 * observations and the HMM parameters (transition + emission log-
 * probabilities). Standard forward + backpointer recovery; log-space
 * arithmetic avoids the multiplicative underflow that linear-space
 * Viterbi hits on long sequences.
 *
 * Pure function. No DB, no I/O, no globals. The HMM model (state
 * space, transition matrix, emission tables) is constructed by the
 * caller and passed in as the lookup callbacks.
 *
 * Tie-breaking is deterministic: when two predecessor states yield
 * the same posterior log-prob for a given (state, t), the one that
 * appeared earlier in the input `states` array wins. This makes the
 * output reproducible — important for the per-day decode cache
 * (`decoded_days`) where a stable input must produce a stable
 * sequence.
 *
 * Complexity: O(T × S²) where T = observations and S = states. For
 * MVP scale (1440 minutes × ~21 states) that's ~640k state-pair
 * operations per decode; sub-50 ms in TypeScript.
 */

export interface ViterbiInput<State, Obs> {
	/** Observations in time order; one per minute (or whatever unit
	 *  the HMM is defined over). */
	observations: readonly Obs[];
	/** All reachable states. Order is significant for deterministic
	 *  tie-breaking (earlier states win ties). */
	states: readonly State[];
	/** Log-probability of transitioning `from → to`. Return
	 *  `-Infinity` for impossible transitions (hard-zero). May be
	 *  asymmetric (`P(a→b) ≠ P(b→a)`). */
	transitionLogProb: (from: State, to: State) => number;
	/** Log-probability of emitting `obs` given the hidden state.
	 *  Return `-Infinity` for impossible emissions. */
	emissionLogProb: (state: State, obs: Obs) => number;
	/** Optional initial state log-probabilities. When omitted, all
	 *  states start with log-prob 0 (uniform over the state set). */
	initialLogProb?: (state: State) => number;
}

export function viterbi<State, Obs>(input: ViterbiInput<State, Obs>): State[] {
	const { observations, states, transitionLogProb, emissionLogProb, initialLogProb } = input;
	const T = observations.length;
	const S = states.length;
	if (T === 0 || S === 0) return [];

	// `score[s]` = log-prob of the best path ending in state s at time t.
	// `back[t][s]` = predecessor state index that achieved score[s] at time t.
	// We keep only the current + previous score columns (rolling),
	// but the full backpointer matrix to recover the path at the end.
	const back: Int32Array[] = new Array(T);
	for (let t = 0; t < T; t++) back[t] = new Int32Array(S);

	const initFn = initialLogProb ?? ((): number => 0);

	let prev = new Float64Array(S);
	let cur = new Float64Array(S);
	for (let s = 0; s < S; s++) {
		prev[s] = initFn(states[s]) + emissionLogProb(states[s], observations[0]);
		back[0][s] = -1;
	}

	for (let t = 1; t < T; t++) {
		const obs = observations[t];
		for (let s = 0; s < S; s++) {
			const emit = emissionLogProb(states[s], obs);
			// Best predecessor (earlier states win ties).
			let bestScore = Number.NEGATIVE_INFINITY;
			let bestPrev = -1;
			for (let p = 0; p < S; p++) {
				const fromScore = prev[p];
				if (fromScore === Number.NEGATIVE_INFINITY) continue;
				const trans = transitionLogProb(states[p], states[s]);
				if (trans === Number.NEGATIVE_INFINITY) continue;
				const score = fromScore + trans;
				if (score > bestScore) {
					bestScore = score;
					bestPrev = p;
				}
			}
			cur[s] = bestScore + emit;
			back[t][s] = bestPrev;
		}
		// Swap rolling columns.
		const tmp = prev;
		prev = cur;
		cur = tmp;
	}

	// Pick the best final state (earlier states win ties).
	let bestEnd = 0;
	let bestEndScore = prev[0];
	for (let s = 1; s < S; s++) {
		if (prev[s] > bestEndScore) {
			bestEndScore = prev[s];
			bestEnd = s;
		}
	}

	// All states finite-negative? That's a degenerate input where no
	// path has any probability mass. Return first state of each step —
	// caller can detect via score and fall back if they care.
	if (bestEndScore === Number.NEGATIVE_INFINITY) {
		const path: State[] = new Array(T);
		for (let t = 0; t < T; t++) path[t] = states[0];
		return path;
	}

	// Recover the path by walking backpointers.
	const path: State[] = new Array(T);
	let cursor = bestEnd;
	for (let t = T - 1; t >= 0; t--) {
		path[t] = states[cursor];
		const prevIdx = back[t][cursor];
		cursor = prevIdx === -1 ? cursor : prevIdx;
	}
	return path;
}

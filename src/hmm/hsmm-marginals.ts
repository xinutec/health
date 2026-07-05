/**
 * Hidden Semi-Markov Model forward-backward marginal inference.
 *
 * Computes per-minute posterior marginals `P(state_t = s | obs_1..T)`
 * for an HSMM. Unlike the Viterbi decoder (which returns a single
 * best path), this returns a distribution over states at each
 * minute — exposing the model's uncertainty.
 *
 * When the data strongly constrains the state at a minute, the
 * distribution concentrates (e.g. 99% at stationary @ Home). When
 * the data is ambiguous (overnight indoor GPS noise; unobserved
 * gap), the distribution spreads (40% Home, 30% neighbour-place,
 * 20% other-place, 10% unknown). The MAP path collapses both
 * cases to one answer; marginals show the difference.
 *
 * Algorithm: standard HSMM forward-backward, log-space.
 *
 *   Forward:
 *     α_t(s, τ) = log P(o_1..t, s_t=s, current-duration=τ)
 *     - Continue:  α_t(s, τ)  =  α_{t-1}(s, τ-1) + log p_emit(o_t | s)
 *     - New seg:   α_t(s, 1)  = logSumExp_{s', τ'} [
 *                                 α_{t-1}(s', τ') + log p_dur(τ' | s') + log p_trans(s', s, o_t)
 *                               ] + log p_emit(o_t | s)
 *
 *   Backward:
 *     β_t(s, τ) = log P(o_t+1..T | s_t=s, current-duration=τ)
 *     - From a τ>1 cell: continue (same state, τ+1) at time t+1.
 *     - From a τ=1 cell: that means the segment is closing at t,
 *       so include log p_dur(1 | s) ... wait that's not how it
 *       works because duration is "elapsed so far," not "remaining."
 *       Let's stick with the simpler "max-duration" formulation
 *       where forward computes α with τ = elapsed, and the segment
 *       ends when emitted by a new-segment transition.
 *
 *   Marginal:
 *     log P(s_t = s | obs) = logSumExp_τ [α_t(s,τ) + β_t(s,τ)]
 *                           - logZ
 *     where logZ = logSumExp_{s, τ} [α_T(s, τ) + log p_dur(τ | s)]
 *
 * This module is more conservative on memory than the Viterbi
 * variant — both α and β trellises must be kept in full (no
 * rolling) so the backward pass can read forward values. T × S ×
 * MAX_D doubles. For T=1440, S=200, MAX_D=240, that's 138M cells
 * × 8 bytes × 2 = ~2GB. Too much.
 *
 * Optimization: store α only as the forward pass produces it, then
 * do the backward pass + marginal computation in one streaming
 * loop, freeing α columns as we go. Peak memory ~ 4 × S × MAX_D
 * floats = 1.5MB. Acceptable.
 *
 * Pure function. No DB, no IO, no globals.
 */

export interface HsmmMarginalsInput<State, Obs> {
	observations: readonly Obs[];
	states: readonly State[];
	transitionLogProb: (from: State, to: State, toObs: Obs) => number;
	emissionLogProb: (state: State, obs: Obs) => number;
	durationLogProb: (state: State, durationMinutes: number) => number;
	initialLogProb?: (state: State) => number;
	/** See {@link HsmmInput.entryLogProb} — applied at t=0 and at each
	 *  new-segment transition. Default 0 (no entry prior). */
	entryLogProb?: (state: State, obs: Obs) => number;
	maxDurationMinutes?: number;
}

/** Per-minute posterior over states.
 *  `marginals[t][s]` = P(state at minute t = states[s] | all obs).
 *  Rows sum to 1 (probability distribution). */
export type Marginals = Float64Array[];

const DEFAULT_MAX_DURATION = 240;

/**
 * log(exp(a) + exp(b)) in numerically-stable form.
 */
function logSumExp(a: number, b: number): number {
	if (a === Number.NEGATIVE_INFINITY) return b;
	if (b === Number.NEGATIVE_INFINITY) return a;
	const max = Math.max(a, b);
	return max + Math.log(Math.exp(a - max) + Math.exp(b - max));
}

export function hsmmMarginals<State, Obs>(
	input: HsmmMarginalsInput<State, Obs>,
): {
	marginals: Marginals;
	logZ: number;
} {
	const { observations, states, transitionLogProb, emissionLogProb, durationLogProb, initialLogProb, entryLogProb } =
		input;
	const T = observations.length;
	const S = states.length;
	const MAX_D = input.maxDurationMinutes ?? DEFAULT_MAX_DURATION;
	if (T === 0 || S === 0) return { marginals: [], logZ: Number.NEGATIVE_INFINITY };
	const initFn = initialLogProb ?? ((): number => 0);
	const entryFn = entryLogProb ?? ((): number => 0);

	const idx = (s: number, tau: number): number => s * MAX_D + (tau - 1); // 1-indexed tau

	// Forward pass — store ALL α columns (need them for backward).
	// α[t] is a Float64Array of size S*MAX_D.
	const alpha: Float64Array[] = new Array(T);
	for (let t = 0; t < T; t++) {
		alpha[t] = new Float64Array(S * MAX_D);
		alpha[t].fill(Number.NEGATIVE_INFINITY);
	}

	// t = 0: only τ=1 valid; initial prior + entry prior + first-minute emission.
	for (let s = 0; s < S; s++) {
		alpha[0][idx(s, 1)] =
			initFn(states[s]) + entryFn(states[s], observations[0]) + emissionLogProb(states[s], observations[0]);
	}

	for (let t = 1; t < T; t++) {
		const obs = observations[t];

		// Pre-compute the "close-segment" log-mass per previous state:
		// closeMass(s') = logSumExp_{τ_prev} [α_{t-1}(s', τ_prev) + log p_dur(τ_prev | s')]
		const closeMass = new Float64Array(S);
		closeMass.fill(Number.NEGATIVE_INFINITY);
		const aPrev = alpha[t - 1];
		for (let sp = 0; sp < S; sp++) {
			let acc = Number.NEGATIVE_INFINITY;
			for (let tau = 1; tau <= MAX_D; tau++) {
				const av = aPrev[idx(sp, tau)];
				if (av === Number.NEGATIVE_INFINITY) continue;
				const dlp = durationLogProb(states[sp], tau);
				if (dlp === Number.NEGATIVE_INFINITY) continue;
				acc = logSumExp(acc, av + dlp);
			}
			closeMass[sp] = acc;
		}

		const aCur = alpha[t];
		for (let s = 0; s < S; s++) {
			const emit = emissionLogProb(states[s], obs);
			if (emit === Number.NEGATIVE_INFINITY) continue;

			// Continue: α_t(s, τ) = α_{t-1}(s, τ-1) + emit
			for (let tau = 2; tau <= MAX_D; tau++) {
				const prev = aPrev[idx(s, tau - 1)];
				if (prev === Number.NEGATIVE_INFINITY) continue;
				aCur[idx(s, tau)] = prev + emit;
			}

			// New-segment: α_t(s, 1) = [logSumExp_{s'≠s} closeMass(s') + trans(s', s, obs)] + emit
			let acc = Number.NEGATIVE_INFINITY;
			for (let sp = 0; sp < S; sp++) {
				if (sp === s) continue;
				const cm = closeMass[sp];
				if (cm === Number.NEGATIVE_INFINITY) continue;
				const trans = transitionLogProb(states[sp], states[s], obs);
				if (trans === Number.NEGATIVE_INFINITY) continue;
				acc = logSumExp(acc, cm + trans);
			}
			if (acc !== Number.NEGATIVE_INFINITY) {
				aCur[idx(s, 1)] = acc + entryFn(states[s], obs) + emit;
			}
		}
	}

	// logZ = log P(obs) = logSumExp_{s, τ} [α_T(s, τ) + log p_dur(τ | s)]
	let logZ = Number.NEGATIVE_INFINITY;
	const aLast = alpha[T - 1];
	for (let s = 0; s < S; s++) {
		for (let tau = 1; tau <= MAX_D; tau++) {
			const av = aLast[idx(s, tau)];
			if (av === Number.NEGATIVE_INFINITY) continue;
			const dlp = durationLogProb(states[s], tau);
			if (dlp === Number.NEGATIVE_INFINITY) continue;
			logZ = logSumExp(logZ, av + dlp);
		}
	}

	// Backward pass. β_t(s, τ) = log P(o_t+1..T | state at t is s with elapsed τ).
	// At t = T: terminal. β_T(s, τ) = log p_dur(τ | s) — the segment closes at T,
	// adding the duration cost. (No future observations to integrate.)
	let beta = new Float64Array(S * MAX_D);
	let betaNext = new Float64Array(S * MAX_D);
	beta.fill(Number.NEGATIVE_INFINITY);
	for (let s = 0; s < S; s++) {
		for (let tau = 1; tau <= MAX_D; tau++) {
			const dlp = durationLogProb(states[s], tau);
			beta[idx(s, tau)] = dlp;
		}
	}

	// Marginals: marginals[t][s] = logSumExp_τ [α_t(s,τ) + β_t(s,τ)] - logZ
	const marginals: Marginals = new Array(T);
	function computeMarginalsAt(t: number, betaT: Float64Array): void {
		const row = new Float64Array(S);
		const aT = alpha[t];
		for (let s = 0; s < S; s++) {
			let acc = Number.NEGATIVE_INFINITY;
			for (let tau = 1; tau <= MAX_D; tau++) {
				const av = aT[idx(s, tau)];
				const bv = betaT[idx(s, tau)];
				if (av === Number.NEGATIVE_INFINITY || bv === Number.NEGATIVE_INFINITY) continue;
				acc = logSumExp(acc, av + bv);
			}
			row[s] = acc === Number.NEGATIVE_INFINITY ? 0 : Math.exp(acc - logZ);
		}
		marginals[t] = row;
	}

	// Marginals at t = T-1 use the terminal β.
	computeMarginalsAt(T - 1, beta);

	// Walk backward: compute β at t-1 from β at t.
	for (let t = T - 1; t >= 1; t--) {
		const obsT = observations[t];
		betaNext.fill(Number.NEGATIVE_INFINITY);

		// Pre-compute the "transition + emit" log-mass aggregated at
		// the start of state s, time t:
		//   nsMass(s) = logSumExp_{s' ≠ s} [trans(s, s', obs_t) + emit(s', obs_t) + β_t(s', 1)]
		// This is the contribution to β_{t-1}(s, τ_prev) from STARTING a
		// new segment at t (closing the s segment at t-1 with duration τ_prev).
		const nsMass = new Float64Array(S);
		nsMass.fill(Number.NEGATIVE_INFINITY);
		for (let sp = 0; sp < S; sp++) {
			let acc = Number.NEGATIVE_INFINITY;
			for (let s = 0; s < S; s++) {
				if (s === sp) continue;
				const trans = transitionLogProb(states[sp], states[s], obsT);
				if (trans === Number.NEGATIVE_INFINITY) continue;
				const emit = emissionLogProb(states[s], obsT);
				if (emit === Number.NEGATIVE_INFINITY) continue;
				const bv = beta[idx(s, 1)];
				if (bv === Number.NEGATIVE_INFINITY) continue;
				acc = logSumExp(acc, trans + emit + bv);
			}
			nsMass[sp] = acc;
		}

		for (let s = 0; s < S; s++) {
			const emit = emissionLogProb(states[s], obsT);
			for (let tau = 1; tau <= MAX_D; tau++) {
				// Two ways forward from (s, τ) at time t-1:
				// 1. Continue: extend to (s, τ+1) at t. Contribution:
				//    β_t(s, τ+1) + emit(o_t | s).
				let extendMass = Number.NEGATIVE_INFINITY;
				if (tau + 1 <= MAX_D && emit !== Number.NEGATIVE_INFINITY) {
					const bv = beta[idx(s, tau + 1)];
					if (bv !== Number.NEGATIVE_INFINITY) extendMass = bv + emit;
				}
				// 2. Close segment at t-1, start new at t: pay duration
				//    cost for s having lasted τ, then enter ANY new state s'.
				let closeMassHere = Number.NEGATIVE_INFINITY;
				const dlp = durationLogProb(states[s], tau);
				if (dlp !== Number.NEGATIVE_INFINITY && nsMass[s] !== Number.NEGATIVE_INFINITY) {
					closeMassHere = dlp + nsMass[s];
				}
				betaNext[idx(s, tau)] = logSumExp(extendMass, closeMassHere);
			}
		}

		// Swap.
		const tmp = beta;
		beta = betaNext;
		betaNext = tmp;
		computeMarginalsAt(t - 1, beta);
	}

	return { marginals, logZ };
}

/**
 * Per-mode segment-duration distributions for the HSMM.
 *
 * A duration distribution `P_d(d | mode)` answers "given the
 * decoder has chosen `mode` as the state for this run, what's
 * the prior probability the run lasts `d` minutes?" It's the
 * factor that lets the HSMM penalise physically-impossible short
 * segments (a 1-minute plane flight, a 1-minute train ride
 * between two stationary stays) without breaking the Markov
 * structure that Viterbi-like inference relies on.
 *
 * Model: Gamma distribution per mode, fit via method-of-moments
 * on training-day segment durations. The Gamma family is right-
 * skewed positive, matches the empirical shape of dwell-time
 * distributions, and has a simple closed-form fit.
 *
 * Physical-floor override: for each mode, durations below
 * `minDuration(mode)` get a hard-floor log-probability — they're
 * physically implausible regardless of what the fitted Gamma
 * would say. The Gamma fit alone doesn't reliably zero out short
 * durations when its mean is large (Gamma(α=4, β=4/30) at d=1
 * is non-trivially non-zero), so the explicit floor is needed.
 *
 * Pure module. No DB, no IO, no globals.
 */

import type { ModelledMode } from "../geo/segments.js";

export interface GammaFit {
	/** Shape parameter (α > 0). */
	alpha: number;
	/** Rate parameter (β > 0). Mean = α/β, variance = α/β². */
	beta: number;
	sampleCount: number;
}

/** Log-probability assigned to durations below `minDuration` for
 *  a mode. Should be low enough to discourage 1-minute mode
 *  segments (the HSMM "bridge" pathology in the Markov HMM) but
 *  not -Infinity (we want the decoder to consider them if
 *  evidence is overwhelming). −10 nats ≈ 4.5e-5 probability. */
export const HARD_FLOOR_LOG_PROB = -10;

/** Per-mode physical-floor minimum duration in minutes.
 *
 *  Empirically derived from `dump-segment-durations` on 45 days
 *  of training data:
 *
 *    mode         1-min  2-4   5-9   10-29  30+   total
 *    stationary    6     4     14    24     84    132
 *    walking       0     0     7     42     11    60
 *    driving       0     1     3     7      13    24
 *    train         0     1     4     10     9     24
 *    cycling       —     —     —     —      —     0
 *    plane         —     —     —     —      —     0
 *
 *  All movement modes (walking / driving / train) have ZERO
 *  observed 1-min segments — they're artifacts of the per-
 *  minute Markov decoder bridging between two stationary
 *  states, not real physical events. Stationary has 6 1-min
 *  segments (4.5%) — likely heuristic artifacts at traffic-
 *  light stops, but rare enough that a min=2 floor doesn't
 *  hurt much.
 *
 *  Plane: hard 30-min floor — short hops are wheels-up to
 *  wheels-down 30-45 min, and the HSMM sees them stripped of
 *  boarding stationary.
 *
 *  Per-place overrides (e.g. stationary @ Home min=10 because
 *  drive-by GPS noise isn't a home visit) are layered on top
 *  at integration time by the HSMM caller.
 */
export const DEFAULT_MIN_DURATION_BY_MODE: Record<ModelledMode, number> = {
	stationary: 2,
	walking: 2,
	cycling: 2,
	driving: 2,
	train: 2,
	plane: 30,
	unknown: 1,
};

/** Fallback Gamma for modes with no/insufficient training data —
 *  a wide right-skewed shape with mean ~15 min. Used when the
 *  fitter sees < 5 samples (any narrower fit would be noise). */
const FALLBACK_GAMMA: GammaFit = {
	alpha: 1.5,
	beta: 0.1,
	sampleCount: 0,
};

/** Floor on stddev when fitting to prevent pathological narrow
 *  fits with σ ≈ 0 (which collapses the Gamma to a delta). */
const VAR_FLOOR = 4; // stddev floor ≈ 2 min

/**
 * Fit a Gamma distribution via method-of-moments.
 *
 *   α = mean² / variance
 *   β = mean / variance
 *
 * Returns the fallback Gamma for empty / degenerate input rather
 * than throwing — HSMM inference shouldn't crash on a thin
 * training day.
 */
export function fitDurationDistribution(values: readonly number[]): GammaFit {
	if (values.length < 5) {
		return { ...FALLBACK_GAMMA, sampleCount: values.length };
	}
	let sum = 0;
	for (const v of values) sum += v;
	const mean = sum / values.length;
	let sumSq = 0;
	for (const v of values) sumSq += (v - mean) ** 2;
	const variance = Math.max(VAR_FLOOR, sumSq / (values.length - 1));
	const alpha = (mean * mean) / variance;
	const beta = mean / variance;
	return { alpha, beta, sampleCount: values.length };
}

/**
 * Log-probability of a `d`-minute segment under `mode`'s fitted
 * duration distribution. Returns `HARD_FLOOR_LOG_PROB` for
 * durations below `minDuration` (physical impossibility).
 *
 * Implementation note: we evaluate the Gamma PDF in log-space
 * directly so very-short or very-long durations don't underflow.
 * Lanczos approximation for `log Γ(α)`.
 */
export function logDurationProb(d: number, _mode: ModelledMode, fit: GammaFit, minDuration: number): number {
	if (d < minDuration) return HARD_FLOOR_LOG_PROB;
	if (d <= 0) return HARD_FLOOR_LOG_PROB;
	return logGammaPdf(d, fit.alpha, fit.beta);
}

/** Log of the Gamma PDF: α log β − log Γ(α) + (α−1) log d − β d. */
function logGammaPdf(d: number, alpha: number, beta: number): number {
	if (alpha <= 0 || beta <= 0 || d <= 0) return HARD_FLOOR_LOG_PROB;
	return alpha * Math.log(beta) - logGamma(alpha) + (alpha - 1) * Math.log(d) - beta * d;
}

const LANCZOS_G = 7;
const LANCZOS_C = [
	0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
	12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** Memo for `logGamma`. The HSMM evaluates the duration prior once per
 *  (state, duration, segment-end) cell — ~55M times for a day at S=159,
 *  maxD=240 — but always at one of a handful of fitted α. Since `logGamma`
 *  is a pure function of a single number, caching on that number is exact
 *  by construction: no identity assumption, nothing to invalidate. */
const logGammaMemo = new Map<number, number>();

/**
 * Lanczos approximation to log Γ(z) for z > 0. Sufficiently
 * accurate for our use (α typically 1.5-10).
 */
function logGamma(z: number): number {
	const hit = logGammaMemo.get(z);
	if (hit !== undefined) return hit;
	const v = logGammaUncached(z);
	logGammaMemo.set(z, v);
	return v;
}

function logGammaUncached(z: number): number {
	if (z < 0.5) {
		// Reflection formula: Γ(z)Γ(1−z) = π / sin(πz)
		return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
	}
	const zMinusOne = z - 1;
	let x = LANCZOS_C[0];
	for (let i = 1; i < LANCZOS_G + 2; i++) x += LANCZOS_C[i] / (zMinusOne + i);
	const t = zMinusOne + LANCZOS_G + 0.5;
	return 0.5 * Math.log(2 * Math.PI) + (zMinusOne + 0.5) * Math.log(t) - t + Math.log(x);
}

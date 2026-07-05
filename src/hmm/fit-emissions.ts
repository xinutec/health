/**
 * Supervised MLE fit of per-mode emission distributions from
 * heuristic-labeled minute samples.
 *
 * Input: a flat array of `(mode, observation)` pairs harvested from
 *   labeled days — one per minute where the heuristic emitted a
 *   confident state and the observation has at least one modality.
 *
 * Output: per-mode Gaussian / zero-inflated-Gaussian fits, ready to
 *   be persisted into `learned_hmm_models` and consumed by the
 *   inference-time emission function.
 *
 * Modes that don't reach `MIN_SAMPLES_PER_MODE` labeled samples are
 * marked `"fallback"` so the inference caller can use the hand-
 * tuned `MODE_PRIORS` for those modes — better than overfitting
 * a Gaussian to 20 noisy samples.
 *
 * Pure function. No DB, no IO, no globals.
 */

import type { TransportMode } from "../geo/segments.js";

/** A single labeled minute used as a training sample. */
export interface LabeledSample {
	mode: TransportMode;
	/** Heart rate (bpm) at the minute, or `null` if no HR reading. */
	hr: number | null;
	/** Cadence (steps/min). `0` is a meaningful value ("explicit zero
	 *  steps observed at this minute"). `null` is "no step row at
	 *  all" — different from explicit zero, and excluded from fit. */
	cadence: number | null;
	/** Speed in km/h at the minute, derived from the GPS fix. `null`
	 *  if `gpsPresent === false` (no fix → no speed). */
	speedKmh: number | null;
	/** Whether a GPS fix was present at this minute. */
	gpsPresent: boolean;
	/** Place id when the heuristic labeled this minute as
	 *  `stationary @ knownPlace`; `null` for moving modes or
	 *  stationary @ off-network. Per-place HR fits (Cleveland Clinic
	 *  baseline ≠ Home baseline) need this conditioning. */
	placeId: number | null;
}

export interface GaussianFit {
	mean: number;
	std: number;
	sampleCount: number;
}

export interface ZeroInflatedCadenceFit {
	/** Fraction of observed cadence samples (non-null) that were 0. */
	expectedZeroProb: number;
	/** Gaussian fit on positive cadence samples. */
	positiveMean: number;
	positiveStd: number;
	positiveSampleCount: number;
	/** Count of all non-null cadence samples (zeros + positives). */
	totalSampleCount: number;
}

export interface LearnedModeParameters {
	/** P(GPS fix present | mode) — empirical. */
	gpsPresentProb: number;
	speed: GaussianFit;
	hr: GaussianFit;
	cadence: ZeroInflatedCadenceFit;
}

export interface TrainingSummary {
	totalSampleCount: number;
	samplesPerMode: Partial<Record<TransportMode, number>>;
	samplesPerPlace: Record<string, number>;
}

export interface LearnedEmissionParameters {
	/** Per-mode learned parameters. `"fallback"` for modes that
	 *  didn't reach `MIN_SAMPLES_PER_MODE` — caller should use
	 *  hand-tuned `MODE_PRIORS` for those modes. */
	perMode: Partial<Record<TransportMode, LearnedModeParameters | "fallback">>;
	/** Per-place HR fits for stationary states. Keyed by stringified
	 *  place id (so the blob is JSON-friendly). Populated when a
	 *  place has at least `MIN_SAMPLES_PER_PLACE` stationary samples
	 *  with non-null HR. Inference uses this when
	 *  `state.mode === "stationary" && state.placeId !== null` and
	 *  the per-place fit exists; otherwise falls through to per-mode.
	 *
	 *  Cadence/speed not learned per-place: cadence is similarly
	 *  sparse across places, speed is ~0 by definition at stationary.
	 *  HR is the signal that varies per place (Home resting vs
	 *  Work typing vs Clinic anxious). */
	perPlaceHr: Record<string, GaussianFit>;
	trainingSummary: TrainingSummary;
}

/** Below this sample count, a mode's fit is too noisy to trust;
 *  fall back to hand-tuned priors. */
export const MIN_SAMPLES_PER_MODE = 50;

/** Below this sample count, a per-place HR fit is too noisy to
 *  trust; fall back to the per-mode (global stationary) HR fit
 *  via the inference-time lookup chain. Higher than
 *  `MIN_SAMPLES_PER_MODE` because per-place data is much sparser
 *  and a wild outlier can throw a small fit dramatically off. */
export const MIN_SAMPLES_PER_PLACE = 50;

/** Floor on HR stddev to prevent pathological overfitting. A
 *  user's HR is naturally noisy (±5 bpm minute-to-minute even at
 *  rest); a fit smaller than this is overconfident. */
export const HR_STD_FLOOR = 5;

/** Per-place HR fits use a tighter sample threshold (50+) but still
 *  have far less data than per-mode fits (thousands of samples).
 *  Without a wider floor, narrow per-place σ values (5-7 from ~100
 *  samples) cause rare places to dominate Home overnight just
 *  because the tight Gaussian happens to land closer to the
 *  observed HR. Floor matches the per-mode global stationary scale
 *  (~12) so per-place can pull the distribution centre but not
 *  overfit its width. */
export const PER_PLACE_HR_STD_FLOOR = 12;

/** Floor on speed stddev. Similar rationale. */
const SPEED_STD_FLOOR = 1;

/** Floor on cadence stddev. */
const CADENCE_STD_FLOOR = 5;

/** Floor on `expectedZeroProb` to prevent a hard-zero on inference-
 *  time cadence=0 observations. Fitbit only writes step rows when
 *  there ARE steps, so heuristic-labeled training minutes never see
 *  explicit zero cadence — but raw inference observations can have
 *  cadence=0 if a step row exists with 0 steps. Without a floor,
 *  `logCadencePdf(0, prior)` returns `log(0) = -Infinity`, hard-
 *  zeroing the entire state for that minute. */
const EXPECTED_ZERO_PROB_FLOOR = 0.01;

/** Fit a 1-D Gaussian via MLE with Bessel-corrected stddev. */
function fitGaussian(values: readonly number[], stdFloor: number): GaussianFit {
	const n = values.length;
	if (n === 0) return { mean: 0, std: stdFloor, sampleCount: 0 };
	let sum = 0;
	for (const v of values) sum += v;
	const mean = sum / n;
	if (n === 1) return { mean, std: stdFloor, sampleCount: 1 };
	let sumSq = 0;
	for (const v of values) sumSq += (v - mean) ** 2;
	const variance = sumSq / (n - 1);
	const std = Math.max(stdFloor, Math.sqrt(variance));
	return { mean, std, sampleCount: n };
}

export function fitPerModeEmissions(samples: readonly LabeledSample[]): LearnedEmissionParameters {
	// Bucket by mode.
	const byMode = new Map<TransportMode, LabeledSample[]>();
	for (const s of samples) {
		let bucket = byMode.get(s.mode);
		if (!bucket) {
			bucket = [];
			byMode.set(s.mode, bucket);
		}
		bucket.push(s);
	}

	const perMode: Partial<Record<TransportMode, LearnedModeParameters | "fallback">> = {};
	const samplesPerMode: Partial<Record<TransportMode, number>> = {};

	for (const [mode, modeSamples] of byMode.entries()) {
		samplesPerMode[mode] = modeSamples.length;
		if (modeSamples.length < MIN_SAMPLES_PER_MODE) {
			perMode[mode] = "fallback";
			continue;
		}

		const hrValues: number[] = [];
		const speedValues: number[] = [];
		const cadenceZeros: number[] = [];
		const cadencePositives: number[] = [];
		let gpsPresentCount = 0;

		for (const s of modeSamples) {
			if (s.hr !== null) hrValues.push(s.hr);
			if (s.gpsPresent && s.speedKmh !== null) speedValues.push(s.speedKmh);
			if (s.gpsPresent) gpsPresentCount += 1;
			if (s.cadence !== null) {
				if (s.cadence === 0) cadenceZeros.push(0);
				else cadencePositives.push(s.cadence);
			}
		}

		const cadenceTotal = cadenceZeros.length + cadencePositives.length;
		const rawZeroProb = cadenceTotal > 0 ? cadenceZeros.length / cadenceTotal : 0;
		const expectedZeroProb = Math.max(EXPECTED_ZERO_PROB_FLOOR, Math.min(1 - EXPECTED_ZERO_PROB_FLOOR, rawZeroProb));
		const positiveFit = fitGaussian(cadencePositives, CADENCE_STD_FLOOR);

		perMode[mode] = {
			gpsPresentProb: gpsPresentCount / modeSamples.length,
			speed: fitGaussian(speedValues, SPEED_STD_FLOOR),
			hr: fitGaussian(hrValues, HR_STD_FLOOR),
			cadence: {
				expectedZeroProb,
				positiveMean: positiveFit.mean,
				positiveStd: positiveFit.std,
				positiveSampleCount: positiveFit.sampleCount,
				totalSampleCount: cadenceTotal,
			},
		};
	}

	// Per-place HR fits for stationary samples with a known placeId.
	// Bucket then fit; below MIN_SAMPLES_PER_PLACE the bucket is
	// dropped (no entry in perPlaceHr) so the inference-time lookup
	// falls through to per-mode.
	const stationaryByPlace = new Map<number, number[]>();
	const samplesPerPlace: Record<string, number> = {};
	for (const s of samples) {
		if (s.mode !== "stationary" || s.placeId === null) continue;
		samplesPerPlace[String(s.placeId)] = (samplesPerPlace[String(s.placeId)] ?? 0) + 1;
		if (s.hr === null) continue;
		let bucket = stationaryByPlace.get(s.placeId);
		if (!bucket) {
			bucket = [];
			stationaryByPlace.set(s.placeId, bucket);
		}
		bucket.push(s.hr);
	}

	const perPlaceHr: Record<string, GaussianFit> = {};
	for (const [placeId, hrValues] of stationaryByPlace.entries()) {
		if (hrValues.length < MIN_SAMPLES_PER_PLACE) continue;
		perPlaceHr[String(placeId)] = fitGaussian(hrValues, PER_PLACE_HR_STD_FLOOR);
	}

	return {
		perMode,
		perPlaceHr,
		trainingSummary: {
			totalSampleCount: samples.length,
			samplesPerMode,
			samplesPerPlace,
		},
	};
}

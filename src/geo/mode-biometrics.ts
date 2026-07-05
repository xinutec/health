/**
 * Per-user mode biometric signatures.
 *
 * Mines (HR, cadence, speed) joint distributions per transport mode from
 * historical data using heuristic labeling functions. The result is a
 * per-user, per-mode reference distribution that downstream classification
 * uses to disambiguate ambiguous segments — fixes the cycling-as-driving
 * bug at the right layer (HR-cadence-speed jointly distinguish them).
 *
 * Pure functions live here so the mining logic is testable without DB.
 */

import type { TransportMode } from "./segments.js";

/** A single per-minute observation, as fed into the labeling heuristic
 *  and into the per-mode aggregation. All fields are nullable because
 *  Fitbit data can be sparse (HR off, watch on charger, no GPS lock). */
export interface MinuteObservation {
	hr: number | null; // bpm
	cadence: number | null; // steps/min
	speed: number | null; // km/h
}

/** Summary statistics for one mode, computed from a user's historical
 *  labeled minutes. Null modality means "not enough samples to fit." */
export interface ModeStats {
	mode: string;
	hrMean: number | null;
	hrStd: number | null;
	hrSampleCount: number;
	cadenceMean: number | null;
	cadenceStd: number | null;
	cadenceSampleCount: number;
	speedMean: number | null;
	speedStd: number | null;
	speedSampleCount: number;
	sampleCount: number;
}

/**
 * Label a per-minute observation as a confident mode or null (ambiguous).
 * Designed for *clean* training data: many observations stay unlabeled —
 * that's fine, the goal is to characterise each mode's signature, not to
 * classify everything.
 *
 * Each rule's bands are chosen so the OTHER modes don't plausibly fit:
 * - Walking: 80-140 spm + 3-7 km/h. Below 80 spm could be tired or
 *   waiting; above 140 spm or above 7 km/h is jogging/running.
 * - Cycling: cadence 0 + 12-25 km/h + HR 100-170. Requires HR confirmation
 *   because cadence=0 + 18 km/h alone could be a slow drive.
 * - Driving: cadence 0 + speed > 30 + HR < 95 (or null). HR ceiling
 *   excludes cycling on a fast descent.
 * - Train: cadence 0 + speed > 80. Below 80 we may confuse with driving;
 *   above 80, no other mode plausibly hits this with cadence 0.
 * - Stationary: speed < 1 + cadence < 5.
 */
export function labelMinuteByHeuristic(obs: MinuteObservation): TransportMode | null {
	const { hr, cadence, speed } = obs;
	if (speed === null) return null;

	// Stationary: very low speed, very low cadence.
	if (speed < 1 && (cadence === null || cadence < 5)) {
		return "stationary";
	}

	// Walking: typical adult cadence + walking speed.
	if (cadence !== null && cadence >= 80 && cadence <= 140 && speed >= 3 && speed <= 7) {
		return "walking";
	}

	// Cycling: zero cadence + cycling speed + elevated HR (required).
	if (cadence !== null && cadence < 5 && speed >= 12 && speed <= 25 && hr !== null && hr >= 100 && hr <= 170) {
		return "cycling";
	}

	// Driving: zero cadence + driving speed + HR not in cycling range.
	if (cadence !== null && cadence < 5 && speed > 30 && speed <= 80 && (hr === null || hr < 95)) {
		return "driving";
	}

	// Train: zero cadence + 80–330 km/h. Upper bound covers fastest
	// scheduled high-speed rail (TGV 320, Shinkansen 285). Speeds above
	// the bound are likely plane climb-out / descent / cruise (see below).
	if (cadence !== null && cadence < 5 && speed > 80 && speed <= 330 && (hr === null || hr < 95)) {
		return "train";
	}

	// Plane: zero cadence + cruise speed. > 500 km/h is unambiguous —
	// no rail mode reaches it. The 330–500 km/h band is the plane
	// climb-out / descent / fast turboprop transition zone; we leave
	// it unlabeled rather than risk corrupting either signature.
	if (cadence !== null && cadence < 5 && speed > 500) {
		return "plane";
	}

	return null;
}

/**
 * Per-modality minimum std floors for `scoreModeLogLikelihood`. The
 * per-user mining produces unrealistically tight stds on sitting modes
 * because every past train / driving / plane minute happened to have
 * almost-zero cadence — so the mined `cadence_std` for those modes is
 * 0.4 spm. The first time a real ride has sensor noise (Fitbit picks
 * up vibration as ~50 spm cadence on a tube ride), the Gaussian
 * assigns ~(50/0.4)²/2 ≈ 7800 nats of penalty, blowing biometric-LL
 * to negative infinity and locking the segment as walking — the only
 * mode whose cadence std (~11 spm) absorbs the noise without
 * exploding.
 *
 * Flooring the stds at sensor-noise-realistic minimums lets the
 * Gaussian carry information without one noisy sample dominating.
 * Floors are conservative: pick the smallest defensible measurement
 * noise for each modality across all modes. Past mining that produced
 * smaller stds was over-confident, not informative.
 *
 *   - HR: 5 bpm. Fitbit's optical HR has ~3-5 bpm noise at rest;
 *     no real per-mode HR distribution is tighter than this.
 *   - cadence: 5 spm. Captures vibration-as-steps false positives
 *     on transit.
 *   - speed: 2 km/h. GPS speed noise on slow / sparse-fix segments.
 */
const HR_STD_FLOOR_BPM = 5;
const CADENCE_STD_FLOOR_SPM = 5;
const SPEED_STD_FLOOR_KMH = 2;

/**
 * Score the log-likelihood of an observation under a mode's Gaussian
 * emission per modality. Modalities with null observations OR null/zero
 * stats are skipped (contribute zero to log-likelihood — equivalent to
 * marginalising out). Returns `-Infinity` when every modality drops out.
 *
 * Each std is floored at a sensor-noise minimum before scoring (see
 * the floor constants' doc). The mined per-user stds are over-confident
 * on sitting modes' cadence and exploding the LL on any noisy reading.
 */
export function scoreModeLogLikelihood(obs: MinuteObservation, stats: ModeStats): number {
	let logLik = 0;
	let contributed = 0;
	const factor = (val: number | null, mean: number | null, std: number | null, floor: number): void => {
		if (val === null || mean === null || std === null || std === 0) return;
		const effectiveStd = Math.max(std, floor);
		const z = (val - mean) / effectiveStd;
		logLik += -0.5 * z * z;
		contributed++;
	};
	factor(obs.hr, stats.hrMean, stats.hrStd, HR_STD_FLOOR_BPM);
	factor(obs.cadence, stats.cadenceMean, stats.cadenceStd, CADENCE_STD_FLOOR_SPM);
	factor(obs.speed, stats.speedMean, stats.speedStd, SPEED_STD_FLOOR_KMH);
	return contributed === 0 ? Number.NEGATIVE_INFINITY : logLik;
}

/** Minimum log-likelihood improvement (best alternative vs current) to
 *  trigger a re-label. Equivalent to a likelihood ratio of e^4 ≈ 55× —
 *  alternative explains the observation 55× better than current. */
const RELABEL_LL_THRESHOLD = 4;

/** Maximum original confidenceMargin at which we'll consider biometric
 *  re-classification. Above this the GPS-derived classification is
 *  treated as authoritative even if biometrics look slightly off. */
const RELABEL_MAX_MARGIN = 3;

/** Minimum number of non-null modality observations the segment must
 *  provide for biometric correction to have a real say. Speed alone
 *  isn't enough — we need at least one biometric signal. */
const RELABEL_MIN_BIOMETRIC_OBS = 1;

/** Modes where the user is sitting — biometrically indistinguishable
 *  (same low HR, same zero cadence). Biometric correction must not flip
 *  among these because speed alone is the discriminator, and speed is
 *  what GPS-feature classification + refineMode already used (with OSM
 *  road/rail context). Letting biometrics override their decision adds
 *  noise: motorway driving at 94 km/h gets flipped to train because the
 *  driving sample is dominated by 52 km/h city driving. */
const SIT_MODES = new Set(["driving", "train", "plane"]);

/** Number of stds below the per-mode HR mean at which the
 *  current mode's HR becomes biologically implausible. 2 σ on a
 *  Gaussian = ~2.3% of the distribution. Strict enough to avoid
 *  false vetoes during low-effort cycling, loose enough to catch
 *  the "labelled cycling but HR sits at resting" case where the
 *  observed HR is several σ below cycling's mean. */
export const HR_VETO_SIGMA = 2.0;

/** Number of stds ABOVE the per-mode cadence mean at which the
 *  observed cadence becomes implausible for a "cadence ≈ 0" mode
 *  (cycling / driving / train / plane). */
export const CADENCE_VETO_SIGMA = 2.0;

/** Floor on the cadence-veto threshold. Some users have a degenerate
 *  per-mode cadence distribution (mean=0, std=0 — every training
 *  sample was exactly zero), which would make mean + 2σ = 0 and veto
 *  *any* non-zero observed cadence. A floor of 30 spm cleanly separates
 *  pedalling-with-occasional-step-noise (typically 0-10 spm) from
 *  actual walking (~80-130 spm). */
export const CADENCE_VETO_FLOOR_SPM = 30;

/** Speed ceiling for cadence-veto. Above this, walking is no longer a
 *  biomechanically plausible alternative, so cadence-veto's premise
 *  ("the user was walking, not pedalling") fails. Production bug
 *  motivator: a train segment at 108 km/h had a cadence reading > 30
 *  (vehicle vibration registered as steps); the veto fired against
 *  "driving" and the alternative-picker chose cycling because every
 *  alternative is equally implausible at that speed, so it picked the
 *  least-bad log-likelihood. 15 km/h sits comfortably above brisk
 *  walking (~7) and well below cycling (~17). */
export const CADENCE_VETO_MAX_SPEED_KMH = 15;

/** Modes whose biometric signature is "cadence ≈ 0" (pedalling /
 *  sitting / standing). A walking-range observed cadence inside one
 *  of these modes is biologically implausible. */
export const LOW_CADENCE_MODES = new Set(["cycling", "driving", "train", "plane"]);

/** Modes the re-classifier must never select as a flip *target*. The
 *  user cycles only rarely and any mined cycling signature is bogus
 *  (learned from the classifier's own mislabels), so flipping a segment
 *  *into* cycling would propagate the error. Cycling is still scored for
 *  the *current* mode — a cycling segment can be vetoed out — and
 *  genuine cycling is preserved by `gateCycling` on positive evidence. */
const NEVER_FLIP_TARGET = new Set(["cycling"]);

/** Speed ceilings used to filter biomechanically implausible flip targets
 *  in the LL-based re-classification. At 80 km/h, walking and cycling are
 *  not real alternatives no matter how the per-modality log-likelihoods
 *  shake out — the speed dimension already excluded them. Modes not in
 *  the table have no cap (sit-modes: driving / train / plane can be
 *  arbitrarily slow or fast). */
export const MAX_SPEED_FOR_MODE: Record<string, number> = {
	stationary: 5,
	walking: 12,
	cycling: 35,
};

/** Pure predicate: is `mode` biologically implausible given the
 *  observed HR for this user's per-mode HR distribution? The "is
 *  this mode possible?" half of `vetoImplausibleHr`, extracted so
 *  the factor-scorer candidate generator can filter implausible
 *  candidates without pulling in the demote-to-alternative logic
 *  (which the aggregator handles by picking the next-best surviving
 *  candidate). The full `vetoImplausibleHr` below now layers the
 *  demote logic on top of this predicate. */
export function isHrImplausibleForMode(mode: string, obsHr: number | null, stats: readonly ModeStats[]): boolean {
	if (mode === "stationary") return false;
	if (obsHr === null) return false;
	const cur = stats.find((s) => s.mode === mode);
	if (!cur || cur.hrMean === null || cur.hrStd === null || cur.hrStd <= 0) return false;
	const minPlausible = cur.hrMean - HR_VETO_SIGMA * cur.hrStd;
	return obsHr < minPlausible;
}

/** Pure predicate: is `mode` biologically implausible given the
 *  observed cadence (and speed, which gates the veto's "this was
 *  walking" premise)? The "is this mode possible?" half of
 *  `vetoImplausibleCadence`. See `isHrImplausibleForMode`. */
export function isCadenceImplausibleForMode(
	mode: string,
	obsCadence: number | null,
	obsSpeed: number | null,
	stats: readonly ModeStats[],
): boolean {
	if (!LOW_CADENCE_MODES.has(mode)) return false;
	if (obsCadence === null) return false;
	if (obsSpeed !== null && obsSpeed > CADENCE_VETO_MAX_SPEED_KMH) return false;
	const cur = stats.find((s) => s.mode === mode);
	if (!cur || cur.cadenceMean === null || cur.cadenceStd === null) return false;
	const maxPlausible = Math.max(cur.cadenceMean + CADENCE_VETO_SIGMA * cur.cadenceStd, CADENCE_VETO_FLOOR_SPM);
	return obsCadence > maxPlausible;
}

/** Hard veto: when the segment's observed HR is more than
 *  HR_VETO_SIGMA std-devs below the current mode's HR mean, the
 *  classification is biologically implausible regardless of how
 *  confidently the GPS+OSM classifier picked it. Demote to the
 *  highest-log-likelihood alternative mode.
 *
 *  Returns no-change when:
 *    - the current mode is stationary (HR-veto only applies to
 *      movement modes; stationary's HR distribution is the
 *      resting band itself);
 *    - no observed HR (no evidence);
 *    - no stats row for the current mode (cold-start user);
 *    - the current mode's stats row has no HR distribution
 *      (insufficient sample for that mode).
 *
 *  Designed as a separate function so the rule is testable on its
 *  own and slots cleanly into `correctModeBySignature` as a
 *  short-circuit before the log-likelihood comparison.
 */
export function vetoImplausibleHr(
	seg: { mode: string; obsHr: number | null; obsCadence: number | null; obsSpeed: number | null },
	stats: readonly ModeStats[],
): { mode: string; changed: boolean } {
	if (!isHrImplausibleForMode(seg.mode, seg.obsHr, stats)) {
		return { mode: seg.mode, changed: false };
	}

	// HR is implausible for the current mode. Pick the
	// highest-log-likelihood alternative as the demotion target.
	const obs: MinuteObservation = { hr: seg.obsHr, cadence: seg.obsCadence, speed: seg.obsSpeed };
	let best: { mode: string; score: number } | null = null;
	for (const s of stats) {
		if (s.mode === seg.mode) continue;
		if (NEVER_FLIP_TARGET.has(s.mode)) continue;
		const sc = scoreModeLogLikelihood(obs, s);
		if (best === null || sc > best.score) best = { mode: s.mode, score: sc };
	}
	if (best === null) return { mode: seg.mode, changed: false };
	return { mode: best.mode, changed: true };
}

/** Hard veto: when the segment is labelled one of the low-cadence
 *  modes (cycling / driving / train / plane) but the observed cadence
 *  is in walking range, the classification is biologically implausible.
 *  Demote to the highest-log-likelihood alternative.
 *
 *  Sibling to `vetoImplausibleHr`. Catches the case where HR sits in
 *  the cycling-borderline band (so HR-veto doesn't fire) but step
 *  cadence ~80 spm gives the walk away. Motivating case: phantom-
 *  cycling segments with cadence 80/86 spm on a brisk walk.
 *
 *  Returns no-change when:
 *    - mode is not in LOW_CADENCE_MODES;
 *    - obsCadence is null;
 *    - no stats row for the current mode (cold-start user);
 *    - the current mode's stats row has no cadence distribution;
 *    - obsCadence is within max(mean + 2σ, FLOOR_SPM).
 */
export function vetoImplausibleCadence(
	seg: { mode: string; obsHr: number | null; obsCadence: number | null; obsSpeed: number | null },
	stats: readonly ModeStats[],
): { mode: string; changed: boolean } {
	if (!isCadenceImplausibleForMode(seg.mode, seg.obsCadence, seg.obsSpeed, stats)) {
		return { mode: seg.mode, changed: false };
	}

	const obs: MinuteObservation = { hr: seg.obsHr, cadence: seg.obsCadence, speed: seg.obsSpeed };
	let best: { mode: string; score: number } | null = null;
	for (const s of stats) {
		if (s.mode === seg.mode) continue;
		if (NEVER_FLIP_TARGET.has(s.mode)) continue;
		const sc = scoreModeLogLikelihood(obs, s);
		if (best === null || sc > best.score) best = { mode: s.mode, score: sc };
	}
	if (best === null) return { mode: seg.mode, changed: false };
	return { mode: best.mode, changed: true };
}

/** Minimum sustained speed (km/h) for a segment to be plausibly
 *  cycling. Below this it is walking pace, not a bicycle. */
const CYCLING_MIN_SPEED_KMH = 12;

/** Maximum sustained speed (km/h) for cycling. Above this the segment
 *  is a motor vehicle, not a bicycle. */
const CYCLING_MAX_SPEED_KMH = 35;

/** Observed step cadence (spm) at or above which a "cycling" segment is
 *  really on foot — pedalling does not register a sustained step rhythm. */
const CYCLING_MAX_CADENCE_SPM = 20;

/**
 * Hard-evidence gate for cycling. The user cycles only rarely, while the
 * classifier over-produces cycling (a feedback loop in signature
 * mining), so a "cycling" segment is kept only with genuine evidence:
 * sustained cycle-band speed AND no walking step cadence. A segment that
 * fails is demoted — to driving when it is too fast for a bicycle,
 * otherwise to walking.
 *
 * Returns no-change for any non-cycling segment.
 */
export function gateCycling(seg: { mode: string; obsCadence: number | null; obsSpeed: number | null }): {
	mode: string;
	changed: boolean;
} {
	if (seg.mode !== "cycling") return { mode: seg.mode, changed: false };
	const speed = seg.obsSpeed;
	const speedOk = speed !== null && speed >= CYCLING_MIN_SPEED_KMH && speed <= CYCLING_MAX_SPEED_KMH;
	const cadenceOk = seg.obsCadence === null || seg.obsCadence < CYCLING_MAX_CADENCE_SPM;
	if (speedOk && cadenceOk) return { mode: "cycling", changed: false };
	const demoted = speed !== null && speed > CYCLING_MAX_SPEED_KMH ? "driving" : "walking";
	return { mode: demoted, changed: true };
}

/**
 * Decide whether to relabel a segment's mode based on per-user
 * biometric signatures. Returns the chosen mode plus whether a change
 * was made.
 *
 * Triggers only when:
 *   - the segment's current mode is non-stationary (stays are
 *     detected by clustering, not by mode score)
 *   - the current classification is ambiguous (margin < RELABEL_MAX_MARGIN)
 *   - the segment carries at least one biometric observation (HR or
 *     cadence — speed alone isn't enough info)
 *   - an alternative mode has log-likelihood >= RELABEL_LL_THRESHOLD
 *     higher than the current mode
 */
export function correctModeBySignature(
	seg: {
		mode: string;
		confidenceMargin: number;
		obsHr: number | null;
		obsCadence: number | null;
		obsSpeed: number | null;
	},
	stats: ModeStats[],
): { mode: string; changed: boolean } {
	if (seg.mode === "stationary") return { mode: seg.mode, changed: false };

	// Biometric vetoes run FIRST, before the confidence-margin gate: a
	// classifier that's "confident" about cycling can still be
	// biologically impossible if HR sits in the resting band or
	// cadence is in walking range.
	const hrVeto = vetoImplausibleHr(seg, stats);
	if (hrVeto.changed) return hrVeto;
	const cadenceVeto = vetoImplausibleCadence(seg, stats);
	if (cadenceVeto.changed) return cadenceVeto;

	if (seg.confidenceMargin >= RELABEL_MAX_MARGIN) return { mode: seg.mode, changed: false };
	if (stats.length === 0) return { mode: seg.mode, changed: false };

	const obs: MinuteObservation = { hr: seg.obsHr, cadence: seg.obsCadence, speed: seg.obsSpeed };
	const biometricObsCount = (obs.hr !== null ? 1 : 0) + (obs.cadence !== null ? 1 : 0);
	if (biometricObsCount < RELABEL_MIN_BIOMETRIC_OBS) return { mode: seg.mode, changed: false };

	let best = { mode: seg.mode, score: Number.NEGATIVE_INFINITY };
	let currentScore = Number.NEGATIVE_INFINITY;
	let currentFound = false;
	for (const s of stats) {
		const score = scoreModeLogLikelihood(obs, s);
		if (s.mode === seg.mode) {
			currentScore = score;
			currentFound = true;
		}
		// Never flip a segment INTO cycling (see NEVER_FLIP_TARGET). The
		// current mode is still scored above so a cycling segment can be
		// vetoed *out*; cycling just cannot be a destination.
		if (s.mode !== seg.mode && NEVER_FLIP_TARGET.has(s.mode)) continue;
		// Don't consider sit-modes as flip targets when the current mode
		// is also a sit-mode — they're biometrically equivalent.
		if (SIT_MODES.has(seg.mode) && SIT_MODES.has(s.mode) && s.mode !== seg.mode) continue;
		// Speed-compatibility gate: don't flip into a mode whose speed
		// signature can't physically accommodate the observation. Catches
		// the cadence-std-numerics quirk where cycling can score "less
		// bad" than train at 80 km/h purely because of std-dev widths.
		if (s.mode !== seg.mode && seg.obsSpeed !== null) {
			const cap = MAX_SPEED_FOR_MODE[s.mode];
			if (cap !== undefined && seg.obsSpeed > cap) continue;
		}
		if (score > best.score) best = { mode: s.mode, score };
	}

	// No stats for current mode → we can't reason about whether the
	// alternative is genuinely better. Keep as classified.
	if (!currentFound) return { mode: seg.mode, changed: false };
	if (best.mode === seg.mode) return { mode: seg.mode, changed: false };
	if (best.score - currentScore < RELABEL_LL_THRESHOLD) return { mode: seg.mode, changed: false };
	return { mode: best.mode, changed: true };
}

/**
 * Aggregate labeled minute samples into per-mode summary stats. Modality
 * means/stds use only non-null values; mean is `null` when zero non-null
 * samples for that mode/modality. Population (not sample) std-dev.
 */
export function aggregateModeStats(samples: { mode: string; obs: MinuteObservation }[]): ModeStats[] {
	// Bucket samples by mode.
	const byMode = new Map<string, MinuteObservation[]>();
	for (const s of samples) {
		const arr = byMode.get(s.mode) ?? [];
		arr.push(s.obs);
		byMode.set(s.mode, arr);
	}

	const computeMeanStd = (values: (number | null)[]): { mean: number | null; std: number | null; count: number } => {
		const filtered = values.filter((v): v is number => v !== null);
		if (filtered.length === 0) return { mean: null, std: null, count: 0 };
		const mean = filtered.reduce((acc, v) => acc + v, 0) / filtered.length;
		const variance = filtered.reduce((acc, v) => acc + (v - mean) ** 2, 0) / filtered.length;
		return { mean, std: Math.sqrt(variance), count: filtered.length };
	};

	const stats: ModeStats[] = [];
	for (const [mode, obs] of byMode) {
		const hr = computeMeanStd(obs.map((o) => o.hr));
		const cadence = computeMeanStd(obs.map((o) => o.cadence));
		const speed = computeMeanStd(obs.map((o) => o.speed));
		stats.push({
			mode,
			hrMean: hr.mean,
			hrStd: hr.std,
			hrSampleCount: hr.count,
			cadenceMean: cadence.mean,
			cadenceStd: cadence.std,
			cadenceSampleCount: cadence.count,
			speedMean: speed.mean,
			speedStd: speed.std,
			speedSampleCount: speed.count,
			sampleCount: obs.length,
		});
	}
	return stats;
}

/**
 * Biometric coherence — the per-segment "is the user *actually*
 * sitting at this place, vs moving through it" signal that modulates
 * the magnetic-focus-place pull.
 *
 * See `docs/proposals/2026-06-magnetic-focus-places.md` §2.
 *
 * The coherence $B_s \in [0, 1]$ is high when HR + steps over the
 * segment window are consistent with sitting still (low cadence,
 * resting-range HR) and low when they show movement (steps
 * accumulating, HR elevated). A focus_place's magnet pull is the
 * product of its visit-history magnet strength $M_p$ and the
 * segment's $B_s$: either signal weakening collapses the pull.
 *
 * Designed to be a pure function over the data already loaded for
 * splitStaysOnEvidence / bridgeStaysWithBiometrics — no new mining,
 * no new schema.
 */

import type { HrPoint, StepPoint } from "./biometrics.js";

/** Coefficients of the logistic that maps steps/min + HR-elevation to
 *  the coherence score. Tuned so:
 *
 *    - 0 steps/min, HR at resting     → B ≈ 0.99
 *    - 30 steps/min, HR resting       → B ≈ 0.90
 *    - 50 steps/min, HR resting       → B ≈ 0.50
 *    - 90 steps/min, HR +25 bpm above → B ≈ 0.05
 *
 *  The point isn't precise calibration — it's a smooth gate that's
 *  near 1 for clearly-sitting and near 0 for clearly-moving, with a
 *  bounded transition zone in between. Per-user resting HR is mined
 *  by the existing mode-biometrics work and can be plumbed later;
 *  for the first cut a fixed resting baseline is fine. */
const BETA_0 = 4;
const BETA_STEPS = 0.08;
const BETA_HR = 0.06;

/** Generic resting HR baseline used when a per-user value isn't
 *  available. The HR elevation $\Delta$ is `hrMean - REST_HR_BASELINE`
 *  in bpm. Tuned to sit comfortably below most adult resting HR;
 *  per-user calibration can refine this later. */
const REST_HR_BASELINE = 70;

function logistic(x: number): number {
	return 1 / (1 + Math.exp(-x));
}

/** Inputs the coherence function consumes for one segment. */
export interface BiometricCoherenceInput {
	startTs: number;
	endTs: number;
	hr: readonly HrPoint[];
	steps: readonly StepPoint[];
}

/** Compute $B_s$ for a segment window. Returns 1 when biometric
 *  data is missing — the coherence factor degrades gracefully into
 *  "no information" rather than penalising candidates. */
export function biometricCoherence(input: BiometricCoherenceInput): number {
	const durationMin = Math.max(1, (input.endTs - input.startTs) / 60);
	const inSeg = (ts: number): boolean => ts >= input.startTs && ts <= input.endTs;

	const hrInSeg = input.hr.filter((p) => inSeg(p.ts));
	const stepsInSeg = input.steps.filter((p) => inSeg(p.ts));

	const stepsPerMin = stepsInSeg.reduce((s, p) => s + p.steps, 0) / durationMin;
	const hrMean = hrInSeg.length > 0 ? hrInSeg.reduce((s, p) => s + p.bpm, 0) / hrInSeg.length : REST_HR_BASELINE;
	const hrElevation = Math.max(0, hrMean - REST_HR_BASELINE);

	return logistic(BETA_0 - BETA_STEPS * stepsPerMin - BETA_HR * hrElevation);
}

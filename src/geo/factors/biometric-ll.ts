/**
 * biometric-ll factor.
 *
 * Thin adapter around `scoreModeLogLikelihood` from `mode-biometrics.ts`.
 * That function already returns log-likelihood in nats under per-user
 * Gaussian emissions for HR / cadence / speed. The factor just
 * dispatches by the candidate's mode and returns null when the
 * information needed isn't in context (no observation, no stats for
 * this mode, or no modality actually contributed).
 *
 * "Returns null" matters: a missing per-user signature for a mode
 * (e.g. a cold-start cyclist who's never been classified as cycling
 * before) should not penalise that mode's candidate. Other factors
 * carry the classification.
 *
 * Behavioural notes:
 *
 * - The underlying scoreModeLogLikelihood returns -Infinity when no
 *   modality contributed (all observations null OR all matching
 *   stats null/zero-std). We map that to `null` because it semantically
 *   matches "no evidence" rather than "evidence against."
 *
 * - A finite negative log-lik (e.g. -2.5 nats) means "the observation
 *   is unusual under this mode's signature" and DOES penalise the
 *   candidate. That's the case we keep.
 */

import { scoreModeLogLikelihood } from "../mode-biometrics.js";
import type { Factor } from "./types.js";

export const biometricLL: Factor = (candidate, ctx) => {
	if (!ctx.biometricObs || !ctx.modeStats) return null;
	const stats = ctx.modeStats.find((s) => s.mode === candidate.mode);
	if (!stats) return null;
	const score = scoreModeLogLikelihood(ctx.biometricObs, stats);
	if (!Number.isFinite(score)) return null;
	return {
		name: "biometric-ll",
		score,
		rationale: rationaleFor(candidate.mode, ctx.biometricObs, score),
	};
};

function rationaleFor(
	mode: string,
	obs: { hr: number | null; cadence: number | null; speed: number | null },
	score: number,
): string {
	const parts: string[] = [];
	if (obs.hr !== null) parts.push(`HR ${obs.hr}`);
	if (obs.cadence !== null) parts.push(`cadence ${obs.cadence}`);
	if (obs.speed !== null) parts.push(`speed ${obs.speed.toFixed(1)} km/h`);
	const observed = parts.length > 0 ? parts.join(", ") : "no biometric data";
	if (score >= -1) return `${observed} fits your ${mode} signature`;
	if (score >= -5) return `${observed} partially fits your ${mode} signature`;
	return `${observed} is unusual under your ${mode} signature`;
}

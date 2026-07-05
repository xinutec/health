/**
 * speed-emission factor.
 *
 * Wraps the existing `scoreWindow` Gaussian range-score in
 * `segments.ts` as a log-likelihood per `ModeCandidate`. The factor
 * unpacks an existing computation; it does not introduce new logic.
 * That's by design — Phase 1 of the scored-classification refactor
 * (see `docs/proposals/2026-05-scored-classification.md`) is
 * structural, not behavioural.
 *
 * Behavioural notes:
 *
 * - `scoreWindow` returns multiplicative masses (positive numbers,
 *   typically in [0, ~10]). We log-transform to get nats, so the
 *   factor's contribution is additive in the per-candidate sum.
 *
 * - Returns null when no `windowFeatures` are in the context. This
 *   distinguishes "factor doesn't apply" from "factor strongly
 *   disagrees" (-Infinity).
 *
 * - When `scoreWindow` returns 0 for a candidate (one of the
 *   product-form multipliers zeroed it), we log to `-Infinity`. The
 *   consumer treats that as "this candidate is ruled out" — it's
 *   the right behaviour, not a special case.
 */

import { scoreWindow } from "../segments.js";
import type { Factor } from "./types.js";

export const speedEmission: Factor = (candidate, ctx) => {
	// Preferred path: full WindowFeatures available (from segments
	// pipeline). Use the rich Gaussian range-score per mode.
	if (ctx.windowFeatures) {
		const scores = scoreWindow(ctx.windowFeatures);
		const match = scores.find((s) => s.mode === candidate.mode);
		if (!match) return null;
		const score = match.score > 0 ? Math.log(match.score) : Number.NEGATIVE_INFINITY;
		return {
			name: "speed-emission",
			score,
			rationale: rationaleFor(candidate.mode, ctx.windowFeatures.medianSpeed, score),
		};
	}
	// Fallback path: only `speedKmh` is available (e.g. refineMode
	// called with a segment-aggregated speed; WindowFeatures lives
	// upstream). Coarser per-mode rules — enough to discriminate
	// walking-pace from vehicular and to keep walking from winning
	// on a fast urban segment.
	if (ctx.speedKmh !== undefined) {
		const score = scoreFromSpeedOnly(candidate.mode, ctx.speedKmh);
		if (score === null) return null;
		return {
			name: "speed-emission",
			score,
			rationale: `(speed-only) ${candidate.mode} at ${ctx.speedKmh.toFixed(1)} km/h`,
		};
	}
	return null;
};

/** Coarser per-mode log-likelihood from speed alone. Values are
 *  tuned so the factor produces roughly the same per-mode ranking
 *  as scoreWindow on synthetic features at the same median speed,
 *  but linearity / heading-change / bounding-radius signals are
 *  absent.
 *
 *  Calibration note: the very-low-speed penalties for vehicular
 *  modes (train, driving) were initially tuned at −2.5 — small
 *  enough that other factors at typical-distance bonuses (osm-
 *  distance +3, mode-coherence +1.5) could compose to a positive
 *  total. That's a calibration failure: a train sustaining 5 km/h
 *  for a 10-minute segment is essentially impossible (the LL
 *  should be heavily negative), but −2.5 lets other factors win
 *  through. The deeper fix is to derive per-mode LLs from empirical
 *  speed distributions; the interim is to make the very-low-speed
 *  exclusions strong enough to dominate any plausible osm-distance
 *  + mode-coherence sum. −7 puts train-at-5-km/h ~5 nats more
 *  negative than the best other factor sum could reach, which is
 *  what "essentially impossible" should look like in nats. Document
 *  as proper-Gaussian-derivation TBD (task #182). */
function scoreFromSpeedOnly(mode: string, kmh: number): number | null {
	switch (mode) {
		case "stationary":
			return kmh < 2 ? 0.5 : kmh < 8 ? -0.5 : -2.5;
		case "walking":
			if (kmh > 15) return -3.0;
			if (kmh >= 2 && kmh <= 8) return 0.5;
			return -0.5;
		case "cycling":
			if (kmh >= 10 && kmh <= 28) return 0.5;
			if (kmh > 40) return -2.0;
			return -0.5;
		case "driving":
			if (kmh > 25) return 1.0;
			if (kmh > 15) return 0.3;
			if (kmh > 8) return -0.5;
			// Walking-pace or slower: strongly contradicts driving.
			// Tightened to −7 (was −2.5) so vehicular candidates with
			// strong osm-distance + mode-coherence sums can't win on a
			// walking-pace segment.
			return -7;
		case "train":
			if (kmh > 40) return 1.0;
			if (kmh > 15) return 0;
			// Below 15 km/h sustained: not a train ride. Tightened to
			// −7 (was −2.5) so a tube line directly underfoot (osm-
			// distance +3, mode-coherence +1.5) can't push a walking-
			// speed segment to "train" via the additive sum.
			return -7;
		case "plane":
			if (kmh > 200) return 1.5;
			if (kmh < 80) return -3.0;
			return 0;
		default:
			return null;
	}
}

function rationaleFor(mode: string, medianSpeedKmh: number, score: number): string {
	if (score === Number.NEGATIVE_INFINITY) {
		return `speed/linearity profile rules out ${mode}`;
	}
	if (score >= 0) {
		return `speed/linearity profile consistent with ${mode} at ${medianSpeedKmh.toFixed(1)} km/h`;
	}
	return `speed/linearity profile partially fits ${mode} at ${medianSpeedKmh.toFixed(1)} km/h`;
}

/**
 * Per-segment-entry log-prior for the HSMM.
 *
 * Why this exists as a separate factor (vs being part of the emission):
 *
 *   Emissions multiply per-minute, accumulating evidence over a stay.
 *   That's correct for observations (HR, speed, GPS-presence) that
 *   are observed every minute and where each minute is independent
 *   evidence about the latent state. It is WRONG for state-priors
 *   that should fire once per segment — like the hour-of-day arrival
 *   rate. A `stationary @ Cafe` stay's correct weight is
 *   `log P(arrive at Cafe at hour h)`, not 60·log(...) per hour of
 *   the stay. The per-minute version over-weights peaky-profile
 *   places by a factor of segment-length-in-minutes, and was the
 *   dominant cause of overnight place-bouncing (HSMM's 0.2% place
 *   attribution score against ground truth, May 2026 audit).
 *
 *   The HSMM `entryLogProb` callback fires once per segment: at t=0
 *   for the initial segment and at every new-segment transition.
 *   That's the correct shape for "log P(enter state s at time t)."
 *
 * Currently wires the per-place hour-of-day arrival rate. Future
 * entry priors (per-place duration distribution, day-of-week visit
 * rates, weather-conditional adjustments) compose into this same
 * callback.
 *
 * Pure module. No DB, no IO, no globals.
 */

import type { Observation } from "./observation.js";
import type { State } from "./state-space.js";

export type EntryLogProbFn = (state: State, obs: Observation) => number;

export interface BuildEntryPriorOpts {
	/** Per-place hour-of-day visit profile (24 normalised buckets
	 *  summing to ~1, as mined into `focus_places.hour_profile`).
	 *  Contributes `log(24 × hour_profile[hourLocal])` — positive at
	 *  the place's typical hours, negative at unusual ones. */
	placeHourProfiles?: ReadonlyMap<number, readonly number[]>;
	/** Per-place visit-frequency weight (fraction of total stationary
	 *  time at each known place). When provided, contributes
	 *  `log(N_places × weight)` to the entry prior for
	 *  `stationary @ knownPlace`. Compositionally:
	 *
	 *    log P(start a stay at P at hour h)
	 *      ≈ log P(P)            ← visit_weight
	 *        + log P(h | P)      ← hour_profile
	 *        + const
	 *
	 *  Without the visit_weight term, mid-night new-segment
	 *  transitions over-favor rare places with peaky hour profiles
	 *  (a one-off late-night visit places spuriously beats Home).
	 *  See the 2026-05-25 ground-truth audit. */
	placeVisitWeights?: ReadonlyMap<number, number>;
}

/** Floor on the per-hour fraction. A place with no recorded visits
 *  at hour H gets `log(24 × 0.001) ≈ -3.73` nats, not -Infinity.
 *  `focus_places` mining can miss an hour for any reason; a hard-
 *  zero would be too strong. */
const HOUR_PROFILE_FLOOR = 0.001;

export function buildEntryPrior(opts: BuildEntryPriorOpts = {}): EntryLogProbFn {
	const hourProfiles = opts.placeHourProfiles ?? null;
	const visitWeights = opts.placeVisitWeights ?? null;
	const nPlaces = visitWeights !== null ? visitWeights.size : 0;
	const fallbackWeight = nPlaces > 0 ? 1 / (10 * nPlaces) : 0;

	return (state: State, obs: Observation): number => {
		if (state.mode !== "stationary" || state.placeId === null) return 0;
		let logProb = 0;
		if (hourProfiles !== null) {
			const profile = hourProfiles.get(state.placeId);
			if (profile !== undefined && profile.length === 24) {
				const f = Math.max(profile[obs.hourLocal], HOUR_PROFILE_FLOOR);
				logProb += Math.log(24 * f);
			}
		}
		if (visitWeights !== null && nPlaces > 0) {
			const w = visitWeights.get(state.placeId) ?? fallbackWeight;
			logProb += Math.log(nPlaces * w);
		}
		return logProb;
	};
}

/**
 * Presence-continuity emission factor — Phase 3 of
 * `docs/proposals/2026-06-presence-continuity.md`.
 *
 * Pure module. Computes a per-minute emission log-bonus for the HSMM
 * given a `ContinuityContext` (yesterday's end-of-day place + how
 * stale that signal is). The factor:
 *
 *   - is silent when `priorPlaceId` is null (no continuation signal)
 *   - is silent when the state's placeId doesn't match priorPlaceId
 *   - is silent when the observation has a GPS fix (the existing
 *     place-distance Gaussian handles fix-bearing minutes; this
 *     factor only fires under no-fix evidence so today's fresh fixes
 *     can always override yesterday-based continuity)
 *   - otherwise returns a non-negative log-bonus
 *     log(1 + EMISSION_STRENGTH · decay · post) so the matching state
 *     is more likely than non-matching under no-fix evidence.
 *
 * Why emission-only (no entry-prior bias): on a discharge-day like
 * 06-02, fresh fixes confirm a stay at a new place, but the prior
 * day's place still has a strong continuity context. An entry-prior
 * bias fires regardless of GPS evidence and over-rides the
 * place-distance Gaussian even when fresh fixes contradict.
 * Per-minute emission (silent on fix-bearing minutes) accumulates
 * over a no-fix stretch — enough to overcome a typical visit_weight
 * gap (~3 nats) when the stretch is long, but cannot override a
 * single fix-bearing minute where place-distance is decisive.
 *
 * The strength constants are design defaults (Phase 2 empirical
 * calibration is deferred — see the proposal's Phasing section).
 */

import { haversineMeters } from "../../geo/place-snap.js";
import type { Observation } from "../observation.js";
import type { State } from "../state-space.js";

export interface ContinuityContext {
	/** focus_places.id from the prior day's end-of-day state, or null
	 *  when the prior day had no established stay (a travel day). */
	priorPlaceId: number | null;
	/** Centroid of the prior place. Used to gate the continuity bonus
	 *  against today's fresh evidence: if the most-recent fix as of
	 *  the minute being scored is far from this point, today's fixes
	 *  have contradicted the prior, and the bonus is silenced.
	 *  Null when the prior place has no known coords (factor stays
	 *  un-gated — bonus fires whenever the other guards pass). */
	priorPlaceCoord: { lat: number; lon: number } | null;
	/** Hours elapsed between the prior day's last confirmed GPS fix
	 *  and the minute being scored. Drives the time-decay term. */
	hoursSinceLastConfirmedFix: number;
	/** Posterior the HSMM assigned to the prior day's end-of-day
	 *  state (0–1). Carried forward unchanged so a high-confidence
	 *  seed contributes more than a low-confidence one. */
	priorPosterior: number;
}

/** A `prevGpsFix` farther than this from `priorPlaceCoord` counts as
 *  today's evidence contradicting yesterday — the bonus is silenced
 *  for the matching state from then on. 1.5 km is well outside the
 *  150 m place radius so this gate doesn't trip on jitter, but tight
 *  enough that a real elsewhere-fix kills the continuation. */
const CONTRADICTION_RADIUS_M = 1500;

/** Per-no-fix-minute bonus given to the matching stationary state.
 *  At decay=1, post=0.95 the bonus is log(1.095) ≈ 0.091 nats/min.
 *  Sized so a 12h no-fix stretch (≈65 nats) accumulates enough to
 *  flip the per-day decision toward continuation, but a 10-minute
 *  fix-bearing stretch at a contradicting place (≈30 nats from
 *  the PLACE_DISTANCE_FLOOR=-3 cap × 10 min) can still break a
 *  short segment back to the observed place. Values much above 0.1
 *  let continuity over-rule fresh-fix contradiction at short stays;
 *  values much below 0.05 don't reliably flip the long-no-fix
 *  hospital case. */
const EMISSION_STRENGTH = 0.1;

/** Time decay constant (hours). At `tau` hours of no fresh fix the
 *  continuation's contribution drops to 1/e ≈ 0.37 of its baseline.
 *  At 2·tau ≈ 14%; at 3·tau ≈ 5%. */
const TAU_HOURS = 24;

/** Per-minute emission log-bonus for the matching stationary state on
 *  a no-fix minute. Non-negative; capped at log(1 + EMISSION_STRENGTH).
 *  Pure function; all inputs are read-only. */
export function continuityLogLikelihood(state: State, obs: Observation, ctx: ContinuityContext | null): number {
	if (ctx === null) return 0;
	if (ctx.priorPlaceId === null) return 0;
	if (state.mode !== "stationary") return 0;
	if (state.placeId !== ctx.priorPlaceId) return 0;
	if (obs.gps !== null) return 0; // place-distance factor handles fix-present minutes
	// Contradiction gate: once today's most-recent fix is far from the
	// prior place, today's evidence has superseded yesterday's. The
	// `obs.prevGpsFix` pointer carries forward across no-fix minutes
	// so this stays silenced for the rest of the day after the
	// contradicting fix arrives. Yesterday's last fix (when it's the
	// most recent because today has no fixes yet) is near the prior
	// place, so the gate naturally lets the bonus fire across the
	// morning no-fix stretch — exactly the case the factor is for.
	if (ctx.priorPlaceCoord !== null && obs.prevGpsFix !== null) {
		const d = haversineMeters(obs.prevGpsFix.lat, obs.prevGpsFix.lon, ctx.priorPlaceCoord.lat, ctx.priorPlaceCoord.lon);
		if (d > CONTRADICTION_RADIUS_M) return 0;
	}
	const decay = Math.exp(-Math.max(0, ctx.hoursSinceLastConfirmedFix) / TAU_HOURS);
	const post = Math.max(0, Math.min(1, ctx.priorPosterior));
	const w = decay * post;
	if (w <= 0) return 0;
	return Math.log(1 + EMISSION_STRENGTH * w);
}

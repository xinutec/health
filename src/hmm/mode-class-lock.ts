/**
 * Per-minute mode-class lock — physical-fact filter for the
 * constraint-first decoder
 * (`docs/proposals/decoder-roadmap.md`).
 *
 * Three locks, all derived from sustained signal aggregated across
 * a window so single-minute noise can't flip the verdict:
 *
 *   "foot"       — watch reports sustained cadence above the walking
 *                  threshold. Feet are moving in the user's reference
 *                  frame; the user cannot simultaneously be in a
 *                  moving vehicle.
 *   "vehicle"    — GPS displacement across the window implies a
 *                  speed above the walking ceiling AND no sustained
 *                  cadence. The user is moving but not on foot
 *                  (train / drive / cycle — the lock doesn't pick
 *                  between them; the scorer does).
 *   "stationary" — GPS observations cluster tightly across the
 *                  window AND no sustained cadence.
 *   null         — the lock is silent; the scorer is free to decide.
 *
 * Thresholds are universal human-physiology / GPS-noise constants,
 * not user-specific. A human cannot sustain > 12 km/h walking; > 30
 * spm wrist cadence sustained is walking; an 80 m cluster spread is
 * within consumer GPS noise for "didn't move."
 *
 * The decoder uses these locks as HARD constraints on segment
 * emission: a `train`/`driving`/`cycling` segment that contains
 * any "foot" or "stationary" minute is rejected; a `walking`
 * segment containing any "vehicle" minute is rejected; etc.
 * That's the structural filter that physical facts must enforce.
 *
 * Pure module.
 */

import type { Observation } from "./observation.js";

export type ModeClass = "foot" | "vehicle" | "stationary" | null;

export interface ComputeModeClassLocksInput {
	observations: readonly Observation[];
}

/** Window radius (minutes) — the lock at minute `t` is computed
 *  from observations in `[t - WINDOW_RADIUS, t + WINDOW_RADIUS]`. */
const WINDOW_RADIUS_MIN = 2;

/** Cadence threshold (steps/min) for sustained walking. Wrist
 *  cadence below this routinely fires from incidental motion
 *  (gestures, riding a bumpy vehicle); above this for multiple
 *  consecutive minutes means the user is walking or running. */
const CADENCE_FOOT_THRESHOLD_SPM = 30;

/** Number of minutes within the window that must exceed
 *  `CADENCE_FOOT_THRESHOLD_SPM` to lock the centre minute as
 *  "foot". Must be a majority of observable cadence minutes. */
const FOOT_LOCK_MIN_HIGH_CADENCE_COUNT = 3;

/** Maximum sustainable human walking speed (km/h). Implied speed
 *  above this means the user isn't walking. */
const V_WALK_MAX_KMH = 12;

/** Maximum GPS displacement (metres) within the window for the
 *  user to count as stationary. 80 m absorbs typical consumer GPS
 *  noise (5–30 m per fix in urban canyons) plus brief in-building
 *  movement. */
const STATIONARY_MAX_DISPLACEMENT_M = 80;

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function computeModeClassLocks(input: ComputeModeClassLocksInput): ModeClass[] {
	const T = input.observations.length;
	const locks: ModeClass[] = new Array(T).fill(null);
	if (T === 0) return locks;

	for (let t = 0; t < T; t++) {
		const start = Math.max(0, t - WINDOW_RADIUS_MIN);
		const end = Math.min(T - 1, t + WINDOW_RADIUS_MIN);

		let highCadenceCount = 0;
		let anyCadenceObserved = false;
		let earliestGps: { ts: number; lat: number; lon: number } | null = null;
		let latestGps: { ts: number; lat: number; lon: number } | null = null;

		for (let k = start; k <= end; k++) {
			const ob = input.observations[k];
			if (ob.cadence !== null) {
				anyCadenceObserved = true;
				if (ob.cadence >= CADENCE_FOOT_THRESHOLD_SPM) highCadenceCount++;
			}
			if (ob.gps !== null) {
				if (earliestGps === null) earliestGps = { ts: ob.ts, lat: ob.gps.lat, lon: ob.gps.lon };
				latestGps = { ts: ob.ts, lat: ob.gps.lat, lon: ob.gps.lon };
			}
		}

		// FOOT: sustained cadence above the walking threshold. Takes
		// precedence over the vehicle lock — running at 12 km/h still
		// has feet moving.
		if (highCadenceCount >= FOOT_LOCK_MIN_HIGH_CADENCE_COUNT) {
			locks[t] = "foot";
			continue;
		}

		// VEHICLE: window-level GPS displacement implies a speed above
		// the walking ceiling AND no sustained cadence in this window.
		// If we have no GPS observations IN the window but the
		// observation's prev/next bookends imply vehicle speed, that
		// also counts — captures underground tube rides where GPS is
		// only observed at the bookends of the gap.
		if (highCadenceCount === 0) {
			let impliedKmh = 0;
			if (earliestGps !== null && latestGps !== null && latestGps.ts > earliestGps.ts) {
				const distKm = haversineMeters(earliestGps.lat, earliestGps.lon, latestGps.lat, latestGps.lon) / 1000;
				const hrs = (latestGps.ts - earliestGps.ts) / 3600;
				impliedKmh = distKm / Math.max(hrs, 1 / 3600);
			} else {
				// Fall back to the per-minute prev/nextGpsFix bookends
				// recorded by the observation tensor builder. This
				// covers the underground-tube case: no GPS observed in
				// the window itself, but the minute's prev/next bookends
				// span much wider than the window.
				const ob = input.observations[t];
				if (ob.prevGpsFix !== null && ob.nextGpsFix !== null && ob.nextGpsFix.ts > ob.prevGpsFix.ts) {
					const distKm =
						haversineMeters(ob.prevGpsFix.lat, ob.prevGpsFix.lon, ob.nextGpsFix.lat, ob.nextGpsFix.lon) / 1000;
					const hrs = (ob.nextGpsFix.ts - ob.prevGpsFix.ts) / 3600;
					impliedKmh = distKm / Math.max(hrs, 1 / 3600);
				}
			}
			if (impliedKmh > V_WALK_MAX_KMH) {
				locks[t] = "vehicle";
				continue;
			}
		}

		// STATIONARY: GPS cluster spread is below the noise floor AND
		// no sustained cadence. Requires at least some signal — pure
		// no-data minutes stay null.
		if (highCadenceCount === 0 && anyCadenceObserved && earliestGps !== null && latestGps !== null) {
			const distM = haversineMeters(earliestGps.lat, earliestGps.lon, latestGps.lat, latestGps.lon);
			if (distM < STATIONARY_MAX_DISPLACEMENT_M) {
				locks[t] = "stationary";
			}
		}
	}

	return locks;
}

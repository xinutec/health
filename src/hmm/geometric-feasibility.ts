/**
 * Geometric feasibility factor for HSMM emissions.
 *
 * Penalises `stationary @ knownPlace` states when the implied
 * teleport speed between a nearby observed GPS fix (forward or
 * backward in time) and the place's centroid exceeds plausible
 * movement speeds.
 *
 * Why this exists:
 *
 *   Without this factor, on a GPS-null minute the HSMM can pick a
 *   stationary state at any known place — the place-distance term
 *   only fires when GPS is present. Combined with the visit-
 *   frequency entry prior, this lets Home (highest-dwell) win
 *   spuriously during any urban GPS gap (tube tunnel, indoor
 *   meeting, etc.) even when the user is physically elsewhere.
 *
 *   The 2026-05-25 audit on 2026-05-22 showed the HSMM hallucinating
 *   `stationary @ Home` (Wembley) for 9 minutes during a 13-minute
 *   Met Line tube ride from King's Cross → Finchley Road. Pentonville
 *   Road at 20:03 → Finchley Road at 20:16; Home is ~10 km from
 *   either endpoint. The implied speed of teleporting to Home and
 *   back is impossible, but nothing in the framework noticed.
 *
 *   This factor closes that gap: for each `stat @ A` candidate at
 *   minute t, find the nearest GPS fix in either direction, compute
 *   the implied avg speed required to traverse from fix to A, and
 *   penalise per-minute when implied speed exceeds plausible bounds.
 *
 * Composition: combined with the base emission via simple addition
 * at the CLI level. Pure function — no DB, no IO, no globals.
 */

import type { Observation } from "./observation.js";
import type { State } from "./state-space.js";

export interface BuildGeometricFeasibilityOpts {
	placeCoords: ReadonlyMap<number, { lat: number; lon: number }>;
}

export type GeometricFeasibilityFn = (state: State, obs: Observation) => number;

/** Speed (km/h) above which the implied teleport starts paying a
 *  penalty. 80 km/h matches an upper bound on London surface
 *  vehicle speeds (motorway-adjacent driving, fast train segments,
 *  taxis with green lights). Underground tube avg is ~30 km/h; main-
 *  line rail can exceed but is bounded by the duration distribution
 *  on `train` states, not by this factor. */
const MAX_PLAUSIBLE_SPEED_KMH = 80;

/** Standard deviation of the half-Gaussian penalty above the
 *  plausible threshold. Smaller σ → sharper penalty. 20 km/h was
 *  tuned against the 2026-05-22 case so:
 *    - 100 km/h implied (excess 20): -0.5 nats / minute (mild)
 *    - 150 km/h (excess 70): -6 nats / minute
 *    - 230 km/h (excess 150): -28 nats / minute (sharp)
 *    - 600 km/h (excess 520): -340 nats / minute (impossible)
 *
 *  Per-minute accumulation through a gap: at the moment the gap
 *  starts (small elapsed → high implied speed), the penalty is
 *  decisive; as elapsed grows it decays toward zero. A 4-minute
 *  "stat @ Home during tube ride" claim accumulates ~-60 nats —
 *  enough to flip the decoder against the visit-frequency + per-
 *  place HR pull that otherwise wins. */
const SPEED_PENALTY_SIGMA_KMH = 20;

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function impliedSpeedKmh(
	fix: { ts: number; lat: number; lon: number },
	target: { lat: number; lon: number },
	currentTs: number,
): number {
	const elapsedSec = Math.abs(currentTs - fix.ts);
	if (elapsedSec <= 0) {
		// Same minute as a real fix; place-distance factor handles
		// near/far check. No additional geometric penalty here.
		return 0;
	}
	const distM = haversineMeters(fix.lat, fix.lon, target.lat, target.lon);
	const distKm = distM / 1000;
	const elapsedH = elapsedSec / 3600;
	return distKm / elapsedH;
}

export function buildGeometricFeasibility(opts: BuildGeometricFeasibilityOpts): GeometricFeasibilityFn {
	const places = opts.placeCoords;
	return (state: State, obs: Observation): number => {
		if (state.mode !== "stationary" || state.placeId === null) return 0;
		const place = places.get(state.placeId);
		if (place === undefined) return 0;

		let worstImpliedSpeed = 0;
		if (obs.prevGpsFix !== null) {
			const s = impliedSpeedKmh(obs.prevGpsFix, place, obs.ts);
			if (s > worstImpliedSpeed) worstImpliedSpeed = s;
		}
		if (obs.nextGpsFix !== null) {
			const s = impliedSpeedKmh(obs.nextGpsFix, place, obs.ts);
			if (s > worstImpliedSpeed) worstImpliedSpeed = s;
		}

		if (worstImpliedSpeed <= MAX_PLAUSIBLE_SPEED_KMH) return 0;
		const excess = worstImpliedSpeed - MAX_PLAUSIBLE_SPEED_KMH;
		return -0.5 * (excess / SPEED_PENALTY_SIGMA_KMH) ** 2;
	};
}

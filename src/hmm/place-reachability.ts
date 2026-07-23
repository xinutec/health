/**
 * Per-day focus-place reachability filter — a safe, near-exact reduction of the
 * decoder's stationary state space.
 *
 * The model makes every one of the user's ~140 lifetime focus places a
 * `stationary@place` state on every day. But on a given day the user is
 * physically near only ~15-35 of them; a place with no GPS fix within a
 * generous radius all day cannot be a stationary destination, so its state is
 * dead weight in the O(T·S²)/O(T·S·maxD) trellis. Dropping it removes the state
 * without changing the optimum (measured identical on the golden corpus).
 *
 * Safety: this is NOT a lossy beam. Two properties keep it near-exact:
 *   - The generic `placeId: null` stationary state is never dropped, so a
 *     genuine stay at a filtered-out place still decodes as (unlabelled)
 *     stationary rather than being made impossible.
 *   - `keepIds` forces through places GPS can't confirm but that are likely —
 *     the continuity prior-day place (GPS is often absent at day start where
 *     the user actually still is).
 */

import { haversineMeters } from "../geo/place-snap.js";

export interface ReachablePlacesOpts {
	/** A place is kept if it lies within this many metres of any GPS fix that
	 *  day. Generous (≥ a few hundred m) to absorb GPS drift + the place's own
	 *  extent; the win is robust to the exact value since far places are km+ off. */
	radiusM: number;
	/** Place ids kept regardless of proximity — e.g. the continuity prior-day
	 *  place, where the user may still be before the day's first fix. */
	keepIds?: ReadonlySet<number>;
}

/**
 * Restrict `places` to those reachable on the day the `points` describe: within
 * `radiusM` of some fix, or in `keepIds`. Pure; O(places × points) with an
 * early exit — negligible beside the trellis it shrinks.
 */
export function reachablePlaces<P extends { id: number; lat: number; lon: number }>(
	places: readonly P[],
	points: readonly { readonly lat: number; readonly lon: number }[],
	opts: ReachablePlacesOpts,
): P[] {
	const keep = opts.keepIds ?? new Set<number>();
	return places.filter((p) => {
		if (keep.has(p.id)) return true;
		for (const pt of points) {
			if (haversineMeters(p.lat, p.lon, pt.lat, pt.lon) <= opts.radiusM) return true;
		}
		return false;
	});
}

/**
 * Production entry point: the day-reachable place set with the safety keeps
 * baked in — the top `anchorCount` places by lifetime dwell (home/work, which
 * the entry/continuity priors can infer through a GPS gap with no nearby fix)
 * and the continuity prior-day place. Single-sources the keep policy so the
 * served decode and its corpus gate cannot drift.
 */
export function reachablePlacesForDay<P extends { id: number; lat: number; lon: number; totalDwellSec?: number }>(
	places: readonly P[],
	points: readonly { readonly lat: number; readonly lon: number }[],
	opts: { radiusM: number; anchorCount?: number; continuityPlaceId?: number | null },
): P[] {
	const anchorCount = opts.anchorCount ?? 8;
	const keepIds = new Set<number>(
		[...places]
			.sort((a, b) => (b.totalDwellSec ?? 0) - (a.totalDwellSec ?? 0))
			.slice(0, anchorCount)
			.map((p) => p.id),
	);
	if (opts.continuityPlaceId != null) keepIds.add(opts.continuityPlaceId);
	return reachablePlaces(places, points, { radiusM: opts.radiusM, keepIds });
}

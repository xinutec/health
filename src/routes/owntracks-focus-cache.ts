/**
 * In-memory cache of focus_places for the Owntracks proxy.
 *
 * Why a cache: each Owntracks POST runs the long-stay gate, which needs
 * the user's focus_places. Hitting MariaDB on every fix would add
 * latency to a hot path (a dense walking trail can produce a fix every
 * 10-30 seconds). focus_places is also updated only by the nightly
 * mining job, so a few minutes of staleness is fine.
 *
 * The cache is per-user keyed and lazy: first request after restart
 * (or expiry) pays the DB hit; subsequent requests within the TTL
 * window read in-memory.
 */

import { db } from "../db/pool.js";
import type { FocusPlaceForGating } from "./owntracks-long-stay.js";

const TTL_MS = 5 * 60 * 1000;

interface Entry {
	places: FocusPlaceForGating[];
	cachedAtMs: number;
}

const cache = new Map<string, Entry>();

/** Get the user's focus_places, refreshing from DB if the cached copy
 *  is stale. Returns an empty list if the user has no focus_places yet
 *  (new user, mining hasn't run, etc.) — long-stay gate treats that as
 *  "no place qualifies" which is the conservative answer. */
export async function getFocusPlacesForGating(userId: string): Promise<FocusPlaceForGating[]> {
	const entry = cache.get(userId);
	if (entry && Date.now() - entry.cachedAtMs < TTL_MS) return entry.places;

	const rows = await db()
		.selectFrom("focus_places")
		.select(["centroid_lat", "centroid_lon", "total_dwell_sec", "visit_count", "sleep_hours"])
		.where("user_id", "=", userId)
		.execute();

	const places: FocusPlaceForGating[] = rows.map((r) => ({
		centroidLat: r.centroid_lat,
		centroidLon: r.centroid_lon,
		// avgDwellSec = total / visits. Guard against visit_count = 0
		// (shouldn't happen in well-formed rows, but easy to guard).
		// total_dwell_sec is BIGINT (returns as bigint after the
		// bigIntAsNumber:false flip). Seconds fit in Number safely,
		// so coerce so we can divide by visit_count (INT/number).
		avgDwellSec: r.visit_count > 0 ? Number(r.total_dwell_sec) / r.visit_count : 0,
		sleepHours: r.sleep_hours ?? 0,
	}));

	cache.set(userId, { places, cachedAtMs: Date.now() });
	return places;
}

/** Test seam: clear the cache between test runs. */
export function _resetFocusCache(): void {
	cache.clear();
}

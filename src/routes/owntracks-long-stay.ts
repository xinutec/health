/**
 * Long-stay location gating for the Owntracks demote decision.
 *
 * Move→Significant mode is the most expensive Owntracks transition —
 * the phone hands back the warm GPS and reports only on motion events
 * thereafter, with a ~15-minute scheduled-tick fallback. We want that
 * transition only at locations where the user typically stays for
 * hours: home, work, regular long-visit places.
 *
 * The gate consults the user's `focus_places` clusters (already
 * computed by the nightly mining pipeline) and answers a single
 * question: is the current fix inside a place where this user
 * historically spends a long time?
 *
 * Two signals, either of which qualifies a focus place as long-stay:
 *
 *   - `avgDwellSec` (computed by the caller as
 *     `total_dwell_sec / visit_count`) ≥ 2 hours. Captures workplaces
 *     and any other day-spend locations the user has accumulated
 *     visits at.
 *   - `sleepHours` ≥ 4. Captures residences — anywhere they
 *     routinely sleep is also somewhere they linger during the day.
 *
 * The radius (100 m) is loose enough to absorb GPS jitter at a known
 * centroid but tight enough that the cluster next door doesn't
 * mistakenly gate the user.
 */

import { haversineMeters } from "../geo/place-snap.js";

const LONG_STAY_RADIUS_M = 100;
const LONG_STAY_AVG_DWELL_SEC = 2 * 3600;
const LONG_STAY_SLEEP_HOURS = 4;

/** A focus_place row in the minimal shape this gate needs. The route
 *  handler builds these from the `focus_places` table; the gate
 *  itself is a pure function so it's easy to test. */
export interface FocusPlaceForGating {
	centroidLat: number;
	centroidLon: number;
	avgDwellSec: number;
	sleepHours: number;
}

/** Returns true when the given fix lies inside a focus place that
 *  historically holds the user for hours. Used to gate the
 *  Move→Significant demotion in the decision pipeline. */
export function isLongStayLocation(lat: number, lon: number, focusPlaces: readonly FocusPlaceForGating[]): boolean {
	for (const fp of focusPlaces) {
		const d = haversineMeters(lat, lon, fp.centroidLat, fp.centroidLon);
		if (d > LONG_STAY_RADIUS_M) continue;
		if (fp.sleepHours >= LONG_STAY_SLEEP_HOURS) return true;
		if (fp.avgDwellSec >= LONG_STAY_AVG_DWELL_SEC) return true;
	}
	return false;
}

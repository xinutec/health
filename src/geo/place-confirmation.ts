/**
 * The user's own word on what a place is — the last step, after the sensors
 * have said everything they honestly can.
 *
 * Some venue ties are not resolvable by any amount of GPS. On 2026-07-12,
 * sitting in Urban Social on Upper Street: OSM maps the café as a bare NODE and
 * the pub next door as a BUILDING, 13 m apart in the same terrace, both
 * plausible for a midday hour-long sit. The measured fixes are excellent (3–8 m
 * accuracy) and they still cannot separate the two, because the indoor smear
 * runs ACROSS the street — the very axis that would tell the two apart. The
 * geometry narrows the field to that pair and then stops. A cleverer prior at
 * that point would not be more accurate, only more confident.
 *
 * So the pair is closed by a confirmation, and the confirmation is remembered.
 *
 * Keyed by LOCATION rather than by `focus_places.id`, deliberately: focus places
 * are re-mined from scratch by `refresh-focus-places`, and clusters shift, split
 * and get renumbered. A confirmation the user made once must outlive all of
 * that.
 */

import { haversineMeters } from "./place-snap.js";

export interface PlaceConfirmation {
	lat: number;
	lon: number;
	/** How far from (lat, lon) a stay may sit and still take this label. */
	radiusM: number;
	label: string;
}

/**
 * The label the user has confirmed for a stay at this centroid, or null.
 *
 * When several confirmations are in range — a big building the user has named
 * more than once, overlapping radii — the NEAREST wins. Pure.
 */
export function confirmedLabelFor(
	lat: number,
	lon: number,
	confirmations: readonly PlaceConfirmation[],
): string | null {
	let best: PlaceConfirmation | null = null;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const c of confirmations) {
		const d = haversineMeters(lat, lon, c.lat, c.lon);
		if (d > c.radiusM) continue;
		if (d < bestDist) {
			bestDist = d;
			best = c;
		}
	}
	return best?.label ?? null;
}

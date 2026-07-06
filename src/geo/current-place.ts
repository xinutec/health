/**
 * "Which focus place is the user in right now" — a pure selector over the
 * user's mined `focus_places` and the latest location fix. Used by the internal
 * `/internal/place/current` endpoint (consumed by coach to auto-select a
 * training location).
 *
 * Unlike the long-stay gate (`owntracks-long-stay.ts`), this does NOT require a
 * multi-hour dwell: coach cares about any place the user has linked (a gym is a
 * ~1h visit, not a home/work long-stay). `focus_places` are already dwell
 * clusters (not drive-throughs), so nearest-within-radius is the right rule.
 * The radius (100 m) matches the long-stay gate — loose enough to absorb GPS
 * jitter at a centroid, tight enough not to catch the place next door.
 */

import { haversineMeters } from "./place-snap.js";

/** Presence radius around a focus-place centroid. Matches the long-stay gate. */
export const PRESENCE_RADIUS_M = 100;

export interface FocusPlaceForPresence {
	id: number;
	displayName: string | null;
	amenityLabel: string | null;
	centroidLat: number;
	centroidLon: number;
}

export interface CurrentFix {
	lat: number;
	lon: number;
}

export interface CurrentPlace {
	id: number;
	/** Best available human label: the auto Home/Work/Stay, else the OSM venue. */
	label: string;
	displayName: string | null;
	amenityLabel: string | null;
	centroid: { lat: number; lon: number };
	distanceM: number;
}

/** The nearest focus place whose centroid is within `PRESENCE_RADIUS_M` of the
 *  fix, or `null` if none. */
export function pickCurrentPlace(fix: CurrentFix, places: readonly FocusPlaceForPresence[]): CurrentPlace | null {
	let best: { p: FocusPlaceForPresence; d: number } | null = null;
	for (const p of places) {
		const d = haversineMeters(fix.lat, fix.lon, p.centroidLat, p.centroidLon);
		if (d > PRESENCE_RADIUS_M) continue;
		if (!best || d < best.d) best = { p, d };
	}
	if (!best) return null;
	const { p, d } = best;
	return {
		id: p.id,
		label: p.displayName ?? p.amenityLabel ?? "Place",
		displayName: p.displayName,
		amenityLabel: p.amenityLabel,
		centroid: { lat: p.centroidLat, lon: p.centroidLon },
		distanceM: Math.round(d),
	};
}

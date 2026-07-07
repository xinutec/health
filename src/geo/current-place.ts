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

import { STAY_DISPLAY_NAME } from "./focus-places.js";
import { haversineMeters } from "./place-snap.js";

/** Best human label for a focus place. A specific auto-name (Home/Work) wins;
 *  otherwise a mined venue name beats the generic "Stay"; otherwise "Place".
 *  (Without this, "Stay" would mask a perfectly good venue name.) */
export function placeLabel(displayName: string | null, amenityLabel: string | null): string {
	if (displayName !== null && displayName !== STAY_DISPLAY_NAME) return displayName;
	return amenityLabel ?? displayName ?? "Place";
}

/** Whether a place is recognisable in a picker: a specific Home/Work, or a
 *  mined venue name. A bare "Stay" (no venue) names no specific place, so
 *  several are indistinguishable — not worth offering. */
export function isNamedPlace(displayName: string | null, amenityLabel: string | null): boolean {
	return (displayName !== null && displayName !== STAY_DISPLAY_NAME) || amenityLabel !== null;
}

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
		label: placeLabel(p.displayName, p.amenityLabel),
		displayName: p.displayName,
		amenityLabel: p.amenityLabel,
		centroid: { lat: p.centroidLat, lon: p.centroidLon },
		distanceM: Math.round(d),
	};
}

/**
 * Magnetic place-snap: pull a noisy GPS fix to the centroid of a known
 * cluster (home, work, frequent café, ...) when the fix is within range,
 * unambiguous, and the GPS uncertainty is worse than how precisely we
 * know the place. Pure function — caller supplies the cluster list.
 *
 * Used to:
 *  - kill the cafe-next-door type of label flip when two named venues sit
 *    within GPS uncertainty of each other
 *  - stop overnight GPS drift from labelling your home as a nearby artwork
 *  - feed cleaner coordinates into segment classification and OSM lookup
 */

export interface KnownPlace {
	centroidLat: number;
	centroidLon: number;
	/** How precisely we know this centroid (defaults to 10 m if omitted). */
	radiusM?: number;
	/** Optional metadata — passed through unchanged for caller bookkeeping. */
	id?: string | number;
}

export interface SnapOptions {
	/** Maximum distance from a place to consider snapping. Default 75 m. */
	snapRadiusM: number;
	/** Don't snap fixes already more accurate than this many metres. Default 30 m. */
	minAccuracyToSnapM: number;
	/** Closest place must be at least this many times closer than the runner-up. Default 2.0. */
	ambiguityRatio: number;
}

const DEFAULTS: SnapOptions = {
	snapRadiusM: 75,
	minAccuracyToSnapM: 30,
	ambiguityRatio: 2.0,
};

export interface SnapInput {
	lat: number;
	lon: number;
	accuracy: number | null;
}

export interface SnapResult {
	lat: number;
	lon: number;
	accuracy: number | null;
	snapped: boolean;
	snappedTo?: KnownPlace;
	/** Distance to the snapped place in metres (when snapped). */
	snapDistanceM?: number;
}

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6371000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function snapToPlace(
	point: SnapInput,
	places: readonly KnownPlace[],
	opts: Partial<SnapOptions> = {},
): SnapResult {
	const o = { ...DEFAULTS, ...opts };

	// Trust very precise fixes — they're more accurate than our cluster
	// centroid would be anyway.
	if (point.accuracy !== null && point.accuracy < o.minAccuracyToSnapM) {
		return { lat: point.lat, lon: point.lon, accuracy: point.accuracy, snapped: false };
	}

	if (places.length === 0) {
		return { lat: point.lat, lon: point.lon, accuracy: point.accuracy, snapped: false };
	}

	const candidates = places
		.map((p) => ({ place: p, dist: haversineMeters(point.lat, point.lon, p.centroidLat, p.centroidLon) }))
		.filter((c) => c.dist <= o.snapRadiusM)
		.sort((a, b) => a.dist - b.dist);

	if (candidates.length === 0) {
		return { lat: point.lat, lon: point.lon, accuracy: point.accuracy, snapped: false };
	}

	// Ambiguity guard: if a runner-up is comparably close, the fix could plausibly
	// belong to either place. Don't pick.
	if (candidates.length >= 2 && candidates[1].dist < candidates[0].dist * o.ambiguityRatio) {
		return { lat: point.lat, lon: point.lon, accuracy: point.accuracy, snapped: false };
	}

	const winner = candidates[0];
	return {
		lat: winner.place.centroidLat,
		lon: winner.place.centroidLon,
		accuracy: winner.place.radiusM ?? 10,
		snapped: true,
		snappedTo: winner.place,
		snapDistanceM: winner.dist,
	};
}

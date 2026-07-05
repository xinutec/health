/**
 * Rail-vs-road proximity from OSM `nearbyWays` — the single source of
 * truth for "is this fix on the track or on a road".
 *
 * The velocity layer already uses this distinction per moving segment
 * (`computeRailRoadProximity` / `computeRoadNearestFraction`, #234) to
 * keep a road-following taxi off a parallel rail line. This module lifts
 * the same classification to a single fix, so the HSMM's per-minute
 * line-proximity factor can make the same call at decode time (#238) —
 * the decoder never credits a tube line to a fix that hugs a road.
 *
 * Pure given the `nearbyWays` results; the async helper is a thin loop
 * over an `OsmAdapter` so the caller can record/replay it through the
 * deterministic-fixtures adapter.
 */

import { median } from "../hmm/observation.js";
import type { FilteredPoint } from "./kalman.js";
import type { NearbyWay } from "./osm.js";
import type { OsmAdapter } from "./osm-adapter.js";
import { dateBoundsUtc } from "./timezone.js";

/** Rail-only OSM way subtypes — trams excluded (mixed-traffic track is
 *  not strong rail-vs-road evidence). Matches `velocity.ts`. */
export const RAIL_ONLY_SUBTYPES: ReadonlySet<string> = new Set(["rail", "subway", "light_rail", "narrow_gauge"]);

/** Drivable highway subtypes — residential through motorway plus
 *  track / living_street; pedestrian / cycle ways excluded. Matches the
 *  candidate generator's `DRIVEABLE_HIGHWAY_SUBTYPES` and `velocity.ts`. */
export const DRIVABLE_HIGHWAY_SUBTYPES: ReadonlySet<string> = new Set([
	"motorway",
	"trunk",
	"primary",
	"secondary",
	"tertiary",
	"residential",
	"service",
	"unclassified",
	"track",
	"living_street",
]);

/** Query radius (m) for the HSMM per-fix proximity. Wider than the
 *  line-proximity factor's NEAR_M (250) so that when a fix is "near"
 *  line L by the route graph, the rail way is also in range here and
 *  the road-vs-rail comparison is meaningful rather than null. */
export const PROXIMITY_RADIUS_M = 300;

/** Distance (m) from a fix to the nearest rail-only way and to the
 *  nearest drivable road, given that fix's `nearbyWays` list. Null for a
 *  kind with nothing in range. Pure. */
export function railRoadDistFromWays(ways: readonly NearbyWay[]): {
	railDistM: number | null;
	roadDistM: number | null;
} {
	let minRail = Number.POSITIVE_INFINITY;
	let minRoad = Number.POSITIVE_INFINITY;
	for (const w of ways) {
		const d = w.distanceM;
		if (d === null || d === undefined || !Number.isFinite(d)) continue;
		if (w.type === "railway" && RAIL_ONLY_SUBTYPES.has(w.subtype)) {
			if (d < minRail) minRail = d;
		} else if (w.type === "highway" && DRIVABLE_HIGHWAY_SUBTYPES.has(w.subtype)) {
			if (d < minRoad) minRoad = d;
		}
	}
	return {
		railDistM: Number.isFinite(minRail) ? minRail : null,
		roadDistM: Number.isFinite(minRoad) ? minRoad : null,
	};
}

/** Coarse-coordinate cache key (~11 m). Two minute-medians this close
 *  share a `nearbyWays` lookup — collapses a stationary day (hundreds of
 *  minutes at one place) to a single query, with no meaningful change to
 *  the rail-vs-road distances. */
function coordKey(lat: number, lon: number): string {
	return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

/** Rail/road proximity per minute, keyed by the minute's top-of-minute
 *  ts. For each local-day minute that has fixes, computes the median
 *  lat/lon (the same coordinate `buildObservationTensor` uses for
 *  `Observation.gps`) and one `nearbyWays` lookup there. One query per
 *  distinct ~11 m location — far fewer than one per fix, and the value is
 *  a coherent single-location pair (not a min mixed across fixes).
 *
 *  Used by the HSMM loader to populate `Observation.roadDistM` /
 *  `railDistM`. `points` should be the same outlier-dropped fixes the
 *  decode observes. */
export async function computeMinuteProximity(
	osm: OsmAdapter,
	date: string,
	tz: string,
	points: readonly FilteredPoint[],
): Promise<Map<number, { railDistM: number | null; roadDistM: number | null }>> {
	const { startUtc, endUtc } = dateBoundsUtc(date, tz);
	// Bucket fixes into their local-day minute (matching the observation
	// tensor): minute index m = floor((ts - startUtc) / 60).
	const byMinute = new Map<number, { lats: number[]; lons: number[] }>();
	for (const p of points) {
		if (p.ts < startUtc || p.ts >= endUtc) continue;
		const minuteTs = startUtc + Math.floor((p.ts - startUtc) / 60) * 60;
		let b = byMinute.get(minuteTs);
		if (b === undefined) {
			b = { lats: [], lons: [] };
			byMinute.set(minuteTs, b);
		}
		b.lats.push(p.lat);
		b.lons.push(p.lon);
	}

	const out = new Map<number, { railDistM: number | null; roadDistM: number | null }>();
	const coordCache = new Map<string, { railDistM: number | null; roadDistM: number | null }>();
	for (const [minuteTs, b] of byMinute) {
		const lat = median(b.lats);
		const lon = median(b.lons);
		const key = coordKey(lat, lon);
		let prox = coordCache.get(key);
		if (prox === undefined) {
			prox = railRoadDistFromWays(await osm.nearbyWays(lat, lon, PROXIMITY_RADIUS_M));
			coordCache.set(key, prox);
		}
		out.set(minuteTs, prox);
	}
	return out;
}

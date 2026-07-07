/**
 * Position-level eval — the "source of truth test" for *where the line is
 * drawn*, the measurement foundation Phase 0 of
 * `docs/proposals/geometry-roadmap.md` calls for.
 *
 * Every map-positioning change we made on 2026-06-21 was unmeasurable: we
 * could only eyeball screenshots. This module scores a drawn track against
 * two ground-truth-light signals that between them capture every failure we
 * chased — and crucially need no hand-labelled road truth, just the fixes'
 * own accuracy field and the OSM road geometry:
 *
 *   1. **cross-track to the reliable-GPS reference** — the perpendicular
 *      distance from each drawn vertex to the polyline of the *good-accuracy*
 *      raw fixes. A good estimate follows the reliable fixes; the ±80 m
 *      Kalman swing (drawn point 80 m off the reliable track) shows up as a
 *      large cross-track. Low is good.
 *   2. **distance to the nearest drivable road** — catches a line drawn
 *      across non-road (the "through the buildings" / corner-cut failure).
 *      Low is good.
 *
 * A faithful map-constrained estimate scores low on BOTH. The raw track
 * scores 0 on (1) only where every fix is reliable, and badly on (2) where
 * the GPS is off-road; the current Kalman-smoothed line is hurt on (1) by
 * outlier swings. So the two numbers, tracked per change, tell better from
 * worse — which a screenshot cannot.
 *
 * Pure: no DB, no network. Deterministic given its inputs.
 */

import { projectPointToSegment, type RoadGeometry } from "../geo/road-match.js";

export interface LatLon {
	lat: number;
	lon: number;
}

export interface ScoredFix extends LatLon {
	ts: number;
	accuracy: number | null;
}

/** Distribution summary of a per-vertex distance set (metres). */
export interface DistStats {
	n: number;
	median: number;
	p90: number;
	max: number;
	mean: number;
}

export interface PositioningScore {
	/** Drawn-vertex distance to the reliable-GPS reference polyline. */
	crossTrack: DistStats;
	/** Drawn-vertex distance to the nearest drivable road. */
	onRoad: DistStats;
}

/** Fixes above this accuracy (m) are too unreliable to anchor the reference
 *  polyline the drawn line is judged against. The 2026-06-21 ±80 m fix is
 *  exactly the kind this drops. */
export const DEFAULT_RELIABLE_ACC_M = 30;

function dist(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const dLat = (bLat - aLat) * 111_320;
	const dLon = (bLon - aLon) * 111_320 * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
}

/** Summarise a distance set: median, p90, max, mean. Empty → all zero. */
export function distStats(values: readonly number[]): DistStats {
	if (values.length === 0) return { n: 0, median: 0, p90: 0, max: 0, mean: 0 };
	const s = [...values].sort((a, b) => a - b);
	const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(s.length * p))];
	const mean = s.reduce((a, b) => a + b, 0) / s.length;
	return { n: s.length, median: q(0.5), p90: q(0.9), max: s[s.length - 1], mean };
}

/** The time-ordered polyline of fixes whose accuracy is at or under
 *  `maxAccM` — the best available proxy for where the user really was, used
 *  as the reference the drawn line is judged against. */
export function reliableReference(fixes: readonly ScoredFix[], maxAccM: number): LatLon[] {
	return fixes
		.filter((f) => (f.accuracy ?? Number.POSITIVE_INFINITY) <= maxAccM)
		.slice()
		.sort((a, b) => a.ts - b.ts)
		.map((f) => ({ lat: f.lat, lon: f.lon }));
}

/** Minimum perpendicular distance (m) from a point to a polyline; the
 *  endpoint distance for a single-vertex polyline; Infinity for empty. */
export function distToPolyline(p: LatLon, poly: readonly LatLon[]): number {
	if (poly.length === 0) return Number.POSITIVE_INFINITY;
	if (poly.length === 1) return dist(p.lat, p.lon, poly[0].lat, poly[0].lon);
	let best = Number.POSITIVE_INFINITY;
	for (let i = 1; i < poly.length; i++) {
		const d = projectPointToSegment(p, poly[i - 1], poly[i]).distM;
		if (d < best) best = d;
	}
	return best;
}

/** Minimum distance (m) from a point to any way in the road network. */
function distToRoads(p: LatLon, geo: RoadGeometry): number {
	let best = Number.POSITIVE_INFINITY;
	for (const w of geo.ways) {
		for (let i = 1; i < w.coords.length; i++) {
			const d = projectPointToSegment(
				p,
				{ lat: w.coords[i - 1][0], lon: w.coords[i - 1][1] },
				{ lat: w.coords[i][0], lon: w.coords[i][1] },
			).distM;
			if (d < best) best = d;
		}
	}
	return best;
}

/**
 * Score a drawn track: cross-track to the reliable-GPS reference and
 * distance to the nearest road, summarised over the drawn vertices.
 *
 * `drawn` is the rendered line (episode geometry); `fixes` the raw GPS for
 * this leg/day; `roads` the drivable network. `reliableAccM` sets which
 * fixes are trustworthy enough to form the reference.
 */
export function scorePositioning(
	drawn: readonly LatLon[],
	fixes: readonly ScoredFix[],
	roads: RoadGeometry,
	reliableAccM: number = DEFAULT_RELIABLE_ACC_M,
): PositioningScore {
	const ref = reliableReference(fixes, reliableAccM);
	const crossTrack = distStats(drawn.map((p) => distToPolyline(p, ref)).filter((d) => Number.isFinite(d)));
	const onRoad = distStats(drawn.map((p) => distToRoads(p, roads)).filter((d) => Number.isFinite(d)));
	return { crossTrack, onRoad };
}

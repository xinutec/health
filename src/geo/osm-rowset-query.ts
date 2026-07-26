/**
 * `queryPoints` / `queryLines` over a pushed row-set instead of over MariaDB.
 *
 * Step 3 of `docs/proposals/2026-07-osm-into-lean.md`. These are the TS twins
 * of `Verified.Geo.OsmSpatial` — same filters, same ordering, same cap — and
 * they return the same {@link LocalFeatureResult} shape the DB path returns, so
 * everything downstream in `osm.ts` is reused rather than reimplemented.
 *
 * # Where this deliberately differs from the SQL
 *
 * **The sphere.** MariaDB 12.3.2's `ST_Distance_Sphere` uses R = 6370986 m;
 * this uses 6371000, matching `FloatScore.haversineMeters` and the Lean kernel.
 * The two are 2.2 ppm apart, so a decision can only move for a feature within
 * `radius × 2.2e-6` of the bar — 0.22 mm at a 100 m radius, 0.9 mm at 400 m.
 * That is the one-time golden re-bless the proposal budgets for, and it is a
 * deliberate choice: under this design the DB no longer computes distances at
 * all, so Lean's constant becomes the definition rather than an approximation
 * of MariaDB's.
 *
 * **The MBR pre-filter is not modelled.** In SQL it exists to make the spatial
 * index usable. Its box is `[lat ± dDeg] × [lon ± dDeg]` with `dDeg = radius /
 * min(111000, 111000·cos lat)`, and BOTH scale factors understate the true
 * metres per degree, so the box strictly contains the radius circle and cannot
 * remove a row the distance test would keep. It is an accelerator, not a
 * predicate.
 *
 * # Where it does NOT differ, however tempting
 *
 * The line metric is PLANAR, in degree space, rescaled by a single
 * `mPerDeg = min(111000, 111000·cos lat)`. At London latitudes a degree of
 * longitude is ~62% of a degree of latitude and this metric ignores that
 * entirely, so a way lying due east scores ~1.6× too far. That is an
 * approximation the algorithm has always run on and the corpus was blessed
 * under it. Reproduced exactly. Fixing it would be a behaviour change, not a
 * port — and it belongs in its own commit with its own re-bless.
 */

import type { LocalFeatureResult } from "./osm-local.js";
import { METERS_PER_DEG_LAT, metersPerDegLon } from "./osm-local.js";
import type { OsmLineRow, OsmPointRow } from "./osm-rowset.js";

/** The sphere the Lean kernel adopts as the definition of distance. */
const EARTH_R = 6_371_000;

/** `SELECT … LIMIT 50` in both query builders. Never binds for the station and
 *  line lookups (at most 11 and 14 rows respectively across the corpus), but a
 *  cap that has never bound is still part of the function being defined. */
const ROW_LIMIT = 50;

/** Great-circle metres, the same formula `FloatScore.haversineMeters` uses. */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const toRad = (d: number) => (d * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
	return EARTH_R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** The single scale both axes are measured in — see the header. */
export function mPerDegAt(lat: number): number {
	return Math.min(METERS_PER_DEG_LAT, metersPerDegLon(lat));
}

/** Planar point-to-segment distance in degree space, x = lon and y = lat. */
function segDistDeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy;
	const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
	const qx = ax + t * dx;
	const qy = ay + t * dy;
	return Math.hypot(px - qx, py - qy);
}

/** `ST_Distance(linestring, point)` — the minimum over the way's segments,
 *  clamped at the endpoints, so a point beyond the end measures to the end. */
export function lineDistDeg(coords: ReadonlyArray<[number, number]>, lat: number, lon: number): number {
	if (coords.length === 0) return Number.POSITIVE_INFINITY;
	if (coords.length === 1) return Math.hypot(lon - coords[0][1], lat - coords[0][0]);
	let best = Number.POSITIVE_INFINITY;
	for (let i = 0; i + 1 < coords.length; i++) {
		const d = segDistDeg(lon, lat, coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0]);
		if (d < best) best = d;
	}
	return best;
}

/** `MBRContains(linestring, point)` — boundary-INCLUSIVE (confirmed on the
 *  live server: a point on the edge, on a corner, and on a degenerate
 *  zero-height bbox all return 1). */
export function mbrContainsPoint(coords: ReadonlyArray<[number, number]>, lat: number, lon: number): boolean {
	if (coords.length === 0) return false;
	let minLat = Number.POSITIVE_INFINITY;
	let maxLat = Number.NEGATIVE_INFINITY;
	let minLon = Number.POSITIVE_INFINITY;
	let maxLon = Number.NEGATIVE_INFINITY;
	for (const [la, lo] of coords) {
		if (la < minLat) minLat = la;
		if (la > maxLat) maxLat = la;
		if (lo < minLon) minLon = lo;
		if (lo > maxLon) maxLon = lo;
	}
	return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
}

/**
 * `queryPoints` over pushed rows: strictly inside the radius, of a wanted
 * subtype, ordered by distance, capped.
 *
 * The sort is by distance only. `Array.prototype.sort` is stable in V8, and the
 * rows arrive in the row-set's insertion order, so equal distances resolve the
 * same way every run — which matters because `dedupeStationsByName` reads the
 * first occurrence of a name.
 */
export function queryPointsFromRows(
	rows: readonly OsmPointRow[],
	lat: number,
	lon: number,
	radiusM: number,
	featureType: string,
	subtypes?: readonly string[],
): LocalFeatureResult[] {
	const out: LocalFeatureResult[] = [];
	for (const r of rows) {
		if (r.featureType !== featureType) continue;
		if (subtypes && subtypes.length > 0 && !(r.subtype !== null && subtypes.includes(r.subtype))) continue;
		const distanceM = haversineMeters(lat, lon, r.lat, r.lon);
		if (!(distanceM < radiusM)) continue;
		out.push({
			osm_id: r.osmId,
			osm_type: "node",
			subtype: r.subtype,
			name: r.name,
			distance_m: distanceM,
			lat: r.lat,
			lon: r.lon,
			// A point feature has no interior — it never encloses a stay.
			encloses: false,
			tags: r.tags,
		});
	}
	out.sort((a, b) => a.distance_m - b.distance_m);
	return out.slice(0, ROW_LIMIT);
}

/**
 * `queryLines` over pushed rows. The radius filter is in DEGREE space
 * (`< radiusM / mPerDeg`), matching the SQL, and the reported metres are that
 * degree distance rescaled by the same factor — so the anisotropy described in
 * the header is preserved end to end rather than half-corrected.
 */
export function queryLinesFromRows(
	rows: readonly OsmLineRow[],
	lat: number,
	lon: number,
	radiusM: number,
	featureType: string,
	subtypes?: readonly string[],
): LocalFeatureResult[] {
	const mPerDeg = mPerDegAt(lat);
	const dDeg = radiusM / mPerDeg;
	const scored: Array<{ r: OsmLineRow; distDeg: number; encloses: boolean }> = [];
	for (const r of rows) {
		if (r.featureType !== featureType) continue;
		if (subtypes && subtypes.length > 0 && !(r.subtype !== null && subtypes.includes(r.subtype))) continue;
		const distDeg = lineDistDeg(r.coords, lat, lon);
		if (!(distDeg < dDeg)) continue;
		scored.push({ r, distDeg, encloses: mbrContainsPoint(r.coords, lat, lon) });
	}
	scored.sort((a, b) => a.distDeg - b.distDeg);
	return scored.slice(0, ROW_LIMIT).map(({ r, distDeg, encloses }) => ({
		osm_id: r.osmId,
		osm_type: "way",
		subtype: r.subtype,
		name: r.name,
		distance_m: distDeg * mPerDeg,
		encloses,
		tags: r.tags,
	}));
}

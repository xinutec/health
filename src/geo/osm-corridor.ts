/**
 * Corridor road-geometry fetch — read the OSM ways along a GPS track by sampling
 * small discs down the track and unioning them, instead of one giant disc around
 * the track's centroid.
 *
 * Why: the mirror's spatial query cost grows super-linearly with the query box
 * (measured on prod: a 300 m box scans in ~0.2 s, a 4 km box in ~32 s — long road
 * LINESTRINGs have large, overlapping bounding boxes, so a big box drags the
 * R-tree into reading thousands of candidates). A long drive's centroid disc is
 * huge; the drive itself is a thin line. Sampling small discs along the line keeps
 * every query's box small (and local), so total cost is ~`samples × small`
 * instead of one pathological scan — an order of magnitude faster.
 *
 * Output-preserving vs the single disc: the union covers a continuous buffer
 * around the track wider than the matcher's reach (candidates ≤ 50 m off a fix,
 * routing penalised beyond the corridor), so every way the matcher could route
 * onto is still returned — only ways far off the track (which the corridor
 * penalty made unusable anyway) are dropped. The per-point query is the SAME
 * `OsmAdapter` call (`drivableRoads` / `walkableRoads`), so record/replay and the
 * golden fixtures work unchanged — just with several small keys per leg.
 */

import type { OsmRoadWay } from "./map-match-core.js";

interface LL {
	lat: number;
	lon: number;
}

function metersBetween(a: LL, b: LL): number {
	const dLat = (b.lat - a.lat) * 111_320;
	const dLon = (b.lon - a.lon) * 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
}

/**
 * Resample a polyline at ~`stepM` arc-length spacing. Always includes the first
 * and last vertex, so the corridor reaches both ends of the leg. Capped at
 * `maxSamples` points — a pathologically long leg widens its effective step
 * rather than firing hundreds of queries (the matcher bails honestly if the
 * coarser coverage leaves it under-connected).
 */
export function resamplePolyline(track: readonly LL[], stepM: number, maxSamples = 48): LL[] {
	if (track.length === 0) return [];
	if (track.length === 1) return [{ lat: track[0].lat, lon: track[0].lon }];

	let total = 0;
	for (let i = 1; i < track.length; i++) total += metersBetween(track[i - 1], track[i]);
	const step = Math.max(stepM, total / (maxSamples - 1));

	const out: LL[] = [{ lat: track[0].lat, lon: track[0].lon }];
	let acc = 0;
	let nextAt = step;
	for (let i = 1; i < track.length; i++) {
		const a = track[i - 1];
		const b = track[i];
		const segLen = metersBetween(a, b);
		if (segLen <= 0) continue;
		while (nextAt <= acc + segLen) {
			const t = (nextAt - acc) / segLen;
			out.push({ lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) });
			nextAt += step;
		}
		acc += segLen;
	}
	const last = track[track.length - 1];
	if (metersBetween(out[out.length - 1], last) > 1) out.push({ lat: last.lat, lon: last.lon });
	return out;
}

/**
 * Fetch the ways in a corridor around `track` by sampling discs every `stepM`
 * along it (each a `query(lat, lon, radiusM)` call) and unioning by `osmId`.
 * Queries run sequentially so a cold area's coverage fetch isn't fired in
 * parallel. `query` is `osm.drivableRoads` (roads) or `osm.walkableRoads` (walks).
 *
 * Sampling only pays off when the single centroid disc would be LARGE (and thus
 * a slow spatial scan). For a SHORT leg — every walk and short drive — one disc
 * is already small and fast, so sampling would just multiply the query count
 * (the bug that made walk-heavy days slow). So below {@link SINGLE_DISC_MAX_DIST_M}
 * (max fix-to-centroid distance) this does the single centroid disc instead.
 */
const SINGLE_DISC_MAX_DIST_M = 600;
const SINGLE_DISC_SLACK_M = 150;
export async function corridorWays(
	track: readonly LL[],
	query: (lat: number, lon: number, radiusM: number) => Promise<OsmRoadWay[]>,
	stepM: number,
	radiusM: number,
): Promise<OsmRoadWay[]> {
	if (track.length === 0) return [];

	// Centroid + the farthest fix from it: how big a single disc would need to be.
	let sumLat = 0;
	let sumLon = 0;
	for (const f of track) {
		sumLat += f.lat;
		sumLon += f.lon;
	}
	const cLat = sumLat / track.length;
	const cLon = sumLon / track.length;
	let maxDist = 0;
	for (const f of track) {
		const d = metersBetween({ lat: cLat, lon: cLon }, f);
		if (d > maxDist) maxDist = d;
	}
	// Short leg → one cheap disc (sampling would only add round-trips).
	if (maxDist <= SINGLE_DISC_MAX_DIST_M) {
		return query(cLat, cLon, Math.round(maxDist + SINGLE_DISC_SLACK_M));
	}

	// Long leg → corridor of small discs sampled down the track, unioned.
	const samples = resamplePolyline(track, stepM);
	const byId = new Map<number, OsmRoadWay>();
	for (const s of samples) {
		for (const w of await query(s.lat, s.lon, radiusM)) {
			if (!byId.has(w.osmId)) byId.set(w.osmId, w);
		}
	}
	return [...byId.values()];
}

/**
 * Walk-level eval — the measurement foundation (Phase 0) of
 * `docs/design/episode-geometry.md`.
 *
 * Scores a drawn walking line against signals that need no hand-labelled
 * truth, capturing the failures the smoother must fix:
 *
 *   1. **tortuosity** — drawn path length ÷ straight-line end-to-end. GPS
 *      jitter inflates it (measured 2.7× on the 2026-06-21 walks); a faithful
 *      walk is near 1 for a straight stroll, modestly above for a real detour.
 *   2. **step-distance error** — |drawn length − pedometer distance| as a
 *      fraction of the pedometer distance. The pedometer measures distance
 *      independently of GPS, so this is the closest thing to physical truth:
 *      a good estimate's length matches the steps.
 *   3. **off-walkable** — mean distance from the drawn vertices to the nearest
 *      walkable way (only meaningful where a path is nearby; open ground is
 *      excluded, mirroring the smoother's openness gate).
 *
 * Pure: no DB, no network. Deterministic given its inputs.
 */

import type { RoadGeometry } from "../geo/road-match.js";

/** Per-minute step count (Fitbit `steps_intraday` shape). */
export interface PedStep {
	ts: number;
	steps: number;
}

export interface LatLon {
	lat: number;
	lon: number;
}

export interface WalkScore {
	/** Drawn length ÷ straight-line distance (≥1). Lower is tighter. */
	tortuosity: number;
	/** Drawn length (m). */
	drawnLengthM: number;
	/** Pedometer distance (m) over the leg, or null if no steps. */
	pedometerM: number | null;
	/** |drawn − pedometer| / pedometer, or null if no steps. Lower is better. */
	stepDistanceError: number | null;
	/** Mean distance (m) from a drawn vertex to the nearest NEARBY walkable way
	 *  (within the openness radius); null if no path is ever near. */
	offWalkableMeanM: number | null;
	/** p90 distance (m) of the drawn LINE to the nearest walkable way, sampled
	 *  along the chords (not just vertices) and WITHOUT the openness exclusion —
	 *  so a chord cutting deep across a block is counted, not filtered out. This
	 *  is the metric that captures "the line crosses buildings", which the vertex
	 *  mean misses; null if there is no walkable way at all. */
	offWalkableP90M: number | null;
}

function metersBetween(a: LatLon, b: LatLon): number {
	const dLat = (b.lat - a.lat) * 111_320;
	const dLon = (b.lon - a.lon) * 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
}

export function pathLength(pts: readonly LatLon[]): number {
	let t = 0;
	for (let i = 1; i < pts.length; i++) t += metersBetween(pts[i - 1], pts[i]);
	return t;
}

/** Total steps overlapping [from, to), distributing per-minute counts by time
 *  overlap (steps rows are per-minute; a window may be sub-minute). */
export function pedometerDistanceM(steps: readonly PedStep[], from: number, to: number, strideM = 0.72): number {
	if (to <= from) return 0;
	let n = 0;
	for (const s of steps) {
		const lo = Math.max(from, s.ts);
		const hi = Math.min(to, s.ts + 60);
		if (hi > lo) n += s.steps * ((hi - lo) / 60);
	}
	return n * strideM;
}

function distToNearestWay(p: LatLon, roads: RoadGeometry): number {
	let best = Number.POSITIVE_INFINITY;
	for (const w of roads.ways) {
		for (let i = 1; i < w.coords.length; i++) {
			const a = { lat: w.coords[i - 1][0], lon: w.coords[i - 1][1] };
			const b = { lat: w.coords[i][0], lon: w.coords[i][1] };
			// planar point-to-segment in metres
			const ax = 0;
			const ay = 0;
			const cosLat = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
			const bx = (b.lon - a.lon) * 111_320 * cosLat;
			const by = (b.lat - a.lat) * 111_320;
			const px = (p.lon - a.lon) * 111_320 * cosLat;
			const py = (p.lat - a.lat) * 111_320;
			const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
			const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len2));
			const qx = ax + t * (bx - ax);
			const qy = ay + t * (by - ay);
			const d = Math.hypot(px - qx, py - qy);
			if (d < best) best = d;
		}
	}
	return best;
}

/**
 * Score a drawn walk. `drawn` is the rendered line; `startTs`/`endTs` the leg
 * window; `steps` the per-minute pedometer; `walkable` the pedestrian network
 * (omit to skip the off-walkable metric). `opennessRadiusM` excludes vertices
 * with no nearby path (open ground) from the off-walkable mean.
 */
export function scoreWalk(
	drawn: readonly LatLon[],
	startTs: number,
	endTs: number,
	steps: readonly PedStep[] = [],
	walkable: RoadGeometry | null = null,
	strideM = 0.72,
	opennessRadiusM = 35,
): WalkScore {
	const drawnLengthM = pathLength(drawn);
	const straight = drawn.length >= 2 ? metersBetween(drawn[0], drawn[drawn.length - 1]) : 0;
	const tortuosity = straight > 1 ? drawnLengthM / straight : 1;

	const ped = steps.length > 0 ? pedometerDistanceM(steps, startTs, endTs, strideM) : null;
	const stepDistanceError = ped && ped > 1 ? Math.abs(drawnLengthM - ped) / ped : null;

	let offWalkableMeanM: number | null = null;
	let offWalkableP90M: number | null = null;
	if (walkable && walkable.ways.length > 0) {
		const near = drawn.map((p) => distToNearestWay(p, walkable)).filter((d) => d <= opennessRadiusM);
		offWalkableMeanM = near.length > 0 ? near.reduce((a, b) => a + b, 0) / near.length : null;
		offWalkableP90M = offWalkableQuantile(drawn, walkable, 0.9);
	}

	return { tortuosity, drawnLengthM, pedometerM: ped, stepDistanceError, offWalkableMeanM, offWalkableP90M };
}

/** The `q`-quantile (0–1) of the drawn LINE's distance to the nearest walkable
 *  way, sampled every `stepM` along the chords as well as at the vertices, with
 *  NO openness exclusion. Vertex-mean misses two things this catches: the chord
 *  excursions the map actually draws, and the far points the openness gate drops
 *  — exactly the deep building cuts. p90 (not max) ignores a single GPS spike. */
function offWalkableQuantile(drawn: readonly LatLon[], walkable: RoadGeometry, q: number, stepM = 5): number | null {
	if (drawn.length === 0) return null;
	const samples: number[] = [];
	const consider = (p: LatLon): void => {
		samples.push(distToNearestWay(p, walkable));
	};
	for (let i = 0; i < drawn.length; i++) {
		consider(drawn[i]);
		if (i + 1 < drawn.length) {
			const a = drawn[i];
			const b = drawn[i + 1];
			const chord = metersBetween(a, b);
			const n = Math.floor(chord / stepM);
			for (let k = 1; k < n; k++) {
				consider({ lat: a.lat + ((b.lat - a.lat) * k) / n, lon: a.lon + ((b.lon - a.lon) * k) / n });
			}
		}
	}
	if (samples.length === 0) return null;
	samples.sort((x, y) => x - y);
	return samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
}

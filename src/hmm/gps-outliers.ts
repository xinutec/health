/**
 * HMM-specific outlier filter on GPS fixes.
 *
 * The pre-existing `qualityFilterGps` (anchor-walk with bridge-back
 * detection) is sound for the velocity pipeline — it preserves
 * sustained-motion fixes (plane / high-speed rail) by design. But for
 * HMM emission scoring, isolated unreachable fixes that have no bridge
 * back are kept "as best-effort fallback," and the HMM faithfully
 * follows them — manifesting as overnight place-bouncing through
 * distant focus_places (stale buffered fixes, cellular triangulation
 * errors, etc.).
 *
 * This filter is a robust statistics pass: for each candidate fix,
 * compute the median position over a recent time window; drop the fix
 * if it falls outside `MAX_DEVIATION_M` of the cluster centre. The
 * median is robust to occasional outliers — a few rogue fixes don't
 * shift the centre, so they get rejected and the cluster stays anchored
 * to the user's true location.
 *
 * For real sustained motion (plane / train), the median moves with
 * the user across the window, so the filter doesn't reject legitimate
 * travel — only isolated jumps that the cluster median refuses to
 * follow.
 *
 * Pure function. Operates on the FilteredPoint stream that
 * buildObservationTensor consumes.
 */

import type { FilteredPoint } from "../geo/kalman.js";

/** Time window (seconds) over which the cluster median is computed.
 *  30 minutes is long enough to anchor against transient rogue fixes
 *  but short enough that real motion can drag the cluster along. */
const WINDOW_S = 30 * 60;

/** Max plausible deviation (metres) from the cluster median. 2km
 *  comfortably covers Owntracks indoor GPS noise (hundreds of metres)
 *  plus a real walking speed × half-window cushion, but is far short
 *  of the typical rogue-fix distance (50km+ for stale-buffer fixes
 *  reporting hotel coords from past trips). */
const MAX_DEVIATION_M = 2_000;

/** Minimum cluster size to apply the filter. Below this, the cluster
 *  is too small to reliably distinguish outliers from real motion — let
 *  the candidate through. */
const MIN_CLUSTER_SIZE = 5;

const M_PER_DEG_LAT = 111_320;

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function approxDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	// Equirectangular approximation — fine at the city scale we filter at.
	const dLatM = (lat2 - lat1) * M_PER_DEG_LAT;
	const dLonM = (lon2 - lon1) * M_PER_DEG_LAT * Math.cos((lat1 * Math.PI) / 180);
	return Math.sqrt(dLatM * dLatM + dLonM * dLonM);
}

/**
 * Drop fixes that fall outside `MAX_DEVIATION_M` of their recent
 * cluster median. Preserves all other fixes in input order.
 *
 * The cluster window is centred on the candidate fix (look both
 * forward and backward in time) so that the very first / last fixes
 * of a long stay are evaluated against the same neighbours as the
 * middle of the stay.
 */
export function dropGpsOutliers(points: readonly FilteredPoint[]): FilteredPoint[] {
	if (points.length < MIN_CLUSTER_SIZE) return [...points];
	const out: FilteredPoint[] = [];
	// Sliding window via two indices.
	let lo = 0;
	let hi = 0;
	for (let i = 0; i < points.length; i++) {
		const p = points[i];
		// Move lo and hi to cover [p.ts - WINDOW_S, p.ts + WINDOW_S].
		while (lo < points.length && points[lo].ts < p.ts - WINDOW_S) lo++;
		while (hi < points.length && points[hi].ts <= p.ts + WINDOW_S) hi++;
		const cluster = points.slice(lo, hi);
		if (cluster.length < MIN_CLUSTER_SIZE) {
			out.push(p);
			continue;
		}
		const medLat = median(cluster.map((c) => c.lat));
		const medLon = median(cluster.map((c) => c.lon));
		const dev = approxDistanceMeters(p.lat, p.lon, medLat, medLon);
		if (dev <= MAX_DEVIATION_M) out.push(p);
		// else: drop — the cluster median says you're somewhere else.
	}
	return out;
}

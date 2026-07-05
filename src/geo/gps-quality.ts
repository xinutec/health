/**
 * GPS quality-control pre-filter.
 *
 * Runs before the Kalman filter. Its job is *quality control* — deciding
 * which raw fixes are real — kept strictly separate from *smoothing*
 * (the Kalman filter) and *gap handling* (`inferTransitGaps`).
 *
 * Why it exists: underground (tube, deep buildings) the phone falls back
 * to cell-tower triangulation and emits positions that are wrong, not
 * just noisy — teleporting kilometres and back within seconds. No
 * smoothing filter recovers a true trajectory from that; the information
 * isn't there. The honest move is to discard the incoherent run and let
 * downstream gap-inference treat the tunnel as missing data (which it
 * already does for above-ground GPS gaps).
 *
 * Algorithm — anchor walk:
 *   - Keep an "anchor": the last fix accepted as real.
 *   - A candidate fix reachable from the anchor at a plausible speed
 *     (<= SPEED_CEILING_KMH) is kept and becomes the new anchor.
 *   - A candidate that is NOT reachable starts a suspected garbage run.
 *     Scan forward for the first later fix that IS reachable from the
 *     anchor — that's the surfacing point. Drop everything between.
 *   - If no bridge exists within BRIDGE_WINDOW_S, the run is genuine
 *     sustained fast travel (plane, high-speed rail): a garbage spike
 *     always has a return fix reachable from the pre-spike anchor,
 *     whereas a plane keeps moving away. Keep the fix and trust it.
 *
 * Magnitude alone cannot separate garbage from a plane — a 480 km/h
 * teleport is *slower* than an 800 km/h plane. Coherence is the
 * separator, and the bridge scan is how this filter tests it: garbage
 * is a detour (there's a reachable fix on the far side); fast travel
 * is not.
 */

import type { GpsPoint } from "./kalman.js";

/** Max plausible point-to-point speed for a fix to count as "reachable"
 *  from the anchor. Covers every ground mode the data realistically
 *  contains — urban driving, motorway, conventional rail (~120 km/h).
 *  High-speed rail and aircraft exceed it; those fall through to the
 *  no-bridge "keep" path, which is correct (they're coherent travel). */
const SPEED_CEILING_KMH = 150;

/** How far ahead to scan for a bridge fix. A garbage run longer than
 *  this (a very long tube journey with no usable GPS the whole way)
 *  exhausts the scan; the fix is then kept as a best-effort fallback.
 *  30 min comfortably covers a typical underground interchange. */
const BRIDGE_WINDOW_S = 30 * 60;

/** Accuracy (m) above which a fix is cell-tower-grade — a position that is
 *  *wrong*, not just noisy. Underground the phone falls back to tower
 *  triangulation and reports tens-to-hundreds of metres of error. Good
 *  open-sky / assisted fixes sit well under this; the user's clean walking and
 *  driving tracks report single-digit to ~40 m. */
const ACCURACY_CEILING_M = 80;

/** Min implied speed (km/h) for a poor-accuracy fix to even be *considered* the
 *  underground signature rather than stationary jitter. Above brisk walking. */
const GARBAGE_MIN_SPEED_KMH = 15;

/** Min net displacement (m) from anchor to surfacing-bridge for a poor-accuracy
 *  run to be dropped as tube transit. Per-hop speed alone cannot tell directional
 *  transit (a tube ride leaves the anchor and arrives a station away — London
 *  inter-station hops are ~1–2 km) from oscillating jitter that never goes
 *  anywhere (a poor-GPS indoor stay, or a platform-to-platform interchange walk,
 *  both net < a few hundred m). Only a run that actually *travels* is dropped;
 *  a run that returns near its anchor is kept and Kalman-smoothed. This is what
 *  protects an indoor hospital stay and a short interchange walk from being
 *  erased while still dropping the H&I→Baker Street tunnel. */
const MIN_TRANSIT_DISPLACEMENT_M = 800;

function distanceM(a: GpsPoint, b: GpsPoint): number {
	const dLatM = (b.lat - a.lat) * 111_320;
	const dLonM = (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
	return Math.sqrt(dLatM ** 2 + dLonM ** 2);
}

/** A teleport: unreachable from the anchor at any plausible ground speed. Always
 *  garbage regardless of accuracy (the existing coherence test). */
function speedUnreachable(anchor: GpsPoint, cand: GpsPoint): boolean {
	return impliedSpeedKmh(anchor, cand) > SPEED_CEILING_KMH;
}

/** Cell-tower-grade *movement*: a poor-accuracy fix that has also moved at
 *  non-pedestrian speed — the underground tube signature the pure speed test
 *  misses (tube hops between tower fixes land under the 150 km/h ceiling).
 *  Whether such a run is actually dropped is gated on net displacement, so
 *  stationary jitter at the same accuracy is preserved. */
function inaccurateMotion(anchor: GpsPoint, cand: GpsPoint): boolean {
	return (
		cand.accuracy !== null &&
		cand.accuracy > ACCURACY_CEILING_M &&
		impliedSpeedKmh(anchor, cand) > GARBAGE_MIN_SPEED_KMH
	);
}

/** Either flavour of garbage — used by the bridge scan to skip over candidates
 *  that cannot anchor the surviving track. */
function isGarbage(anchor: GpsPoint, cand: GpsPoint): boolean {
	return speedUnreachable(anchor, cand) || inaccurateMotion(anchor, cand);
}

/** A fix usable as an anchor / bridge: its position is trustworthy enough to
 *  reason from. Poor-accuracy fixes never become anchors, so a dropped tunnel
 *  run cannot be "bridged" onto another garbage fix. */
function trustworthy(p: GpsPoint): boolean {
	return p.accuracy === null || p.accuracy <= ACCURACY_CEILING_M;
}

function impliedSpeedKmh(a: GpsPoint, b: GpsPoint): number {
	const dt = b.ts - a.ts;
	if (dt <= 0) return 0; // duplicate / out-of-order ts: treat as reachable
	return (distanceM(a, b) / dt) * 3.6;
}

/**
 * Drop physically-incoherent runs of GPS fixes (underground / cell-tower
 * garbage). Returns the surviving fixes in input order; dropped fixes
 * leave an honest temporal gap for downstream gap-inference.
 */
export function qualityFilterGps(points: GpsPoint[]): GpsPoint[] {
	if (points.length <= 2) return points;

	const kept: GpsPoint[] = [points[0]];
	let i = 1;
	while (i < points.length) {
		const anchor = kept[kept.length - 1];
		const cand = points[i];

		if (!isGarbage(anchor, cand)) {
			kept.push(cand);
			i++;
			continue;
		}

		// `cand` is garbage (a teleport, or a poor-accuracy fix that has
		// moved). Scan forward for the surfacing point on the far side of the
		// run. A valid bridge must be reachable from the anchor, a trustworthy
		// (good-accuracy) position itself — never bridge onto more garbage — AND
		// the start of a coherent run (its own successor reachable from it),
		// otherwise a fix that is *coincidentally* reachable (enough elapsed time
		// that the average speed looks plausible) would be mistaken for the
		// surfacing point.
		let bridge = -1;
		for (let j = i + 1; j < points.length && points[j].ts - anchor.ts <= BRIDGE_WINDOW_S; j++) {
			if (isGarbage(anchor, points[j]) || !trustworthy(points[j])) continue;
			const coherentSuccessor =
				j + 1 >= points.length || impliedSpeedKmh(points[j], points[j + 1]) <= SPEED_CEILING_KMH;
			if (coherentSuccessor) {
				bridge = j;
				break;
			}
		}

		// A bridge alone is not enough to drop a poor-accuracy run: it must also
		// have *travelled*. A teleport (speed-unreachable) is always dropped, but
		// inaccurate jitter that surfaces back near its anchor — an indoor stay or
		// a platform interchange — is kept, not erased. Only a run whose surfacing
		// point is a real distance away is tube transit.
		const travelled = bridge >= 0 && distanceM(anchor, points[bridge]) > MIN_TRANSIT_DISPLACEMENT_M;
		if (bridge >= 0 && (speedUnreachable(anchor, cand) || travelled)) {
			// points[i .. bridge-1] are a garbage run — drop them.
			kept.push(points[bridge]);
			i = bridge + 1;
		} else {
			// No bridge (sustained fast travel), or a non-travelling poor-accuracy
			// run (jitter at a stay / short walk). Keep the fix.
			kept.push(cand);
			i++;
		}
	}
	return kept;
}

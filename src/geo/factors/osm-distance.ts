/**
 * osm-distance factor.
 *
 * Scores each candidate by how close its chosen OSM way is to the
 * GPS trajectory. Different candidates point at different ways (a
 * "train on Tube line X" candidate looks at distance to a rail
 * polyline; a "driving on road Y" candidate looks at distance to a
 * highway polyline) — so the distance lives ON the candidate, set
 * by the candidate generator.
 *
 * This factor absorbs today's rule-cascade fixes:
 *
 *   - distance-aware rail-vs-road tie-break: when both train and
 *     driving candidates are available, the closer one wins via the
 *     factor sum.
 *   - driveable-vs-footway preference: combined with mode-coherence,
 *     a closer footway gets penalised when the segment is clearly
 *     vehicular.
 *
 * Mathematical shape: `-log(max(distance, MIN_M) / REF_M)` in nats.
 *
 *   - At REF_M (25m), score is 0 — the "expected" GPS-to-feature
 *     offset given typical urban GPS noise (median fix-to-way
 *     distance in production data sits around 15-25m; 25m is
 *     calibrated so the no-way fallback candidate (osm-distance =
 *     null = 0) is a fair tie with a way-attached candidate at
 *     typical urban distance, rather than the asymmetric free pass
 *     the original 10m REF gave it). Empirical derivation from the
 *     user's own fix-to-way distribution is a future calibration
 *     task; 25m is a defensible interim default for urban GPS.
 *   - Closer than REF_M gives a small positive bonus.
 *   - The MIN_M floor (1m) prevents distance=0 from producing
 *     `+Infinity` and dominating the candidate's total score.
 *   - Logarithmic falloff: doubling distance subtracts ~0.69 nats.
 *     A way-attached candidate at 100m loses ~1.4 nats relative to
 *     one at 25m, significant but not annihilating.
 *
 * The 25m calibration is what makes way-presence-the-factor
 * unnecessary: under 10m REF, every way-attached candidate at >10m
 * was strictly worse than the no-way fallback (which scored 0), so
 * a separate way-presence factor was needed to give the way-attached
 * candidate a constant bonus. Under 25m REF the comparison is fair
 * directly and the patch comes off. See task #182.
 */

import type { Factor } from "./types.js";

const REFERENCE_DISTANCE_M = 25;
const MIN_DISTANCE_M = 1;

export const osmDistance: Factor = (candidate, _ctx) => {
	const d = candidate.wayDistanceM;
	if (d === undefined || d === null || !Number.isFinite(d)) return null;
	const clamped = Math.max(d, MIN_DISTANCE_M);
	const score = -Math.log(clamped / REFERENCE_DISTANCE_M);
	return {
		name: "osm-distance",
		score,
		rationale: rationaleFor(candidate.wayName, d),
	};
};

function rationaleFor(wayName: string | undefined, distance: number): string {
	const what = wayName ?? "way";
	if (distance < 5) return `essentially on ${what} (${Math.round(distance)}m)`;
	if (distance < 30) return `near ${what} (${Math.round(distance)}m)`;
	return `${Math.round(distance)}m from ${what}`;
}

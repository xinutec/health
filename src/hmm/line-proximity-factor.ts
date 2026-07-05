/**
 * Per-line GPS-distance factor.
 *
 * Complements `route-rail-evidence` (which fires only at GPS-NULL
 * minutes during a tube tunnel gap). This factor fires at
 * GPS-PRESENT minutes, scoring `train @ L` by whether the observed
 * GPS fix sits on L's track corridor in the route graph.
 *
 * Why both:
 *   - Route-rail-evidence: structural — "are the bookends near
 *     underground L?" Catches tube rides during the GPS gap.
 *   - Line-proximity-factor: continuous — "is THIS minute's fix
 *     near L's track?" Catches everything else (surface rail, the
 *     GPS-present minutes inside a tube ride, mode-continuation
 *     errors where HSMM stays on the wrong line because per-minute
 *     evidence doesn't discriminate).
 *
 * Decision shape per minute:
 *   - L not present in the graph at all: 0 (we don't punish a line
 *     we can't see)
 *   - L's edges within NEAR_M of GPS: boost (+)
 *   - L modeled but NOT within NEAR_M: penalty (−)
 *
 * The earlier two-radius design (NEAR_M / FAR_M) left a dead zone
 * between 250m and 1000m. At urban interchanges that dead zone
 * covered the wrong-line case — e.g. Bond St mid-Jubilee-ride sees
 * Met track ~600m north (on Marylebone Rd) and so paid no penalty
 * for staying on a wrong Met segment. Collapsing to a single tight
 * radius forces a per-minute verdict.
 *
 * Pure with respect to the route graph; per-minute cache keyed off
 * coarse GPS coords.
 */

import type { RouteGraph } from "../geo/route-graph.js";
import type { Observation } from "./observation.js";
import type { State } from "./state-space.js";

export interface BuildLineProximityFactorOpts {
	routeGraph: RouteGraph;
	/** When set, this factor yields (returns 0) for `train` states on
	 *  minutes the train generator covers — the per-segment generator entry
	 *  prior owns line attribution there, so scoring it per-minute too would
	 *  double-count. Off-window the factor is unchanged. See
	 *  `train-generator-prior.ts`. */
	isCovered?: (ts: number) => boolean;
}

export type LineProximityFactorFn = (state: State, obs: Observation) => number;

/** Single proximity radius: L edges within this distance of the GPS
 *  fix count as "on track" and earn the boost; otherwise (provided
 *  L is modeled in the graph somewhere) earn the penalty. 250m
 *  absorbs GPS noise + the vertical-projection of an underground
 *  line that runs ~150m beneath the street. */
const NEAR_M = 250;

/** Boost when GPS sits on L's track. Calibrated so a 4-5 minute
 *  ride on the right line beats the per-minute cross-state
 *  transition cost (~5 nats) of switching away from a wrong line
 *  HSMM is continuing by inertia. */
const NEAR_BOOST = 1.5;

/** Penalty when L is modeled but GPS is not near any L edge.
 *  Larger than the boost — actively pushes HSMM out of a wrong-line
 *  continuation rather than just discouraging entry. */
const FAR_PENALTY = -2.5;

/** Penalty when L's track IS within `NEAR_M` of the fix BUT the fix sits
 *  nearer a drivable road than any rail — the fix is road-following, so
 *  it's evidence the user is driving past L's corridor, not riding it.
 *  This is the per-minute analogue of the velocity layer's road-vs-rail
 *  weighing (`computeRoadNearestFraction`, #234) that keeps a central-
 *  London taxi off the Circle Line. Weighted, not a veto: a real train
 *  whose fixes hug the track (rail nearer than road) is unaffected.
 *
 *  Same magnitude as `FAR_PENALTY` — being demonstrably on a road is at
 *  least as much evidence against riding L as being far from L. */
const ROAD_NEARER_PENALTY = -2.5;

/**
 * Per-minute line-proximity score for a `train @ L` state. Pure decision
 * over the proximity facts; the builder supplies them from the route
 * graph + (optionally) the observation's road/rail distances.
 *
 *   - L not modeled anywhere in the graph → 0 (don't punish an unseen line).
 *   - L's track near the fix, and NOT road-nearer → `NEAR_BOOST`.
 *   - L's track near the fix, but the fix is road-nearer → `ROAD_NEARER_PENALTY`.
 *   - L modeled but its track is not near the fix → `FAR_PENALTY`.
 *
 * `roadDistM` / `railDistM` are the fix's distance to the nearest drivable
 * road / nearest rail (any line), or null when no proximity data was
 * captured for this minute — in which case the road-vs-rail test is
 * skipped and the original near/far behaviour stands (backward
 * compatible with fixtures decoded before road proximity existed).
 */
export function scoreLineProximity(opts: {
	lineModeled: boolean;
	lineNear: boolean;
	roadDistM: number | null | undefined;
	railDistM: number | null | undefined;
}): number {
	if (!opts.lineModeled) return 0;
	if (!opts.lineNear) return FAR_PENALTY;
	const { roadDistM, railDistM } = opts;
	if (roadDistM != null && railDistM != null && roadDistM < railDistM) {
		return ROAD_NEARER_PENALTY;
	}
	return NEAR_BOOST;
}

function fixCacheKey(lat: number, lon: number): string {
	return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

/** Lines for which the route graph has at least one edge within
 *  the given radius of the fix. */
function linesWithinRadius(routeGraph: RouteGraph, lat: number, lon: number, radiusM: number): Set<string> {
	const lines = new Set<string>();
	for (const edge of routeGraph.edgesNear(lat, lon, radiusM)) {
		for (const line of edge.attrs.lineMemberships) lines.add(line);
	}
	return lines;
}

/** Set of every line that appears anywhere in the route graph.
 *  Used to gate the penalty: don't punish a line the graph doesn't
 *  model. */
function linesInGraph(routeGraph: RouteGraph): Set<string> {
	const lines = new Set<string>();
	for (const edge of routeGraph.edges.values()) {
		for (const line of edge.attrs.lineMemberships) lines.add(line);
	}
	return lines;
}

export function buildLineProximityFactor(opts: BuildLineProximityFactorOpts): LineProximityFactorFn {
	const routeGraph = opts.routeGraph;
	const isCovered = opts.isCovered;
	const cache = new Map<string, ReadonlySet<string>>();
	const modeledLines = linesInGraph(routeGraph);

	function nearAt(lat: number, lon: number): ReadonlySet<string> {
		const key = fixCacheKey(lat, lon);
		let v = cache.get(key);
		if (v === undefined) {
			v = linesWithinRadius(routeGraph, lat, lon, NEAR_M);
			cache.set(key, v);
		}
		return v;
	}

	return (state: State, obs: Observation): number => {
		if (state.mode !== "train") return 0;
		if (isCovered?.(obs.ts)) return 0; // generator entry prior owns line here
		if (state.lineName === null) return 0;
		if (state.lineName === "unknown_rail") {
			// `unknown_rail` is rail of an undetermined line — we can't score
			// line proximity, but it must still be ON rail. A road vehicle (bus /
			// taxi) moving faster than walking otherwise settles on
			// `train @ unknown_rail` (cheapest rail state, no line factors, and
			// the mode prior favours train over driving). Penalise it ONLY when
			// the fix is demonstrably road-nearer-than-rail — the line-agnostic
			// form of the per-line road-vs-rail signal (#234). Never fires on
			// GPS-null (a real underground ride) or rail-nearer fixes (real
			// surface rail), so it can't harm a genuine unknown-line ride.
			if (obs.gps === null) return 0;
			if (obs.roadDistM != null && obs.railDistM != null && obs.roadDistM < obs.railDistM) {
				return ROAD_NEARER_PENALTY;
			}
			return 0;
		}
		if (obs.gps === null) return 0;
		const line = state.lineName;

		const near = nearAt(obs.gps.lat, obs.gps.lon);
		return scoreLineProximity({
			lineModeled: modeledLines.has(line),
			lineNear: near.has(line),
			roadDistM: obs.roadDistM,
			railDistM: obs.railDistM,
		});
	};
}

/**
 * Road map-matching — draw a road-vehicle leg on the streets it drove, not as
 * the raw GPS zigzag through the buildings between them.
 *
 * This is now a thin adapter over the shared {@link matchTrajectory} core
 * (`map-match-core.ts`): it supplies {@link ROAD_PROFILE} — the original road
 * tuning, unchanged — and re-exports the mode-agnostic types and display gate so
 * existing callers (`road-match-annotate.ts`, the eval/score CLIs, the tests)
 * keep their imports. The pedestrian matcher (`pedestrian-match.ts`) is the
 * sibling that supplies `WALK_PROFILE`.
 *
 * See `map-match-core.ts` for the Newson-Krumm HMM algorithm and the honest
 * `null` ("draw the raw fixes") fallback.
 */

import {
	type MatchProfile,
	type MatchResult,
	matchTrajectory,
	type RoadFix,
	type RoadGeometry,
} from "./map-match-core.js";

// Re-export the shared types + display gate so existing road-match importers are
// unaffected by the core extraction.
export {
	type DisplayMatchDecision,
	fractionOffRoad,
	type MatchedPoint,
	matchImprovesDisplay,
	maxPolylineOffRoad,
	type OsmRoadWay,
	projectPointToSegment,
	quantilePointDistToPolyline,
	type RoadFix,
	type RoadGeometry,
} from "./map-match-core.js";

/** Result of a road match — the leg routed onto the streets. */
export type RoadMatchResult = MatchResult;

export interface RoadMatchOpts {
	/** Max snap distance (m) for a fix to a road segment to be a candidate. */
	matchRadiusM?: number;
}

/**
 * Road tuning for the shared matcher — the exact constants the road matcher
 * shipped with. `wayContinuityNats: 5` is the road-continuity (turn) prior; the
 * pedestrian profile sets it to 0. Changing any value here changes driving
 * output, which the golden corpus guards.
 */
export const ROAD_PROFILE: MatchProfile = {
	minFixes: 3,
	matchRadiusM: 50,
	maxCandidatesPerFix: 5,
	sigmaZ: 12,
	beta: 10,
	gapBridgeM: 8,
	vertexDp: 7,
	detourFactor: 4,
	detourSlackM: 250,
	maxLenFactor: 1.8,
	maxLenSlackM: 200,
	maxRoadlessFraction: 0.4,
	corridorNearM: 25,
	corridorFarM: 80,
	corridorMaxPenalty: 40,
	wayContinuityNats: 5,
	spurReturnM: 25,
	spurMaxSpanVerts: 4,
	simplifyToleranceM: 5,
	// Off for roads: the road callers supply no building layer, and a vehicle
	// under a mapped structure (bridge deck, gate arch) is not a routing error.
	buildingCrossFactor: 1,
	buildingSupportM: 0,
};

/**
 * Map-match a road-vehicle leg onto the street network. Returns the leg routed
 * onto the streets and time-interpolated across the fix window, or null when it
 * cannot be matched (a null result means "draw the raw fixes").
 */
export function matchRoadSegment(
	fixes: readonly RoadFix[],
	geo: RoadGeometry,
	opts: RoadMatchOpts = {},
): RoadMatchResult | null {
	const profile = opts.matchRadiusM !== undefined ? { ...ROAD_PROFILE, matchRadiusM: opts.matchRadiusM } : ROAD_PROFILE;
	return matchTrajectory(fixes, geo, profile);
}

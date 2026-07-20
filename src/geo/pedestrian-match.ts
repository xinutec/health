/**
 * Pedestrian map-matching — snap a walking leg onto the OSM walkable network so
 * the map draws it on the pavement/footway (or the residential centerline where
 * pavements aren't separately mapped) instead of cutting across buildings.
 *
 * The sibling of `road-match.ts`: both are thin adapters over the shared
 * {@link matchTrajectory} core (`map-match-core.ts`). This one supplies
 * {@link WALK_PROFILE} — the road tuning with the way-continuity (turn) prior
 * removed (pedestrians change ways freely at every crossing) and the candidate
 * radius / emission tightened (walk GPS sits closer to truth than a parked car).
 *
 * The walkable network includes residential/service centerlines (via
 * `osm.walkableRoads`), so where London pavements aren't mapped as separate ways
 * the leg routes onto the street centerline — a lane-width off the true pavement,
 * but far better than a chord through the houses.
 *
 * # Honest fallback
 *
 * `matchWalkSegment` returns `null` ("draw the smoother / raw") when the leg
 * can't be matched: too few fixes, too far off the walkable network (a genuine
 * across-park/plaza walk with no ways), or — the common London case — a
 * fragmented walkable graph the Viterbi can't route across. `null` is the signal
 * to fall back to the pedestrian smoother, never to invent an on-pavement path.
 */

import { despikeViaLean, trimViaLean } from "../lean/lean-passes.js";
import {
	despikeUnsupportedApexes,
	type MatchProfile,
	type MatchResult,
	matchTrajectory,
	type RoadFix,
	type RoadGeometry,
	spliceRouteDetail,
	trimOverRouteExcursions,
} from "./map-match-core.js";
import { ROAD_PROFILE } from "./road-match.js";

/**
 * Pedestrian tuning for the shared matcher — the road profile with the
 * pedestrian deltas. Tuned against `score-walk` (off-walkable p90) on the
 * 2026-06-24 Wembley walks.
 */
export const WALK_PROFILE: MatchProfile = {
	...ROAD_PROFILE,
	// Walkers change ways at every crossing/corner; the road turn-prior would
	// fight legitimate footway↔crossing↔residential transitions. THE key change.
	wayContinuityNats: 0,
	// Walk GPS (~4-19 m accuracy) sits closer to truth than urban driving; a
	// tight radius keeps the match from snapping across the carriageway to the
	// wrong pavement, or grabbing a footway one street over.
	matchRadiusM: 20,
	// The walkable graph is denser (both pavements + crossings + the residential
	// centerline are candidates within radius), so consider a few more.
	maxCandidatesPerFix: 6,
	// Trust the pre-Kalman accuracy-bearing fix more (the road σ was loosened for
	// Kalman-smoothed, urban-scattered driving fixes).
	sigmaZ: 8,
	// Slightly more tolerant of walking weave/backtrack in the transition.
	beta: 12,
	// Tighter length bail than road (1.8): a walker's matched path that is much
	// longer than the raw track is a routing blunder (the matcher took the long
	// way round on the network), not a real detour. 1.4 catches a ~2× blunder
	// while keeping legitimate matches that hug the GPS. Tuned on 2026-06-24.
	maxLenFactor: 1.4,
	// The pedestrian network is genuinely more fragmented than the road network
	// (footways, crossings, service ways that don't share an OSM node at
	// junctions), so the 8 m road bridge leaves the graph disconnected and the
	// Viterbi bails on real walks. A larger bridge restores routing continuity;
	// the off-walkable p90 metric + the p85 stray gate catch any wrong bridging
	// across a genuinely-separated parallel pavement. Tuned on 2026-06-24.
	gapBridgeM: 18,
	// Building-aware route choice (#304): a through-building edge (a mapped
	// passage/concourse footway crossing a footprint) with no raw fix within
	// buildingSupportM of its in-building portion costs 25× — the router walks
	// the block's streets instead. Fixes ON the crossing (a concourse the walk
	// really traced, e.g. King's Cross 13:27 on 2026-07-01 at 3-7 m) waive it;
	// the unsupported cases measured 24-46 m from every fix. 25× makes a 15 m
	// unsupported crossing lose to any detour under ~360 m of extra weight while
	// the transition + maxLenFactor still bound the detour's real length.
	buildingCrossFactor: 25,
	buildingSupportM: 15,
};

export interface WalkMatchOpts {
	/** Override the profile's candidate snap radius (m). */
	matchRadiusM?: number;
}

export interface WalkMatchResult {
	/** The display line: the cleaned matched line with the route's curve
	 *  geometry spliced back into its chords (#369). */
	path: MatchResult["path"];
	/** The cleaned matched line exactly as every downstream threshold (display
	 *  gate, splice salvage, refine engagement) was tuned against — decisions
	 *  consume this, never the finer display line. */
	coarsePath: MatchResult["path"];
}

/**
 * Map-match a walking leg onto the walkable network. Returns the leg routed onto
 * the pavement/footway network and time-interpolated across the fix window, or
 * `null` when it cannot be matched honestly (draw the smoother / raw instead).
 */
export function matchWalkSegment(
	fixes: readonly RoadFix[],
	geo: RoadGeometry,
	opts: WalkMatchOpts = {},
): WalkMatchResult | null {
	const profile = opts.matchRadiusM !== undefined ? { ...WALK_PROFILE, matchRadiusM: opts.matchRadiusM } : WALK_PROFILE;
	const result = matchTrajectory(fixes, geo, profile);
	if (result === null) return null;
	// Clean the matched line of two artifacts the raw GPS never made (#293/#295):
	// wide over-route detours (a loop out and back the corridor tests catch), then
	// tight apex spikes where the snapper amplified GPS jitter into a triangle that
	// hugs the noisy fixes too closely for the corridor tests to see.
	const trimmed = trimViaLean(result.path, fixes, trimOverRouteExcursions(fixes, result.path));
	const cleaned = despikeViaLean(trimmed, fixes, despikeUnsupportedApexes(trimmed, fixes));
	// Then carry the way geometry back into the surviving chords (#369) — pure
	// curve fidelity; every deliberate excision above stays excised.
	return { path: spliceRouteDetail(cleaned, result.routeDetail, profile.simplifyToleranceM), coarsePath: cleaned };
}

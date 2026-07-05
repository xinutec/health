/**
 * Annotate road-vehicle segments with a street-matched geometry (task #261).
 *
 * The map draws a driving / bus / cycling leg as its raw GPS polyline, which
 * scatters off the carriageway and cuts corners through buildings. This pass
 * reads the OSM street network around each road leg (through the
 * `OsmAdapter`, so it records/replays deterministically like the rail and
 * bus passes) and runs the Newson-Krumm matcher (`road-match.ts`) to snap
 * the leg onto the roads. The result is attached as `matchedPath`; the map's
 * `episode-geometry` layer draws it as `kind:"matched"` and falls back to
 * the raw track when it is absent.
 *
 * Purely additive — like `annotateSnappedPaths` (rail) it never rewrites the
 * mode or the raw fixes, only adds display geometry. With no road data
 * available (a fixture predating #261, or a leg the matcher can't confidently
 * place) `matchedPath` stays undefined and nothing changes.
 */

import type { EnrichedSegment } from "./enriched-segment.js";
import { rejectSpikes } from "./episode-geometry.js";
import type { FilteredPoint } from "./kalman.js";
import { MAX_SPEED_FOR_MODE } from "./mode-biometrics.js";
import type { OsmAdapter } from "./osm-adapter.js";
import { corridorWays } from "./osm-corridor.js";
import { matchImprovesDisplay, matchRoadSegment, type RoadFix } from "./road-match.js";
import { effectiveMode, samplesInWindow } from "./segment-util.js";

/** Effective modes drawn as a raw road polyline today — the legs this pass
 *  targets. Matches `episode-geometry`'s `MOVING_MODES` minus rail/air. */
const ROAD_MODES: ReadonlySet<string> = new Set(["driving", "bus", "cycling"]);

/** Below this many in-window fixes a leg is too sparse to map-match — leave
 *  it for the raw renderer. */
const MIN_LEG_FIXES = 4;

/** Corridor sampling for the street-network read: query a small disc every
 *  `STEP_M` along the leg and union the ways, instead of one disc around the
 *  centroid (whose box — and the mirror's spatial scan — explode on a long
 *  drive). The disc is `drivableRoads`'s own box (this radius + its internal
 *  margin), wider than the matcher's reach, so the union is output-identical to
 *  the old single disc. STEP ≈ 2× the disc radius is the cost optimum. */
const ROAD_SAMPLE_STEP_M = 700;
const ROAD_SAMPLE_RADIUS_M = 50;

/** Confidence gate, judged on the DRAWN LINE not the fix vertices. Map-matching
 *  only helps when the raw drawn track strays off-road — but the stray is in the
 *  CHORDS between fixes, not the fixes themselves: a sparse leg can have every
 *  fix sitting on a road while the straight lines between them cut ~40 m across
 *  the blocks (observed 2026-06-21: both home drives, fix-off-road 8–14 m but
 *  chord-off-road 37–40 m). The old fix-fraction gate scored 0 there and skipped
 *  matching. {@link matchImprovesDisplay} measures the chords instead, and keeps
 *  the original protection — it accepts the match only when it follows roads
 *  better AND stays within {@link MATCH_MAX_STRAY_M} of every fix, so a snap onto
 *  a far parallel road (the failure the old gate guarded against) is rejected. */
const NEEDS_MATCH_M = 25;
const MATCH_MAX_STRAY_M = 40;

/**
 * Attach `matchedPath` to every road-vehicle segment whose leg the matcher
 * can confidently place on the street network. The street network is read in a
 * corridor sampled along the leg ({@link corridorWays}). Returns a new segment
 * array; the input is not mutated.
 */
export async function annotateRoadMatches(
	segments: readonly EnrichedSegment[],
	points: readonly FilteredPoint[],
	osm: OsmAdapter,
): Promise<EnrichedSegment[]> {
	const out: EnrichedSegment[] = [];
	for (const seg of segments) {
		const mode = effectiveMode(seg);
		if (!ROAD_MODES.has(mode)) {
			out.push(seg);
			continue;
		}

		// Match the same fixes the map would draw: speed-plausible window
		// fixes with lone teleport spikes dropped (mirrors episode-geometry's
		// moving-mode filter), so a fast neighbour's tail can't drag the match.
		const cap = MAX_SPEED_FOR_MODE[mode];
		const windowFixes = samplesInWindow(points, seg);
		const plausible = cap === undefined ? windowFixes : windowFixes.filter((p) => p.speed_kmh <= cap);
		const clean = rejectSpikes(plausible);
		if (clean.length < MIN_LEG_FIXES) {
			out.push(seg);
			continue;
		}

		// Read the street network in a CORRIDOR along the leg — small discs
		// sampled down the track, unioned — not one giant disc around the
		// centroid. Each sample is the same `drivableRoads(lat, lon, radius)` call
		// on deterministic (frozen-fix) coordinates, so record/replay and the
		// golden fixtures are unaffected (just several small keys per leg).
		const ways = await corridorWays(
			clean.map((p) => ({ lat: p.lat, lon: p.lon })),
			(la, lo, r) => osm.drivableRoads(la, lo, r),
			ROAD_SAMPLE_STEP_M,
			ROAD_SAMPLE_RADIUS_M,
		);
		if (ways.length === 0) {
			out.push(seg);
			continue;
		}

		const fixes: RoadFix[] = clean.map((p) => ({ lat: p.lat, lon: p.lon, ts: p.ts }));

		// Match first, then decide on the DRAWN line: use the matched path only
		// when the raw chords stray off-road, the match follows the road better,
		// and it stays faithful to where the GPS was (no parallel-road snap).
		const result = matchRoadSegment(fixes, { ways });
		if (!result) {
			out.push(seg);
			continue;
		}
		const decision = matchImprovesDisplay(fixes, result.path, { ways }, NEEDS_MATCH_M, MATCH_MAX_STRAY_M);
		if (process.env.ROAD_MATCH_DEBUG === "1") {
			const t = (ts: number): string => new Date(ts * 1000).toISOString().slice(11, 16);
			console.error(
				`[road-match] ${t(seg.startTs)}-${t(seg.endTs)} use=${decision.use} rawOff=${decision.rawOffRoadM.toFixed(0)} matchedOff=${decision.matchedOffRoadM.toFixed(0)} stray=${decision.strayM.toFixed(0)} (needs>${NEEDS_MATCH_M}, stray≤${MATCH_MAX_STRAY_M})`,
			);
		}
		out.push(decision.use ? { ...seg, matchedPath: result.path } : seg);
	}
	return out;
}

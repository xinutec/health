/**
 * Annotate walking segments with a pavement-matched geometry — the pedestrian
 * analogue of `annotateRoadMatches` (#261), the proper fix for walks cutting
 * across buildings (#265 / `map-constrained-positioning`).
 *
 * Without it the map draws a walking leg as its raw GPS, which on house-lined
 * residential streets sits ~10-30 m off the pavement, clipping the houses. This
 * pass reads the OSM walkable network around each walk (through the `OsmAdapter`,
 * so it records/replays deterministically like the rail/road/bus passes) and runs
 * the pedestrian matcher (`pedestrian-match.ts`) to snap the leg onto the
 * pavement/footway network. The result is attached as `walkMatchedPath`;
 * `episode-geometry` draws it as `kind:"matched"`, above the raw track.
 *
 * Purely additive: never rewrites mode or fixes, only adds display geometry. The
 * matcher's honest `null` (off-network / fragmented graph) leaves
 * `walkMatchedPath` undefined and the raw track draws instead.
 */

import { type StepPoint, stepsInWindow } from "./biometrics.js";
import type { EnrichedSegment } from "./enriched-segment.js";
import { holdImplausibleSpeed, rejectSpikes } from "./episode-geometry.js";
import type { FilteredPoint } from "./kalman.js";
import { matchImprovesDisplay, type RoadFix } from "./map-match-core.js";
import { MAX_SPEED_FOR_MODE } from "./mode-biometrics.js";
import type { OsmAdapter } from "./osm-adapter.js";
import { matchWalkSegment } from "./pedestrian-match.js";
import { effectiveMode } from "./segment-util.js";
import { type CorrectRunDiag, correctWalkPath } from "./walk-building-escape.js";
import { countSharpTurns, reconstructWalk, refineMatchedPath, type WalkFix } from "./walk-smooth-map.js";

/** A raw GPS fix as drawn — the same set the raw renderer uses. */
interface PedFix {
	ts: number;
	lat: number;
	lon: number;
	accuracy: number | null;
}

const MIN_LEG_FIXES = 4;
const WALK_SPEED_CAP_KMH = MAX_SPEED_FOR_MODE.walking ?? 12;

/** Diagnostics sink for `correctWalkPath`: populated only when
 *  `WALK_CORRECT_DIAG=1`. Each record is tagged with the walk leg's start ts so
 *  a referee can attribute a residual crossing to its cause. Drain + reset with
 *  `drainWalkCorrectDiag()`. Off the hot path when the flag is unset. */
const walkCorrectDiag: Array<CorrectRunDiag & { startTs: number }> = [];
export function drainWalkCorrectDiag(): Array<CorrectRunDiag & { startTs: number }> {
	return walkCorrectDiag.splice(0, walkCorrectDiag.length);
}
/** Slack added to the leg's centroid→farthest-fix radius for the walkable-network
 *  read, so the disc comfortably covers the matcher's reach. Same shape as the
 *  smoother's query (one disc around the centroid) — walks are short, so a single
 *  disc is both cheap and sufficient. */
const WALK_QUERY_SLACK_M = 120;

/** Total drawn length (m) of a polyline. */
function pathLenM(pts: ReadonlyArray<{ lat: number; lon: number }>): number {
	let total = 0;
	for (let i = 1; i < pts.length; i++) total += metersBetween(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
	return total;
}

/** Great-circle metres between two lat/lon points. */
function metersBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const R = 6371000;
	const dLat = ((bLat - aLat) * Math.PI) / 180;
	const dLon = ((bLon - aLon) * Math.PI) / 180;
	const lat1 = (aLat * Math.PI) / 180;
	const lat2 = (bLat * Math.PI) / 180;
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Confidence gate, judged on the DRAWN LINE (chords) like the road matcher,
 *  but against the WALKABLE network. Use the match only when the raw chords stray
 *  > {@link WALK_NEEDS_MATCH_M} off the walkable surface, the match follows it
 *  better, AND the match stays within {@link WALK_MATCH_MAX_STRAY_M} (p85) of the
 *  fixes. The stray cap is GENEROUS (40 m, like road): a walker's GPS genuinely
 *  sits 10-30 m off the pavement (houses / urban canyon), so the on-pavement
 *  match is legitimately that far from the fixes — measured p85 stray was 26-34 m
 *  on the 2026-06-24 walks while the match was clearly correct (off-road 67→9,
 *  38→7). A tight cap rejected exactly the good matches. The matcher's own tight
 *  20 m radius + corridor penalty are what bound a wrong-parallel-pavement snap;
 *  the stray cap only catches a gross mis-snap. */
const WALK_NEEDS_MATCH_M = 18;
const WALK_MATCH_MAX_STRAY_M = 40;

/** Robust-reconstruction swap (`WALK_RECON`, #296). The Viterbi matcher is blind
 *  to GPS accuracy, so a post-tunnel reacquire smear gets snapped into a clean
 *  out-and-back phantom detour (the Regent's Park case: ~1.5 km drawn on ~300 m of
 *  steps). `reconstructWalk` rejects those low-consensus fixes (redescending
 *  emission under a GNC anneal) and draws the honest short path. We swap it in for
 *  the matched/raw line ONLY when it is BOTH a large fraction shorter AND shorter by
 *  a wide absolute margin — the unambiguous signature of a dissolved excursion. On
 *  an ordinary leg the reconstruction is ~the same length, so the swap never fires
 *  and the matched line is kept byte-identical (measured: a global replacement
 *  over-routes ~70 m more on ~1/3 of legs; this conditional swap ships only the win).
 *  Both thresholds must clear. */
const RECON_SWAP_MAX_LEN_FRACTION = 0.75; // reconstruction ≤ 75 % of the drawn length
const RECON_SWAP_MIN_ABS_DROP_M = 150; // …AND ≥ 150 m shorter

/**
 * Attach `walkMatchedPath` to every walking segment the matcher can confidently
 * place on the walkable network. The walkable network is read in a single disc
 * around the leg's centroid (radius = farthest fix + {@link WALK_QUERY_SLACK_M}).
 * Returns a new segment array; the input is not mutated. `WALK_MATCH_DISABLE=1`
 * makes it a no-op (the raw baseline, for the score-walk eval).
 */
export async function annotateWalkMatches(
	segments: readonly EnrichedSegment[],
	displayFixes: readonly PedFix[],
	points: readonly FilteredPoint[],
	osm: OsmAdapter,
	stepPoints: readonly StepPoint[] = [],
): Promise<EnrichedSegment[]> {
	if (process.env.WALK_MATCH_DISABLE === "1") return [...segments];

	const speedByTs = new Map(points.map((p) => [p.ts, p.speed_kmh]));
	const out: EnrichedSegment[] = [];
	for (const seg of segments) {
		if (effectiveMode(seg) !== "walking") {
			out.push(seg);
			continue;
		}
		const inWin = displayFixes
			.filter((f) => f.ts >= seg.startTs && f.ts <= seg.endTs && (speedByTs.get(f.ts) ?? 0) <= WALK_SPEED_CAP_KMH)
			.sort((a, b) => a.ts - b.ts);
		if (inWin.length < MIN_LEG_FIXES) {
			out.push(seg);
			continue;
		}

		// Read the walkable network in a single disc around the leg's centroid —
		// the same `walkableRoads(lat, lon, radius)` call on deterministic
		// (frozen-fix) coordinates the smoother already captured.
		let cLat = 0;
		let cLon = 0;
		for (const p of inWin) {
			cLat += p.lat;
			cLon += p.lon;
		}
		cLat /= inWin.length;
		cLon /= inWin.length;
		let maxDist = 0;
		for (const p of inWin) {
			const d = metersBetween(cLat, cLon, p.lat, p.lon);
			if (d > maxDist) maxDist = d;
		}
		const discRadiusM = Math.round(maxDist + WALK_QUERY_SLACK_M);
		const ways = await osm.walkableRoads(cLat, cLon, discRadiusM);
		if (ways.length === 0) {
			out.push(seg);
			continue;
		}
		// Building footprints in the same disc — the impassable layer for the
		// building-escape corrector. Queried unconditionally (so capture records
		// them; the pipeline is otherwise building-blind and no fixture carries
		// them). The escape itself is applied below, gated, so drawn geometry — and
		// therefore the golden corpus — is unchanged until it is turned on.
		const buildings = await osm.buildingsNear(cLat, cLon, discRadiusM);

		// The matcher gets the same fixes with lone teleport spikes dropped.
		const clean = rejectSpikes(inWin);
		if (clean.length < MIN_LEG_FIXES) {
			out.push(seg);
			continue;
		}
		const fixes: RoadFix[] = clean.map((p) => ({ lat: p.lat, lon: p.lon, ts: p.ts }));
		// Buildings ride along as the matcher's impassable layer (#304): an
		// unsupported through-building edge is routed around at graph level, so
		// most crossings never reach the corrector below.
		const result = matchWalkSegment(fixes, { ways, buildings });
		const decision = result
			? matchImprovesDisplay(fixes, result.path, { ways }, WALK_NEEDS_MATCH_M, WALK_MATCH_MAX_STRAY_M)
			: null;
		if (process.env.WALK_MATCH_DEBUG === "1" && result && decision) {
			const t = (ts: number): string => new Date(ts * 1000).toISOString().slice(11, 16);
			console.error(
				`[walk-match] ${t(seg.startTs)}-${t(seg.endTs)} use=${decision.use} rawOff=${decision.rawOffRoadM.toFixed(0)} matchedOff=${decision.matchedOffRoadM.toFixed(0)} stray=${decision.strayM.toFixed(0)} (needs>${WALK_NEEDS_MATCH_M}, stray≤${WALK_MATCH_MAX_STRAY_M})`,
			);
		}
		const useMatch = decision?.use === true;
		// Accuracy-aware fixes for the continuous MAP passes (refine + reconstruct).
		const walkFixes: WalkFix[] = clean.map((p) => ({
			lat: p.lat,
			lon: p.lon,
			ts: p.ts,
			accuracyM: p.accuracy ?? undefined,
		}));

		let drawn: Array<{ lat: number; lon: number; ts: number }>;
		if (useMatch && result) {
			// De-box the matched line: round its boxy ~90° graph corners toward the
			// raw GPS with the continuous MAP refinement, keeping the vetted matched
			// line as the single corridor (so it can't stray off-route; the clamp
			// bounds it). Applied only when it actually reduces sharp turns — else the
			// matched line is already smooth and is kept as-is. `WALK_REFINE_DISABLE=1`
			// opts out.
			drawn = result.path;
			if (process.env.WALK_REFINE_DISABLE !== "1") {
				const refined = refineMatchedPath(walkFixes, result.path);
				if (refined && countSharpTurns(refined) < countSharpTurns(result.path)) drawn = refined;
			}
		} else {
			// Matcher bailed or the gate rejected: the leg draws as raw GPS — which
			// on house-lined streets can itself run through buildings. The corrector
			// below fixes exactly that. Start from EXACTLY the line the raw renderer
			// draws (rejectSpikes + holdImplausibleSpeed, `episode-geometry.ts`) —
			// starting from the un-collapsed fixes would hand the corrector an
			// indoor-smear teleport zigzag the renderer never shows, and attaching
			// its "correction" would replace a short honest line with a long noisy
			// one (measured: the 2026-07-01 10:44 leg, 1908 m of jitter in 10 min).
			drawn = holdImplausibleSpeed(clean, WALK_SPEED_CAP_KMH).map((p) => ({ lat: p.lat, lon: p.lon, ts: p.ts }));
		}

		// Robust-reconstruction swap (#296, behind WALK_RECON): when the drawn line
		// (matched or raw) is a phantom out-and-back — the accuracy-blind matcher
		// snapping a post-tunnel GPS smear into a clean detour — `reconstructWalk`
		// rejects the low-consensus fixes and draws the honest short path. Swap it in
		// ONLY when it is a large fraction shorter AND shorter by a wide absolute
		// margin (the unambiguous dissolved-excursion signature); on an ordinary leg
		// the reconstruction is ~the same length, so nothing changes. Deterministic.
		let smoothed = false;
		if (process.env.WALK_RECON === "1") {
			// Pedometer budget for the leg window (#320): the one signal independent
			// of GPS that contradicts a coherent smear. null (no step data for the
			// day) leaves the factor off.
			const stepsWalked = stepsInWindow(stepPoints, seg.startTs, seg.endTs);
			const recon = reconstructWalk(walkFixes, { ways, buildings }, undefined, {
				stepsWalked: stepsWalked ?? undefined,
			});
			if (recon && recon.length >= 2) {
				const drawnLen = pathLenM(drawn);
				const reconLen = pathLenM(recon);
				if (reconLen <= drawnLen * RECON_SWAP_MAX_LEN_FRACTION && drawnLen - reconLen >= RECON_SWAP_MIN_ABS_DROP_M) {
					drawn = recon.map((p) => ({ lat: p.lat, lon: p.lon, ts: p.ts }));
					smoothed = true;
					if (process.env.WALK_MATCH_DEBUG === "1") {
						const t = (ts: number): string => new Date(ts * 1000).toISOString().slice(11, 16);
						console.error(
							`[walk-recon] ${t(seg.startTs)}-${t(seg.endTs)} SWAP drawn=${drawnLen.toFixed(0)}m → recon=${reconLen.toFixed(0)}m`,
						);
					}
				}
			}
		}

		// Building corrector (Pippijn's case-based design): densify → route a gap
		// that crosses a block around it along the streets (case 2) → escape a lone
		// vertex inside a house to its near-side street (case 1) → no streets, trust
		// GPS (case 3). Honesty guards inside `correctWalkPath` (detour ratio,
		// crossing must reduce, never worse than the input). ON by default since
		// the 2026-07-02 rollout: an opt-in flag here made every local replay
		// (golden, walk-gate) silently diverge from prod — the ratchet floor was
		// blessed against uncorrected lines. WALK_BUILDING_ESCAPE=0 is the
		// emergency off-switch.
		let corrected = false;
		if (process.env.WALK_BUILDING_ESCAPE !== "0" && buildings.length > 0) {
			const diag =
				process.env.WALK_CORRECT_DIAG === "1"
					? (rec: CorrectRunDiag) => walkCorrectDiag.push({ ...rec, startTs: seg.startTs })
					: undefined;
			const fixed = correctWalkPath(drawn, { ways }, buildings, undefined, diag);
			corrected =
				fixed.length !== drawn.length || fixed.some((p, k) => p.lat !== drawn[k].lat || p.lon !== drawn[k].lon);
			if (corrected) drawn = fixed;
		}

		// Attach the drawn line. A reconstruction swap draws as `kind:"smoothed"`
		// (`walkSmoothedPath`, precedence over the matched line); otherwise a vetted
		// match or a corrector-changed raw leg draws as `kind:"matched"`. An unchanged
		// raw leg keeps its existing raw rendering path untouched.
		if (smoothed) out.push({ ...seg, walkSmoothedPath: drawn });
		else if (useMatch || corrected) out.push({ ...seg, walkMatchedPath: drawn });
		else out.push(seg);
	}
	return out;
}

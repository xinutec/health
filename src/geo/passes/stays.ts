/**
 * Stationary-stay consolidation passes.
 *
 * Merges adjacent same-place stays (bridging brief phantom moves and
 * blackout gaps), absorbs intra-place pottering walks, attaches stay
 * centroids, and consolidates GPS-jitter-shattered sits into a single
 * re-resolved stay. Extracted from the velocity orchestrator.
 */

import tzLookup from "tz-lookup";
import type { EnrichedSegment } from "../enriched-segment.js";
import type { FilteredPoint } from "../kalman.js";
import { bestPlace, extractCity, placeLabel } from "../osm.js";
import type { OsmAdapter } from "../osm-adapter.js";
import { haversineMeters } from "../place-snap.js";
import { effectiveMode, hasRefinedKind, samplesInWindow } from "../segment-util.js";
import type { VenuePriors } from "../venue-prior.js";

/**
 * Merge two consecutive stationary segments that resolved to the same `place`
 * label and are separated by ≤ 5 min. Reflects the user's intent: a brief
 * pause that lands inside the same venue should read as one stay, not two.
 *
 * Chains (A, A, A) collapse into one. We deliberately do NOT collapse across
 * a real movement segment yet — keeps the post-step trivially correct.
 */
/** Max duration of a brief intermediate segment we'll bridge across when
 *  it sits between two same-place stays. A user genuinely stepping out
 *  for more than ~10 min is doing something the timeline should surface,
 *  not be silently absorbed. */
const STAY_BRIDGE_MAX_GAP_S = 10 * 60;

/** Max average speed of the intermediate segment. A GPS-multipath phantom
 *  walk has near-zero avg speed (a few outliers drag pointwise speed up
 *  briefly, but the time-weighted average stays sub-walking). A real
 *  excursion — even a brief one — averages 3+ km/h. */
const STAY_BRIDGE_MAX_AVG_KMH = 2;

export function mergeAdjacentStays(segments: EnrichedSegment[]): EnrichedSegment[] {
	const result: EnrichedSegment[] = [];
	for (const seg of segments) {
		const prev = result[result.length - 1];
		// Direct adjacency: two stationary segments at the same place,
		// back-to-back. The classifier sometimes splits a continuous stay
		// when GPS goes briefly dark or jitters; collapse them. Use
		// `refinedMode ?? mode` so a walking segment that biometricCorrect
		// re-classified to stationary still merges with its same-place
		// neighbour — the 2026-06-02 "two consecutive Home stays" case.
		if (
			prev &&
			effectiveMode(prev) === "stationary" &&
			effectiveMode(seg) === "stationary" &&
			prev.place &&
			prev.place === seg.place &&
			seg.startTs - prev.endTs <= 5 * 60
		) {
			prev.endTs = seg.endTs;
			prev.pointCount += seg.pointCount;
			continue;
		}
		// Bridge over a brief non-stationary segment when bracketed by
		// two stays at the same place. The triggering shape is
		// [stay @ X, brief move, stay @ X]: a GPS multipath spike
		// inside a continuous stay produced a fake "walking" segment
		// (typically with avg ≤ 2 km/h — well below walking pace,
		// because most fixes are still at the table and only one or
		// two outliers drag the position).
		const prevPrev = result[result.length - 2];
		// A middle segment to bridge across when bracketed by two stays at
		// the same place. Two shapes qualify:
		//   1. A brief GPS-multipath phantom move — a "walking" sliver the
		//      raw classifier produced from one or two outlier fixes inside
		//      a continuous stay (avg ≤ 2 km/h, ≤ 10 min). Tested on
		//      `mode !== "stationary"` (not effectiveMode) so a middle that
		//      biometricCorrect later reclassified to stationary still
		//      bridges — the 2026-05-22 Royal Free 23:49-23:54 case.
		//   2. A no-GPS BLACKOUT (`unknown`, zero fixes) of ANY length — an
		//      absence of data, not an observed excursion. The stay-split
		//      emits it on a speculative mid-stay-departure hint, but if the
		//      place resolves the SAME on both sides the user never left
		//      (the 2026-06-12 17-min Cleveland Clinic indoor-GPS gap). Place
		//      identity outranks the speculative split, so the duration /
		//      speed caps that guard shape 1 don't apply.
		const isBriefPhantomMove =
			prev?.mode !== "stationary" &&
			prev !== undefined &&
			prev.endTs - prev.startTs <= STAY_BRIDGE_MAX_GAP_S &&
			prev.avgSpeed <= STAY_BRIDGE_MAX_AVG_KMH;
		const isBlackoutGap = prev?.mode === "unknown" && prev.pointCount === 0;
		if (
			prev &&
			prevPrev &&
			effectiveMode(seg) === "stationary" &&
			effectiveMode(prevPrev) === "stationary" &&
			prevPrev.place &&
			prevPrev.place === seg.place &&
			(isBriefPhantomMove || isBlackoutGap)
		) {
			result.pop(); // drop the bridged middle
			prevPrev.endTs = seg.endTs;
			prevPrev.pointCount += prev.pointCount + seg.pointCount;
			continue;
		}
		result.push({ ...seg });
	}
	return result;
}

/** Centroid distance under which two stationary stays are "the same spot" for
 *  the jitter-consolidation merge. Sized for indoor/urban-canyon GPS scatter
 *  (the 2026-06-09 Olivomare sit jittered in a ~50 m blob). */
const JITTER_STAY_MERGE_RADIUS_M = 75;

/** Longest intra-place walk to absorb — a kitchen / bathroom / meeting-room
 *  run inside a building, not a real outing. */
const INTRA_PLACE_WALK_MAX_S = 12 * 60;
/** The two bracketing stays must resolve to the same spot (same building). */
const INTRA_PLACE_SAME_SPOT_M = 75;
/** The walk must stay within this radius of the stay — it pottered around the
 *  building, it didn't go anywhere. Sized for a large office footprint; a real
 *  excursion (a walk round the block, a coffee across the road) strays past it
 *  and is kept as a leg. */
const INTRA_PLACE_FOOTPRINT_M = 120;

/**
 * Demote a short "walking" segment to stationary when it is intra-place
 * pottering: bracketed by two stays at the SAME place and the SAME spot, and
 * its fixes never leave the building footprint. The user got up from the desk,
 * walked to the kitchen and back — real steps, but no journey (the 2026-06-17
 * 5-min walk that split a 5-hour office stay in two; the two Work centroids
 * were 2 m apart).
 *
 * This is the geometric sibling of `mergeAdjacentStays`' multipath-spike
 * bridge: that one keys off avg speed ≤ 2 km/h (the fixes never really moved);
 * this one accepts genuine movement, gated instead on staying inside the
 * place. After demotion the neighbouring `mergeAdjacentStays` coalesces the
 * three into one continuous stay. Pure.
 */
export function absorbIntraPlaceWalk<T extends EnrichedSegment>(segments: T[], points: readonly FilteredPoint[]): T[] {
	const stayCentroid = (s: T): { lat: number; lon: number } | null => {
		// The stay's attached centroid is canonical; fall back to its fixes.
		if (s.centroidLat != null && s.centroidLon != null) return { lat: s.centroidLat, lon: s.centroidLon };
		const win = samplesInWindow(points, s);
		if (win.length === 0) return null;
		return {
			lat: win.reduce((a, p) => a + p.lat, 0) / win.length,
			lon: win.reduce((a, p) => a + p.lon, 0) / win.length,
		};
	};
	return segments.map((seg, i) => {
		if (effectiveMode(seg) !== "walking" || seg.endTs - seg.startTs > INTRA_PLACE_WALK_MAX_S) return seg;
		const prev = segments[i - 1];
		const next = segments[i + 1];
		if (!prev || !next || effectiveMode(prev) !== "stationary" || effectiveMode(next) !== "stationary") return seg;
		if (!prev.place || prev.place !== next.place) return seg;
		const cp = stayCentroid(prev);
		const cn = stayCentroid(next);
		if (!cp || !cn || haversineMeters(cp.lat, cp.lon, cn.lat, cn.lon) > INTRA_PLACE_SAME_SPOT_M) return seg;
		const win = samplesInWindow(points, seg);
		if (win.length === 0) return seg;
		let maxD = 0;
		for (const p of win) maxD = Math.max(maxD, haversineMeters(cp.lat, cp.lon, p.lat, p.lon));
		if (maxD > INTRA_PLACE_FOOTPRINT_M) return seg;
		const reason = `intra-place movement within ${prev.place} (stayed ${Math.round(maxD)} m from the stay, returned to it) — not a journey leg`;
		return {
			...seg,
			refinedMode: "stationary",
			place: prev.place,
			city: prev.city,
			wayName: undefined,
			centroidLat: cp.lat,
			centroidLon: cp.lon,
			refinedReason: seg.refinedReason ? `${seg.refinedReason}; ${reason}` : reason,
		};
	});
}

/** Attach each stationary segment's GPS centroid (mean of its in-window fixes).
 *  Pure. Moving segments and stays with no fixes are returned unchanged. The
 *  centroid is what `consolidateJitterStays` compares and re-resolves on. */
export function attachStayCentroids<T extends EnrichedSegment>(
	segments: T[],
	points: { ts: number; lat: number; lon: number }[],
): T[] {
	return segments.map((seg) => {
		if (effectiveMode(seg) !== "stationary") return seg;
		let n = 0;
		let sumLat = 0;
		let sumLon = 0;
		for (const p of points) {
			if (p.ts >= seg.startTs && p.ts <= seg.endTs) {
				sumLat += p.lat;
				sumLon += p.lon;
				n++;
			}
		}
		if (n === 0) return seg;
		return { ...seg, centroidLat: sumLat / n, centroidLon: sumLon / n };
	});
}

/** Index ranges [start, end] (inclusive) of adjacent stationary segments that
 *  should collapse into one stay: every segment in the run is stationary, has a
 *  centroid, and sits within `JITTER_STAY_MERGE_RADIUS_M` of the run's first
 *  segment, AND the run contains at least one jitter-demoted leg. The last
 *  guard is deliberate — it confines this pass to days where indoor/urban GPS
 *  jitter fragmented a sit (see `demoteJitterWalkToStationary`), so it can't
 *  disturb normal multi-stay days. Pure; returns runs of length ≥ 2 only. */
export function planJitterStayRuns(segments: EnrichedSegment[]): Array<{ start: number; end: number }> {
	const isJitter = (s: EnrichedSegment): boolean => hasRefinedKind(s, "gps-jitter");
	const runs: Array<{ start: number; end: number }> = [];
	let i = 0;
	while (i < segments.length) {
		const anchor = segments[i];
		if (effectiveMode(anchor) !== "stationary" || anchor.centroidLat === undefined) {
			i++;
			continue;
		}
		let j = i;
		while (j + 1 < segments.length) {
			const next = segments[j + 1];
			if (effectiveMode(next) !== "stationary" || next.centroidLat === undefined) break;
			const d = haversineMeters(
				anchor.centroidLat,
				anchor.centroidLon as number,
				next.centroidLat,
				next.centroidLon as number,
			);
			if (d > JITTER_STAY_MERGE_RADIUS_M) break;
			j++;
		}
		if (j > i && segments.slice(i, j + 1).some(isJitter)) runs.push({ start: i, end: j });
		i = j + 1;
	}
	return runs;
}

/** Collapse runs of co-located stationary fragments (one continuous sit that
 *  GPS jitter shattered into several stays with different, wrong place labels)
 *  into a single stay, re-resolving its name from the combined centroid.
 *
 *  Motivating case (2026-06-09): a ~75-min dinner sit came out as 7 fragments
 *  labelled "The Plumbers Arms" / "Keencare Pharmacy" / way-names because each
 *  jittery fragment's centroid grabbed a different nearest POI. Merged, the
 *  combined centroid lands 11 m from the actual venue (Olivomare), which
 *  `bestPlace` then returns. Confined to runs containing a jitter-demoted leg
 *  (see `planJitterStayRuns`) so normal days are untouched.
 */
export async function consolidateJitterStays(
	segments: EnrichedSegment[],
	osm: OsmAdapter,
	priors: VenuePriors | null = null,
): Promise<EnrichedSegment[]> {
	const runs = planJitterStayRuns(segments);
	if (runs.length === 0) return segments;
	const merged = new Map<number, EnrichedSegment>(); // start index -> merged stay
	const drop = new Set<number>();
	for (const { start, end } of runs) {
		const run = segments.slice(start, end + 1);
		const totalPoints = run.reduce((s, x) => s + x.pointCount, 0) || 1;
		const cLat = run.reduce((s, x) => s + (x.centroidLat as number) * x.pointCount, 0) / totalPoints;
		const cLon = run.reduce((s, x) => s + (x.centroidLon as number) * x.pointCount, 0) / totalPoints;
		// Re-resolve the venue from the combined centre, with the merged
		// stay's full window as plausibility evidence — this run IS the
		// poor-GPS indoor-sit case the venue scorer exists for (#246).
		const place = await bestPlace(osm, cLat, cLon, {
			stay: { startUnix: run[0].startTs, endUnix: run[run.length - 1].endTs, tz: tzLookup(cLat, cLon) },
			priors,
		});
		const base = run.reduce((a, b) => (b.endTs - b.startTs > a.endTs - a.startTs ? b : a)); // longest leg as base
		const reason = `consolidated ${run.length} GPS-jitter stay fragments`;
		merged.set(start, {
			...base,
			startTs: run[0].startTs,
			endTs: run[run.length - 1].endTs,
			pointCount: totalPoints,
			centroidLat: cLat,
			centroidLon: cLon,
			place: place ? placeLabel(place) : base.place,
			city: place ? (extractCity(place) ?? base.city) : base.city,
			wayName: undefined,
			refinedReason: base.refinedReason ? `${base.refinedReason}; ${reason}` : reason,
		});
		for (let k = start + 1; k <= end; k++) drop.add(k);
	}
	const out: EnrichedSegment[] = [];
	for (let i = 0; i < segments.length; i++) {
		if (merged.has(i)) out.push(merged.get(i) as EnrichedSegment);
		else if (!drop.has(i)) out.push(segments[i]);
	}
	return out;
}

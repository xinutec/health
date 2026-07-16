/**
 * Bridge: HSMM `decoded_days` segments → heuristic pipeline
 * `EnrichedSegment[]` place override.
 *
 * The heuristic pipeline is good at segment shape (boundaries,
 * way names, biometric joins) but its place attribution can drift
 * — multiple focus places within the OSM cluster radius, brief
 * stop near a POI being labelled as that POI, etc. The HSMM (as of
 * 2026-05-25, after the entry-prior + visit-frequency + mode-prior
 * fixes) scores 96.4% place attribution against ground truth vs
 * 100% (over a narrow denominator) for the pipeline.
 *
 * This module applies the HSMM's place picks to the pipeline's
 * stationary segments: for each pipeline stationary segment, find
 * the HSMM-dominant focus_place across the segment's minutes and
 * override the segment's display name. The pipeline's other fields
 * (`mode`, `wayName`, biometrics, `city`, etc.) are unchanged.
 *
 * Defensive defaults — the override is conservative:
 *   - Only stationary pipeline segments are considered.
 *   - HSMM must agree the user is stationary AND name a known
 *     focus_place AND that place must have a display name.
 *   - Off-network HSMM (`placeId=null`) leaves the pipeline label
 *     intact.
 *   - HSMM-thinks-the-user-is-walking-but-pipeline-says-stationary
 *     leaves the segment alone (avoid contradicting pipeline on
 *     mode-level disagreements; mode is a separate concern).
 *
 * Pure function. No DB, no IO, no globals.
 */

import type { EnrichedSegment } from "../geo/enriched-segment.js";
import { haversineMeters } from "../geo/place-snap.js";
import type { HmmSegment } from "./persist.js";

export interface PlaceLookup {
	displayName: string | null;
	/** Focus-place centroid. Used by the doorstep-consistency gate to
	 *  reject a geometrically-implausible override (a stay's place must be
	 *  near the stay's own GPS). Optional — when absent the gate can't
	 *  judge and the override proceeds. */
	lat?: number | null;
	lon?: number | null;
}

/** A stay's place must be near the stay's own observed location. A focus
 *  place whose centroid is further than this from the segment's GPS
 *  centroid is not a *refinement* of the place name — it's a teleport (the
 *  decoder filling a GPS-dark stay interior with a visit-frequency prior,
 *  then winning the segment by majority overlap). Refuse it and keep the
 *  pipeline's geometry-anchored place. Anchors the venue to the good-GPS
 *  doorstep rather than the gap-filled interior (#244). 1.5 km matches the
 *  presence-continuity contradiction radius. */
const MAX_PLACE_OVERRIDE_DISTANCE_M = 1500;

/** Apply HSMM-derived place overrides to pipeline segments.
 *
 *  Input `segments` is not mutated — a new array of (possibly
 *  cloned) segments is returned. A segment is cloned only when its
 *  place attribution is being overridden. */
export function applyHsmmPlaceOverride(
	segments: readonly EnrichedSegment[],
	hmmSegments: readonly HmmSegment[],
	places: ReadonlyMap<number, PlaceLookup>,
): EnrichedSegment[] {
	const out: EnrichedSegment[] = [];
	for (const seg of segments) {
		out.push(maybeOverride(seg, hmmSegments, places));
	}
	return out;
}

function maybeOverride(
	seg: EnrichedSegment,
	hmmSegments: readonly HmmSegment[],
	places: ReadonlyMap<number, PlaceLookup>,
): EnrichedSegment {
	const effectiveMode = seg.refinedMode ?? seg.mode;
	if (effectiveMode === "stationary") {
		return maybeOverridePlace(seg, hmmSegments, places);
	}
	// Movement segments: if HSMM has a confident train @ knownLine
	// pick across this segment, rewrite to train. Skips train-vs-
	// train cases — pipeline's line attribution is finer-grained
	// than the per-line route-graph evidence today.
	if (effectiveMode !== "train") {
		return maybeOverrideMovementToTrain(seg, hmmSegments);
	}
	return seg;
}

/** Generic clustering-bucket markers assigned by `assignDisplayNames`
 *  in `src/geo/focus-places.ts`. These are NOT venue labels — they
 *  identify a cluster's *kind* (you sleep here sometimes) without
 *  naming the venue. The pipeline's `bestPlace` lookup has already
 *  resolved a real venue name (e.g. "Cleveland Clinic London"); the
 *  HSMM override must not overwrite it with the bucket marker. The
 *  sleep-stay resolver in `src/geo/velocity.ts:1014` treats the same
 *  value the same way. */
const GENERIC_BUCKET_LABELS: ReadonlySet<string> = new Set(["Stay"]);

function maybeOverridePlace(
	seg: EnrichedSegment,
	hmmSegments: readonly HmmSegment[],
	places: ReadonlyMap<number, PlaceLookup>,
): EnrichedSegment {
	const dominantPlaceId = findDominantStationaryPlaceId(seg, hmmSegments);
	if (dominantPlaceId === null) return seg;

	const place = places.get(dominantPlaceId);
	if (!place || place.displayName === null) return seg;

	if (GENERIC_BUCKET_LABELS.has(place.displayName)) return seg;

	if (place.displayName === seg.place) return seg;

	// Doorstep-consistency gate (#244): the stay's own GPS centroid pins
	// where it physically was. If the HSMM's place is implausibly far from
	// it, the override is a teleport (the decoder filled a GPS-dark interior
	// with the Home/visit-frequency prior and won by overlap), not a
	// refinement — keep the pipeline's geometry-anchored place. Skipped when
	// the stay has no centroid (a truly GPS-dark stay legitimately anchors
	// via the prior).
	if (
		seg.centroidLat !== undefined &&
		seg.centroidLon !== undefined &&
		place.lat != null &&
		place.lon != null &&
		haversineMeters(seg.centroidLat, seg.centroidLon, place.lat, place.lon) > MAX_PLACE_OVERRIDE_DISTANCE_M
	) {
		return seg;
	}

	return { ...seg, place: place.displayName };
}

/** Minimum avg segment speed for movement→train override. Below
 *  this the segment is more consistent with walking-pace movement
 *  to/from a tube entrance than with riding the train itself. Tube
 *  averages 20-30 km/h; a brisk walk is 5-6 km/h. 8 km/h splits
 *  cleanly. */
const MOVEMENT_TO_TRAIN_MIN_AVG_KMH = 8;

/**
 * Weighted decision: should the HSMM's `train @ line` suggestion override
 * the pipeline's movement classification for this segment?
 *
 * This is deliberately NOT a hard veto. The HSMM picks a line from
 * route-graph connectivity + station proximity, which in dense central
 * London can credit a line a road vehicle merely drove past (2026-05-25:
 * a taxi home → Cleveland Clinic mislabelled "Circle Line" because the
 * loop passes within ~600 m of half of zone 1). Against that we weigh the
 * GPS evidence — how much of the trace runs nearer a drivable road than
 * any rail. Neither side is absolute:
 *
 *   - `lineOverlapFraction` — the HSMM's temporal support for the line
 *     (1.0 = it calls the whole segment this train; low = a sliver).
 *   - `roadCorridorFraction` — the share of GPS samples road-nearest
 *     (1.0 = follows roads throughout, no rail anywhere; null = no
 *     samples, e.g. an underground gap the HSMM reconstructed — then
 *     the GPS can't contradict and the HSMM stands).
 *
 * The override fires when the HSMM's line support outweighs the trace's
 * road-following: `lineOverlapFraction > roadCorridorFraction`. A
 * confident line over a rail-consistent trace still wins (real trains);
 * a thin line over a road-hugging trace loses (the taxi). Because OSM
 * rail coverage is fallible, a strong enough HSMM signal can always
 * overcome it — that is the point of weighing rather than vetoing.
 */
export function decideHsmmTrainOverride(opts: {
	avgSpeedKmh: number;
	lineOverlapFraction: number;
	roadCorridorFraction: number | null;
}): boolean {
	if (opts.avgSpeedKmh < MOVEMENT_TO_TRAIN_MIN_AVG_KMH) return false;
	if (opts.lineOverlapFraction <= 0) return false;
	const roadContradiction = opts.roadCorridorFraction ?? 0;
	return opts.lineOverlapFraction > roadContradiction;
}

function maybeOverrideMovementToTrain(seg: EnrichedSegment, hmmSegments: readonly HmmSegment[]): EnrichedSegment {
	const dominant = findDominantTrainLineName(seg, hmmSegments);
	if (dominant === null) return seg;
	const apply = decideHsmmTrainOverride({
		avgSpeedKmh: seg.avgSpeed,
		lineOverlapFraction: dominant.overlapFraction,
		roadCorridorFraction: seg.roadCorridorFraction ?? null,
	});
	if (!apply) return seg;
	// Set both `mode` and `refinedMode` so the override sticks
	// through to the user-facing display (which uses
	// `refinedMode ?? mode`). Clear the `refinedReason` since the
	// pipeline's biometric / cadence reclassification reasoning no
	// longer applies — HSMM's route-graph evidence supersedes it.
	// `vehicleKind` must go for the same reason: it is the bus
	// passes' judgement of the leg AS a road vehicle, and the
	// day-state flattening gives it precedence over refinedMode —
	// left in place it renders this train as a bus (#365).
	return {
		...seg,
		mode: "train",
		refinedMode: "train",
		refinedReason: `hsmm route evidence — ${dominant.line}`,
		wayName: dominant.line,
		vehicleKind: undefined,
	};
}

/** For the time window of `seg`, find the rail line name the HSMM
 *  attributes the most train-overlap-seconds to, together with that
 *  overlap as a FRACTION of the segment's duration (the HSMM's temporal
 *  support for the line — 1.0 = the HSMM calls the whole segment this
 *  train line, low = it only labels a sliver). Returns null when no
 *  train-with-knownLine HSMM segment overlaps (no train, only
 *  unknown_rail, etc.). */
function findDominantTrainLineName(
	seg: EnrichedSegment,
	hmmSegments: readonly HmmSegment[],
): { line: string; overlapFraction: number } | null {
	const counts = new Map<string, number>();
	for (const h of hmmSegments) {
		if (h.endTs <= seg.startTs) continue;
		if (h.startTs >= seg.endTs) break;
		if (h.mode !== "train") continue;
		if (h.lineName === null || h.lineName === "unknown_rail") continue;
		const overlapStart = Math.max(seg.startTs, h.startTs);
		const overlapEnd = Math.min(seg.endTs, h.endTs);
		const overlap = overlapEnd - overlapStart;
		if (overlap <= 0) continue;
		counts.set(h.lineName, (counts.get(h.lineName) ?? 0) + overlap);
	}
	let bestLine: string | null = null;
	let bestOverlap = 0;
	for (const [line, n] of counts) {
		if (n > bestOverlap) {
			bestLine = line;
			bestOverlap = n;
		}
	}
	if (bestLine === null) return null;
	const segDuration = Math.max(1, seg.endTs - seg.startTs);
	return { line: bestLine, overlapFraction: bestOverlap / segDuration };
}

/** For the time window of `seg`, find the focus_place id that the
 *  HSMM attributes the most stationary-overlap-seconds to. Returns
 *  null when no stationary-with-placeId HSMM segment dominates the
 *  overlap (off-network only, non-stationary only, or empty). */
function findDominantStationaryPlaceId(seg: EnrichedSegment, hmmSegments: readonly HmmSegment[]): number | null {
	const counts = new Map<number, number>();
	for (const h of hmmSegments) {
		if (h.endTs <= seg.startTs) continue;
		if (h.startTs >= seg.endTs) break; // assumes hmmSegments are time-sorted (true by construction)
		if (h.mode !== "stationary") continue;
		if (h.placeId === null) continue;
		const overlapStart = Math.max(seg.startTs, h.startTs);
		const overlapEnd = Math.min(seg.endTs, h.endTs);
		const overlap = overlapEnd - overlapStart;
		if (overlap <= 0) continue;
		counts.set(h.placeId, (counts.get(h.placeId) ?? 0) + overlap);
	}
	let bestId: number | null = null;
	let bestOverlap = 0;
	for (const [id, n] of counts) {
		if (n > bestOverlap) {
			bestId = id;
			bestOverlap = n;
		}
	}
	return bestId;
}

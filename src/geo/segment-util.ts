/**
 * Shared helpers for the segment-refinement passes.
 *
 * The classification pipeline is a long cascade of passes (see
 * `computeVelocityFromInputs`), and three small operations recur in almost
 * every one: reading a segment's effective mode, selecting the GPS fixes that
 * fall in a segment's time window, and reducing those to a centroid. Before
 * this module each pass re-implemented them inline — ~24 copies of
 * `refinedMode ?? mode` and ~8 copies of the filter+reduce — which is both
 * noise and a correctness hazard: a copy that forgets the `??` or uses the
 * wrong window boundary is a silent bug. Centralising them removes the
 * duplication and pins ONE documented convention.
 *
 * Pure; no DB, no IO.
 */

import { haversineMeters } from "./place-snap.js";
import type { RefinedKind, TransportMode } from "./segments.js";

/** The minimum shape these helpers read: a time window plus a mode that a
 *  later pass may have refined. */
export interface ModedSegment {
	startTs: number;
	endTs: number;
	mode: TransportMode;
	refinedMode?: TransportMode;
}

/** Any timestamped sample (a GPS fix, an HR reading, a step row). */
export interface Timestamped {
	ts: number;
}

/**
 * A segment's effective mode: the refined mode a later pass assigned, falling
 * back to the raw classifier mode. This is THE accessor — never read
 * `refinedMode ?? mode` inline; a forgotten `??` silently ignores every
 * refinement the cascade made.
 */
export function effectiveMode(seg: ModedSegment): TransportMode {
	return seg.refinedMode ?? seg.mode;
}

/**
 * The samples whose timestamp falls inside a segment's window.
 *
 * Boundary convention: INCLUSIVE on both ends (`startTs <= ts <= endTs`) — the
 * dominant convention across the pipeline, kept so behaviour is unchanged. A
 * sample landing exactly on a shared boundary is therefore counted by both
 * neighbours; that is harmless for centroids/extents (one sample among many)
 * but NOT for picking the single boarding/alighting fix of a rail leg, where a
 * boundary fix belongs to the neighbour — those sites use
 * {@link samplesInWindowExclusiveEnd} instead. Choose deliberately.
 */
export function samplesInWindow<P extends Timestamped>(
	samples: readonly P[],
	window: { startTs: number; endTs: number },
): P[] {
	return samples.filter((p) => p.ts >= window.startTs && p.ts <= window.endTs);
}

/**
 * Like {@link samplesInWindow} but with an EXCLUSIVE upper bound
 * (`startTs <= ts < endTs`). Use when a sample on the closing boundary belongs
 * to the next segment — e.g. resolving a rail leg's alighting fix, where the
 * boundary fix is the start of the following movement, not the end of the
 * ride (see `stationAtTrainAlight`).
 */
export function samplesInWindowExclusiveEnd<P extends Timestamped>(
	samples: readonly P[],
	window: { startTs: number; endTs: number },
): P[] {
	return samples.filter((p) => p.ts >= window.startTs && p.ts < window.endTs);
}

/** Append a refinement kind to a segment's existing tags, preserving any
 *  already carried forward. Mirrors the `refinedReason` string-append pattern
 *  but for the machine-readable {@link RefinedKind} channel: a pass that both
 *  appends a reason and branches-relevantly tags should call this so an earlier
 *  tag (e.g. `gps-gap-inferred`) is not dropped when a later one is added. */
export function addRefinedKind(
	existing: readonly RefinedKind[] | undefined,
	kind: RefinedKind,
): readonly RefinedKind[] {
	return existing ? [...existing, kind] : [kind];
}

/** Whether a segment carries a given refinement tag — the typed replacement for
 *  substring-matching `refinedReason`. */
export function hasRefinedKind(seg: { refinedKinds?: readonly RefinedKind[] }, kind: RefinedKind): boolean {
	return seg.refinedKinds?.includes(kind) ?? false;
}

/** The kinematic summary a segment carries. Every field is an observation
 *  about the segment's OWN window — see {@link statsOverWindow}. */
export interface WindowStats {
	pointCount: number;
	avgSpeed: number;
	maxSpeed: number;
	linearity: number;
}

/**
 * Recompute a segment's kinematics from the fixes its window actually owns.
 *
 * A carve that reslices a segment and emits the pieces as `{...seg, startTs,
 * endTs}` hands every piece the PARENT's summary. That summary was measured
 * across the whole parent — including whatever the carve just removed — so the
 * piece reports a peak that never happened inside it, and the kinematic
 * invariants downstream read that peak as evidence. Measured on the golden
 * corpus: 60 of 208 walking segments reported a `maxSpeed` their own fixes do
 * not support, the underground carve's post-tube walks among them, one of them
 * claiming 187.2 km/h on foot.
 *
 * `avgSpeed` is the MEDIAN, matching how `classifySegments` derives it — a mean
 * over a window containing a ride is dragged by the ride.
 *
 * @param excludeStart drops the fix ON `startTs`. Set it when a VEHICLE
 * precedes this window: the fix at the boundary is the one the vehicle arrived
 * on and its speed reading is the vehicle's, so a following walk that keeps it
 * is right back to claiming the ride's arrival speed on foot.
 */
export function statsOverWindow(
	points: readonly (Timestamped & LatLon & { speed_kmh?: number })[],
	startTs: number,
	endTs: number,
	excludeStart = false,
): WindowStats {
	const fixes = points
		.filter((p) => (excludeStart ? p.ts > startTs : p.ts >= startTs) && p.ts <= endTs)
		.sort((a, b) => a.ts - b.ts);
	if (fixes.length === 0) return { pointCount: 0, avgSpeed: 0, maxSpeed: 0, linearity: 0 };
	const speeds = fixes.map((f) => f.speed_kmh ?? 0);
	const sorted = [...speeds].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const med = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
	let pathDist = 0;
	for (let k = 1; k < fixes.length; k++) {
		pathDist += haversineMeters(fixes[k - 1].lat, fixes[k - 1].lon, fixes[k].lat, fixes[k].lon);
	}
	const straight = haversineMeters(
		fixes[0].lat,
		fixes[0].lon,
		fixes[fixes.length - 1].lat,
		fixes[fixes.length - 1].lon,
	);
	return {
		pointCount: fixes.length,
		avgSpeed: Math.round(med * 10) / 10,
		maxSpeed: Math.round(Math.max(...speeds) * 10) / 10,
		linearity: pathDist > 0 ? Math.round(Math.min(straight / pathDist, 1) * 100) / 100 : 0,
	};
}

/** A geographic point. */
export interface LatLon {
	lat: number;
	lon: number;
}

/** The arithmetic-mean centroid of some fixes, or null when there are none.
 *  The unweighted mean of in-window fixes is the pipeline's standard stay
 *  centroid. */
export function centroidOf(fixes: readonly LatLon[]): LatLon | null {
	if (fixes.length === 0) return null;
	let sumLat = 0;
	let sumLon = 0;
	for (const f of fixes) {
		sumLat += f.lat;
		sumLon += f.lon;
	}
	return { lat: sumLat / fixes.length, lon: sumLon / fixes.length };
}

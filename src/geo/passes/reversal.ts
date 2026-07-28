/**
 * Reversal detection: a ride that doubles back is two rides.
 *
 * You cannot stay on one train from a station out to another and back again —
 * reaching the far point and returning means you got off and boarded a train
 * going the other way. Nothing local to the turnaround says so: the platform
 * dwell there looks exactly like the station dwells a journey is meant to be
 * stitched across, and the speeds either side are identical. The evidence is
 * directional, so that is what this module reads.
 *
 * Two consumers, one rule. {@link splitReversingLegs} cuts a leg whose own
 * fixes reverse inside it, and {@link reversesAt} stops the rail-run pass from
 * growing a run back across a cut. Both are needed: without the split there is
 * no boundary to refuse to cross, and without the refusal the run pass welds the
 * two halves straight back together.
 *
 * The case this exists for is 2026-07-07, where Pippijn rode King's Cross →
 * Wembley Park, realised he had left his watch at work, and rode straight back.
 * The whole out-and-back arrived as ONE segment, was assembled into one
 * Metropolitan-line leg boarding and alighting at King's Cross, and
 * `checkWorldlineFeasibility` rejected it as degenerate.
 */

import type { EnrichedSegment } from "../enriched-segment.js";
import type { FilteredPoint } from "../kalman.js";
import { haversineMeters } from "../place-snap.js";
import { addRefinedKind, effectiveMode, samplesInWindow } from "../segment-util.js";

/** How far the track must travel either side of a point before its direction is
 *  worth reading. Under this, platform scatter and a tunnel-mouth reacquire
 *  dominate the vector and the angle is noise. */
export const DIRECTION_ARM_M = 500;

/** Cosine of the angle between the approach and departure vectors, above which
 *  the track carried on. Below it (a turn sharper than 120°) it went back the
 *  way it came. Deliberately far from a right angle: a line that merely curves
 *  through a station, or an interchange onto a line heading off at a tangent,
 *  must not read as a reversal — only a genuine doubling-back should. */
export const REVERSAL_COS_MAX = -0.5;

/** How far a leg must reach from its start before "it came back" is a
 *  meaningful thing to say about it. */
const REVERSAL_MIN_SPAN_M = 1500;

/** A leg ending this fraction (or less) of the way out from its start, having
 *  once been much further, has doubled back. Half is deliberately loose: the
 *  test must not fire on a ride whose GPS goes dark short of the alight, where
 *  the last OBSERVED fix is still well down the line. */
const REVERSAL_RETURN_FRACTION = 0.5;

/** Only a MOTORISED leg is split. An out-and-back stroll is an ordinary single
 *  walk; the constraint being enforced is that you cannot ride one train through
 *  a reversal. The bound sits above the cycling ceiling, matching the rail
 *  passes' own transit test. */
const REVERSAL_MIN_PEAK_KMH = 40;

/** Each half of a split must be long enough to be a ride in its own right —
 *  below this we would be slicing a tail off, not finding a turnaround. */
const REVERSAL_MIN_HALF_S = 60;

/** How long after the furthest fix to look for the platform the rider actually
 *  stood on. */
const TURNAROUND_SETTLE_S = 180;

/** Speed (km/h) below which the rider is off the train and on the platform.
 *  Matches the rail passes' own disembark threshold. */
const TURNAROUND_STOPPED_KMH = 5;

/** Local metres east/north of `ref` — good enough for comparing directions over
 *  a few km, and it keeps the turn test to plain vector arithmetic. */
function localOffset(p: { lat: number; lon: number }, ref: { lat: number; lon: number }): { x: number; y: number } {
	const D = Math.PI / 180;
	const R = 6371000;
	return {
		x: (p.lon - ref.lon) * D * Math.cos(((p.lat + ref.lat) / 2) * D) * R,
		y: (p.lat - ref.lat) * D * R,
	};
}

/** Do the approach to `pivot` and the departure from it oppose? Measured from
 *  the nearest fixes at least {@link DIRECTION_ARM_M} away on each side, so the
 *  answer is about travel rather than platform scatter, and bounded to
 *  `[fromTs, toTs]` so it only ever reads evidence the caller owns. Returns
 *  false when either side is unobserved — a test that cannot see is not
 *  evidence of a reversal. */
export function reversesAtPoint(
	points: readonly FilteredPoint[],
	pivot: { ts: number; lat: number; lon: number },
	fromTs: number,
	toTs: number,
): boolean {
	const far = (p: FilteredPoint): boolean => haversineMeters(p.lat, p.lon, pivot.lat, pivot.lon) >= DIRECTION_ARM_M;
	const inFix = [...points].reverse().find((p) => p.ts >= fromTs && p.ts < pivot.ts && far(p));
	const outFix = points.find((p) => p.ts > pivot.ts && p.ts <= toTs && far(p));
	if (inFix === undefined || outFix === undefined) return false;
	const a = localOffset(pivot, inFix); // approach: towards the pivot
	const b = localOffset(outFix, pivot); // departure: away from it
	const magA = Math.hypot(a.x, a.y);
	const magB = Math.hypot(b.x, b.y);
	if (magA === 0 || magB === 0) return false;
	return (a.x * b.x + a.y * b.y) / (magA * magB) < REVERSAL_COS_MAX;
}

/** Does the track double back at a segment boundary? The rail-run pass asks
 *  this before growing a run across the boundary, because what follows a
 *  turnaround is the ride back, not more of this ride. */
export function reversesAt(
	points: readonly FilteredPoint[],
	runStartTs: number,
	boundaryTs: number,
	lookAheadTs: number,
): boolean {
	const pivot = [...points].sort((a, b) => Math.abs(a.ts - boundaryTs) - Math.abs(b.ts - boundaryTs))[0];
	if (pivot === undefined) return false;
	return reversesAtPoint(points, pivot, runStartTs, lookAheadTs);
}

/**
 * Split any motorised leg whose own fixes double back, at the turnaround.
 *
 * The furthest fix from the leg's start is the candidate turnaround. It is only
 * accepted when the leg both RETURNS from it — ending far closer to its start
 * than that furthest point ever was — and genuinely reverses direction there.
 * The second condition is what a lone far-flung GPS spike fails: the track
 * approaches and leaves a spike on the same heading, so its arms do not oppose,
 * while a real turnaround's do.
 *
 * Runs before the rail-run pass, so both halves get their own board/alight
 * labels from the existing machinery rather than needing to be named here.
 */
export function splitReversingLegs(segments: EnrichedSegment[], points: readonly FilteredPoint[]): EnrichedSegment[] {
	const out: EnrichedSegment[] = [];
	for (const seg of segments) {
		const split = turnaroundOf(seg, points);
		if (split === null) {
			out.push(seg);
			continue;
		}
		const reason =
			"split at a turnaround: the leg doubles back on itself, so it is two rides with a change between them";
		out.push(
			{
				...seg,
				endTs: split.ts,
				...statsOver(points, seg.startTs, split.ts),
				refinedReason: appendReason(seg, reason),
				refinedKinds: addRefinedKind(seg.refinedKinds, "turnaround-alight"),
			},
			{
				...seg,
				startTs: split.ts,
				...statsOver(points, split.ts, seg.endTs),
				refinedReason: appendReason(seg, reason),
				refinedKinds: addRefinedKind(seg.refinedKinds, "turnaround-board"),
			},
		);
	}
	return out;
}

/** The fix a leg turns round at, or null when it does not turn round. */
function turnaroundOf(seg: EnrichedSegment, points: readonly FilteredPoint[]): FilteredPoint | null {
	if (effectiveMode(seg) === "stationary" || seg.maxSpeed < REVERSAL_MIN_PEAK_KMH) return null;
	const fixes = samplesInWindow(points, seg);
	if (fixes.length < 4) return null;
	const origin = fixes[0];
	let far = fixes[0];
	let maxD = 0;
	for (const p of fixes) {
		const d = haversineMeters(p.lat, p.lon, origin.lat, origin.lon);
		if (d > maxD) {
			maxD = d;
			far = p;
		}
	}
	if (maxD < REVERSAL_MIN_SPAN_M) return null;
	const endD = haversineMeters(fixes[fixes.length - 1].lat, fixes[fixes.length - 1].lon, origin.lat, origin.lon);
	if (endD >= maxD * REVERSAL_RETURN_FRACTION) return null;
	if (far.ts - seg.startTs < REVERSAL_MIN_HALF_S || seg.endTs - far.ts < REVERSAL_MIN_HALF_S) return null;
	// The distance test alone accepts a lone far-flung spike, whose "return" is
	// just the track carrying on. Only a real turnaround reverses direction.
	if (!reversesAtPoint(points, far, seg.startTs, seg.endTs)) return null;
	// Cut at the PLATFORM, not at the furthest fix. The extreme fix is wherever
	// the train happened to be at its outermost sample — on 2026-07-07 that was
	// 455 m beyond Wembley Park, outside the station lookup's radius, so the leg
	// resolved to no station at all. The first fix at which the rider is actually
	// stopped is the one that names the interchange.
	const settled = fixes.find(
		(p) => p.ts >= far.ts && p.ts <= far.ts + TURNAROUND_SETTLE_S && p.speed_kmh < TURNAROUND_STOPPED_KMH,
	);
	const cut = settled ?? far;
	return seg.endTs - cut.ts >= REVERSAL_MIN_HALF_S ? cut : far;
}

/** Recompute the per-half observations from the fixes each half actually owns —
 *  copying the whole leg's speeds onto both would report a peak that never
 *  happened in that window, which the kinematic invariants read as evidence. */
function statsOver(
	points: readonly FilteredPoint[],
	startTs: number,
	endTs: number,
): Pick<EnrichedSegment, "pointCount" | "avgSpeed" | "maxSpeed"> {
	const fixes = samplesInWindow(points, { startTs, endTs });
	if (fixes.length === 0) return { pointCount: 0, avgSpeed: 0, maxSpeed: 0 };
	const sum = fixes.reduce((a, p) => a + p.speed_kmh, 0);
	return {
		pointCount: fixes.length,
		avgSpeed: Math.round((sum / fixes.length) * 10) / 10,
		maxSpeed: Math.round(Math.max(...fixes.map((p) => p.speed_kmh)) * 10) / 10,
	};
}

function appendReason(seg: EnrichedSegment, reason: string): string {
	return seg.refinedReason ? `${seg.refinedReason}; ${reason}` : reason;
}

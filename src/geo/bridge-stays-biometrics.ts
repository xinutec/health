/**
 * Bridge stationary stays across short signal gaps using
 * biometric evidence. Implements the multi-signal-inference idea
 * surfaced by the 2026-05-22 Pizza Union case in the ground-truth
 * audit (#185): GPS data shows three separate stays at the same
 * coordinates because there's a brief no-fix gap mid-meal (likely
 * a toilet break); HR (resting) + steps (zero) for the gap window
 * tell us the user never actually moved.
 *
 * The function takes the segment pipeline's output + biometric
 * series, finds pairs of stationary segments that are:
 *
 *   - spatially co-located (centroids within COLOCATION_RADIUS_M)
 *   - separated by a gap shorter than MAX_GAP_SEC
 *   - covered by HR samples whose mean is at RESTING_HR_MAX or
 *     below, AND zero steps over the gap window
 *
 * and emits one merged stationary segment.
 *
 * The function is conservative by design: if HR data is missing
 * over the gap, OR steps were recorded during the gap, OR mean HR
 * is elevated, the pair is left as two separate stays. This is
 * weighted evidence ("we have positive signal that the user
 * didn't move"), not a gap-filling assumption.
 *
 * Why this lives outside `findStays`: findStays operates on raw
 * StayPoint clustering and runs before biometric attribution.
 * This pass runs after segmentation, after HR / steps have been
 * loaded for the day. It bridges stays that the geometry layer
 * had no information to merge.
 */

import type { HrPoint, StepPoint } from "./biometrics.js";
import { samplesInWindow } from "./segment-util.js";
import type { TrackSegment } from "./segments.js";

export interface BridgeStaysInput {
	/** The segment pipeline's output, in ascending startTs order.
	 *  Non-stationary segments are passed through unchanged. */
	segments: readonly TrackSegment[];
	/** Per-segment centroid coordinates. The geometry layer has
	 *  these; we accept them as a parallel array to avoid coupling
	 *  the segment type to this module. */
	centroids: readonly (readonly [number, number] | null)[];
	hr: readonly HrPoint[];
	steps: readonly StepPoint[];
}

/** Two stays whose centroids are within this radius (m) count as
 *  "the same place" for bridging. Matches `CLUSTER_RADIUS_M` in
 *  `findStays` so the bridge can heal a stay that fragmented
 *  during a brief gap. */
const COLOCATION_RADIUS_M = 150;

/** Maximum gap (seconds) between two stays that the bridge will
 *  consider merging. ~10 minutes covers a typical toilet break,
 *  short queue, or signal-loss-while-still-sitting; longer gaps
 *  need stronger evidence than HR + steps alone can provide. */
const MAX_GAP_SEC = 10 * 60;

/** Mean HR (bpm) at or below which the user is at rest. Calibrated
 *  generically (60-80 bpm covers most adults at sedentary
 *  baseline); the per-user mode-biometrics work refines this. */
const RESTING_HR_MAX = 90;

/** Minimum HR sample count required across the gap window to act
 *  on HR evidence. Below this, "low HR mean" might just be a
 *  one-sample artifact and we leave the pair unmerged. */
const MIN_HR_SAMPLES_IN_GAP = 3;

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** True iff biometric evidence over `[gapStart, gapEnd]` supports
 *  the user being at rest (HR low, no steps). */
function gapLooksStationary(
	gapStart: number,
	gapEnd: number,
	hr: readonly HrPoint[],
	steps: readonly StepPoint[],
): boolean {
	// Strictly INSIDE the gap — samples at the boundary timestamps
	// belong to the bracketing stays, not to the gap window itself.
	const hrInGap = hr.filter((p) => p.ts > gapStart && p.ts < gapEnd);
	if (hrInGap.length < MIN_HR_SAMPLES_IN_GAP) return false;
	const hrMean = hrInGap.reduce((s, p) => s + p.bpm, 0) / hrInGap.length;
	if (hrMean > RESTING_HR_MAX) return false;
	const stepsInGap = steps.filter((p) => p.ts > gapStart && p.ts < gapEnd);
	const stepSum = stepsInGap.reduce((s, p) => s + p.steps, 0);
	return stepSum === 0;
}

/** Mean HR above which we won't merge stays. Catches exercise-at-a-
 *  fixed-place cases (gym, home workout) where the centroid is stable
 *  but the user was actively moving. 130 bpm is conservative: a
 *  moderate jog. Most sedentary or seated activity sits well below. */
const MAX_MERGE_HR_MEAN = 130;

/** Pull HR samples strictly inside `[startTs, endTs]` and return their
 *  mean, or null when there are no samples. */
function meanHrInWindow(startTs: number, endTs: number, hr: readonly HrPoint[]): number | null {
	const inWin = samplesInWindow(hr, { startTs, endTs });
	if (inWin.length === 0) return null;
	return inWin.reduce((s, p) => s + p.bpm, 0) / inWin.length;
}

/** Merge consecutive stationary stays at the same place. Two stays
 *  count as "the same place" when their centroids sit within
 *  `COLOCATION_RADIUS_M` of each other. Handles two distinct shapes:
 *
 *   1. Gap-bridging — the original toilet-break case. Two stays with
 *      a no-GPS gap in between; merge only when HR + steps confirm
 *      the user stayed put across the gap.
 *
 *   2. Co-location merge — consecutive stationary segments with no
 *      gap (e.g., the middle 5-min was reclassified from walking to
 *      stationary by a biometric signature pass). Merge when the
 *      whole sequence's HR is below the exercise threshold.
 *
 *  Returns a new array; input is not mutated. */
export function bridgeStaysWithBiometrics(input: BridgeStaysInput): TrackSegment[] {
	const out: TrackSegment[] = [];
	let i = 0;
	while (i < input.segments.length) {
		const cur = input.segments[i];
		if (cur.mode !== "stationary") {
			out.push(cur);
			i++;
			continue;
		}
		// Walk forward to find the maximal co-located stationary run
		// starting at i.
		let j = i + 1;
		let extended = { ...cur };
		while (j < input.segments.length && input.segments[j].mode === "stationary") {
			const next = input.segments[j];
			const cCur = input.centroids[i];
			const cNext = input.centroids[j];
			if (cCur === null || cNext === null) break;
			const colocated = haversineMeters(cCur[0], cCur[1], cNext[0], cNext[1]) <= COLOCATION_RADIUS_M;
			if (!colocated) break;

			const gapStart = extended.endTs;
			const gapEnd = next.startTs;
			const gapSec = gapEnd - gapStart;
			if (gapSec > MAX_GAP_SEC) break;

			if (gapSec > 0) {
				// True signal gap — original toilet-break case. Require
				// positive HR + steps evidence the user stayed put.
				if (!gapLooksStationary(gapStart, gapEnd, input.hr, input.steps)) break;
			} else {
				// Back-to-back stays — only the segment-level HR check.
				// If the combined window shows exercise-grade HR, the
				// user was likely moving even though the geometry says
				// "same place" — leave separate.
				const combinedMean = meanHrInWindow(extended.startTs, next.endTs, input.hr);
				if (combinedMean !== null && combinedMean > MAX_MERGE_HR_MEAN) break;
			}

			extended = {
				...extended,
				endTs: next.endTs,
				pointCount: extended.pointCount + next.pointCount,
			};
			j++;
		}
		out.push(extended);
		i = j > i + 1 ? j : i + 1;
	}
	return out;
}

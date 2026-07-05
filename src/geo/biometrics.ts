/**
 * Cross-modal segment enrichment with Fitbit biometrics.
 *
 * Pure module — no DB, no I/O. Caller loads HR intraday + sleep stages
 * (from MariaDB), converts timestamps to unix seconds via fitbitTsToUnix,
 * and passes to enrichSegmentWithBiometrics.
 *
 * Designed for graceful degradation: any subset of (HR, sleep) may be
 * missing because the user wasn't wearing the watch, the battery died,
 * or Fitbit hadn't synced yet. All fields go to null/0/false in those
 * cases — the timeline still works, just without the extra context.
 */

import type { FilteredPoint } from "./kalman.js";
import { haversineMeters } from "./place-snap.js";
import { addRefinedKind, effectiveMode, hasRefinedKind, samplesInWindow } from "./segment-util.js";
import type { TrackSegment, TransportMode } from "./segments.js";

export interface HrPoint {
	ts: number; // unix seconds
	bpm: number;
}

export interface SleepStageRecord {
	startTs: number;
	endTs: number;
	stage: string; // "asleep" | "awake" | "deep" | "light" | "rem" | "wake"
}

/** One row from `steps_intraday`. The DB stores only non-zero minutes — a
 *  missing minute is implicit zero. */
export interface StepPoint {
	ts: number; // unix seconds, top-of-minute
	steps: number;
}

export interface BiometricEnrichment {
	/** Mean HR over the segment, or null if no HR samples in window. */
	hrMean: number | null;
	hrMin: number | null;
	hrMax: number | null;
	hrStd: number | null;
	/** Number of HR samples that fell inside the segment time window. */
	sampleCount: number;
	/** True if any sleep stage record overlapped the segment. */
	overlapsSleep: boolean;
	/** Fraction of segment duration covered by sleep records (0–1). */
	sleepFraction: number;
	/** Total steps recorded inside the segment (Fitbit 1-min intraday).
	 *  Null when no step rows touched the window — distinguish from zero
	 *  steps actively recorded. */
	stepsTotal: number | null;
}

const EMPTY_BIOMETRICS: BiometricEnrichment = {
	hrMean: null,
	hrMin: null,
	hrMax: null,
	hrStd: null,
	sampleCount: 0,
	overlapsSleep: false,
	sleepFraction: 0,
	stepsTotal: null,
};

export function enrichSegmentWithBiometrics(
	segment: TrackSegment,
	hrPoints: HrPoint[],
	sleepStages: SleepStageRecord[],
	stepPoints: StepPoint[] = [],
): BiometricEnrichment {
	const segDuration = segment.endTs - segment.startTs;
	const result: BiometricEnrichment = { ...EMPTY_BIOMETRICS };

	// HR stats
	const inWindow: number[] = [];
	for (const p of hrPoints) {
		if (p.ts >= segment.startTs && p.ts <= segment.endTs) inWindow.push(p.bpm);
	}
	if (inWindow.length > 0) {
		const sum = inWindow.reduce((a, b) => a + b, 0);
		const mean = sum / inWindow.length;
		const variance = inWindow.reduce((s, b) => s + (b - mean) ** 2, 0) / inWindow.length;
		result.hrMean = Math.round(mean * 10) / 10;
		result.hrMin = Math.min(...inWindow);
		result.hrMax = Math.max(...inWindow);
		result.hrStd = Math.round(Math.sqrt(variance) * 10) / 10;
		result.sampleCount = inWindow.length;
	}

	// Sleep overlap (sum of intersections, normalised by segment duration)
	if (segDuration > 0) {
		let overlapSec = 0;
		for (const stage of sleepStages) {
			const start = Math.max(segment.startTs, stage.startTs);
			const end = Math.min(segment.endTs, stage.endTs);
			if (end > start) overlapSec += end - start;
		}
		if (overlapSec > 0) {
			result.overlapsSleep = true;
			result.sleepFraction = Math.min(1, overlapSec / segDuration);
		}
	}

	// Step total. Each row in steps_intraday represents one minute starting at
	// `ts`; we sum all minutes whose top-of-minute falls inside the segment.
	// Only attribute steps if the array contains *any* row covering the
	// segment's day — otherwise leave as null (no Fitbit data, distinct from
	// "Fitbit recorded zero steps").
	if (stepPoints.length > 0) {
		let total = 0;
		let anyOverlap = false;
		for (const sp of stepPoints) {
			if (sp.ts >= segment.startTs && sp.ts <= segment.endTs) {
				total += sp.steps;
				anyOverlap = true;
			}
		}
		// Even if no non-zero minutes fell in the window, presence of step rows
		// for the day implies the Fitbit was on; treat that as zero steps.
		if (anyOverlap || stepPoints.some((sp) => Math.abs(sp.ts - segment.startTs) < 86400)) {
			result.stepsTotal = total;
		}
	}

	return result;
}

/** Steps per minute over a segment'\''s window. Zero if the segment is shorter
 *  than 30 seconds (denominator too small to be meaningful). Steps outside
 *  the window are ignored. */
export function cadenceForSegment(segment: TrackSegment, stepPoints: StepPoint[]): number {
	const durationSec = segment.endTs - segment.startTs;
	if (durationSec < 30) return 0;
	let total = 0;
	for (const sp of stepPoints) {
		if (sp.ts >= segment.startTs && sp.ts <= segment.endTs) total += sp.steps;
	}
	return (total / durationSec) * 60;
}

/** Highest single per-minute step count inside a segment's window. Fitbit
 *  `steps_intraday` is per-minute, so each `StepPoint` is one minute's steps
 *  and the max over the window is the segment's peak cadence. Returns 0 if no
 *  step rows fall in the window. Unlike the mean (`cadenceForSegment`), the
 *  peak survives a window that is slow / interrupted overall but contains one
 *  unmistakable walking minute. */
export function peakCadenceForSegment(segment: TrackSegment, stepPoints: StepPoint[]): number {
	let peak = 0;
	for (const sp of stepPoints) {
		if (sp.ts >= segment.startTs && sp.ts <= segment.endTs && sp.steps > peak) peak = sp.steps;
	}
	return peak;
}

// --- Cadence-based mode correction ---

/** A walking-classified segment with cadence below this is almost certainly
 *  not walking — typical walking is 80–120 steps/min, jogging 130+, slow
 *  strolling ~40, busy urban walking with stops ~25–40, and even Fitbit
 *  partial-data minutes for real walking can dip into single digits. Set
 *  the threshold to 5 to only correct genuinely-zero cases (passenger in
 *  vehicle, escalator, shuttle); anything above 5 is more likely real
 *  walking with sparse Fitbit data than vehicle transit.
 *
 *  Tradeoff: false positives (real walks → driving) corrupt the timeline
 *  more visibly than false negatives (passenger trip kept as walking).
 *  Erring conservative is intentional. */
const WALKING_MIN_CADENCE = 5;

/** Don'\''t correct very short segments — a 1-min "walking" segment with
 *  zero steps could be a brief pause. Need enough samples to be confident. */
const CADENCE_CORRECTION_MIN_DURATION_S = 3 * 60;

/** Above this speed, the segment classifier already wouldn'\''t pick walking
 *  — cadence correction shouldn'\''t fight that boundary. */
const WALKING_MAX_SPEED_KMH = 15;

/** A cadence-flipped "driving" leg only gets reverted to walking when its
 *  average speed is in pedestrian range. A real slow-vehicle leg that GPS
 *  mistook for walking still tends to average faster than a stroll; a
 *  pottering-about walk averages 2-5 km/h (observed 2.6-4.6 on the leg that
 *  motivated this). 7 km/h is a brisk-walk ceiling: below it we are confident
 *  it is pedestrian, above it we leave the cadence call alone. */
const CADENCE_REVERT_PEDESTRIAN_AVG_KMH = 7;

/** A "stationary" segment carrying a single minute at or above this step
 *  count was almost certainly a walk the GPS read as a stop — 80 steps in one
 *  minute is an unmistakable walking burst, not the incidental shuffling of
 *  someone genuinely still. The *peak* minute (not the segment mean) is the
 *  robust signal: a real walk-through is often slow / interrupted overall
 *  (window-shopping, a park stroll) so its mean cadence looks ambiguous, but
 *  at least one minute hits a clear walking burst. */
const STATIONARY_WALK_PEAK_CADENCE = 80;

/** ...but only flip when the GPS also shows the segment actually translated.
 *  Pacing in place at an established stay (home, a hospital ward) produces the
 *  same step burst with ~0 net GPS movement; a walk-through moves you. 1.0
 *  km/h cleanly separates a meandering park walk-through (~1.4 km/h observed
 *  on 2026-05-25) from in-place pacing (~0–0.2 km/h observed at home / the
 *  ward). This is the GPS + watch fusion: steps alone cannot tell
 *  walking-in-place from walking-somewhere — GPS translation can. */
const STATIONARY_WALK_MIN_AVG_SPEED_KMH = 1.0;

/** Physical-plausibility veto on the walk-through flip. `avgSpeed` is the mean
 *  of per-fix speeds, so urban / indoor GPS multipath jitter inflates it above
 *  the translation threshold even when the user never left a tiny area — a
 *  walking burst (arriving, pacing a waiting room) then flips a genuine STAY
 *  into a phantom walk-through. The fix reads the SHAPE, not the per-fix speed:
 *  a segment this long whose fixes never stray more than
 *  STATIONARY_WALK_STAY_MAX_EXTENT_M from their centroid did not go anywhere —
 *  you cannot "walk through" a ~60 m spot for ten-plus minutes — so it is a
 *  stay and the flip is vetoed. 10 min clears real walk-throughs (the
 *  2026-05-25 Union Park stroll is ~5 min and genuinely covers ground); 80 m
 *  absorbs multipath spread (the 2026-06-17 Bloomsbury Surgery dwell stayed
 *  within ~50 m for 15 min while jitter spikes lifted avgSpeed past 1 km/h).
 *  Skipped when no fixes are supplied — without the geometry the old behaviour
 *  stands. */
const STATIONARY_WALK_STAY_MIN_DURATION_S = 10 * 60;
const STATIONARY_WALK_STAY_MAX_EXTENT_M = 80;

/** Require at least one step row at or after the segment'\''s end within this
 *  window — proof that Fitbit data has been synced through the segment'\''s
 *  time period. Without this, "no steps recorded" might just mean "we
 *  haven'\''t pulled this minute from Fitbit yet" and we'\''d wrongly correct
 *  a real walk into driving. */
const CADENCE_CORRECTION_FRESHNESS_S = 30 * 60;

/** Use cadence to correct mode classifications that GPS alone got wrong.
 *  This pass handles the walking → driving direction: a "walking" segment
 *  with near-zero cadence is almost certainly a passenger in slow traffic /
 *  on an escalator. The symmetric stationary → walking direction lives in
 *  `correctStationaryWalkThrough` (it must run at a different pipeline stage).
 *
 *  Runs BEFORE merge so a neighbouring drive can absorb the relabelled leg.
 *
 *  Pure: needs a `TrackSegment`-shaped input plus the day'\''s step rows.
 *  Returns a segment with `refinedMode` / `refinedReason` updated when a
 *  correction applies; otherwise returns the input unchanged.
 *
 *  Conservative on missing data: if `stepPoints` is empty (no Fitbit data
 *  for the day at all), no correction is applied — we don'\''t know the
 *  cadence and a false-positive correction would be worse than leaving
 *  the GPS classification alone.
 */
export function correctModeFromCadence<
	T extends TrackSegment & { refinedMode?: TransportMode; refinedReason?: string },
>(segment: T, stepPoints: StepPoint[]): T {
	if (stepPoints.length === 0) return segment;
	const duration = segment.endTs - segment.startTs;
	if (duration < CADENCE_CORRECTION_MIN_DURATION_S) return segment;

	const currentMode = effectiveMode(segment);
	if (currentMode !== "walking") return segment;
	if (segment.avgSpeed > WALKING_MAX_SPEED_KMH) return segment;

	// Freshness guard: only correct when there'\''s a step row at-or-after the
	// segment'\''s end, within the freshness window. That proves Fitbit data
	// has been pulled through the segment'\''s time period; otherwise zero
	// cadence might just mean the most recent sync hasn'\''t covered this
	// minute yet, and a real walk would be wrongly relabelled as driving.
	const hasFreshData = stepPoints.some(
		(sp) => sp.ts >= segment.endTs && sp.ts <= segment.endTs + CADENCE_CORRECTION_FRESHNESS_S,
	);
	if (!hasFreshData) return segment;

	const cadence = cadenceForSegment(segment, stepPoints);
	if (cadence >= WALKING_MIN_CADENCE) return segment;

	const reason = `low cadence (${cadence.toFixed(0)}/min)`;
	return {
		...segment,
		refinedMode: "driving",
		refinedReason: segment.refinedReason ? `${segment.refinedReason}; ${reason}` : reason,
		refinedKinds: addRefinedKind(segment.refinedKinds, "low-cadence"),
	};
}

/** Undo a `correctModeFromCadence` flip that has no vehicular context.
 *
 *  The cadence correction's whole purpose is "relabel a slow leg so a
 *  NEIGHBOURING DRIVE can absorb it" (see the comment on the call site). It
 *  relies entirely on the step counter, so when steps under-record — phone in
 *  hand, not wrist-worn, an irregular gait — a real slow walk reads as a
 *  passenger trip. Speed can't rescue it: a slow vehicle GPS mistook for
 *  walking is, by GPS alone, indistinguishable from a walk (that motivating
 *  leg even peaked HIGHER than the case the flip was designed for).
 *
 *  The signal that DOES separate them is context. A genuine slow-traffic leg
 *  sits next to real GPS-detected driving (the drive the merge will absorb it
 *  into); a pottering-about walk sits between walks and pedestrian stays. So a
 *  cadence flip is reverted to walking when BOTH:
 *    - no adjacent real (GPS-classified) driving — scanning past stationary
 *      stops and other cadence flips, since a flip is not independent
 *      vehicular evidence for its neighbour; and
 *    - the leg is pedestrian-paced (avg < CADENCE_REVERT_PEDESTRIAN_AVG_KMH),
 *      so an isolated genuinely-fast leg is left for the cadence call to own.
 *
 *  Sequence pass (needs neighbour context); pure. Runs right after
 *  `correctModeFromCadence`, before merge, so surviving flips can still be
 *  absorbed by their drive.
 */
export function revertIsolatedCadenceDrives<
	T extends TrackSegment & { refinedMode?: TransportMode; refinedReason?: string },
>(segments: T[]): T[] {
	const isCadenceFlip = (s: T): boolean =>
		s.mode === "walking" && s.refinedMode === "driving" && hasRefinedKind(s, "low-cadence");
	// A neighbour counts as "real driving" only if GPS classified it as driving
	// (base mode), not a sibling cadence flip — otherwise a run of flips would
	// vouch for each other and none would revert.
	const isRealDrive = (s: T): boolean => effectiveMode(s) === "driving" && !isCadenceFlip(s);
	// Scan outward in `dir`, skipping stationary stops and other cadence flips,
	// to the nearest segment that constitutes independent evidence; true iff it
	// is real driving.
	const hasDriveNeighbour = (i: number, dir: -1 | 1): boolean => {
		for (let j = i + dir; j >= 0 && j < segments.length; j += dir) {
			const s = segments[j];
			if (effectiveMode(s) === "stationary" || isCadenceFlip(s)) continue;
			return isRealDrive(s);
		}
		return false;
	};

	return segments.map((s, i) => {
		if (!isCadenceFlip(s)) return s;
		if (s.avgSpeed >= CADENCE_REVERT_PEDESTRIAN_AVG_KMH) return s;
		if (hasDriveNeighbour(i, -1) || hasDriveNeighbour(i, 1)) return s;
		const reason = "reverted cadence-drive: no adjacent driving (isolated pedestrian leg)";
		return {
			...s,
			refinedMode: "walking",
			refinedReason: s.refinedReason ? `${s.refinedReason}; ${reason}` : reason,
		};
	});
}

/** A "walking" segment whose single-minute *peak* step count never reaches this
 *  recorded no real walking minute at all — even a slow, interrupted urban walk
 *  produces one clear minute well above this. Below it, the GPS "movement" has
 *  no pedometer backing, so it is jitter, not a walk. */
const STATIONARY_JITTER_MAX_PEAK_CADENCE = 20;

/** ...and the path doubled back on itself: straight-line / path-length below
 *  this is GPS jitter wandering around one spot, not a directed walk from A to
 *  B. Observed 0.11–0.19 on the sit-still-but-jittering legs vs 0.57–0.85 on
 *  real walks the same evening. */
const STATIONARY_JITTER_MAX_LINEARITY = 0.35;

/** Demote a "walking" segment to stationary when the watch says you never took
 *  a walking step AND the GPS path just jittered around one spot. The
 *  motivating case: sitting indoors (a restaurant, a clinic waiting room) where
 *  urban-canyon / indoor GPS wanders enough to score as a slow walk, but the
 *  step counter — flat at ~0 — knows you were still. This is the missing third
 *  outcome for a low-cadence "walk": `correctModeFromCadence` handles the
 *  vehicle case (it translates), this handles the sitting case (it doesn't).
 *
 *  Two guards keep it from flattening a real walk Fitbit simply under-counted:
 *    - peak (not mean) cadence < `STATIONARY_JITTER_MAX_PEAK_CADENCE` — one
 *      clear walking minute anywhere in the window vetoes the demotion;
 *    - linearity < `STATIONARY_JITTER_MAX_LINEARITY` — a directed walk that
 *      actually translated is kept even if the steps were missed.
 *  Plus the same freshness guard as `correctModeFromCadence`: only act once
 *  Fitbit has synced through the segment, so "no steps" means "stood still",
 *  not "not pulled yet".
 *
 *  Runs after the cadence pass, before merge, so the newly-stationary leg can
 *  coalesce with the stays around it into one clean visit. Pure; conservative
 *  on missing data (empty `stepPoints` → no change).
 */
export function demoteJitterWalkToStationary<
	T extends TrackSegment & { refinedMode?: TransportMode; refinedReason?: string },
>(segment: T, stepPoints: StepPoint[]): T {
	if (stepPoints.length === 0) return segment;
	const duration = segment.endTs - segment.startTs;
	if (duration < CADENCE_CORRECTION_MIN_DURATION_S) return segment;
	if (effectiveMode(segment) !== "walking") return segment;
	if (segment.linearity >= STATIONARY_JITTER_MAX_LINEARITY) return segment;

	const hasFreshData = stepPoints.some(
		(sp) => sp.ts >= segment.endTs && sp.ts <= segment.endTs + CADENCE_CORRECTION_FRESHNESS_S,
	);
	if (!hasFreshData) return segment;

	const peak = peakCadenceForSegment(segment, stepPoints);
	if (peak >= STATIONARY_JITTER_MAX_PEAK_CADENCE) return segment;

	const reason = `no walking steps (peak ${peak.toFixed(0)}/min) + non-directed path (linearity ${segment.linearity.toFixed(2)}) — sitting, GPS jitter`;
	return {
		...segment,
		refinedMode: "stationary",
		refinedReason: segment.refinedReason ? `${segment.refinedReason}; ${reason}` : reason,
		refinedKinds: addRefinedKind(segment.refinedKinds, "gps-jitter"),
	};
}

/**
 * Symmetric counterpart to `correctModeFromCadence`: relabel a "stationary"
 * segment the GPS read as a stop into walking, when the watch recorded an
 * unmistakable walking burst AND the GPS shows the segment actually
 * translated. A slow, meandering walk-through (a park stroll, a wander between
 * two close stops) scores as stationary on GPS alone; the step counter knows
 * better. The two guards are what keep this safe:
 *   - peak (not mean) cadence ≥ `STATIONARY_WALK_PEAK_CADENCE` — one clear
 *     walking minute, so a slow / interrupted real walk still qualifies even
 *     though its mean cadence looks ambiguous;
 *   - avgSpeed ≥ `STATIONARY_WALK_MIN_AVG_SPEED_KMH` — in-place pacing at a
 *     real stay (home, a hospital ward) produces the same step burst with no
 *     GPS movement, so the translation guard protects genuine stays.
 * No freshness guard is needed: the trigger is the PRESENCE of a high-cadence
 * minute inside the window, which is itself proof Fitbit has data for it.
 *
 * MUST run AFTER the rail / drive absorbers (annotateUndergroundRuns,
 * absorbBoardingPlatform, absorbInterchanges, absorbDriveStops): walking
 * through a station during an underground interchange is genuine walking
 * (steps + translation), but it belongs to the train journey and those
 * specialised passes claim it first. Flipping it early chops the train run
 * and surfaces phantom concourse stops (the 2026-05-15 regression).
 *
 * Pure; conservative on missing data (empty `stepPoints` → no change).
 */
export function correctStationaryWalkThrough<
	T extends TrackSegment & { refinedMode?: TransportMode; refinedReason?: string },
>(segment: T, stepPoints: StepPoint[], points: readonly FilteredPoint[] = []): T {
	if (stepPoints.length === 0) return segment;
	const duration = segment.endTs - segment.startTs;
	if (duration < CADENCE_CORRECTION_MIN_DURATION_S) return segment;

	const currentMode = effectiveMode(segment);
	if (currentMode !== "stationary") return segment;
	if (segment.avgSpeed < STATIONARY_WALK_MIN_AVG_SPEED_KMH) return segment;

	// Physical-plausibility veto: a long segment whose fixes never leave a
	// tight radius is a STAY, no matter how a step burst or jitter-inflated
	// avgSpeed reads. The geometry (net-zero displacement) dominates the
	// per-fix speed. Skipped when no fixes are supplied.
	if (duration >= STATIONARY_WALK_STAY_MIN_DURATION_S) {
		const win = samplesInWindow(points, segment);
		if (win.length > 0) {
			const cLat = win.reduce((s, p) => s + p.lat, 0) / win.length;
			const cLon = win.reduce((s, p) => s + p.lon, 0) / win.length;
			let extent = 0;
			for (const p of win) extent = Math.max(extent, haversineMeters(cLat, cLon, p.lat, p.lon));
			if (extent <= STATIONARY_WALK_STAY_MAX_EXTENT_M) return segment;
		}
	}

	const peak = peakCadenceForSegment(segment, stepPoints);
	if (peak < STATIONARY_WALK_PEAK_CADENCE) return segment;

	const reason = `walking burst (${peak.toFixed(0)}/min) with GPS movement`;
	return {
		...segment,
		refinedMode: "walking",
		refinedReason: segment.refinedReason ? `${segment.refinedReason}; ${reason}` : reason,
	};
}

/** Segment shape the walk-through sequence pass needs: a TrackSegment plus the
 *  refined-mode / place / wayName fields carried by enriched segments. */
type WalkThroughSeg = TrackSegment & {
	refinedMode?: TransportMode;
	refinedReason?: string;
	place?: string;
	city?: string;
	wayName?: string;
};

/** Coalesce consecutive WALKING segments into one. Only touches walking —
 *  never trains or drives — so it cannot collapse two distinct train legs at
 *  an interchange (that bug killed the 2026-05-22 golden when a blanket
 *  mergeAdjacentMoving ran post-line-assignment). The merged run keeps a real
 *  `wayName` if either part has one, drops any stale stay `place`, and unions
 *  the time span / point count / max speed. */
function mergeAdjacentWalking<T extends WalkThroughSeg>(segments: T[]): T[] {
	const out: T[] = [];
	for (const seg of segments) {
		const prev = out[out.length - 1];
		if (prev && effectiveMode(prev) === "walking" && effectiveMode(seg) === "walking") {
			prev.endTs = seg.endTs;
			prev.pointCount += seg.pointCount;
			prev.maxSpeed = Math.max(prev.maxSpeed, seg.maxSpeed);
			if (!prev.wayName && seg.wayName) prev.wayName = seg.wayName;
			continue;
		}
		out.push({ ...seg });
	}
	return out;
}

/**
 * Apply `correctStationaryWalkThrough` across a time-ordered segment
 * sequence, with the cross-segment guard the per-segment rule can't see, then
 * tidy the result:
 *
 *  1. Place-continuity guard — a stationary stop bracketed by the SAME place
 *     on both sides is intra-place pacing (walking to the office bathroom and
 *     back), part of that stay, not a journey leg. Only a stop that
 *     TRANSITIONS between different places (or sits between moving legs) is a
 *     genuine walk-through. This is what kept the 2026-05-12 "stationary @
 *     Work" afternoon from fragmenting.
 *  2. Flip eligible stops to walking and drop their stay `place` label — a
 *     walk-through is no longer a stop.
 *  3. Merge adjacent walking runs (walking-only — see `mergeAdjacentWalking`)
 *     so the reclassified walk coalesces with the walk beside it instead of
 *     surfacing as a separate "walking @ <park>" sliver.
 *
 * MUST run after the rail / drive absorbers — see the contract on
 * `correctStationaryWalkThrough`.
 */
export function applyStationaryWalkThrough<T extends WalkThroughSeg>(
	segments: T[],
	stepPoints: StepPoint[],
	points: readonly FilteredPoint[] = [],
): T[] {
	const flipped = segments.map((seg, i) => {
		if (effectiveMode(seg) !== "stationary") return seg;

		const prev = segments[i - 1];
		const next = segments[i + 1];
		const bracketedBySamePlace =
			prev !== undefined &&
			next !== undefined &&
			effectiveMode(prev) === "stationary" &&
			effectiveMode(next) === "stationary" &&
			prev.place != null &&
			prev.place === next.place;
		if (bracketedBySamePlace) return seg;

		const out = correctStationaryWalkThrough(seg, stepPoints, points);
		if (out === seg || out.refinedMode !== "walking") return out;
		// Reclassified to walking → the stay label no longer applies.
		return { ...out, place: undefined, city: undefined };
	});
	return mergeAdjacentWalking(flipped);
}

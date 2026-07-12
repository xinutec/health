/**
 * Transport mode classification from Kalman-filtered GPS tracks.
 *
 * Splits a track into time windows, calculates movement features per window,
 * scores each transport mode, then merges adjacent windows with the same mode
 * into segments. Smooths transitions to avoid impossible mode flipping.
 */

import type { FilteredPoint } from "./kalman.js";
import { samplesInWindow } from "./segment-util.js";

/** Every mode the pipeline can attribute to a stretch of time.
 *
 *  Two of these are not physical modes but honest statements of ignorance, and
 *  the distinction matters:
 *    - `unknown` — no observation at all (a GPS gap). We do not know *where*
 *      you were, let alone how you got there.
 *    - `vehicle` — you were plainly in a vehicle (vehicle-speed, linear track)
 *      but nothing identified *which*: no road matched, no street name, no bus
 *      route, no rail line. Distinct from `driving`, which asserts a car.
 *
 *  `driving` doubles as the working placeholder for an unidentified road
 *  vehicle *inside* the cascade — the rail and bus passes each get a chance to
 *  claim it — and `resolveVehicleIdentity` runs last to demote any placeholder
 *  that nobody claimed to `vehicle`. So `driving` means "a car" on the way out,
 *  even though it means "some vehicle" on the way through.
 *
 *  Note `bus` is NOT here: a bus is a `driving` segment carrying
 *  `vehicleKind: "bus"`, flattened to a `bus` mode at the day-state layer. */
export type TransportMode =
	| "stationary"
	| "walking"
	| "cycling"
	| "driving"
	| "vehicle"
	| "train"
	| "boat"
	| "plane"
	| "unknown";

/** The modes a *generative* model may emit: the physical ones.
 *
 *  The HSMM keys its emission, duration and transition priors on this rather
 *  than on the full {@link TransportMode}, because two of those are not things
 *  the world does — they are things *we* say when we cannot tell:
 *    - `vehicle` is produced by `resolveVehicleIdentity` at the very end of the
 *      velocity cascade, as an admission that no pass identified the ride. A
 *      decoder cannot have a speed/heart-rate signature for "unidentified".
 *    - `boat` is an OSM-geometry refinement (you were on a waterway), never a
 *      state the motion model proposes on its own.
 *
 *  Keeping them out of the model's alphabet means a `Record<ModelledMode, …>`
 *  of priors stays exhaustive and honest, instead of forcing a made-up prior
 *  for a mode that exists only to say "I don't know". */
export type ModelledMode = Exclude<TransportMode, "vehicle" | "boat">;

/** A machine-readable tag for the *kind* of refinement a downstream pass made,
 *  for the cases where a later pass needs to branch on "was this segment touched
 *  by rule X?". This exists alongside the free-form `refinedReason` string so
 *  control flow never depends on substring-matching a human-readable sentence
 *  (reword the sentence and the matching silently breaks). Only kinds that some
 *  pass actually branches on are enumerated here:
 *    - `gps-gap-inferred` — mode synthesised across a no-coverage gap from the
 *      implied straight-line speed (see {@link inferGapSegments}); a candidate
 *      for rail upgrade.
 *    - `gps-jitter` — a "walking" leg demoted to stationary because the watch
 *      recorded no steps and the path only jittered in place (sitting indoors).
 *    - `low-cadence` — a leg flipped to driving by the low-cadence rule, so a
 *      later pass can revert it when it has no vehicular neighbour. */
export type RefinedKind = "gps-gap-inferred" | "gps-jitter" | "low-cadence";

export interface TrackSegment {
	startTs: number;
	endTs: number;
	mode: TransportMode;
	/** Probability of the chosen mode given the window features — share of
	 *  total mode score, normalised to [0,1]. Confident classifications
	 *  approach 1; a coin flip between two modes sits at 0.5. */
	confidence: number;
	/** Ratio of the top mode score to the runner-up. > 2 is unambiguous;
	 *  ~1 is genuinely ambiguous (low margin). Capped at MARGIN_MAX_FINITE
	 *  to keep the value JSON-serialisable. */
	confidenceMargin: number;
	avgSpeed: number; // km/h
	maxSpeed: number;
	linearity: number; // 0-1, ratio of straight-line to path distance
	pointCount: number;
	/** Free-form annotation: why this segment is the mode it is. Set by
	 *  cross-modal inference (cadence correction, gap inference) and by
	 *  OSM-aware mode refinement downstream. Optional; absent on plain
	 *  GPS-classified segments. For display and debugging only — never branch
	 *  on its text; use {@link refinedKinds} for that. */
	refinedReason?: string;
	/** Machine-readable tags for refinements a later pass branches on. Carried
	 *  forward (merged) as a segment passes through the cascade, in parallel
	 *  with `refinedReason`. Absent when no branch-relevant refinement applied.
	 *  See {@link RefinedKind}. */
	refinedKinds?: readonly RefinedKind[];
}

export interface WindowFeatures {
	startTs: number;
	endTs: number;
	centroidLat: number;
	centroidLon: number;
	medianSpeed: number;
	maxSpeed: number;
	speedVariance: number;
	headingChangeRate: number; // degrees per second
	linearity: number;
	accelerationBursts: number; // count of speed changes > 5 km/h/s
	stopFraction: number; // fraction of points with speed < 1 km/h
	netDisplacement: number; // meters between first and last point
	boundingRadius: number; // meters, max distance from centroid
	pointCount: number;
}

// --- Feature extraction ---

function median(arr: number[]): number {
	if (arr.length === 0) return 0;
	const sorted = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function variance(arr: number[]): number {
	if (arr.length < 2) return 0;
	const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
	return arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (arr.length - 1);
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6371000;
	const dLat = (lat2 - lat1) * (Math.PI / 180);
	const dLon = (lon2 - lon1) * (Math.PI / 180);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function extractFeatures(points: FilteredPoint[], windowSec: number): WindowFeatures[] {
	if (points.length < 2) return [];

	const windows: WindowFeatures[] = [];
	let windowStart = 0;

	while (windowStart < points.length) {
		const startTs = points[windowStart].ts;
		const endTs = startTs + windowSec;

		// Collect points in this window
		let windowEnd = windowStart;
		while (windowEnd < points.length && points[windowEnd].ts < endTs) {
			windowEnd++;
		}

		const windowPoints = points.slice(windowStart, windowEnd);
		if (windowPoints.length < 2) {
			windowStart = windowEnd;
			continue;
		}

		const speeds = windowPoints.map((p) => p.speed_kmh);
		const bearings = windowPoints.map((p) => p.bearing);

		// Heading change rate (degrees per second)
		let totalHeadingChange = 0;
		for (let i = 1; i < bearings.length; i++) {
			let diff = Math.abs(bearings[i] - bearings[i - 1]);
			if (diff > 180) diff = 360 - diff;
			totalHeadingChange += diff;
		}
		const duration = windowPoints[windowPoints.length - 1].ts - windowPoints[0].ts || 1;
		const headingChangeRate = totalHeadingChange / duration;

		// Path linearity: straight-line distance / total path distance
		const straightLine = haversineMeters(
			windowPoints[0].lat,
			windowPoints[0].lon,
			windowPoints[windowPoints.length - 1].lat,
			windowPoints[windowPoints.length - 1].lon,
		);
		let pathDistance = 0;
		for (let i = 1; i < windowPoints.length; i++) {
			pathDistance += haversineMeters(
				windowPoints[i - 1].lat,
				windowPoints[i - 1].lon,
				windowPoints[i].lat,
				windowPoints[i].lon,
			);
		}
		const linearity = pathDistance > 0 ? Math.min(straightLine / pathDistance, 1) : 0;

		// Acceleration bursts: speed changes > 5 km/h between consecutive points
		let accelBursts = 0;
		for (let i = 1; i < windowPoints.length; i++) {
			const dt = windowPoints[i].ts - windowPoints[i - 1].ts || 1;
			const accel = Math.abs(speeds[i] - speeds[i - 1]) / dt;
			if (accel > 5 / 3.6) accelBursts++; // 5 km/h/s
		}

		// Stop fraction
		const stops = speeds.filter((s) => s < 1).length;

		// Net displacement: straight-line distance from start to end
		const netDisplacement = straightLine;

		// Bounding radius: max distance from centroid
		const centroidLat = windowPoints.reduce((s, p) => s + p.lat, 0) / windowPoints.length;
		const centroidLon = windowPoints.reduce((s, p) => s + p.lon, 0) / windowPoints.length;
		let maxDist = 0;
		for (const p of windowPoints) {
			const d = haversineMeters(centroidLat, centroidLon, p.lat, p.lon);
			if (d > maxDist) maxDist = d;
		}
		const boundingRadius = maxDist;

		windows.push({
			startTs: windowPoints[0].ts,
			endTs: windowPoints[windowPoints.length - 1].ts,
			centroidLat,
			centroidLon,
			medianSpeed: median(speeds),
			maxSpeed: Math.max(...speeds),
			speedVariance: variance(speeds),
			headingChangeRate,
			linearity,
			accelerationBursts: accelBursts,
			stopFraction: stops / speeds.length,
			netDisplacement,
			boundingRadius,
			pointCount: windowPoints.length,
		});

		windowStart = windowEnd;
	}

	return windows;
}

// --- Mode scoring ---

export interface ModeScore {
	mode: TransportMode;
	score: number;
}

/** Maximum finite margin value, used when the runner-up score is zero
 *  (single-element input, or all-zero array with one non-zero entry). A
 *  finite cap keeps the value JSON-serialisable and bounded for downstream
 *  consumers without losing the "unambiguous" signal. */
const MARGIN_MAX_FINITE = 1000;

/** Driving max plausible speed in km/h. Autobahn / Italian autostrada
 *  can briefly hit 240 km/h legitimately; we set the bar at 250 to give
 *  high-end legal driving the benefit of the doubt. A segment whose max
 *  sustained speed exceeds this cannot be driving — must be train. */
const DRIVING_MAX_SPEED_KMH = 250;

/** Train max plausible average speed. TGV / Shinkansen / Eurostar top
 *  out around 350 km/h scheduled; we set the override at 400 km/h
 *  average to leave room for individual peaks. Anything sustained
 *  above this must be a plane (or GPS noise, but GPS noise produces
 *  high MAX, not high AVG over an extended segment). */
const TRAIN_MAX_AVG_SPEED_KMH = 400;

/**
 * Hard physical-impossibility overrides. A car cannot sustain 300 km/h
 * regardless of what the GPS/OSM classification says; a train cannot
 * average 600 km/h. These constraints hold independent of biometric
 * data, OSM context, or anything else.
 *
 * Apply as a post-classification override so that downstream passes
 * (mergeAdjacentMoving, annotateRailRuns, biometric correction) see the
 * physically consistent mode.
 */
export function enforcePhysicalConstraints(seg: TrackSegment): TrackSegment {
	if (seg.mode === "driving" && seg.maxSpeed > DRIVING_MAX_SPEED_KMH) {
		// 300+ km/h is the LGV / high-speed rail signature. Driving is
		// impossible at these speeds; relabel as train.
		return {
			...seg,
			mode: "train",
			refinedReason: `physical-impossibility override (max ${seg.maxSpeed.toFixed(0)} km/h exceeds driving limit)`,
		};
	}
	if (seg.mode === "train" && seg.avgSpeed > TRAIN_MAX_AVG_SPEED_KMH) {
		return {
			...seg,
			mode: "plane",
			refinedReason: `physical-impossibility override (avg ${seg.avgSpeed.toFixed(0)} km/h exceeds train limit)`,
		};
	}
	return seg;
}

/** A genuine stay mills around a point: its fixes scatter (LOW linearity)
 *  and stay put. Above this linearity the motion is *directed* — the user
 *  is travelling in a line, not dwelling. */
export const STAY_MAX_LINEARITY = 0.7;
/** Maximum straight-line, start-to-end displacement a real stay may show.
 *  GPS smear + a large venue footprint stay well under this; a walk toward
 *  a station crosses it. Paired with the linearity gate so a jittery (but
 *  genuinely still) stay — which never reaches high linearity — is safe. */
export const STAY_MAX_NET_DISPLACEMENT_M = 90;

/**
 * Stationary-coherence constraint: a segment labelled `stationary` whose
 * fixes progress in a directed line over a real distance is not a stay —
 * it is slow locomotion (a walk to a platform, a crawl through traffic)
 * that low per-fix speed misread as dwelling. Left unchecked, the place
 * step then names the "stay" after whatever POI it drifted past (the
 * 2026-06-12 "Bleecker" / "The Other Palace" phantoms on the walk to
 * Victoria). This is a physical-impossibility constraint, not a heuristic:
 * a stay does not translate `STAY_MAX_NET_DISPLACEMENT_M` along a straight
 * line. Pure decision so the calibration is unit-testable.
 */
export function isStationaryIncoherent(opts: { linearity: number; netDisplacementM: number }): boolean {
	return opts.linearity > STAY_MAX_LINEARITY && opts.netDisplacementM > STAY_MAX_NET_DISPLACEMENT_M;
}

/**
 * Normalise raw mode scores from `scoreWindow` into a probability + margin.
 *
 * - `probability`: share-of-total. The top mode's score divided by the sum
 *   of all scores. A confident classification approaches 1.0; a coin flip
 *   between two modes sits at 0.5.
 * - `margin`: ratio of the top score to the runner-up. > 2 is unambiguous;
 *   ~1 is genuinely ambiguous.
 *
 * Kept as a pure function so the calibration is testable without rebuilding
 * a whole pipeline. Returns sentinel values for degenerate inputs (empty
 * array or all-zero scores) so callers don't need defensive checks.
 */
export function normalizeScores(scores: ModeScore[]): {
	mode: TransportMode;
	probability: number;
	margin: number;
} {
	if (scores.length === 0) return { mode: "stationary", probability: 0, margin: 1 };
	const top = scores[0];
	const sum = scores.reduce((acc, s) => acc + s.score, 0);
	if (sum === 0) return { mode: top.mode, probability: 0, margin: 1 };
	const probability = top.score / sum;
	const runnerUp = scores.length > 1 ? scores[1].score : 0;
	const margin = runnerUp > 0 ? Math.min(top.score / runnerUp, MARGIN_MAX_FINITE) : MARGIN_MAX_FINITE;
	return { mode: top.mode, probability, margin };
}

export function scoreWindow(f: WindowFeatures): ModeScore[] {
	const scores: ModeScore[] = [
		{ mode: "stationary", score: scoreStationary(f) },
		{ mode: "walking", score: scoreWalking(f) },
		{ mode: "cycling", score: scoreCycling(f) },
		{ mode: "driving", score: scoreDriving(f) },
		{ mode: "train", score: scoreTrain(f) },
		{ mode: "plane", score: scorePlane(f) },
	];
	return scores.sort((a, b) => b.score - a.score);
}

/**
 * Temper a road-vehicle segment's confidence by whether the GPS actually
 * followed a road (#296 → joint decision). `scoreWindow` picks the mode from
 * MOTION alone, so a fast, straight leg scores as "driving" with high
 * confidence even when it's a Tube — a train and a car are identical at 40-90
 * km/h. The corridor evidence (`roadCorridorFraction` — the share of the track
 * that hugs a drivable road) is the missing input: a "driving" leg that hugs no
 * road is genuinely ambiguous (could be rail), so its confidence should not be
 * a motion-only 100%.
 *
 * Only road vehicles (`driving`; buses are `driving` too) are affected — train /
 * walk / cycle are untouched. `null` fraction (no road data) leaves it unchanged.
 * At full road support (fraction ≥ 0.5) confidence is unchanged; with no road
 * under the track it is halved. Measured safe on the golden corpus: real driving
 * sits at fraction ~1.0, trains at ~0.2.
 */
export function roadSupportedConfidence(
	mode: TransportMode,
	confidence: number,
	roadCorridorFraction: number | null,
): number {
	if (mode !== "driving" || roadCorridorFraction === null) return confidence;
	const support = 0.5 + Math.min(0.5, Math.max(0, roadCorridorFraction));
	return Math.round(confidence * support * 100) / 100;
}

// Gaussian-like scoring: how well does the value match the expected range?
function rangeScore(value: number, ideal: number, tolerance: number): number {
	return Math.exp(-0.5 * ((value - ideal) / tolerance) ** 2);
}

function scoreStationary(f: WindowFeatures): number {
	let score = rangeScore(f.medianSpeed, 0, 1.5);
	score *= 1 + f.stopFraction; // bonus for lots of stops

	// Key insight: if all points are within a small radius, it's stationary
	// regardless of GPS-noise-induced speed. Catches stone-throwing, fidgeting, etc.
	if (f.boundingRadius < 30) score *= 3;
	if (f.boundingRadius < 15) score *= 3;
	if (f.netDisplacement < 20) score *= 2;

	// Hidden-movement penalty: stationary should mean *consistently* low speed
	// AND no significant displacement. A high max speed combined with a real
	// net displacement (>200m) means the user actually moved during the window
	// — typically a train segment that surfaced briefly between underground
	// stretches. Without this, sparse-GPS train rides hide inside a stationary
	// segment whose median speed is dominated by the surrounding platform fixes.
	// A GPS noise spike (high max but no displacement) doesn't trigger this.
	if (f.maxSpeed > 20 && f.netDisplacement > 200) score *= 0.1;

	return score;
}

function scoreWalking(f: WindowFeatures): number {
	let score = rangeScore(f.medianSpeed, 4, 3); // 1-7 km/h
	score *= rangeScore(f.linearity, 0.5, 0.4); // moderate linearity
	score *= 1 + f.headingChangeRate * 0.5; // walking has more turns
	if (f.maxSpeed > 15) score *= 0.1; // unlikely if max speed is high

	// If you don't actually go anywhere, it's not walking
	if (f.boundingRadius < 30) score *= 0.1;
	if (f.netDisplacement < 30) score *= 0.2;

	return score;
}

function scoreCycling(f: WindowFeatures): number {
	let score = rangeScore(f.medianSpeed, 18, 8); // 10-26 km/h
	score *= rangeScore(f.linearity, 0.7, 0.3);
	score *= rangeScore(f.speedVariance, 15, 20); // moderate variance
	if (f.maxSpeed > 50) score *= 0.1;
	return score;
}

function scoreDriving(f: WindowFeatures): number {
	let score = rangeScore(f.medianSpeed, 60, 35); // 25-95 km/h
	score *= 1 + f.accelerationBursts * 0.3; // cars accelerate/brake
	score *= rangeScore(f.linearity, 0.7, 0.3);
	if (f.medianSpeed < 10) score *= 0.1;
	return score;
}

function scoreTrain(f: WindowFeatures): number {
	let score = rangeScore(f.medianSpeed, 120, 60); // 60-180 km/h
	score *= rangeScore(f.linearity, 0.95, 0.1); // very linear
	score *= rangeScore(f.speedVariance, 5, 15); // very consistent speed
	score *= rangeScore(f.headingChangeRate, 0.5, 2); // minimal turning
	if (f.medianSpeed < 30) score *= 0.1;
	return score;
}

function scorePlane(f: WindowFeatures): number {
	let score = rangeScore(f.medianSpeed, 500, 300); // 200-800 km/h
	score *= rangeScore(f.linearity, 0.99, 0.05); // extremely linear
	score *= rangeScore(f.speedVariance, 2, 10); // extremely consistent
	if (f.medianSpeed < 150) score *= 0.01;
	return score;
}

// --- Segment merging ---

/** A new stationary window joining a stationary segment forces a split if its
 * centroid is more than this far from the segment's running centroid. Catches
 * "you were stationary at A, then stationary at B, 280m away" — two stays,
 * not one. Threshold matches STAY_RADIUS_M used elsewhere. */
const STATIONARY_SPLIT_DIST_M = 100;

function mergeWindows(windows: WindowFeatures[], scores: ModeScore[][]): TrackSegment[] {
	if (windows.length === 0) return [];

	const segments: TrackSegment[] = [];
	let currentMode = scores[0][0].mode;
	let segStart = 0;

	function flushSegment(endIdx: number): void {
		const segWindows = windows.slice(segStart, endIdx);
		const segScores = scores.slice(segStart, endIdx);
		const allSpeeds = segWindows.map((w) => w.medianSpeed);
		// Per-window probability + margin, averaged across the segment.
		// Each window's probability is the share-of-total of its top mode
		// score; averaging is approximately the segment-wide posterior
		// confidence (close enough for a heuristic).
		const norms = segScores.map(normalizeScores);
		const avgConfidence = norms.reduce((sum, n) => sum + n.probability, 0) / norms.length;
		const avgMargin = norms.reduce((sum, n) => sum + n.margin, 0) / norms.length;
		const avgLinearity = segWindows.reduce((sum, w) => sum + w.linearity, 0) / segWindows.length;

		segments.push({
			startTs: segWindows[0].startTs,
			endTs: segWindows[segWindows.length - 1].endTs,
			mode: currentMode,
			confidence: Math.round(avgConfidence * 100) / 100,
			confidenceMargin: Math.round(avgMargin * 100) / 100,
			avgSpeed: Math.round(median(allSpeeds) * 10) / 10,
			maxSpeed: Math.round(Math.max(...segWindows.map((w) => w.maxSpeed)) * 10) / 10,
			linearity: Math.round(avgLinearity * 100) / 100,
			pointCount: segWindows.reduce((sum, w) => sum + w.pointCount, 0),
		});
	}

	for (let i = 1; i <= windows.length; i++) {
		const newMode = i < windows.length ? scores[i][0].mode : null;

		// Force-split a stationary segment if the new stationary window is far
		// from the segment's running centroid. Same-mode windows otherwise merge
		// regardless of location, which would collapse two distinct stays.
		let locationSplit = false;
		if (i < windows.length && currentMode === "stationary" && newMode === "stationary") {
			const segWindows = windows.slice(segStart, i);
			const totalPts = segWindows.reduce((s, w) => s + w.pointCount, 0);
			const cLat = segWindows.reduce((s, w) => s + w.centroidLat * w.pointCount, 0) / totalPts;
			const cLon = segWindows.reduce((s, w) => s + w.centroidLon * w.pointCount, 0) / totalPts;
			const next = windows[i];
			const dist = haversineMeters(cLat, cLon, next.centroidLat, next.centroidLon);
			if (dist > STATIONARY_SPLIT_DIST_M) locationSplit = true;
		}

		if (newMode !== currentMode || locationSplit || i === windows.length) {
			flushSegment(i);
			if (i < windows.length) {
				currentMode = scores[i][0].mode;
				segStart = i;
			}
		}
	}

	return segments;
}

/**
 * Remove segments shorter than minDuration by merging them into neighbors.
 * A 10-second "driving" segment between two "walking" segments is noise.
 */
export function smoothSegments(segments: TrackSegment[], minDurationSec: number): TrackSegment[] {
	if (segments.length <= 1) return segments;

	// Copy every segment we keep: the merge branch below mutates the last
	// element of `result` in place, so aliasing an input object would corrupt
	// the caller's array. (Today the caller passes fresh mergeWindows output,
	// but the copy makes the no-mutation contract hold for any caller.)
	const result: TrackSegment[] = [{ ...segments[0] }];

	for (let i = 1; i < segments.length; i++) {
		const seg = segments[i];
		const duration = seg.endTs - seg.startTs;

		if (duration < minDurationSec && result.length > 0) {
			// Too short — merge into previous segment
			const prev = result[result.length - 1];
			prev.endTs = seg.endTs;
			prev.pointCount += seg.pointCount;
			prev.maxSpeed = Math.max(prev.maxSpeed, seg.maxSpeed);
		} else {
			result.push({ ...seg });
		}
	}

	return result;
}

// --- Stay detection (sparse-data fallback) ---

const STAY_MIN_DURATION_SEC = 15 * 60; // 15 minutes
/** Trajectory-segmentation radius for honest-gaps findStays. A new fix
 *  beyond this distance from the running cluster centroid starts a new
 *  cluster. Sized to tolerate indoor / urban-canyon GPS jitter that can
 *  push consecutive in-place fixes 80-130 m apart while still separating
 *  distinct buildings — typical inter-POI spacing in a dense urban
 *  neighbourhood is 200+ m. Matches the established `STAY_RADIUS_M`
 *  used by other parts of the pipeline so the conceptual "what counts
 *  as the same place" radius is consistent across modules. */
const CLUSTER_RADIUS_M = 150;

interface StayPoint {
	ts: number;
	lat: number;
	lon: number;
}

/**
 * Find stationary "stays" in time periods not covered by any classified
 * segment, using time-ordered trajectory segmentation.
 *
 * For each gap between (and around) classified segments, walk the in-gap
 * points in time order, maintaining a running cluster. A point within
 * `CLUSTER_RADIUS_M` of the current cluster's centroid joins it; a point
 * outside that radius closes the current cluster and starts a new one.
 * Each closed cluster with ≥ 2 fixes spanning ≥ STAY_MIN_DURATION_SEC
 * becomes a stationary stay.
 *
 * This replaces an earlier single-median + 150 m radius approach that
 * collapsed multi-stop days (e.g. Bairro Alto → parents' → café, all
 * within 500 m of each other) into one phantom stay anchored at the
 * day-wide median. With trajectory segmentation, each distinct stop
 * surfaces as its own stay.
 *
 * Outlier tolerance: a single bad GPS fix that jumps outside
 * `CLUSTER_RADIUS_M` from the cluster's centroid will start a new
 * cluster of size 1. If the next in-time fix is back near the original
 * cluster's centroid, the 1-fix outlier cluster fails the ≥ 2 fix
 * threshold and is dropped, and the next fix joins the original
 * cluster. Net effect: the outlier is excluded without fracturing the
 * surrounding stay.
 */
export function findStays(points: StayPoint[], existing: TrackSegment[]): TrackSegment[] {
	if (points.length === 0) return [];

	const sorted = [...existing].sort((a, b) => a.startTs - b.startTs);
	const gaps: Array<{ start: number; end: number }> = [];

	if (sorted.length === 0) {
		gaps.push({ start: points[0].ts, end: points[points.length - 1].ts });
	} else {
		const firstPointTs = points[0].ts;
		if (sorted[0].startTs - firstPointTs >= STAY_MIN_DURATION_SEC) {
			gaps.push({ start: firstPointTs, end: sorted[0].startTs });
		}
		for (let i = 0; i < sorted.length - 1; i++) {
			const gapStart = sorted[i].endTs;
			const gapEnd = sorted[i + 1].startTs;
			if (gapEnd - gapStart >= STAY_MIN_DURATION_SEC) {
				gaps.push({ start: gapStart, end: gapEnd });
			}
		}
		const lastPointTs = points[points.length - 1].ts;
		const lastSegEnd = sorted[sorted.length - 1].endTs;
		if (lastPointTs - lastSegEnd >= STAY_MIN_DURATION_SEC) {
			gaps.push({ start: lastSegEnd, end: lastPointTs });
		}
	}

	const stays: TrackSegment[] = [];

	function emitStay(cluster: StayPoint[]): void {
		if (cluster.length < 2) return;
		const sortedCluster = [...cluster].sort((a, b) => a.ts - b.ts);
		const duration = sortedCluster[sortedCluster.length - 1].ts - sortedCluster[0].ts;
		if (duration < STAY_MIN_DURATION_SEC) return;
		stays.push({
			startTs: sortedCluster[0].ts,
			endTs: sortedCluster[sortedCluster.length - 1].ts,
			mode: "stationary",
			// Stays detected by trajectory clustering are unambiguous by
			// construction — every point in the cluster fits within
			// CLUSTER_RADIUS_M of the running centroid for the minimum
			// duration. High probability, high margin.
			confidence: 0.9,
			confidenceMargin: MARGIN_MAX_FINITE,
			avgSpeed: 0,
			maxSpeed: 0,
			linearity: 0,
			pointCount: sortedCluster.length,
		});
	}

	for (const gap of gaps) {
		const inGap = samplesInWindow(points, { startTs: gap.start, endTs: gap.end }).sort((a, b) => a.ts - b.ts);
		if (inGap.length < 2) continue;

		let cluster: StayPoint[] = [];
		// Centroid maintained as a running mean — recomputed on each add.
		let cLat = 0;
		let cLon = 0;

		for (const p of inGap) {
			if (cluster.length === 0) {
				cluster = [p];
				cLat = p.lat;
				cLon = p.lon;
				continue;
			}
			const d = haversineMeters(cLat, cLon, p.lat, p.lon);
			if (d <= CLUSTER_RADIUS_M) {
				cluster.push(p);
				// Running mean: O(1) update.
				cLat += (p.lat - cLat) / cluster.length;
				cLon += (p.lon - cLon) / cluster.length;
			} else {
				emitStay(cluster);
				cluster = [p];
				cLat = p.lat;
				cLon = p.lon;
			}
		}
		emitStay(cluster);
	}

	return stays;
}

// --- Public API ---

const WINDOW_SEC = 300; // 5 minute windows
const MIN_SEGMENT_SEC = 120; // segments shorter than 2 min get merged

/** Minimum gap duration between two segments to consider inferring transit. */
const TRANSIT_GAP_MIN_DURATION_S = 3 * 60;
/** Minimum displacement between the points bounding the gap. Below this, the
 *  user effectively stayed put and the gap is just sparse GPS / no movement. */
const TRANSIT_GAP_MIN_DISTANCE_M = 200;
/** A gap whose implied straight-line speed is below this is sub-walking pace —
 *  no plausible mode covers it. The user was almost certainly stationary
 *  somewhere we can't observe; emit `unknown` rather than fabricating
 *  "walking at 0.1 km/h". */
const SLOW_GAP_MAX_SPEED_KMH = 1.5;
/** Sub-walking-pace gaps shorter than this stay as today's walking inference
 *  ("loitering between two close stops"). Beyond this duration, sub-walking
 *  pace becomes `unknown` — the user was stationary at one of the endpoints
 *  for most of the gap, or somewhere we missed entirely. */
const SLOW_GAP_MIN_DURATION_S = 30 * 60;

/**
 * Insert synthetic transit segments for time gaps where GPS coverage is
 * absent but the user clearly moved. Catches the underground-train and
 * Faraday-cage cases (Eurostar, metro) where the segment classifier sees
 * "stationary at A" then "stationary at B" with no movement in between.
 *
 * For each pair of adjacent segments separated by at least
 * TRANSIT_GAP_MIN_DURATION_S of dead time, we look at the last point
 * before the gap and the first point after. If their displacement exceeds
 * TRANSIT_GAP_MIN_DISTANCE_M, we synthesise a segment covering the gap
 * with `mode` chosen by the implied average speed and a `refinedReason`
 * marking it as inferred. Inferred segments have pointCount=0 so OSM
 * enrichment (which iterates point arrays) skips them naturally.
 */
export function inferTransitGaps(segments: TrackSegment[], points: FilteredPoint[]): TrackSegment[] {
	if (segments.length < 2 || points.length < 2) return segments;
	const result: TrackSegment[] = [];
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		result.push(seg);
		const next = segments[i + 1];
		if (!next) continue;
		const gapDuration = next.startTs - seg.endTs;
		if (gapDuration < TRANSIT_GAP_MIN_DURATION_S) continue;

		const lastBefore = lastPointAtOrBefore(points, seg.endTs);
		const firstAfter = firstPointAtOrAfter(points, next.startTs);
		if (!lastBefore || !firstAfter) continue;

		const distanceM = haversineMeters(lastBefore.lat, lastBefore.lon, firstAfter.lat, firstAfter.lon);
		if (distanceM < TRANSIT_GAP_MIN_DISTANCE_M) continue;

		const speedKmh = (distanceM / gapDuration) * 3.6;
		// Coarse mode guess from implied speed. Cycling/walking/driving are
		// hard to distinguish at low speeds (a 15 km/h gap could be cycling,
		// tram, slow car), so we collapse the middle band into "driving" as
		// the conservative vehicle-of-some-kind. Walking covers the bottom
		// (under-7 km/h gaps that crossed the 200m distance threshold).
		//
		// Train continuity: if a bordering segment is itself rail, upgrade
		// a vehicle-speed gap to "train". A 38 km/h gap between Saint
		// Espresso and a Jubilee Line tube ride is part of the same
		// transit chain (e.g. line interchange), not a sudden car ride in
		// the middle of London Underground.
		//
		// "Bordering is rail" sources:
		//   - segment.mode is already "train" or "plane" (classifier picked it)
		//   - segment looks rail-shaped from features alone: very high
		//     linearity (>0.95) + high maxSpeed (>60 km/h). Rail tracks
		//     are straighter than roads. The user's motorway drives top
		//     out around linearity 0.91; tube/train hit 0.99. This catches
		//     the case where the classifier picked driving for the tube
		//     but OSM refineMode (which runs *after* inferTransitGaps in
		//     the velocity pipeline) would later upgrade it to train.
		const looksLikeRail = (s: TrackSegment): boolean =>
			s.mode === "train" || s.mode === "plane" || (s.linearity > 0.95 && s.maxSpeed > 60);
		const neighbouringTransit = looksLikeRail(seg) || looksLikeRail(next);
		// Sub-walking-pace gap covering more than half an hour. The user
		// did not walk this; they were stationary at a place we don't
		// observe. Emit `unknown` rather than fabricate a walking
		// trajectory at 0.1 km/h.
		const honestUnknown = speedKmh < SLOW_GAP_MAX_SPEED_KMH && gapDuration >= SLOW_GAP_MIN_DURATION_S;
		let inferredMode: TransportMode;
		if (honestUnknown) {
			inferredMode = "unknown";
		} else if (speedKmh < 7) {
			inferredMode = "walking";
		} else if (speedKmh >= 120) {
			inferredMode = "train";
		} else if (neighbouringTransit) {
			inferredMode = "train";
		} else {
			inferredMode = "driving";
		}
		const km = (distanceM / 1000).toFixed(1);
		const min = Math.round(gapDuration / 60);
		const reason = honestUnknown
			? `no GPS coverage for ${min} min (${km} km between endpoints — sub-walking pace)`
			: `inferred from GPS gap (${km} km in ${min} min)`;
		result.push({
			startTs: seg.endTs,
			endTs: next.startTs,
			mode: inferredMode,
			// Inferred from implied speed across a gap with no observations
			// — genuinely ambiguous mode-wise. Low probability, low margin.
			// `unknown` is even less certain: not a positive mode claim
			// at all, just an honest "no data".
			confidence: honestUnknown ? 0.1 : 0.3,
			confidenceMargin: honestUnknown ? 1 : 1.2,
			avgSpeed: honestUnknown ? 0 : Math.round(speedKmh * 10) / 10,
			maxSpeed: honestUnknown ? 0 : Math.round(speedKmh * 10) / 10,
			linearity: honestUnknown ? 0 : 1,
			pointCount: 0,
			refinedReason: reason,
			// Tag the positively-inferred (non-`unknown`) gap so a later pass can
			// branch on it without re-parsing `reason`. The honest-unknown gap is
			// not a mode claim, so it carries no kind.
			refinedKinds: honestUnknown ? undefined : ["gps-gap-inferred"],
		});
	}
	return result;
}

function lastPointAtOrBefore(points: FilteredPoint[], ts: number): FilteredPoint | null {
	let result: FilteredPoint | null = null;
	for (const p of points) {
		if (p.ts <= ts) result = p;
		else break;
	}
	return result;
}

function firstPointAtOrAfter(points: FilteredPoint[], ts: number): FilteredPoint | null {
	for (const p of points) {
		if (p.ts >= ts) return p;
	}
	return null;
}

/**
 * Classify a Kalman-filtered GPS track into transport mode segments.
 *
 * Optionally accepts a separate (looser-accuracy) point set to use for
 * stay detection — indoor GPS is often filtered out of the movement
 * pipeline but is still useful evidence that you were at one place.
 */
export function classifySegments(points: FilteredPoint[], stayPoints?: StayPoint[]): TrackSegment[] {
	const windows = extractFeatures(points, WINDOW_SEC);

	let classified: TrackSegment[] = [];
	if (windows.length > 0) {
		const scores = windows.map(scoreWindow);
		const raw = mergeWindows(windows, scores);
		classified = smoothSegments(raw, MIN_SEGMENT_SEC);
	}

	const stays = findStays(stayPoints ?? points, classified);
	const ordered = [...classified, ...stays].sort((a, b) => a.startTs - b.startTs);
	return inferTransitGaps(ordered, points);
}

/**
 * Rail-run detection and annotation passes.
 *
 * Identifies maximal runs of rail-like segments, resolves their
 * board→alight station-pair (and line) labels from OSM, and collapses
 * brief in-run pauses into a single train journey. Extracted from the
 * velocity orchestrator.
 */

import type { EnrichedSegment } from "../enriched-segment.js";
import type { FilteredPoint } from "../kalman.js";
import { type NearbyStation, pickBestStation } from "../osm.js";
import { dbOsmAdapter } from "../osm-adapter.js";
import { haversineMeters } from "../place-snap.js";
import { hasRefinedKind, samplesInWindow, samplesInWindowExclusiveEnd } from "../segment-util.js";

/**
 * Annotate consecutive rail-like segments as a single tube/train journey.
 *
 * A "rail-like" segment is anything classified as train (mode or refinedMode)
 * plus inferred-vehicle-speed gaps that look like a tube ride continuation
 * (refinedReason "inferred from GPS gap" with non-stationary mode and
 * avgSpeed >= 7). A maximal run of these is a single journey: a multi-
 * station tube ride that surfaced for one fix mid-route shows up as
 * train + inferred-gap + train (different modes, so mergeAdjacentMoving
 * leaves them separate), but it's one journey and gets one label.
 *
 * Per run, we look up nearby stations at the outer-bounding fixes (last fix
 * at-or-before run start, first fix at-or-after run end) and label every
 * segment in the run with "<board> → <alight>". This fixes the mid-ride-
 * fix false-alight: a noisy mid-ride fix near an intermediate station
 * can't produce an annotation for that station because the run's outer
 * fixes are at the true board/alight platforms.
 */
/** Search radius (m) for rail-run endpoint station lookup. Larger than the
 *  default 200m of nearbyStations because overground stations often have
 *  the first post-train GPS fix 200-300m away — the phone reports the next
 *  position after the user has already walked away from the platform. */
export const RAIL_RUN_STATION_RADIUS_M = 400;

/** Speed (km/h) below which we treat a fix as "the user is at or near a
 *  station, not in transit." The first fix at-or-after the rail run's
 *  endTs is often still on the train (surface GPS reading mid-route);
 *  we want the first fix where the user has actually disembarked and is
 *  walking or stopped. Walking pace is ~5 km/h, generous buffer at 15. */
const POST_TRANSIT_SPEED_KMH = 15;
/** Tighter threshold for the alighting lookup. A train decelerating
 *  through a station can sit at 5-15 km/h — the looser
 *  `POST_TRANSIT_SPEED_KMH` accepts those as "the user is off the
 *  train" and resolves the alight station to whatever the train is
 *  currently passing. Below 5 km/h the user is genuinely walking or
 *  standing on a platform and the location is the actual disembark.
 *  See the failure-class for "decelerating train through a non-
 *  disembark station." */
const POST_TRANSIT_ALIGHT_SPEED_KMH = 5;

/** A slow fix is a mid-ride dwell (not the real alight) if a transit-
 *  speed fix follows within this window. The train stopped at a
 *  station, the user stayed on board, the train resumed. The actual
 *  alight is later. 2 min is long enough to cover a typical platform
 *  dwell + train re-acceleration; shorter than any legitimate alight-
 *  to-walking-pace transition. */
const MID_RIDE_DWELL_RESUME_S = 120;

// A short stationary segment bordered by rail-like segments is almost
// always a train pause (signal stop, station dwell) — the user is on
// the same train the whole time. Collapse the whole run into one
// segment so the timeline doesn't show meaningless "Cafe X · 2 min"
// artefacts in the middle of a tube ride. Threshold deliberately
// tight (5 min) so that genuine longer stays still surface.
const TRAIN_PAUSE_MAX_SEC = 5 * 60;
const TRAIN_PAUSE_MAX_AVG_KMH = 10;
const TRAIN_DWELL_RADIUS_M = 100;
const TRAIN_DWELL_PERCENTILE = 0.8;

/** Apparent velocity (km/h) above which a fix-to-fix hop is treated as
 *  mid-tunnel GPS noise rather than a genuine walk between stations. Used
 *  to decide whether to trust a preceding-stationary boarding station over
 *  the `slowBefore` fix's own station lookup. */
const BOARDING_NOISE_SPEED_KMH = 15;

/** How far back in time to scan for a platform-train-platform fix
 *  pattern that suggests the velocity classifier closed the train
 *  segment's startTs too late. 15 minutes accommodates a multi-
 *  station tube ride whose initial portion got classified as walking
 *  because the per-station platform stops dominated the window
 *  median. */
const PLATFORM_PATTERN_WALKBACK_S = 900;
/** Speeds at or below this are "near-stationary" — the user is
 *  standing on the platform, not still walking towards it. The
 *  boarding-platform chain walks backwards through these only,
 *  stopping at the first walking-pace fix. That separates the
 *  platform-wait cluster from the approach walk past a closer
 *  station (the "walked past an intermediate station to board at the
 *  next one" pattern). The looser PLATFORM_SLOW_KMH still bounds
 *  the chain's outer edge — once we've collected a near-stationary
 *  cluster, we don't re-extend through anything > 8 km/h. */
const BOARDING_STILL_KMH = 3;
/** Speeds at or above this are clearly train-in-motion. */
const PLATFORM_TRAIN_KMH = 30;
/** Maximum time gap between consecutive slow fixes that we still
 *  consider part of the same boarding-platform chain. A user walking
 *  to a different station has a slow-fix gap of several minutes (or
 *  no fix at all because the phone went to power-save). Inside a
 *  station / on a platform / on a stopping-train sequence, the gap
 *  rarely exceeds ~3 minutes between recorded fixes. */
const PLATFORM_MAX_GAP_S = 180;
/** Maximum geographic spread of a "platform cluster" of slow fixes.
 *  Inside one station, fixes cluster within ~50m. Allowing 150m
 *  permits a short walk between adjacent platforms during a transfer
 *  while still rejecting a walking trail across multiple blocks. */
const PLATFORM_MAX_SPREAD_M = 150;

/**
 * Detect a platform-train-platform pattern in the fixes preceding
 * a rail run's classifier-given startTs, and return the earliest
 * slow fix that's part of that pattern. This is the *actual*
 * boarding fix — annotateRailRuns uses it as `slowBefore` to look
 * up the boarding station.
 *
 * Returns null when no train-speed fix appears in the lookback
 * window (so the classifier-given startTs is trustworthy) or when
 * no slow fix is connected to the train-pattern.
 *
 * Pure helper for unit testing — no DB calls, no async.
 */
export function findBoardingPlatformFix(points: FilteredPoint[], startTs: number): FilteredPoint | null {
	const windowStart = startTs - PLATFORM_PATTERN_WALKBACK_S;
	const windowFixes = samplesInWindow(points, { startTs: windowStart, endTs: startTs }).sort((a, b) => a.ts - b.ts);
	if (windowFixes.length === 0) return null;

	// Find the earliest train-speed fix in the window. If none, the
	// classifier's startTs is already at-or-before the first train
	// signal we have — no platform extension to do.
	let firstFastIdx = -1;
	for (let i = 0; i < windowFixes.length; i++) {
		if (windowFixes[i].speed_kmh >= PLATFORM_TRAIN_KMH) {
			firstFastIdx = i;
			break;
		}
	}
	if (firstFastIdx === -1) return null;

	// Anchor-and-extend: walk backward from firstFast until we find
	// the first near-stationary fix (the user definitely on the
	// platform). From there, keep extending backwards through more
	// near-stationary fixes — clustered within PLATFORM_MAX_SPREAD_M
	// and contiguous within PLATFORM_MAX_GAP_S — until we hit a
	// walking-pace fix. The earliest near-stationary fix is the
	// boarding-station anchor.
	//
	// Why a two-phase walk: the platform-train-platform pattern (today
	// already tested in tests/velocity.test.ts) has accelerating
	// fixes (walking-pace, 4-8 km/h) between the boarding-platform
	// fix and the first train-speed fix. We need to walk PAST those
	// to find the platform anchor. But once we have an anchor, a
	// further-back walking fix means the user was still approaching
	// — that's where the chain ends.
	const isStill = (p: FilteredPoint): boolean => p.speed_kmh < BOARDING_STILL_KMH;
	let anchorIdx = -1;
	for (let i = firstFastIdx - 1; i >= 0; i--) {
		const p = windowFixes[i];
		if (windowFixes[firstFastIdx].ts - p.ts > PLATFORM_PATTERN_WALKBACK_S) break;
		if (isStill(p)) {
			anchorIdx = i;
			break;
		}
	}
	let earliestIdx = anchorIdx;
	if (anchorIdx >= 0) {
		const anchorLat = windowFixes[anchorIdx].lat;
		const anchorLon = windowFixes[anchorIdx].lon;
		let prevChainTs = windowFixes[anchorIdx].ts;
		for (let i = anchorIdx - 1; i >= 0; i--) {
			const p = windowFixes[i];
			if (!isStill(p)) break;
			if (prevChainTs - p.ts > PLATFORM_MAX_GAP_S) break;
			if (haversineMeters(p.lat, p.lon, anchorLat, anchorLon) > PLATFORM_MAX_SPREAD_M) break;
			earliestIdx = i;
			prevChainTs = p.ts;
		}
	}

	return earliestIdx >= 0 ? windowFixes[earliestIdx] : null;
}

/** Canonicalise one OSM rail-line name into the set of physical lines it
 *  denotes, so the board∩alight intersection can resolve a unique line
 *  despite OSM's inconsistent naming. Two OSM quirks are handled:
 *
 *   1. **Direction split** — a line's two directions are separate relations
 *      ("Victoria Line" vs "Victoria Line Northbound", "Jubilee Line" vs
 *      "Jubilee Line Eastbound"). Strip the trailing compass word.
 *   2. **Shared-track combine** — lines that share track are tagged under
 *      one relation ("Circle, Hammersmith & City and Metropolitan Lines"
 *      at King's Cross, "Circle and District Lines" at Victoria) while the
 *      same line is plain ("Metropolitan Line") elsewhere. Split the
 *      combined name on ", " / " and " and re-suffix each component, so
 *      "Circle, Hammersmith & City and Metropolitan Lines" yields
 *      ["Circle Line", "Hammersmith & City Line", "Metropolitan Line"]
 *      (note "&" is not a separator, so "Hammersmith & City" stays whole).
 *
 *  A plain singular name returns itself. */
export function expandTubeLineNames(name: string): string[] {
	const base = name.replace(/\s+(?:East|West|North|South)bound$/i, "").trim();
	const combined = base.match(/^(.*) Lines$/);
	if (combined) {
		const parts = combined[1]
			.split(/,\s*|\s+and\s+/)
			.map((p) => p.trim())
			.filter(Boolean);
		if (parts.length > 1) return parts.map((p) => `${p} Line`);
	}
	return [base];
}

/** A maximal rail run: a span of segments `[from, toExclusive)` that begins
 *  and ends with a rail-like segment, plus the indices of any short
 *  stationary "platform" segments absorbed into its interior. */
interface RailRun {
	from: number;
	toExclusive: number;
	absorbedStationary: number[];
}

/**
 * Identify maximal rail runs in a segment list.
 *
 * A run starts and ends with a rail-like segment but may absorb short
 * stationary "platform" segments in the middle when followed by another
 * rail-like segment. The interior absorbed stationaries get relabelled by
 * {@link applyRailRuns}.
 */
function findRailRuns(segments: EnrichedSegment[], points: FilteredPoint[]): RailRun[] {
	const isRailLike = (s: EnrichedSegment): boolean => {
		if (s.mode === "train" || s.refinedMode === "train") return true;
		const inferredVehicleGap = hasRefinedKind(s, "gps-gap-inferred") && s.mode !== "stationary" && s.avgSpeed >= 7;
		return Boolean(inferredVehicleGap);
	};

	// A short non-rail-like segment bookended by rail-like segments
	// (caller checks bookends) is almost certainly a platform
	// interchange. Three disjunctive signals confirm it isn't a real
	// activity between train legs:
	//   - duration ≤ 5 min (a real stop is longer)
	//   - segment avgSpeed ≤ walking pace, OR
	//   - the segment's GPS points cluster within TRAIN_DWELL_RADIUS_M
	//     of their centroid.
	//
	// Either signal alone is enough. The classifier-reported avgSpeed
	// is wrong sometimes (GPS jitter at a platform inflates instant-
	// speeds, but the average smooths them out — usually). The GPS
	// tightness is wrong sometimes (sparse fixes with multipath spikes
	// inflate the apparent spread — the actual April 29 prod case had
	// 7 fixes covering 2.8 km of apparent path with avgSpeed 4.7 km/h).
	// Trusting whichever signal looks sane catches both failure modes.
	const couldBeTrainPause = (s: EnrichedSegment): boolean => {
		if (s.endTs - s.startTs > TRAIN_PAUSE_MAX_SEC) return false;
		if (s.mode === "stationary") return true;
		if (s.avgSpeed <= TRAIN_PAUSE_MAX_AVG_KMH) return true;
		// Fallback: GPS-cluster check for the case where the classifier
		// over-estimated avgSpeed (instant-speed spikes at a platform).
		const segPoints = samplesInWindow(points, s);
		if (segPoints.length < 2) return false;
		const cLat = segPoints.reduce((sum, p) => sum + p.lat, 0) / segPoints.length;
		const cLon = segPoints.reduce((sum, p) => sum + p.lon, 0) / segPoints.length;
		const distances = segPoints.map((p) => haversineMeters(p.lat, p.lon, cLat, cLon)).sort((a, b) => a - b);
		const idx = Math.min(distances.length - 1, Math.floor(distances.length * TRAIN_DWELL_PERCENTILE));
		return distances[idx] <= TRAIN_DWELL_RADIUS_M;
	};

	const runs: RailRun[] = [];
	for (let i = 0; i < segments.length; ) {
		if (!isRailLike(segments[i])) {
			i++;
			continue;
		}
		let j = i + 1;
		const absorbed: number[] = [];
		while (j < segments.length) {
			if (isRailLike(segments[j])) {
				j++;
				continue;
			}
			// Absorb a short stationary IFF a rail-like segment follows it.
			// Without that follow-up condition we'd swallow the trailing
			// stationary at the end of a journey too (e.g. arriving home).
			if (couldBeTrainPause(segments[j]) && j + 1 < segments.length && isRailLike(segments[j + 1])) {
				absorbed.push(j);
				j += 2; // skip the stationary AND the rail-like that confirmed it
				continue;
			}
			break;
		}
		runs.push({ from: i, toExclusive: j, absorbedStationary: absorbed });
		i = j;
	}
	return runs;
}

/**
 * Select the boarding fix for a rail run.
 *
 * Prefer fixes where the user is NOT in transit (speed below walking pace)
 * — these are at-or-near a station rather than mid-route. A subway line
 * that surfaces between stations means a fix near the run's startTs can be
 * a real GPS reading at ~30 km/h mid-train; skipping transit-speed fixes
 * gets us to the actual boarding-near-station fix.
 *
 * First {@link findBoardingPlatformFix} checks whether the classifier's
 * startTs is too late: when the per-window scorer averages over a stop-and-
 * go platform sequence, the early part of a multi-station tube ride can
 * land in the preceding "walking" segment. It walks back through the
 * platform-train-platform fix pattern and returns the true boarding fix; if
 * no such pattern exists, we fall through to the latest slow fix at-or-
 * before startTs, then to any fix at-or-before startTs.
 */
function findRunBoardingFix(points: FilteredPoint[], startTs: number): FilteredPoint | undefined {
	const slow = (p: FilteredPoint): boolean => p.speed_kmh < POST_TRANSIT_SPEED_KMH;
	const platformBoardingFix = findBoardingPlatformFix(points, startTs);
	return (
		platformBoardingFix ??
		[...points].reverse().find((p) => p.ts <= startTs && slow(p)) ??
		[...points].reverse().find((p) => p.ts <= startTs)
	);
}

/**
 * Select the alighting fix for a rail run.
 *
 * Two reasons we need to be picky about which post-train fix we use:
 *   1. Strict `>` (not `>=`): the fix AT endTs is still inside the train
 *      segment — the classifier closes a train segment on the first slow-
 *      enough fix, but that fix is mid-ride. `>=` picks it; `>` doesn't.
 *   2. Tighter speed threshold: between endTs and the actual disembark, a
 *      decelerating train through a non-disembark station can land a fix at
 *      5-15 km/h. The looser POST_TRANSIT threshold accepts those and the
 *      alight resolves to "wherever the train is currently passing" rather
 *      than the actual disembark station. Fall back to the looser threshold
 *      if no fix below 5 exists, then to any fix as final fallback.
 *
 * Walk past mid-ride dwells: a slow fix followed within
 * MID_RIDE_DWELL_RESUME_S by a transit-speed fix is the train pausing at a
 * station, not the user getting off. The actual alight is the first slow
 * fix that ISN'T followed by a return to transit speed.
 */
export function findRunAlightFix(points: readonly FilteredPoint[], endTs: number): FilteredPoint | undefined {
	const slow = (p: FilteredPoint): boolean => p.speed_kmh < POST_TRANSIT_SPEED_KMH;
	const findSustainedAlight = (predicate: (p: FilteredPoint) => boolean): FilteredPoint | undefined => {
		for (const p of points) {
			if (p.ts <= endTs) continue;
			if (!predicate(p)) continue;
			const cutoff = p.ts + MID_RIDE_DWELL_RESUME_S;
			const resumes = points.some((q) => q.ts > p.ts && q.ts <= cutoff && q.speed_kmh >= POST_TRANSIT_SPEED_KMH);
			if (!resumes) return p;
		}
		return undefined;
	};
	return (
		findSustainedAlight((p) => p.speed_kmh < POST_TRANSIT_ALIGHT_SPEED_KMH) ??
		findSustainedAlight((p) => slow(p)) ??
		points.find((p) => p.ts > endTs)
	);
}

/**
 * Resolve the station-pair (and optional line) label for a single rail run.
 *
 * Selects boarding/alighting fixes, resolves their stations (with a
 * preceding-stationary preference gated by a walking-pace sanity check),
 * and appends a disambiguating line name when a single line serves both
 * endpoints. The station lookup and line lookup have independent failure
 * modes — a line-lookup failure (Overpass down, no data) degrades to a
 * station-pair label rather than losing the annotation entirely. A station-
 * lookup failure returns null.
 */
async function resolveRailRunLabel(
	run: RailRun,
	segments: EnrichedSegment[],
	points: FilteredPoint[],
	stationsLookup: (lat: number, lon: number) => Promise<NearbyStation[]>,
	linesLookup: (lat: number, lon: number) => Promise<Set<string>>,
): Promise<string | null> {
	const startTs = segments[run.from].startTs;
	const endTs = segments[run.toExclusive - 1].endTs;
	const slowBefore = findRunBoardingFix(points, startTs);
	const after = findRunAlightFix(points, endTs);
	if (!slowBefore || !after) return null;

	// Boarding-station lookup with preceding-stationary preference,
	// gated by a walking-pace sanity check.
	//
	// Walk back through stationary + walking segments only; stop
	// at any other mode (e.g. a previous train, driving) so we
	// don't claim the last journey's destination as this one's
	// boarding station. The first stationary segment we hit whose
	// location resolves to a real station is a *candidate*.
	//
	// The candidate is used IFF the user's apparent velocity from
	// the stationary endpoint to slowBefore is mid-tunnel-noise
	// territory (> 15 km/h). If it's realistic walking pace, the
	// user genuinely moved to a different station between the
	// stay and the boarding and we trust slowBefore's lookup
	// instead.
	let startStation: string | undefined;
	let beforeLookup = { lat: slowBefore.lat, lon: slowBefore.lon };
	let endStation: string | undefined;
	try {
		let stationaryCandidate: { name: string; lat: number; lon: number; endTs: number } | null = null;
		for (let i = run.from - 1; i >= 0; i--) {
			const seg = segments[i];
			if (seg.mode === "stationary") {
				// Strict `<` on the upper bound: seg.endTs equals the
				// next segment's startTs (the segment classifier puts
				// adjacent segments back-to-back). The fix at that
				// boundary is the FIRST fix of the next segment, not
				// the last of this one. Including it picks up the
				// mid-ride boundary fix as the "last stationary fix"
				// and the boarding-station lookup resolves to wherever
				// the train was passing, not the actual boarding
				// platform.
				const segPoints = samplesInWindowExclusiveEnd(points, seg);
				if (segPoints.length > 0) {
					const last = segPoints[segPoints.length - 1];
					const stations = await stationsLookup(last.lat, last.lon);
					const best = pickBestStation(stations);
					if (best) {
						stationaryCandidate = { name: best.name, lat: last.lat, lon: last.lon, endTs: last.ts };
					}
				}
				break;
			}
			if (seg.mode !== "walking") break;
		}

		if (stationaryCandidate) {
			const dM = haversineMeters(stationaryCandidate.lat, stationaryCandidate.lon, slowBefore.lat, slowBefore.lon);
			const dt = Math.max(1, slowBefore.ts - stationaryCandidate.endTs);
			const apparentKmh = (dM / dt) * 3.6;
			if (apparentKmh > BOARDING_NOISE_SPEED_KMH) {
				// slowBefore is mid-tunnel GPS noise — trust stationary.
				startStation = stationaryCandidate.name;
				beforeLookup = { lat: stationaryCandidate.lat, lon: stationaryCandidate.lon };
			}
			// else: realistic walking pace, fall through to slowBefore.
		}

		const [startStationsSlow, endStations] = await Promise.all([
			startStation ? Promise.resolve([]) : stationsLookup(slowBefore.lat, slowBefore.lon),
			stationsLookup(after.lat, after.lon),
		]);
		if (!startStation) startStation = pickBestStation(startStationsSlow)?.name;
		// Fallback for back-compat: when slowBefore doesn't resolve
		// to a station but a preceding-stationary station exists,
		// use that — covers the original "user noisy at platform"
		// case from before the velocity gate was added.
		if (!startStation && stationaryCandidate) {
			startStation = stationaryCandidate.name;
			beforeLookup = { lat: stationaryCandidate.lat, lon: stationaryCandidate.lon };
		}
		endStation = pickBestStation(endStations)?.name;
	} catch {
		return null;
	}
	if (!startStation || !endStation) return null;
	// Same station at both ends: probably hanging around a single
	// station rather than actually riding. Skip annotation — don't
	// even fetch lines for this run.
	if (startStation === endStation) return null;
	const base = `${startStation} → ${endStation}`;
	// Line intersection: which line serves both physical endpoints?
	// Two lines might both serve one endpoint but only one
	// reaches the other — the intersection picks the right line.
	// Append the suffix only
	// when the intersection is a singleton; on empty (one endpoint
	// off-OSM, or disjoint sets) or ambiguous (>1 line serves both),
	// fall through to the bare station-pair label.
	try {
		const [startLines, endLines] = await Promise.all([
			linesLookup(beforeLookup.lat, beforeLookup.lon),
			linesLookup(after.lat, after.lon),
		]);
		// OSM tags each travel direction as its own line name
		// ("Jubilee Line Eastbound" at one station, "Jubilee Line" at
		// the next), so a raw string intersection comes up empty for
		// the same physical line. Canonicalise (drop the directional
		// suffix) into a Set before intersecting — Wembley Park ∩ Green
		// Park then resolves to the single Jubilee Line, King's Cross ∩
		// Wembley Park to the Metropolitan.
		const startCanon = new Set([...startLines].flatMap(expandTubeLineNames));
		const endCanon = new Set([...endLines].flatMap(expandTubeLineNames));
		const intersection = [...startCanon].filter((l) => endCanon.has(l));
		if (intersection.length === 1) return `${base} · ${intersection[0]}`;
		return base;
	} catch {
		return base;
	}
}

/**
 * Apply resolved rail runs to a segment list, producing the output segments.
 *
 * For each rail run:
 *   - Single-segment run: keep shape, just annotate with the station-pair
 *     label (if available) and upgrade the mode to "train".
 *   - Multi-segment run (with or without absorbed short stationaries):
 *     collapse into one train segment spanning the whole journey. The user
 *     thinks of it as one ride — "I got on at station A, off at station B" —
 *     not three sub-windows of the classifier plus a momentary train pause.
 *     Surface the journey, not the artefacts.
 * Segments outside any run pass through unchanged.
 */
function applyRailRuns(segments: EnrichedSegment[], runs: RailRun[], runLabels: (string | null)[]): EnrichedSegment[] {
	const out: EnrichedSegment[] = [];
	const runByStart = new Map(runs.map((r, idx) => [r.from, idx]));
	let i = 0;
	while (i < segments.length) {
		const runIdx = runByStart.get(i);
		if (runIdx === undefined) {
			out.push({ ...segments[i] });
			i++;
			continue;
		}
		const run = runs[runIdx];
		const label = runLabels[runIdx];
		if (run.toExclusive - run.from === 1 && run.absorbedStationary.length === 0) {
			// Single-segment rail run. Annotate with the station label
			// AND upgrade the mode to "train" — a station-pair label
			// only gets produced when BOTH endpoints resolve to real
			// stations (line 833), which is strong rail evidence. The
			// classifier may have called this "driving" because the
			// GPS surface fixes look road-shaped (high linearity,
			// vehicle-speed), but the station-pair annotation outranks
			// that. Without the upgrade we end up with a segment that's
			// internally contradictory: mode=driving + a station-pair
			// wayName.
			const s = { ...segments[run.from] };
			if (label) {
				s.wayName = label;
				if (s.mode !== "train") {
					s.mode = "train";
					s.refinedMode = "train";
					s.refinedReason = `station-pair upgrade${s.refinedReason ? ` (was: ${s.refinedReason})` : ""}`;
				}
			}
			out.push(s);
			i = run.toExclusive;
			continue;
		}
		// Multi-segment / absorbed run → collapse into one train segment.
		const first = segments[run.from];
		const last = segments[run.toExclusive - 1];
		const railSegs: EnrichedSegment[] = [];
		for (let k = run.from; k < run.toExclusive; k++) {
			if (segments[k].mode !== "stationary") railSegs.push(segments[k]);
		}
		const totalWeight = railSegs.reduce((a, s) => a + (s.pointCount || 1), 0) || 1;
		const weighted = (field: (s: EnrichedSegment) => number, digits: number): number => {
			const sum = railSegs.reduce((a, s) => a + field(s) * (s.pointCount || 1), 0);
			return Math.round((sum / totalWeight) * 10 ** digits) / 10 ** digits;
		};
		const merged: EnrichedSegment = {
			startTs: first.startTs,
			endTs: last.endTs,
			mode: "train",
			refinedMode: "train",
			confidence: weighted((s) => s.confidence, 2),
			confidenceMargin: weighted((s) => s.confidenceMargin, 2),
			avgSpeed: weighted((s) => s.avgSpeed, 1),
			maxSpeed: Math.max(...railSegs.map((s) => s.maxSpeed)),
			linearity: weighted((s) => s.linearity, 2),
			pointCount: railSegs.reduce((a, s) => a + s.pointCount, 0),
			refinedReason: "merged rail run (collapsed brief pauses)",
		};
		if (label) merged.wayName = label;
		out.push(merged);
		i = run.toExclusive;
	}
	return out;
}

export async function annotateRailRuns(
	segments: EnrichedSegment[],
	points: FilteredPoint[],
	stationsLookup: (lat: number, lon: number) => Promise<NearbyStation[]> = (lat, lon) =>
		dbOsmAdapter.nearbyStations(lat, lon, RAIL_RUN_STATION_RADIUS_M),
	linesLookup: (lat: number, lon: number) => Promise<Set<string>> = (lat, lon) => dbOsmAdapter.linesAtPoint(lat, lon),
): Promise<EnrichedSegment[]> {
	const runs = findRailRuns(segments, points);
	// Look up board/alight stations and disambiguating line names for each
	// run in parallel.
	const runLabels = await Promise.all(
		runs.map((run) => resolveRailRunLabel(run, segments, points, stationsLookup, linesLookup)),
	);
	return applyRailRuns(segments, runs, runLabels);
}

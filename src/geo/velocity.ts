/**
 * Velocity pipeline: raw PhoneTrack GPS → Kalman filter → segment classification → OSM enrichment.
 *
 * Used by both the API route and the CLI tool.
 */

import { sql } from "kysely";
import tzLookup from "tz-lookup";
import { db } from "../db/pool.js";
import { getSyncState } from "../db/sync-state.js";
import { checkWorldlineFeasibility } from "../eval/worldline-feasibility.js";
import { applyHsmmPlaceOverride } from "../hmm/place-override.js";
import type { NextcloudConfig } from "../nextcloud/phonetrack.js";
import { type DayState, segmentsToDayStates } from "../sleep/day-state.js";
import { detectKnownPlaceStays, type StayCandidate } from "../sleep/known-place-stays.js";
import { enrichSleepWindows } from "../sleep/load.js";
import { biometricCoherence } from "./biometric-coherence.js";
import {
	applyStationaryWalkThrough,
	correctModeFromCadence,
	demoteJitterWalkToStationary,
	enrichSegmentWithBiometrics,
	type HrPoint,
	revertIsolatedCadenceDrives,
	type SleepStageRecord,
	type StepPoint,
} from "./biometrics.js";
import { bridgeStaysWithBiometrics } from "./bridge-stays-biometrics.js";
import { annotateBusEvidence } from "./bus-evidence.js";
import { annotateBusRoutes } from "./bus-route-match.js";
import type { ClassificationInputs } from "./classification-inputs.js";
import { applyDwellContinuation } from "./dwell-continuation.js";
import type { EnrichedSegment } from "./enriched-segment.js";
import { buildEpisodes, type EpisodeGeometry } from "./episode-geometry.js";
import { useBiometricFactor } from "./factors/feature-flag.js";
import { hourProfileForRange, localSolarHour } from "./focus-places.js";
import { qualityFilterGps } from "./gps-quality.js";
import { inferEmptyDayStatesFromBracket } from "./infer-empty-day.js";
import { spliceInterchanges } from "./interchange-split.js";
import type { FilteredPoint } from "./kalman.js";
import { filterGpsTrack } from "./kalman.js";
import { loadClassificationInputs } from "./load-classification-inputs.js";
import { correctModeBySignature, gateCycling, type ModeStats } from "./mode-biometrics.js";
import {
	bestPlace,
	commonCity,
	extractCity,
	type NearbyWay,
	placeLabel,
	refineMode,
	rejectImplausibleDriving,
} from "./osm.js";
import { ENRICH_CONCURRENCY, mapLimit, mergeAdjacentMoving } from "./passes/moving.js";
import {
	absorbBoardingPlatform,
	absorbDriveStops,
	absorbInterchanges,
	anchorTrainAlightToWalkedStation,
	anchorTrainBoardingToWalkedStation,
	relabelWalkingInterchanges,
} from "./passes/rail-absorbers.js";
import {
	annotateSnappedPaths,
	assembleRailJourney,
	mergeAdjacentSameRouteTrains,
	reconcileAdjacentRailLegs,
} from "./passes/rail-reconcile.js";
import { annotateRailRuns, RAIL_RUN_STATION_RADIUS_M } from "./passes/rail-runs.js";
import { repairVehicleHandoff } from "./passes/repair-handoff.js";
import {
	absorbFarFocusPlacePhantom,
	absorbIntraPlaceWalk,
	attachStayCentroids,
	consolidateJitterStays,
	mergeAdjacentStays,
} from "./passes/stays.js";
import { upgradeTubeHops } from "./passes/tube-hop.js";
import { resolveVehicleIdentity } from "./passes/vehicle-identity.js";
import { annotateWalkMatches } from "./pedestrian-match-annotate.js";
import { type PlaceCandidate, pickBestPlace } from "./place-prior.js";
import { haversineMeters, type KnownPlace, snapToPlace } from "./place-snap.js";
import { DRIVABLE_HIGHWAY_SUBTYPES, RAIL_ONLY_SUBTYPES } from "./rail-road-proximity.js";
import { annotateRoadMatches } from "./road-match-annotate.js";
import { effectiveMode, samplesInWindow } from "./segment-util.js";
import type { TransportMode } from "./segments.js";
import {
	classifySegments,
	enforcePhysicalConstraints,
	isStationaryIncoherent,
	pedestrianCoreDisplacementM,
	roadSupportedConfidence,
} from "./segments.js";
import {
	reassignVehicleArrivalWalk,
	reassignWalkTailToVehicle,
	shedVehiclePedestrianEdges,
	splitStaysOnEvidence,
	splitWalksOnEvidence,
	splitWalksOnVehicleLeg,
} from "./stay-split.js";
import { dateBoundsUtc, fitbitTsToUnix } from "./timezone.js";
import { stationAtTrainAlight, stationAtTransitInterchange } from "./transit-place.js";
import {
	annotateUndergroundRuns,
	UNDERGROUND_LINES_RADIUS_M,
	UNDERGROUND_STATION_RADIUS_M,
} from "./underground-rail.js";

/** Format a unix-second instant as a `YYYY-MM-DD HH:MM:SS` UTC DATETIME
 *  string for filtering against `ts_utc` columns. */
export function utcSecondsToDatetimeStr(unix: number): string {
	return new Date(unix * 1000).toISOString().slice(0, 19).replace("T", " ");
}

/** Parse a `YYYY-MM-DD HH:MM:SS` UTC DATETIME value from the DB into
 *  unix seconds. The mariadb driver returns DATETIME columns as `Date`
 *  objects whose UTC components literally mirror the stored bytes (any
 *  `Z` suffix is decoration, not a TZ claim); `DATE_FORMAT(...)` returns
 *  a string. Handle both by component-matching the same way
 *  `fitbitTsToUnix` does. */
export function utcDatetimeStrToSeconds(s: string | Date): number {
	const str = typeof s === "string" ? s : s.toISOString();
	const m = str.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
	if (!m) return Number.NaN;
	return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
}

/**
 * Load Fitbit HR + sleep stages for a UTC time window. Filters directly on
 * the derived `ts_utc` columns populated by sync/backfill (see
 * `docs/design/timezone.md`); no per-row tz lookup or
 * wall-clock-string padding required. Returns empty arrays gracefully when
 * the user wasn't wearing their Fitbit.
 *
 * A tiny fallback path covers rows where `ts_utc IS NULL` — these are
 * expected to be zero in steady state after Phase B backfill, and arise
 * only when forward sync ran without any tz signal (no PhoneTrack, no
 * profile.tz). The fallback pays the legacy per-row conversion only for
 * those rows.
 */
export async function loadBiometrics(
	userId: string,
	startUtc: number,
	endUtc: number,
	tz: string | undefined,
): Promise<{ hr: HrPoint[]; sleep: SleepStageRecord[]; steps: StepPoint[] }> {
	const startUtcDt = utcSecondsToDatetimeStr(startUtc);
	const endUtcDt = utcSecondsToDatetimeStr(endUtc);

	// Legacy tz fallback chain for the rare `ts_utc IS NULL` stragglers:
	// row.tz → home_tz → request tz. See TIMEZONE.md.
	const homeTz = await getSyncState(userId, "home_tz");
	const resolveTz = (rowTz: string | null): string | undefined => rowTz ?? homeTz ?? tz;
	const padDate = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
	const dayBefore = padDate(startUtc - 86400);
	const dayAfter = padDate(endUtc + 86400);

	// Per-minute HR aggregate. Fitbit stores 1-second-resolution HR (~21k
	// rows per day); for segment-level mean/std the per-minute average
	// loses essentially no precision and is ~60× cheaper to load + parse.
	const hrPrimaryRows = await db()
		.selectFrom("heart_rate_intraday")
		.select([
			sql<string>`DATE_FORMAT(MIN(ts_utc), '%Y-%m-%d %H:%i:00')`.as("ts_utc"),
			sql<number>`ROUND(AVG(bpm))`.as("bpm"),
		])
		.where("user_id", "=", userId)
		.where("ts_utc", ">=", startUtcDt)
		.where("ts_utc", "<", endUtcDt)
		.groupBy(sql`DATE_FORMAT(ts_utc, '%Y-%m-%d %H:%i')`)
		.orderBy("ts_utc")
		.execute();

	const hr: HrPoint[] = hrPrimaryRows.map((r) => ({ ts: utcDatetimeStrToSeconds(r.ts_utc), bpm: Number(r.bpm) }));

	const hrFallbackRows = await db()
		.selectFrom("heart_rate_intraday")
		.select([
			sql<string>`DATE_FORMAT(MIN(ts), '%Y-%m-%d %H:%i:00')`.as("ts"),
			sql<number>`ROUND(AVG(bpm))`.as("bpm"),
			sql<string | null>`MAX(tz)`.as("tz"),
		])
		.where("user_id", "=", userId)
		.where("ts", ">=", dayBefore)
		.where("ts", "<", dayAfter)
		.where("ts_utc", "is", null)
		.groupBy(sql`DATE_FORMAT(ts, '%Y-%m-%d %H:%i')`)
		.execute();
	for (const r of hrFallbackRows) {
		const ts = fitbitTsToUnix(r.ts, resolveTz(r.tz));
		if (Number.isNaN(ts) || ts < startUtc || ts > endUtc) continue;
		hr.push({ ts, bpm: Number(r.bpm) });
	}
	hr.sort((a, b) => a.ts - b.ts);

	const sleepPrimaryRows = await db()
		.selectFrom("sleep_stages")
		.select(["ts_utc", "stage", "duration_seconds"])
		.where("user_id", "=", userId)
		.where("ts_utc", ">=", startUtcDt)
		.where("ts_utc", "<", endUtcDt)
		.execute();

	const sleep: SleepStageRecord[] = [];
	for (const r of sleepPrimaryRows) {
		if (r.ts_utc === null) continue;
		const startTs = utcDatetimeStrToSeconds(r.ts_utc);
		sleep.push({ startTs, endTs: startTs + r.duration_seconds, stage: r.stage });
	}

	const sleepFallbackRows = await db()
		.selectFrom("sleep_stages")
		.select(["ts", "stage", "duration_seconds", "tz"])
		.where("user_id", "=", userId)
		.where("ts", ">=", dayBefore)
		.where("ts", "<", dayAfter)
		.where("ts_utc", "is", null)
		.execute();
	for (const r of sleepFallbackRows) {
		const startTs = fitbitTsToUnix(r.ts, resolveTz(r.tz));
		if (Number.isNaN(startTs)) continue;
		const endTs = startTs + r.duration_seconds;
		if (endTs < startUtc || startTs > endUtc) continue;
		sleep.push({ startTs, endTs, stage: r.stage });
	}
	sleep.sort((a, b) => a.startTs - b.startTs);

	// Steps intraday — only non-zero minutes are stored, so the row count
	// directly reflects "user took at least one step in this minute".
	const stepsPrimaryRows = await db()
		.selectFrom("steps_intraday")
		.select(["ts_utc", "steps"])
		.where("user_id", "=", userId)
		.where("ts_utc", ">=", startUtcDt)
		.where("ts_utc", "<", endUtcDt)
		.execute();

	const steps: StepPoint[] = [];
	for (const r of stepsPrimaryRows) {
		if (r.ts_utc === null) continue;
		steps.push({ ts: utcDatetimeStrToSeconds(r.ts_utc), steps: r.steps });
	}

	const stepsFallbackRows = await db()
		.selectFrom("steps_intraday")
		.select(["ts", "steps", "tz"])
		.where("user_id", "=", userId)
		.where("ts", ">=", dayBefore)
		.where("ts", "<", dayAfter)
		.where("ts_utc", "is", null)
		.execute();
	for (const r of stepsFallbackRows) {
		const ts = fitbitTsToUnix(r.ts, resolveTz(r.tz));
		if (Number.isNaN(ts) || ts < startUtc || ts > endUtc) continue;
		steps.push({ ts, steps: r.steps });
	}
	steps.sort((a, b) => a.ts - b.ts);

	return { hr, sleep, steps };
}

/** Returns true if the segment includes ≥1 hour of local overnight time
 *  (00:00–06:00 in the segment's local solar time). Used to decide whether
 *  to prefer a residential address over a nearby amenity at the same coords. */
function hasOvernightPresence(startTs: number, endTs: number, lon: number): boolean {
	const stepSec = 30 * 60;
	let overnight = 0;
	for (let t = startTs; t <= endTs; t += stepSec) {
		const h = localSolarHour(t, lon);
		if (h >= 0 && h < 6) overnight += stepSec / 3600;
	}
	return overnight >= 1;
}

interface NamedPlace extends KnownPlace {
	displayName: string | null;
	sleepHours: number;
	amenityLabel: string | null;
	/** Distinct days this cluster has been visited — frequency
	 *  prior for the place scorer. */
	uniqueDays: number;
	/** Mined hour-of-day dwell profile (24 fractions) or null for a
	 *  place mined before the column existed — the time-of-day term
	 *  of the place scorer. */
	hourProfile: number[] | null;
}

/** A focus_place is "residential" if the user has slept (covered deep-night
 *  hours) at it for at least RESIDENCE_SLEEP_THRESHOLD_H total hours. */
const RESIDENCE_SLEEP_THRESHOLD_H = 5;

/** Mean of HR / cadence stream values over a segment's time range. */
function meanInWindow<T extends { ts: number }>(
	stream: T[],
	field: (x: T) => number | null,
	startTs: number,
	endTs: number,
): number | null {
	let sum = 0;
	let count = 0;
	for (const s of stream) {
		if (s.ts < startTs || s.ts > endTs) continue;
		const v = field(s);
		if (v === null) continue;
		sum += v;
		count++;
	}
	return count > 0 ? sum / count : null;
}

/** Apply per-user biometric-signature correction to one segment. Synthetic
 *  gap segments (inferred-from-gap walking / `unknown` no-coverage) carry
 *  pointCount=0 and have no observations to score against — skip them. For
 *  others, aggregate HR + cadence from the loaded biometric streams and run
 *  the pure decision helper. On change, record refinedReason so the timeline
 *  shows why. */
function applyBiometricSignature(
	seg: EnrichedSegment,
	hr: HrPoint[],
	steps: StepPoint[],
	modeStats: ModeStats[],
): EnrichedSegment {
	if (seg.pointCount === 0) return seg;
	const obsHr = meanInWindow(hr, (p) => p.bpm, seg.startTs, seg.endTs);
	const obsCadence = meanInWindow(steps, (p) => p.steps, seg.startTs, seg.endTs);
	const obsSpeed = seg.avgSpeed;
	const currentMode = effectiveMode(seg);
	const r = correctModeBySignature(
		{ mode: currentMode, confidenceMargin: seg.confidenceMargin, obsHr, obsCadence, obsSpeed },
		modeStats,
	);
	const correctedMode = r.changed ? r.mode : currentMode;
	// Hard-evidence gate: a segment still labelled "cycling" is kept only
	// with genuine cycling evidence; otherwise it is demoted.
	const gate = gateCycling({ mode: correctedMode, obsCadence, obsSpeed });
	if (gate.changed) {
		return {
			...seg,
			refinedMode: gate.mode as TransportMode,
			refinedReason: `cycling demoted to ${gate.mode} — no hard cycling evidence`,
		};
	}
	if (!r.changed) return seg;
	return {
		...seg,
		refinedMode: r.mode as TransportMode,
		refinedReason: `re-classified as ${r.mode} by biometric signature`,
	};
}

/** `RAIL_ONLY_SUBTYPES` and `DRIVABLE_HIGHWAY_SUBTYPES` now live in
 *  `rail-road-proximity.ts` — the single source shared with the HSMM
 *  per-fix proximity (#238). Imported above. */

/** Per-segment rail-vs-road proximity, aggregated across sample
 *  points. For each sample we take the minimum distance to any
 *  rail-only way and the minimum to any drivable highway; then mean
 *  across samples that had each kind in range. Samples with no rail
 *  / no road in range are skipped (so a 5-sample segment with rail
 *  in only 2 samples reports the mean of those 2). Returns nulls
 *  when no sample had a given kind nearby. */
function computeRailRoadProximity(wayResults: NearbyWay[][]): {
	meanRailDistM: number | null;
	meanDrivableRoadDistM: number | null;
} {
	const railDists: number[] = [];
	const roadDists: number[] = [];
	for (const sample of wayResults) {
		let minRail = Number.POSITIVE_INFINITY;
		let minRoad = Number.POSITIVE_INFINITY;
		for (const w of sample) {
			const d = w.distanceM;
			if (d === null || d === undefined || !Number.isFinite(d)) continue;
			if (w.type === "railway" && RAIL_ONLY_SUBTYPES.has(w.subtype)) {
				if (d < minRail) minRail = d;
			} else if (w.type === "highway" && DRIVABLE_HIGHWAY_SUBTYPES.has(w.subtype)) {
				if (d < minRoad) minRoad = d;
			}
		}
		if (Number.isFinite(minRail)) railDists.push(minRail);
		if (Number.isFinite(minRoad)) roadDists.push(minRoad);
	}
	const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length);
	return { meanRailDistM: mean(railDists), meanDrivableRoadDistM: mean(roadDists) };
}

/** Minimum number of samples that must carry usable road/rail proximity
 *  before `computeRoadNearestFraction` will return a verdict. Below this
 *  the evidence is too thin to weigh against the HSMM's line support, so
 *  the override is left undisturbed (null). */
const ROAD_FRACTION_MIN_SAMPLES = 3;

/**
 * Across a moving segment's sampled points, the fraction whose nearest
 * drivable road is closer than any rail-only way. A sample with a road
 * in range but no rail counts as road-nearest — there is no track there
 * to ride. Returns null when fewer than `ROAD_FRACTION_MIN_SAMPLES`
 * samples carry usable proximity (a short or fix-sparse segment can't
 * support a road-vs-rail verdict).
 *
 * This is the GPS "does the track follow roads or rail" evidence the
 * HSMM train override weighs against — graded, not a veto. Pure helper
 * over the `nearbyWays` results the enrichment already fetched, so it
 * adds no OSM query (and no fixture re-capture).
 */
export function computeRoadNearestFraction(wayResults: NearbyWay[][]): number | null {
	let roadNearer = 0;
	let total = 0;
	for (const sample of wayResults) {
		let minRail = Number.POSITIVE_INFINITY;
		let minRoad = Number.POSITIVE_INFINITY;
		for (const w of sample) {
			const d = w.distanceM;
			if (d === null || d === undefined || !Number.isFinite(d)) continue;
			if (w.type === "railway" && RAIL_ONLY_SUBTYPES.has(w.subtype)) {
				if (d < minRail) minRail = d;
			} else if (w.type === "highway" && DRIVABLE_HIGHWAY_SUBTYPES.has(w.subtype)) {
				if (d < minRoad) minRoad = d;
			}
		}
		if (!Number.isFinite(minRail) && !Number.isFinite(minRoad)) continue;
		total++;
		if (minRoad < minRail) roadNearer++;
	}
	if (total < ROAD_FRACTION_MIN_SAMPLES) return null;
	return roadNearer / total;
}

/** Wrap a post-midnight stay candidate (raw fixes + known-place
 *  match) as a synthetic stationary `EnrichedSegment`. This shape is
 *  what `derivePlaceForSleep` expects — the synthetic segment never
 *  enters the day's segment output, only the sleep-place attribution
 *  candidate set. The non-place fields are filler. */
function synthesizeStayCandidateSegment(stay: StayCandidate): EnrichedSegment {
	return {
		startTs: stay.startTs,
		endTs: stay.endTs,
		mode: "stationary",
		confidence: 1,
		confidenceMargin: Number.POSITIVE_INFINITY,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0,
		pointCount: 0,
		place: stay.place,
	};
}

/** Project a loaded NamedPlace down to the shape the place-prior
 *  scorer needs. Pure mapping — kept inline so the scorer stays
 *  loosely coupled to the DB-touching pipeline. */
function toPlaceCandidate(p: NamedPlace): PlaceCandidate {
	return {
		id: typeof p.id === "number" ? p.id : 0,
		centroidLat: p.centroidLat,
		centroidLon: p.centroidLon,
		radiusM: p.radiusM ?? 50,
		uniqueDays: p.uniqueDays,
		hourProfile: p.hourProfile,
	};
}

// `EnrichedSegment` now lives in ./enriched-segment.ts so the passes can depend
// on it without importing this orchestrator. Re-exported here for the existing
// consumers (CLIs, routes, sleep, tests) that import it from this module.
export type { EnrichedSegment } from "./enriched-segment.js";

/** One phone-battery reading: a charge level (integer percent, 0–100)
 *  at a wall-clock instant. Sourced from the `battery` field PhoneTrack
 *  records on each GPS fix — see `batterySeries`. */
export interface BatterySample {
	ts: number;
	level: number;
}

/** Reduce the day's per-fix battery readings to a compact series for
 *  the battery chart. A fix is kept iff its level differs from the
 *  reading before or after it, so each constant run collapses to just
 *  its two endpoints — the chart still draws a flat line across the
 *  run and a clean step at each change. Fixes with no battery reading
 *  are dropped. Assumes `points` is in ascending-`ts` order, which is
 *  how `fetchTrackPoints` returns them. */
export function batterySeries(points: { ts: number; battery: number | null }[]): BatterySample[] {
	const all: BatterySample[] = [];
	for (const p of points) {
		if (p.battery !== null) all.push({ ts: p.ts, level: p.battery });
	}
	// Collapse runs of readings that share a timestamp to their first sample.
	// When the phone charges while stationary, OwnTracks reuses the last GPS
	// fix's timestamp for every battery update, so an entire charge curve
	// (e.g. 4→80%) lands on one instant. Keeping every sample would draw a
	// vertical spike at that x; keeping only the first lets the chart draw an
	// angled line from the discharge floor to the next real reading. Assumes
	// ascending `ts` (how `fetchTrackPoints` returns them).
	const read = all.filter((s, i) => i === 0 || s.ts !== all[i - 1].ts);
	return read.filter((s, i) => {
		const prev = read[i - 1];
		const next = read[i + 1];
		return prev === undefined || next === undefined || s.level !== prev.level || s.level !== next.level;
	});
}

/**
 * Extend the battery series to the day boundary when the phone went idle in the
 * evening (e.g. charging) and only reported again after midnight. `tail` — the
 * first reading after the local day end (fetched cross-day as
 * `inputs.batteryTail`) — sets the slope; we interpolate the level at the day
 * boundary (`dayEndTs`) and append THAT point, so the chart draws an angled line
 * up to midnight and stops there, rather than running into the next day. No-op
 * when there is no tail, no in-day series to extend, or the tail does not
 * postdate the last in-day sample.
 */
export function appendBatteryTail(
	series: BatterySample[],
	tail: { ts: number; level: number } | null | undefined,
	dayEndTs: number,
): BatterySample[] {
	if (!tail || series.length === 0) return series;
	const last = series[series.length - 1];
	if (tail.ts <= last.ts || dayEndTs <= last.ts) return series;
	// Linear-interpolate the level where the last-reading→tail line crosses the
	// day boundary. `tail.ts >= dayEndTs` by construction, so frac ∈ (0, 1].
	const frac = Math.min(1, (dayEndTs - last.ts) / (tail.ts - last.ts));
	const level = Math.round(last.level + (tail.level - last.level) * frac);
	return [...series, { ts: dayEndTs, level }];
}

export interface VelocityResult {
	points: FilteredPoint[];
	/** The raw, accuracy-bearing GPS fixes the map-matchers + smoother actually
	 *  consume (`displayFixes`): the cleaned PhoneTrack track (GPS-quality pass +
	 *  accuracy ≤ 200 m), pre-Kalman, un-snapped. Exposed so the map can draw a
	 *  "GPS fixes" overlay — the input the drawn line is estimated from, for an
	 *  honest comparison against the matched / smoothed geometry. */
	rawFixes: { ts: number; lat: number; lon: number; accuracy: number | null }[];
	segments: EnrichedSegment[];
	/** Non-overlapping day state sequence — bottom layer of the
	 *  three-altitude data model. Derived from `segments` plus the
	 *  user's main sleep windows. Sleep at a stationary place is
	 *  the `sleeping` mode; sleep while moving is an `asleep:true`
	 *  attribute on the moving state. Adjacent same-state runs
	 *  merge. See `src/sleep/day-state.ts`. */
	states: DayState[];
	/** Per-episode display geometry, 1:1 with `states`. The map renders
	 *  this (not the raw segments) so the two views cannot diverge; a
	 *  per-mode speed filter drops a faster neighbour's fixes that bled
	 *  across a segment boundary. See `src/geo/episode-geometry.ts` and
	 *  `docs/design/episode-geometry.md`. */
	episodes: EpisodeGeometry[];
	/** The day's phone-battery trace, compressed to run boundaries.
	 *  Derived from the same PhoneTrack fixes as `points`; the Day
	 *  view renders it as a standalone chart. */
	battery: BatterySample[];
	/** Per-phase wall-clock ms from the classification pipeline. */
	timing: Record<string, number>;
}

export async function computeVelocity(
	config: NextcloudConfig,
	userId: string,
	date: string,
	tz?: string,
	options: { enrich?: boolean; walkMatch?: boolean; walkDraw?: "matcher" | "recon" } = {},
): Promise<VelocityResult> {
	// Production wrapper: load the input closure from the DB / PhoneTrack,
	// then run the pure classification core. The two-step split (Phase B of
	// docs/proposals/2026-06-deterministic-fixtures.md) is what lets the
	// golden harness inject a FixtureOsmAdapter + captured row-sets and run
	// the same core with no DB. All existing callers keep this signature.
	const inputs = await loadClassificationInputs(config, { userId, date, displayTz: tz ?? "UTC" });
	return computeVelocityFromInputs(inputs, options);
}

/**
 * The classification pipeline core: pure in its `ClassificationInputs`. No
 * DB, no HTTP — every external read was resolved by the loader, and the
 * OSM / Nominatim lookups flow through the injected `inputs.osm` adapter.
 * Given the same inputs it produces the same output, which is what makes
 * the golden corpus reproducible. Phase B of the deterministic-fixtures
 * proposal.
 *
 * The display timezone is `inputs.identity.displayTz`, already defaulted to
 * `"UTC"` by the loader when the caller passed no tz. `dateBoundsUtc` is
 * UTC-offset-identical for `undefined` and `"UTC"`, so the day bounds are
 * unchanged; the only knock-on is that a fully-empty, no-tz day's single
 * inferred stay now carries `tz: "UTC"` rather than omitting the field —
 * the same UTC default the rest of the pipeline already assumes.
 */
export async function computeVelocityFromInputs(
	inputs: ClassificationInputs,
	options: { enrich?: boolean; walkMatch?: boolean; walkDraw?: "matcher" | "recon" } = {},
): Promise<VelocityResult> {
	const { userId, date, displayTz: tz } = inputs.identity;
	const t0 = Date.now();
	const phaseTimes: Record<string, number> = {};
	const time = <T>(phase: string, p: Promise<T>): Promise<T> => {
		const start = Date.now();
		return p.finally(() => {
			phaseTimes[phase] = (phaseTimes[phase] ?? 0) + (Date.now() - start);
		});
	};
	const timeSync = <T>(phase: string, fn: () => T): T => {
		const start = Date.now();
		try {
			return fn();
		} finally {
			phaseTimes[phase] = (phaseTimes[phase] ?? 0) + (Date.now() - start);
		}
	};

	const bounds = dateBoundsUtc(date, tz);
	const { today: raw, morning: morningRaw, priorEvening: prevEveningRaw } = inputs.phonetrack;
	const inDay = raw.filter((p) => p.ts >= bounds.startUtc && p.ts < bounds.endUtc);

	// Battery trace: derived straight from the raw in-day fixes, before
	// the GPS quality / accuracy filters touch them — a fix dropped for
	// an incoherent position still carries a valid battery reading. The
	// cross-day tail anchor lets the chart slope up to the next real reading
	// when the phone went idle in the evening (see `appendBatteryTail`).
	const battery = appendBatteryTail(batterySeries(inDay), inputs.batteryTail, bounds.endUtc);

	// GPS quality control: drop physically-incoherent runs (underground
	// cell-tower garbage) before anything else touches the data. The
	// dropped fixes leave an honest temporal gap that `inferTransitGaps`
	// bridges downstream. See src/geo/gps-quality.ts.
	const cleaned = timeSync("gpsQuality", () => qualityFilterGps(inDay));

	// Place-snap: if a fix is unambiguously close to a known cluster (home,
	// work, etc.), pull it to the cluster centroid. Reduces GPS noise around
	// well-known locations and stabilises both segment timing and labels.
	const knownPlaces = inputs.knownPlaces;
	const snapped =
		knownPlaces.length > 0
			? cleaned.map((p) => {
					const r = snapToPlace({ lat: p.lat, lon: p.lon, accuracy: p.accuracy }, knownPlaces);
					return r.snapped ? { ...p, lat: r.lat, lon: r.lon, accuracy: r.accuracy } : p;
				})
			: cleaned;

	// Use the same loose accuracy ceiling (≤200m) for both movement and stay
	// detection. The Kalman filter already weights measurements by their
	// accuracy^2 variance (kalman.ts), so a noisy fix contributes much less
	// to the trajectory estimate than a clean one — pre-filtering at 50m
	// just throws away signal that's especially valuable for high-speed
	// linear travel (trains, planes), where even a 150m fix is a useful
	// anchor along an inherently smooth path.
	const gpsPoints = snapped
		.filter((p) => p.accuracy === null || p.accuracy <= 200)
		.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon, accuracy: p.accuracy }));

	const stayPoints = snapped
		.filter((p) => p.accuracy === null || p.accuracy <= 200)
		.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon }));

	// Display fixes for drawing road-vehicle legs from raw GPS (#265 Phase 1).
	// Same accuracy ceiling as `gpsPoints` but derived from `cleaned`, i.e.
	// BEFORE place-snap. Place-snap pulls a fix near a known cluster to that
	// cluster's centroid — correct for stay detection, but on a moving leg
	// that *passes* home/work it yanks the drawn line off the road to the
	// centroid (measured: leg 0's first drive fix snapped ~63 m onto the home
	// centroid, vs ~11 m for the true fix). The raw renderer wants where the
	// phone actually was, quality-filtered but un-snapped.
	const displayFixes = cleaned
		.filter((p) => p.accuracy === null || p.accuracy <= 200)
		.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon, accuracy: p.accuracy }));

	const points = timeSync("kalman", () => filterGpsTrack(gpsPoints));
	const segments = timeSync("segments", () => classifySegments(points, stayPoints));

	if (options.enrich === false) {
		// Non-enriched path: no OSM, no biometrics, no sleep — caller
		// requested raw segments only. `states` is still produced for
		// shape consistency; without enrichment it just trivially
		// reflects the raw segment sequence (sleep windows = empty,
		// no rewrite).
		const states = segmentsToDayStates(segments as EnrichedSegment[], []);
		const episodes = buildEpisodes(states, segments as EnrichedSegment[], points, displayFixes);
		return { points, rawFixes: displayFixes, segments, states, episodes, battery, timing: phaseTimes };
	}

	const N_SAMPLES = 5;

	// Moving-segment CITY lookups run at area zoom on a coarse coordinate
	// grid: city is an area-scale fact, and the ~110 m cell makes habitual
	// endpoints (doorstep, station forecourt) share one cache entry across
	// days instead of re-geocoding every fresh centroid over live HTTP.
	const CITY_ZOOM = 16;
	const cityGrid = (n: number): number => Math.round(n * 1000) / 1000;

	// Kick off biometrics + per-user mode-signature loads in parallel with OSM
	// enrichment — all I/O-bound. The biometric streams are needed for cadence-
	// based mode correction (between OSM enrichment and merge) plus the final
	// per-segment enrichment after merge. The per-user mode signatures
	// (modeStats) are needed either by the legacy `applyBiometricSignature`
	// pass after OSM enrichment, or — when `useBiometricFactor()` is on — by
	// the factor scorer's candidate generator inside refineMode itself, in
	// which case we need them before enrichment starts.
	// Already loaded by `loadClassificationInputs`. Kept as resolved
	// Promises so the existing `await biometricsPromise` / `await
	// modeStatsPromise` call sites downstream don't need changes.
	const biometricsPromise = Promise.resolve(inputs.biometrics);
	const modeStatsPromise = Promise.resolve(inputs.modeBiometrics);
	const biometricFactorOn = useBiometricFactor();
	// When the biometric factor is on, refineMode needs per-segment hr/cadence
	// + modeStats inside the enrichment map, so await both biometric loads
	// before the Promise.all. When it is off, the streams are only consumed
	// after enrichment and we keep the original parallelism — except: we
	// also need biometrics *now* to drive `splitStaysOnEvidence`
	// (the multi-signal weighted stay-split). That blocks the request
	// path on the biom load; acceptable cost in exchange for honest
	// mid-stay-departure detection (see stay-split.ts).
	const preEnrichBiometrics = biometricFactorOn ? await biometricsPromise : null;
	const preEnrichModeStats = biometricFactorOn ? await modeStatsPromise : null;
	const biomForStaySplit = preEnrichBiometrics ?? (await biometricsPromise);
	const splitSegments = timeSync("staySplit", () =>
		splitStaysOnEvidence(segments, points, { hr: biomForStaySplit.hr, steps: biomForStaySplit.steps }),
	);
	// Symmetric pass for the opposite failure: a long indoor sit whose
	// jittery GPS classified as a single "walking" segment together with
	// the real walk at its edge (the Cleveland Clinic shape, #245). Runs
	// before enrichment so the carved-out sit gets normal place naming.
	const walkSplitSegments = timeSync("walkSplit", () =>
		splitWalksOnEvidence(splitSegments, points, { hr: biomForStaySplit.hr, steps: biomForStaySplit.steps }),
	);
	// Multi-signal stay-continuity merge: heal stays the trajectory
	// layer fragmented by a brief no-fix gap, when HR-resting + zero
	// steps in the gap window confirm the user never actually moved.
	// Symmetric to splitStaysOnEvidence above — same biometric series,
	// opposite direction. Targets the Pizza Union / toilet-break class
	// of failure (ground-truth #185).
	const segCentroids: (readonly [number, number] | null)[] = walkSplitSegments.map((s) => {
		if (s.mode !== "stationary") return null;
		const segPoints = samplesInWindow(points, s);
		if (segPoints.length === 0) return null;
		const cLat = segPoints.reduce((sum, p) => sum + p.lat, 0) / segPoints.length;
		const cLon = segPoints.reduce((sum, p) => sum + p.lon, 0) / segPoints.length;
		return [cLat, cLon] as const;
	});
	const refinedSegments = timeSync("bridgeStays", () =>
		bridgeStaysWithBiometrics({
			segments: walkSplitSegments,
			centroids: segCentroids,
			hr: biomForStaySplit.hr,
			steps: biomForStaySplit.steps,
		}),
	);

	// Enrich each (post-stay-split) segment with OSM data. Bounded
	// concurrency: each segment fans out several DB-backed OSM queries,
	// so an unbounded Promise.all over a long day starves the fixed
	// 20-connection pool whenever per-query latency is high — capture
	// runs over the SSH tunnel failed deterministically at 16 segments
	// (2026-06-10, "pool timeout after 10000ms", two segments dropped
	// unenriched). The cap keeps total in-flight queries safely under
	// the pool size; segments are independent, so only wall-clock shape
	// changes, never results.
	/**
	 * OSM enrichment for a *moving* segment: sample along the path, aggregate
	 * the nearby ways, refine the mode, name the road, tag the city.
	 *
	 * Extracted so it can be run a second time. `splitWalksOnVehicleLeg` carves
	 * a hidden ride out of a walk long *after* this pass, leaving two on-foot
	 * remainders whose inherited enrichment was derived from the parent's
	 * window — a window that spanned the ride. The `reenrichSplitWalks` pass
	 * sends those remainders back through here to be named from their own
	 * geometry (2026-07-12: a walk from Highbury & Islington down Upper Street,
	 * labelled "Euston Road" because the parent segment had begun at King's
	 * Cross, on the far side of a tube ride).
	 *
	 * It reads `seg.mode`, `seg.avgSpeed` and `seg.maxSpeed`, so a remainder's
	 * kinematics must be recomputed *before* it is re-enriched — otherwise
	 * refineMode is handed the ride's speeds and duly reaches the ride's
	 * conclusion about a walk.
	 */
	const enrichMovingSegment = async (
		seg: EnrichedSegment,
		segPoints: readonly FilteredPoint[],
	): Promise<EnrichedSegment> => {
		// Moving segment: sample several points along the path so the
		// OSM evidence reflects the whole route, not whatever the
		// centroid happens to land on.
		const sampleCount = Math.min(N_SAMPLES, segPoints.length);
		const sampleIdxs = Array.from({ length: sampleCount }, (_, i) =>
			Math.floor((i * (segPoints.length - 1)) / Math.max(1, sampleCount - 1)),
		);
		const movingStart = segPoints[0];
		const movingEnd = segPoints[segPoints.length - 1];
		const [wayResults, startPlace, endPlace] = await Promise.all([
			Promise.all(sampleIdxs.map((i) => inputs.osm.nearbyWays(segPoints[i].lat, segPoints[i].lon))),
			// Endpoint reverseGeocode: tag the segment with a city iff
			// both endpoints agree. A walk inside one city gets a city
			// header; a drive between two cities stays untagged.
			//
			// City needs AREA-level truth, so query zoom 16 at a ~110 m
			// grid coordinate — not the old building-level zoom 18 at the
			// raw endpoint. Raw endpoints never repeat between days, so
			// every fresh compute paid live Nominatim HTTP here (measured
			// 2026-07-02: ~14 endpoint misses ≈ the 13.5 s osm pass);
			// habitual endpoints now share one cached cell forever. The
			// only cost is a city boundary crossing a cell, and the
			// both-endpoints-must-agree rule already absorbs that.
			inputs.osm.reverseGeocode(cityGrid(movingStart.lat), cityGrid(movingStart.lon), CITY_ZOOM),
			inputs.osm.reverseGeocode(cityGrid(movingEnd.lat), cityGrid(movingEnd.lon), CITY_ZOOM),
		]);
		// Dedup by (type, subtype, name) but keep the *minimum* distance
		// across sample points. A road we brushed past at one sample
		// shouldn't outweigh a road we hugged at four others — and the
		// distance is what refineMode uses to tie-break parallel
		// rail/road.
		const byKey = new Map<string, (typeof wayResults)[number][number]>();
		for (const ways of wayResults) {
			for (const w of ways) {
				const key = `${w.type}/${w.subtype}/${w.name ?? ""}`;
				const existing = byKey.get(key);
				if (!existing) {
					byKey.set(key, w);
				} else {
					const existingD = existing.distanceM ?? Number.POSITIVE_INFINITY;
					const newD = w.distanceM ?? Number.POSITIVE_INFINITY;
					if (newD < existingD) byKey.set(key, w);
				}
			}
		}
		const aggregated = [...byKey.values()];
		// Rail-vs-road proximity per sample point — feeds the
		// rail-corridor factor. For each sample's nearbyWays list,
		// the minimum distance to any rail-only way and the minimum
		// to any drivable highway. Mean across samples where each
		// kind had something in range; null when no sample had it.
		// The factor scorer uses the ratio to discriminate train
		// from driving when speed-emission can't.
		const railRoad = computeRailRoadProximity(wayResults);
		// Per-sample road-vs-rail "which is nearer" fraction, from the
		// same samples — the GPS evidence the HSMM movement→train
		// override weighs against (see decideHsmmTrainOverride). No
		// extra OSM query.
		const roadCorridorFraction = computeRoadNearestFraction(wayResults);
		// Under USE_BIOMETRIC_FACTOR, pass per-segment hr/cadence + the
		// loaded mode signatures into refineMode so the factor scorer's
		// candidate generator can filter biologically-implausible
		// candidates. Without the flag, refineMode runs with no
		// biometric context and the legacy `applyBiometricSignature`
		// pass below does the corresponding work as a post-step.
		const biometricCtx =
			biometricFactorOn && preEnrichBiometrics && preEnrichModeStats
				? {
						obs: {
							hr: meanInWindow(preEnrichBiometrics.hr, (p) => p.bpm, seg.startTs, seg.endTs),
							cadence: meanInWindow(preEnrichBiometrics.steps, (p) => p.steps, seg.startTs, seg.endTs),
							speed: seg.avgSpeed,
						},
						stats: preEnrichModeStats,
					}
				: undefined;
		const refined = refineMode(
			seg.mode,
			seg.avgSpeed,
			aggregated,
			biometricCtx,
			seg.confidenceMargin,
			process.env.FACTOR_DEBUG === "1"
				? `[${new Date(seg.startTs * 1000).toISOString().slice(11, 16)}-${new Date(seg.endTs * 1000).toISOString().slice(11, 16)}Z]`
				: undefined,
			railRoad,
		);
		// Physical-plausibility override: a tube ride under a road
		// can look like driving to refineMode (the road is the
		// closest OSM way). Demote when the max speed exceeds
		// urban-non-motorway limits and a subway is parallel.
		const plausible = rejectImplausibleDriving(
			{ mode: refined.mode, wayName: refined.wayName },
			seg.maxSpeed,
			aggregated,
		);
		const movingCity = commonCity(startPlace, endPlace);
		return {
			...seg,
			// Temper motion-only confidence by the road-corridor evidence: a
			// "driving" leg the GPS shows off any road is ambiguous (could be
			// rail), so it shouldn't read a confident 100% car (#296).
			confidence: roadSupportedConfidence(plausible.mode, seg.confidence, roadCorridorFraction),
			refinedMode: plausible.mode,
			refinedReason: plausible.reason ?? refined.reason,
			wayName: plausible.wayName,
			...(movingCity ? { city: movingCity } : {}),
			...(roadCorridorFraction !== null ? { roadCorridorFraction } : {}),
		};
	};

	const enrichStart = Date.now();
	const enriched: EnrichedSegment[] = await mapLimit(refinedSegments, ENRICH_CONCURRENCY, async (seg, i) => {
		// Synthetic gap segments (inferred-walking or `unknown`) carry
		// pointCount=0 — no real GPS data. Enriching with road names /
		// OSM places would invent context we don't have. Pass them
		// through with their refinedReason intact.
		if (seg.pointCount === 0) return seg;
		const segPoints = samplesInWindow(points, seg);
		if (segPoints.length === 0) return seg;

		try {
			if (seg.mode === "stationary") {
				const cLat = segPoints.reduce((s, p) => s + p.lat, 0) / segPoints.length;
				const cLon = segPoints.reduce((s, p) => s + p.lon, 0) / segPoints.length;

				// Transit continuity: a stay immediately after a train,
				// within station range, is at the station the user just
				// alighted at — not at a co-located café (2026-05-22
				// Finchley Road ambulance wait, mislabelled "Loft Coffee
				// Company"). Takes precedence over the focus_place /
				// OSM-amenity picker below.
				const alightStation = await stationAtTrainAlight(refinedSegments[i - 1], cLat, cLon, inputs.osm);
				if (alightStation !== null) {
					const namedPlace = await bestPlace(inputs.osm, cLat, cLon, { preferResidential: false });
					const city = extractCity(namedPlace);
					return { ...seg, place: alightStation, ...(city ? { city } : {}) };
				}

				// Probabilistic place assignment: rank candidates from
				// focus_places by combined log-likelihood (Gaussian on
				// distance, σ = empirical radius) + log-prior (visit
				// frequency, time-of-day match against sleep_hours /
				// awake_hours). Replaces the old snap-radius +
				// residential-hours-threshold + amenity-gate chain.
				// See `src/geo/place-prior.ts`.
				const isSleepWindow = hasOvernightPresence(seg.startTs, seg.endTs, cLon);
				const stayHourProfile = hourProfileForRange(seg.startTs, seg.endTs, cLon);
				// Magnetic anchoring: pass biometric coherence so the
				// scorer can boost established focus_places when the
				// segment's HR + steps confirm the user was actually
				// sitting (vs walking past). See
				// `docs/proposals/2026-06-magnetic-focus-places.md`.
				const segBs = biometricCoherence({
					startTs: seg.startTs,
					endTs: seg.endTs,
					hr: biomForStaySplit.hr,
					steps: biomForStaySplit.steps,
				});
				const winner =
					knownPlaces.length > 0
						? pickBestPlace(knownPlaces.map(toPlaceCandidate), cLat, cLon, {
								stayHourProfile,
								biometricCoherence: segBs,
							})
						: null;

				if (winner !== null) {
					const wp = knownPlaces.find((p) => p.id === winner.winner.id) ?? null;
					if (wp !== null) {
						// Snap the centroid to the place's stored centroid
						// so downstream OSM-amenity / city lookup runs at the
						// place's "true" coordinates instead of the day's
						// noisy aggregate.
						const placeLat = wp.centroidLat;
						const placeLon = wp.centroidLon;

						// Personal label wins outright — but only for the
						// "intent" labels Home / Work. The "Stay" category
						// label is just a clustering bucket, not a useful
						// timeline name; fall through to address lookup.
						if (wp.displayName === "Home" || wp.displayName === "Work") {
							const namedPlace = await bestPlace(inputs.osm, placeLat, placeLon, { preferResidential: true });
							const namedCity = extractCity(namedPlace);
							return {
								...seg,
								place: wp.displayName,
								focusPlaceId: wp.id,
								...(namedCity ? { city: namedCity } : {}),
							};
						}
						// Mined cluster-level amenity_label (majority-vote
						// across the user's prior visits to this cluster)
						// when the cluster isn't residential. Residential
						// clusters fall through to the address lookup —
						// A residential address beats a co-located cafe
						// label because the cluster's sleep_hours dwarfs
						// its awake_hours.
						const isResidential = wp.sleepHours >= RESIDENCE_SLEEP_THRESHOLD_H;
						if (!isResidential && wp.amenityLabel) {
							const namedPlace = await bestPlace(inputs.osm, placeLat, placeLon, { preferResidential: false });
							const namedCity = extractCity(namedPlace);
							return {
								...seg,
								place: wp.amenityLabel,
								focusPlaceId: wp.id,
								...(namedCity ? { city: namedCity } : {}),
							};
						}
						// Residential without a personal label, or no mined
						// amenity_label — fall through to bestPlace at the
						// snapped centroid. Prefer the address when the
						// cluster is residential OR the mining gate found
						// no confident venue here (null amenity_label): a
						// venue-less place — e.g. an evening-only residence
						// the sleep gate misses — must show a neutral
						// area/address, not a low-confidence nearby park.
						const venueless = wp.amenityLabel === null;
						const place = await bestPlace(inputs.osm, placeLat, placeLon, {
							preferResidential: isResidential || venueless,
							stay: { startUnix: seg.startTs, endUnix: seg.endTs, tz: tzLookup(placeLat, placeLon) },
							priors: inputs.venuePriors ?? null,
						});
						if (!place) return seg;
						const city = extractCity(place);
						return {
							...seg,
							place: placeLabel(place),
							focusPlaceId: wp.id,
							...(city ? { city } : {}),
						};
					}
				}

				// No focus_place crossed the posterior floor — this is a
				// stay somewhere new. Use the day's centroid and the
				// per-stay overnight check to decide residential preference.
				const preferResidential = isSleepWindow;
				const place = await bestPlace(inputs.osm, cLat, cLon, {
					preferResidential,
					stay: { startUnix: seg.startTs, endUnix: seg.endTs, tz: tzLookup(cLat, cLon) },
					priors: inputs.venuePriors ?? null,
				});
				if (!place) return seg;
				const city = extractCity(place);
				return {
					...seg,
					place: placeLabel(place),
					...(city ? { city } : {}),
				};
			}
			return enrichMovingSegment(seg, segPoints);
		} catch (e) {
			console.warn(`OSM enrichment failed for segment ${seg.startTs}: ${e}`);
			return seg;
		}
	});
	phaseTimes.osm = Date.now() - enrichStart;

	// Cadence-based correction: a "walking" segment with no recorded steps
	// is almost certainly a passenger in slow traffic, an escalator, or
	// similar — relabel before merge so neighbouring drives can absorb it.
	const { hr, sleep, steps } = await biometricsPromise;
	const flipped = timeSync("cadenceCorrect", () => enriched.map((s) => correctModeFromCadence(s, steps)));
	// Undo cadence flips with no adjacent real driving: the correction exists so
	// a neighbouring drive can absorb a slow-traffic leg, so an isolated flip
	// (a slow walk whose phone didn't count steps) is a false positive. Runs
	// before merge so surviving flips can still coalesce into their drive.
	const reverted = timeSync("revertIsolatedCadence", () => revertIsolatedCadenceDrives(flipped));
	// A "walking" leg with zero recorded steps and a path that just jitters
	// around one spot is sitting still (a restaurant, a waiting room) where
	// urban/indoor GPS wandered enough to score as a slow walk. Demote to
	// stationary so the stays around it coalesce into one clean visit instead
	// of fragmenting and grabbing wrong place names.
	const corrected = timeSync("jitterWalkToStay", () => reverted.map((s) => demoteJitterWalkToStationary(s, steps)));

	// Biometric-signature correction: re-evaluate ambiguous segments
	// against the user's per-mode (HR, cadence, speed) signatures from
	// mode_biometrics. Fixes the walking-mislabeled-as-driving case
	// (low-speed segment with HR 110 + cadence 100 looks nothing like
	// driving even though the speed scored ambiguously) and the cycling-
	// mislabeled-as-driving case. See `correctModeBySignature` for the
	// gating rules.
	//
	// When USE_BIOMETRIC_FACTOR is on, refineMode above has already
	// consulted the per-user biometric signatures via the factor scorer's
	// candidate generator — running this pass on top would double-correct
	// (and bypass the scorer's principled aggregation in favour of a
	// hard-coded cascade). Skip in that case; otherwise this is the
	// production path.
	const modeStats = preEnrichModeStats ?? (await modeStatsPromise);
	const biometricCorrected = biometricFactorOn
		? corrected
		: timeSync("biometricCorrect", () => corrected.map((seg) => applyBiometricSignature(seg, hr, steps, modeStats)));

	// Hard physical-impossibility overrides: a car can't sustain 300+ km/h,
	// a train can't average 600 km/h. These are constraints, not
	// heuristics — enforced regardless of GPS / OSM / biometric output.
	// Apply BEFORE merge so consistent modes can coalesce. Also propagate
	// the override into refinedMode so downstream consumers (annotateRail
	// Runs, frontend) see the corrected mode.
	const physicallyCorrected = timeSync("physicalConstraints", () =>
		biometricCorrected.map((seg) => {
			const constrained = enforcePhysicalConstraints(seg);
			if (constrained.mode === seg.mode) return seg;
			return { ...constrained, refinedMode: constrained.mode };
		}),
	);

	const homeTz = inputs.homeTz;
	const hmmDecode = inputs.hsmmDecode;

	type RefinementPass = {
		name: string;
		run: (segs: EnrichedSegment[]) => EnrichedSegment[] | Promise<EnrichedSegment[]>;
	};

	// A single timing wrapper for the refinement cascade below that handles
	// sync OR async passes and records into `phaseTimes` exactly like
	// `time` / `timeSync` do (start-to-finish wall clock, accumulated per phase).
	const runPass = async (
		phase: string,
		run: () => EnrichedSegment[] | Promise<EnrichedSegment[]>,
	): Promise<EnrichedSegment[]> => {
		const start = Date.now();
		try {
			return await run();
		} finally {
			phaseTimes[phase] = (phaseTimes[phase] ?? 0) + (Date.now() - start);
		}
	};

	// ───────────────────────────────────────────────────────────────────────
	// Refinement cascade. The ORDER of these passes is load-bearing: each pass
	// consumes the segments the previous one produced, and several rationale
	// comments below spell out precisely why a pass must run after another
	// (e.g. the second cadence revert needs annotateRailRuns to have run, the
	// rail reconcile must precede rail-snap). It is now expressed as data — one
	// array entry per pass, in execution order — so the whole sequence is
	// auditable in one place. Do not reorder without reading the comments.
	// ───────────────────────────────────────────────────────────────────────
	const passes: RefinementPass[] = [
		// Stationary-coherence constraint: a segment the classifier called
		// `stationary` but whose fixes march in a directed line over real
		// distance is slow locomotion (a walk to a platform), not a stay —
		// low per-fix speed misread it as dwelling. Reclassify to walking
		// BEFORE merge + place attribution, so it (a) coalesces with the
		// adjacent walk and (b) never gets named after a POI it merely drifted
		// past (the 2026-06-12 "Bleecker" / "The Other Palace" phantoms). Net
		// displacement is the straight-line first→last fix distance; isolated
		// stays (low linearity) and barely-moving stays (small displacement)
		// are untouched. See `isStationaryIncoherent`.
		{
			name: "stationaryCoherence",
			run: (segs) =>
				segs.map((seg) => {
					if (effectiveMode(seg) !== "stationary") return seg;
					const segPoints = samplesInWindow(points, seg);
					if (segPoints.length < 2) return seg;
					const first = segPoints[0];
					const last = segPoints[segPoints.length - 1];
					const netDisplacementM = haversineMeters(first.lat, first.lon, last.lat, last.lon);
					// The dwell-with-departure-tail carve-out (#354) judges what the
					// window's pedestrian-paced mass did, separately from the raw
					// march signal — a ride head stranded in a long stay's tail must
					// not flip hours of dwelling into one giant walk.
					const coreDisplacementM = pedestrianCoreDisplacementM(segPoints);
					const durationS = seg.endTs - seg.startTs;
					if (process.env.STAY_FLIP_DEBUG === "1") {
						const oldFlip = seg.linearity > 0.7 && netDisplacementM > 90;
						const newFlip = isStationaryIncoherent({
							linearity: seg.linearity,
							netDisplacementM,
							coreDisplacementM,
							durationS,
						});
						if (oldFlip !== newFlip) {
							const t = (ts: number): string => new Date(ts * 1000).toISOString().slice(11, 16);
							console.error(
								`[stay-flip] ${t(seg.startTs)}-${t(seg.endTs)} lin=${seg.linearity.toFixed(2)} rawNet=${netDisplacementM.toFixed(0)} coreNet=${coreDisplacementM.toFixed(0)} dur=${Math.round(durationS / 60)}m old=${oldFlip} new=${newFlip}`,
							);
						}
					}
					if (!isStationaryIncoherent({ linearity: seg.linearity, netDisplacementM, coreDisplacementM, durationS }))
						return seg;
					return {
						...seg,
						mode: "walking" as const,
						refinedMode: "walking" as const,
						refinedReason: `stationary-coherence override (linear ${netDisplacementM.toFixed(0)} m progress, lin ${seg.linearity.toFixed(2)} — moving, not a stay)`,
						place: undefined,
					};
				}),
		},

		{
			name: "merge",
			run: (segs) => mergeAdjacentMoving(mergeAdjacentStays(segs, steps)),
		},

		// Collapse a sit that indoor/urban GPS jitter shattered into several
		// co-located stays with different wrong labels (see demoteJitterWalkToStationary).
		// Re-resolves the merged stay's venue from its combined centroid. Confined to
		// runs containing a jitter-demoted leg, so normal multi-stay days are untouched.
		{
			name: "consolidateJitterStays",
			run: (segs) => consolidateJitterStays(attachStayCentroids(segs, points), inputs.osm, inputs.venuePriors ?? null),
		},

		{
			name: "railRuns",
			run: (segs) =>
				annotateRailRuns(
					segs,
					points,
					(lat, lon) => inputs.osm.nearbyStations(lat, lon, RAIL_RUN_STATION_RADIUS_M),
					(lat, lon) => inputs.osm.linesAtPoint(lat, lon),
				),
		},

		// Underground reconstruction: a tube ride leaves only coarse
		// cell-network fixes, which annotateRailRuns cannot resolve. Mine
		// those coarse fixes (from the raw, pre-Kalman track) to identify the
		// line and split the swallowing walk into walk → train → walk.
		{
			name: "undergroundRail",
			run: (segs) =>
				annotateUndergroundRuns(
					segs,
					inDay,
					(lat, lon) => inputs.osm.nearbyStations(lat, lon, UNDERGROUND_STATION_RADIUS_M),
					(lat, lon) => inputs.osm.linesAtPoint(lat, lon, UNDERGROUND_LINES_RADIUS_M),
					(lat, lon) => inputs.osm.nearbyWays(lat, lon),
				),
		},

		// Second cadence-drive revert. The FIRST revert (≈l.933) runs before
		// annotateRailRuns / annotateUndergroundRuns exist, so the afternoon's
		// fast underground fixes were still `driving` then — and a cadence-flip
		// sandwiched between them (a platform interchange) saw a "driving"
		// neighbour and survived. Now those neighbours are `train`, so an
		// isolated walking-pace flip between two trains reverts to the walk it
		// is (the 2026-06-12 King's Cross Victoria→Met interchange). A real
		// drive to a station is unaffected: it is not pedestrian-paced, so the
		// avg-speed gate in revertIsolatedCadenceDrives keeps it.
		{
			name: "revertIsolatedCadence2",
			run: (segs) => revertIsolatedCadenceDrives(segs),
		},

		// Absorb a platform / concourse wait into the boarding of its train
		// run, so a station wait doesn't surface as a standalone stay
		// mislabelled with the nearest focus place.
		{
			name: "boardingPlatform",
			run: (segs) =>
				absorbBoardingPlatform(segs, points, (lat, lon) =>
					inputs.osm.nearbyStations(lat, lon, RAIL_RUN_STATION_RADIUS_M),
				),
		},

		// Absorb a transit interchange — a run of short stationary segments
		// between a train and onward movement — into the preceding train,
		// so it doesn't surface as a phantom place-stay. See absorbInterchanges.
		{
			name: "interchange",
			run: (segs) => absorbInterchanges(segs),
		},

		// Absorb a phantom drive-stop — a brief stationary segment
		// sandwiched between two driving segments with zero/near-zero steps
		// across it. The biometric data confirms the user stayed in the
		// vehicle; the stop was just GPS noise at a traffic light or in
		// dense urban congestion. See absorbDriveStops + the 2026-06-02
		// "phantom Lanesborough" case in conversation context.
		{
			name: "driveStops",
			run: (segs) => absorbDriveStops(segs, biomForStaySplit.steps),
		},

		// Physical constraint: back-to-back train legs must share a station.
		// You can't step off one train and instantly be on another at a
		// different station — so a leg whose independently-resolved boarding
		// contradicts the previous leg's alighting is corrected to board
		// where that leg alighted. Runs after the interchange absorber so it
		// sees the final train-leg adjacency, and before rail-snap so the
		// snap keys off the corrected station pair. See reconcileAdjacentRailLegs.
		{
			name: "railReconcile",
			run: (segs) => reconcileAdjacentRailLegs(segs),
		},

		// Coalesce a tube ride the reconstruction left as two adjacent
		// same-route train segments (one possibly line-named, one not) — the
		// 2026-06-12 Victoria→King's Cross split. Runs after reconciliation so
		// it sees the final, station-corrected legs.
		{
			name: "mergeSameRouteTrains",
			run: (segs) => mergeAdjacentSameRouteTrains(segs),
		},

		// Stationary walk-through correction (cadence + GPS-translation fusion):
		// a "stationary" stop the watch shows was actually a walk-through — a clear
		// per-minute step burst coinciding with real GPS translation. Runs HERE,
		// after every rail / drive absorber has claimed the station-walking and
		// drive-stop segments it owns, so this only touches genuine standalone
		// phantom stops (the 2026-05-25 Union Park park-stroll case). The pass
		// carries its own cross-segment guards (intra-place pacing, walking-only
		// coalesce) — see applyStationaryWalkThrough.
		// Interchange decomposition (task #222): a train leg whose endpoint
		// line sets are disjoint is impossible as one ride — split it at the
		// watch-timed interchange step burst, with the change station picked
		// from the line graph by timing fit.
		{
			name: "interchangeSplit",
			run: (segs) => spliceInterchanges(segs, points, steps, inputs.osm),
		},
		{
			name: "walkThrough",
			run: (segs) => applyStationaryWalkThrough(segs, steps, points),
		},

		// A short walk between two train legs that share a station is the
		// platform-to-platform interchange (a line change), not a street walk —
		// relabel it to the station so GPS resurfacing mid-change doesn't name it
		// after the nearest road (the 2026-06-16 Baker St Met→Jubilee change,
		// mislabelled "Allsop Place"). See relabelWalkingInterchanges.
		{
			name: "interchangeLabel",
			run: (segs) => relabelWalkingInterchanges(segs),
		},

		// A "walking" segment that actually contains a short ride — got off
		// the train, then a taxi/bus to the door — averages to walking pace and
		// stays one walk. Carve the ride out as `driving` by net GPS progress
		// (net displacement, not the jittery per-fix speed, so a stationary
		// platform wait is never split). Runs here so the post-train walk
		// already exists and the carved leg can still be bus-refined below.
		{
			name: "vehicleSplit",
			run: (segs) => splitWalksOnVehicleLeg(segs, points),
		},

		// Walk→vehicle boundary correction (#176): a drive's launch from the
		// kerb is slow enough to be glued onto the preceding walk by
		// segmentation, leaving a vehicle-paced tail hidden inside a
		// "walking" leg (the 2026-06-21 "24 km/h walk down Midholm"). Where
		// the next segment is already a confirmed road vehicle, move that
		// sustained tail across the boundary into the ride. Runs after
		// vehicleSplit so an interior ride is carved first and its trailing
		// walk, if any, is the segment evaluated here.
		{
			name: "walkVehicleHandoff",
			run: (segs) => reassignWalkTailToVehicle(segs, points),
		},

		// Vehicle→walk ARRIVAL correction: the mirror of walkVehicleHandoff.
		// A drive decelerating to a halt at a stay leaves its final slow
		// seconds glued to the first minute of sitting still, and the blended
		// segment's diluted mean scores WALKING — a phantom walk wedged
		// between the drive and the stay (2026-07-09 Grenfell Gardens → Home,
		// mislabelled "walk on The Avenue"). Move the vehicle-paced head back
		// into the preceding drive; if the residual is already parked at the
		// stay, dissolve the walk into it. Runs after walkVehicleHandoff so
		// the launch-side boundary is settled first.
		{
			name: "vehicleArrival",
			run: (segs) => reassignVehicleArrivalWalk(segs, points),
		},

		// The mirror of vehicleArrival for the OTHER side of a ride boundary
		// (#356): a train leg whose edge sustains a pedestrian-paced stepping
		// run (pace + duration + net distance + wearer cadence all agree) is
		// still carrying the user's walk to/from the platform — hand that run
		// to the adjacent walking segment. Fixes the "train at walking pace
		// down the street" / "walk starts 200 m from the station" class the
		// worldline-feasibility invariant counts. Runs before
		// reenrichSplitWalks so the extended walk gets re-derived enrichment.
		{
			name: "vehicleEdgeShed",
			run: (segs) => shedVehiclePedestrianEdges(segs, points, biomForStaySplit.steps),
		},

		// Re-enrich the on-foot remainders `vehicleSplit` left behind.
		//
		// The OSM pass ran ~30 passes ago, on segments that had not yet been
		// split. When a "walk" turns out to have spanned a ride — classically
		// because the fixes cut out underground, gluing walk + tube + walk into
		// one row — everything that pass concluded about it was derived from a
		// window containing the ride: the road name from a line of samples drawn
		// straight through it, the refined mode from speeds averaged across it.
		//
		// The 2026-07-12 case: one segment ran King's Cross → Highbury &
		// Islington. Both remainders came out named "Euston Road" (the parent's
		// pick, hugged at the King's Cross end) — including the one 4 km away on
		// Upper Street. `walkRemainder` has already recomputed their kinematics
		// and cleared that enrichment; here they get their own, from their own
		// geometry, exactly as if they had been separate segments all along.
		//
		// Runs after walkVehicleHandoff / vehicleArrival so the walk↔vehicle
		// boundaries are settled first — no point naming a stretch that is about
		// to be re-cut. A remainder that fails re-enrichment stays honestly
		// unnamed rather than confidently wrong.
		{
			name: "reenrichSplitWalks",
			run: async (segs) => {
				const stale = segs.filter((s) => s.needsReenrich);
				if (stale.length === 0) return segs;
				const redone = new Map<number, EnrichedSegment>();
				await Promise.all(
					stale.map(async (seg) => {
						const segPoints = samplesInWindow(points, seg);
						if (segPoints.length === 0) return;
						try {
							redone.set(seg.startTs, await enrichMovingSegment(seg, segPoints));
						} catch (e) {
							console.warn(`re-enrichment failed for split walk ${seg.startTs}: ${e}`);
						}
					}),
				);
				return segs.map((s) => {
					if (!s.needsReenrich) return s;
					const { needsReenrich: _, ...rest } = redone.get(s.startTs) ?? s;
					return rest;
				});
			},
		},

		// Rail-journey assembly: when GPS surfaces mid-tunnel, one continuous
		// Underground ride is shattered into several train legs plus short
		// slivers (platform jitter mis-scored walking/stationary, or a mis-moded
		// vehicle leg from the surfaced fixes). If a SINGLE rail line serves
		// every station the run's legs touch, it was one ride on that line —
		// collapse it to one leg, absorbing the slivers. The line topology, not a
		// GPS heuristic, decides; a genuine multi-line interchange (no single
		// serving line) is left intact. Runs after vehicleSplit so a surfaced
		// mis-moded middle is present to absorb, before railSnap so the merged
		// leg is snapped. The 2026-06-23 Wembley Park→Euston Square fix.
		// Re-anchor an underground train's boarding to the station the preceding
		// walk actually reached. When GPS surfaces a stop or two into a tunnel,
		// the reconstruction boards the train at the first snappable fix (a
		// station or two past the real boarding) and the walk keeps the stranded
		// first hop — so the walk line bleeds on to the next station (the
		// 2026-06-23 UCLH → Euston Square walk that drew on to Great Portland
		// Street, boarding read "Baker Street"). Runs before railJourney so the
		// corrected boarding feeds the journey merge. See
		// anchorTrainBoardingToWalkedStation.
		{
			name: "boardingAnchor",
			run: (segs) =>
				anchorTrainBoardingToWalkedStation(segs, points, (lat, lon) =>
					inputs.osm.nearbyStations(lat, lon, RAIL_RUN_STATION_RADIUS_M),
				),
		},

		// Alight anchor (#288): the mirror of boardingAnchor for the disembark
		// side. When GPS blacks out in a tunnel the train closes at the surfaced
		// station and the ride on to the true alight (a stop or two downline on
		// the same line) is stranded as the FAST leading fixes of the next walk.
		// Extend the train forward to that station and trim the walk. The
		// 2026-06-29 outbound Wembley Park → Baker Street that should be → Euston
		// Square. Runs after boardingAnchor, before railJourney so the corrected
		// alight feeds the journey merge. See anchorTrainAlightToWalkedStation.
		{
			name: "alightAnchor",
			run: (segs) =>
				anchorTrainAlightToWalkedStation(
					segs,
					points,
					(lat, lon) => inputs.osm.nearbyStations(lat, lon, RAIL_RUN_STATION_RADIUS_M),
					(lat, lon) => inputs.osm.linesAtPoint(lat, lon),
				),
		},

		{
			name: "railJourney",
			run: (segs) => assembleRailJourney(segs, points, inputs.osm),
		},

		// Short clean tube-hop rescue (#280): a brief Underground hop whose GPS
		// surfaces cleanly (fixes on the platforms) trips neither
		// annotateUndergroundRuns gate (≥180 s + coarse fixes), so it survives as
		// a `driving` leg carved out by vehicleSplit — and the only thing left to
		// label it is the bus matcher. Upgrade a fast (≥ bus-pace ceiling)
		// station-to-station driving leg on a shared Underground line to `train`,
		// making it ineligible for the bus passes. Runs AFTER railJourney so it
		// can't trigger a journey over-merge, BEFORE railSnap so the upgraded leg
		// can still be snapped. The 2026-06-29 Euston Square → Baker Street hop
		// mislabelled "bus 18". See upgradeTubeHops.
		{
			name: "tubeHop",
			run: (segs) =>
				upgradeTubeHops(
					segs,
					points,
					(lat, lon) => inputs.osm.nearbyStations(lat, lon, RAIL_RUN_STATION_RADIUS_M),
					(lat, lon) => inputs.osm.linesAtPoint(lat, lon),
				),
		},

		// Rail-snap: attach the precomputed rail-track geometry to each
		// train run whose route is in rail_route_cache (filled offline by
		// refresh-rail-routes). One indexed lookup — purely additive, the
		// raw track is untouched. See annotateSnappedPaths.
		{
			name: "railSnap",
			run: (segs) => annotateSnappedPaths(segs, inputs.railRouteCache),
		},

		// Bus-vs-car stop-pattern evidence (task #247): a refined-driving leg
		// whose boarding wait and mid-leg dwells coincide with bus_stop nodes
		// is a bus. Runs after all mode refinement so it judges the final
		// driving legs; purely additive annotation.
		{
			name: "busEvidence",
			run: (segs) => annotateBusEvidence(segs, points, inputs.osm),
		},

		// C-bus route naming (#252): for each driving leg, anchor its first +
		// last fix to a mirrored bus route's stops and, on a match, name the
		// bus ("From → To · Ref") + mark it a bus. Stronger than the dwell
		// evidence above — it catches short rides with too few dwells to score
		// (the 06-12 Green Park→clinic leg). Purely additive: with an empty
		// `bus_route_cache` (no mirror yet, or fixtures predating it) this is a
		// no-op, so the golden corpus is unchanged until routes are captured.
		{
			name: "busRoutes",
			run: (segs) => annotateBusRoutes(segs, points, inputs.busRouteCache ?? []),
		},

		// Road map-matching (#261): snap each road-vehicle leg (driving / bus /
		// cycling) onto the OSM street network so the map draws it on the road
		// instead of the raw GPS zigzag through buildings. Runs after all mode
		// refinement so it only matches the final road legs. Purely additive —
		// attaches `matchedPath`; with no road data (fixtures predating #261, or
		// a leg the matcher can't place) it is a no-op and the raw track draws.
		{
			name: "roadMatch",
			run: (segs) => annotateRoadMatches(segs, points, inputs.osm),
		},

		// Pedestrian map-matching (#265): snap each walking leg onto the OSM
		// walkable network (footway / path / pedestrian / residential…) so the
		// map draws it on the pavement instead of the raw GPS cutting across
		// buildings. Attaches `walkMatchedPath`; episode-geometry prefers the
		// matched line, falling back to the raw track when the matcher bails
		// (off-network / fragmented graph). Display geometry only — states
		// unchanged.
		{
			name: "walkMatch",
			// `options.walkMatch === false` (the /api/velocity `walkMatch=0` query
			// param) skips matching so the map can render the raw walks for an A/B
			// comparison against the pavement-matched line.
			run: (segs) =>
				options.walkMatch === false
					? segs
					: annotateWalkMatches(segs, displayFixes, points, inputs.osm, biomForStaySplit.steps, options.walkDraw),
		},

		// Per-segment displayTz: the IANA tz the frontend should use to render
		// the segment's wall-clock. Derived from the segment's geographic
		// location (centroid for stationary, midpoint for moving). Lets the UI
		// show times "as the user experienced them" — morning at parents in
		// CEST, evening home in BST, even across a travel day. Fallback to
		// home_tz / Europe/Amsterdam when no points cover the segment (inferred
		// gap segments).
		{
			name: "displayTz",
			run: (segs) =>
				segs.map((s): EnrichedSegment => {
					const segPoints = samplesInWindow(points, s);
					if (segPoints.length === 0) {
						return { ...s, displayTz: homeTz };
					}
					// Stationary: centroid. Moving: midpoint of path.
					let lat: number;
					let lon: number;
					if (s.mode === "stationary") {
						lat = segPoints.reduce((acc, p) => acc + p.lat, 0) / segPoints.length;
						lon = segPoints.reduce((acc, p) => acc + p.lon, 0) / segPoints.length;
					} else {
						const mid = segPoints[Math.floor(segPoints.length / 2)];
						lat = mid.lat;
						lon = mid.lon;
					}
					try {
						return { ...s, displayTz: tzLookup(lat, lon) };
					} catch {
						return { ...s, displayTz: homeTz };
					}
				}),
		},

		// Final cross-modal enrichment: attach HR / sleep / steps stats per
		// segment. Missing Fitbit data → biometrics fields are null/zero.
		{
			name: "biomEnrich",
			run: (segs) => segs.map((s) => ({ ...s, biometrics: enrichSegmentWithBiometrics(s, hr, sleep, steps) })),
		},

		// HSMM place override — when an HSMM decode exists in decoded_days
		// for this (user, date), use its place picks to override the
		// pipeline's `place` attribution on stationary segments. The HSMM
		// scores ~96% place vs ground truth (2026-05-25 audit) where the
		// pipeline drifts on multi-candidate clusters. Falls back to the
		// pipeline's label when no decode exists (cron hasn't run yet) or
		// the HSMM is uncertain.
		{
			name: "hsmmOverride",
			run: (segs) => {
				if (!hmmDecode) return segs;
				const placeLookup = new Map<number, { displayName: string | null; lat: number; lon: number }>();
				for (const p of knownPlaces) {
					if (typeof p.id === "number") {
						placeLookup.set(p.id, { displayName: p.displayName, lat: p.centroidLat, lon: p.centroidLon });
					}
				}
				return applyHsmmPlaceOverride(segs, hmmDecode, placeLookup);
			},
		},

		// Final merge pass — by this point HSMM may have attached a place
		// to a segment that was un-placed at the earlier merge (e.g., a
		// walking-reclassified-to-stationary segment that the place-attribution
		// stage skipped because its raw `mode` was still "walking"). Re-run
		// mergeAdjacentStays so two consecutive same-place segments don't
		// surface as duplicates — the 2026-06-02 "two Home stays" case.
		// Absorb intra-place pottering (a kitchen / bathroom run that split a
		// long office or home stay in two) BEFORE the final merge, so the demoted
		// walk coalesces into its stay. See absorbIntraPlaceWalk.
		{
			name: "finalMerge",
			// ...then swallow a phantom focus-place stay: a transient the place's
			// over-long veto radius mis-labelled (a coffee stop at the station
			// stamped "Work"), surfacing as a spurious leave-and-return. When it
			// demotes a stay to walking it returns a NEW array (else the same
			// reference), so coalesce the freshly-adjacent walks ONLY then —
			// keeping days with no such artifact byte-identical. See
			// absorbFarFocusPlacePhantom.
			run: (segs) => {
				const intra = absorbIntraPlaceWalk(segs, points);
				const swallowed = absorbFarFocusPlacePhantom(intra, knownPlaces, points);
				// dev-lint: allow-reference-equality absorbFarFocusPlacePhantom returns its
				// input array by identity on a no-op, so !== means "a stay was demoted" —
				// coalesce the freshly-adjacent walks only then, keeping other days byte-identical.
				const coalesced = swallowed === intra ? swallowed : mergeAdjacentMoving(swallowed);
				return mergeAdjacentStays(coalesced, steps);
			},
		},
		// Plausibility critic: repair any contiguous vehicle hand-off the
		// grammar forbids — absorb a non-train leg flush against an identified
		// train journey into that journey (the tube-under-a-road "driving"
		// stretch). See src/geo/passes/repair-handoff.ts and src/infer/day-grammar.ts.
		{
			name: "repairHandoff",
			run: (segs) => repairVehicleHandoff(segs),
		},

		// Re-establish the back-to-back shared-station constraint over the FINAL
		// leg sequence. railReconcile enforced it early, on the pre-merge
		// fragments — but two later passes invalidate that: railJourney rewrites a
		// merged ride's alight, and repairHandoff absorbs the surfaced sliver that
		// was keeping an interchange's two legs apart. An invariant checked before
		// the last pass that can break it is not an invariant.
		//
		// The 2026-06-28 morning: the Metropolitan ride now alights at "King's
		// Cross St Pancras", while the Victoria leg boarding the same platform
		// still carries "London King's Cross" — the co-located National Rail node
		// that `nearbyStations` happens to rank 1.7 m closer. One interchange, two
		// names, and a rail-discontinuity between them. Same pure constraint, run
		// where it can finally see the truth.
		{
			name: "railReconcile2",
			run: async (segs) => reconcileAdjacentRailLegs(segs),
		},

		// Transit-interchange stay label: a stationary stay sitting at a station
		// and bracketed by train legs on BOTH sides — a train alighting just
		// before (across at most one short platform-change walk) and a train
		// boarding just after — is a change of trains, not a venue visit. Name it
		// the station so a co-located shop can't be surfaced as a destination (the
		// 2026-06-29 Baker Street platform change mislabelled "Krispy Kreme", a
		// fast-food unit mapped 40 m away inside the station). Runs LAST, because
		// the train adjacency is only final after the rail passes AND repairHandoff
		// absorb the surfaced slivers between the change and the next ride; the
		// early place-enrichment that named the stay had no transit context yet.
		// See `stationAtTransitInterchange`.
		{
			name: "interchangeStayLabel",
			run: async (segs) => {
				const out = [...segs];
				for (let i = 0; i < out.length; i++) {
					const s = out[i];
					if (s.mode !== "stationary") continue;
					// Centroid from the stay's own fixes — `centroidLat` isn't
					// reliably attached at this point, so compute it here as the
					// enrichment does.
					const segPoints = samplesInWindow(points, s);
					if (segPoints.length === 0) continue;
					const cLat = segPoints.reduce((a, p) => a + p.lat, 0) / segPoints.length;
					const cLon = segPoints.reduce((a, p) => a + p.lon, 0) / segPoints.length;
					// Provenance guard: a stay the posterior assigned to an
					// established focus place is a destination, not a platform —
					// pass its visit-days so the labeller can refuse the rename.
					const focus =
						s.focusPlaceId !== undefined ? inputs.knownPlaces.find((p) => p.id === s.focusPlaceId) : undefined;
					const station = await stationAtTransitInterchange(
						out,
						i,
						cLat,
						cLon,
						inputs.osm,
						undefined,
						focus?.uniqueDays,
					);
					if (station !== null && station !== s.place) {
						out[i] = {
							...s,
							place: station,
							refinedReason: s.refinedReason
								? `${s.refinedReason}; transit interchange → named station`
								: "transit interchange → named station",
						};
					}
				}
				return out;
			},
		},

		// LAST. `driving` is this cascade's placeholder for "a vehicle-speed run
		// nobody has identified yet" — `vehicleSplit` mints it, and the rail and
		// bus passes above each get their chance to claim it. They have now all
		// had that chance, so any placeholder still wearing the name of a car
		// must justify it with road evidence or be demoted to an honest
		// `vehicle`. Must run after `roadMatch` / `busRoutes` / `busEvidence`
		// (which supply that evidence) and after every mode upgrade — otherwise
		// it would demote a tube ride that simply hadn't been identified yet,
		// which is the very bug it exists to fix. See `resolveVehicleIdentity`.
		{
			name: "vehicleIdentity",
			run: (segs) => resolveVehicleIdentity(segs),
		},
	];

	let segs = physicallyCorrected;
	// PASS_TRACE=1 prints the segment list after every refinement pass that
	// changed it — the way to find which pass ate (or invented) a segment.
	const trace = process.env.PASS_TRACE === "1";
	const traceLine = (list: readonly EnrichedSegment[]): string =>
		list
			.map((s) => {
				const t = (ts: number): string => new Date(ts * 1000).toISOString().slice(11, 16);
				return `${t(s.startTs)}-${t(s.endTs)}:${effectiveMode(s)}`;
			})
			.join(" ");
	let prevTrace = trace ? traceLine(segs) : "";
	if (trace) console.error(`[pass-trace] input: ${prevTrace}`);
	for (const pass of passes) {
		segs = await runPass(pass.name, () => pass.run(segs));
		if (trace) {
			const cur = traceLine(segs);
			if (cur !== prevTrace) {
				console.error(`[pass-trace] ${pass.name}: ${cur}`);
				prevTrace = cur;
			}
		}
	}
	const withBiometrics = segs;

	const total = Date.now() - t0;
	const summary = Object.entries(phaseTimes)
		.map(([k, v]) => `${k}=${v}ms`)
		.join(" ");
	console.log(`velocity ${date} user=${userId}: total=${total}ms ${summary} segments=${withBiometrics.length}`);

	// Day-state composition (bottom layer of the three-altitude model):
	// load the main sleep windows that bracket this day, derive each
	// window's place from the surrounding stationary segments, and
	// compose the non-overlapping state sequence. Sleep at a stationary
	// place rewrites the mode to "sleeping"; sleep while moving sets
	// `asleep: true` as an attribute. See `src/sleep/day-state.ts`.
	//
	// For sleep-place attribution, augment today's segments with
	// synthetic stationary candidates derived from the neighbouring
	// days' fixes. Two cases:
	//   - Next-day morning fixes: handle the post-midnight evening
	//     sleep case (taxi home from a late hospital stay, then sleep
	//     at home; today's last segment is the hospital, but the user
	//     actually slept at home).
	//   - Prior-day evening fixes: handle the morning sleep case
	//     where today's first stationary segment is hours later
	//     (sleeping starts before that segment, and the user actually
	//     slept where they stayed yesterday evening — e.g. a
	//     guesthouse from the night before).
	// The synthetic candidates are only fed to derivePlaceForSleep —
	// they never enter the day's segment output. Each candidate's
	// label is re-resolved through `bestPlace` (preferResidential: true,
	// since these stays sit inside the sleep window) so a lodging POI
	// near the centroid wins over a focus_place's generic "Stay" label
	// — without this, a hotel stay attaches "Stay" instead of the
	// hotel's name. See `src/sleep/known-place-stays.ts`.
	const morningStays = timeSync("morningStays", () =>
		detectKnownPlaceStays(
			morningRaw.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon })),
			knownPlaces,
		),
	);
	const prevEveningStays = timeSync("prevEveningStays", () =>
		detectKnownPlaceStays(
			prevEveningRaw.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon })),
			knownPlaces,
		),
	);
	// Only re-resolve via bestPlace when the focus_place match returned
	// a generic placeholder ("Stay") — the OSM POI lookup then has a
	// chance to find a lodging name. When the focus_place already has
	// a specific label (Home, Work, named hotel from a prior re-mine),
	// keep it: bestPlace would otherwise replace "Home" with the
	// residential street address.
	const isGenericStayLabel = (s: string): boolean => s === "Stay";
	const resolvedSleepStays = await time(
		"resolveSleepStays",
		Promise.all(
			[...morningStays, ...prevEveningStays].map(async (stay) => {
				if (!isGenericStayLabel(stay.place)) return stay;
				const resolved = await bestPlace(inputs.osm, stay.centroidLat, stay.centroidLon, { preferResidential: true });
				const placeName = resolved ? placeLabel(resolved) : stay.place;
				return { ...stay, place: placeName };
			}),
		),
	);
	const sleepPlaceCandidates: EnrichedSegment[] = [
		...withBiometrics,
		...resolvedSleepStays.map(synthesizeStayCandidateSegment),
	];
	const rawSleep = inputs.sleepWindows;
	const sleepWindows = enrichSleepWindows(rawSleep, sleepPlaceCandidates);
	const states = timeSync("dayStates", () => segmentsToDayStates(withBiometrics, sleepWindows));

	// No observed data at all for the day. Rather than show a blank
	// timeline, infer a single stay when the day is fully constrained by
	// its neighbours (same place before and after) — the multi-day
	// hospital-stay case. Confidence comes from constraint, not data
	// volume. See infer-empty-day.ts. Days that aren't bracketed stay
	// blank (genuinely unknown).
	if (states.length === 0 && points.length === 0) {
		const inferred = await time(
			"inferEmptyDay",
			inferEmptyDayStatesFromBracket(inputs.emptyDayBracket, date, tz, inputs.osm),
		);
		if (inferred.length > 0)
			return {
				points,
				rawFixes: displayFixes,
				segments: withBiometrics,
				states: inferred,
				episodes: buildEpisodes(inferred, withBiometrics, points, displayFixes),
				battery,
				timing: phaseTimes,
			};
	}

	// Dwell-prior continuation (#259): when the phone went quiet at a strong
	// focus_place and nothing else carried the stay forward (no sleep window,
	// no cross-day bracket), continue it to the place's survival horizon —
	// silence at a well-known place is evidence of staying. No-op when the day
	// is already filled to its end, or the last stay binds to no established
	// place. The trailing time past the horizon stays an honest gap.
	const finalStates = timeSync("dwellContinuation", () =>
		applyDwellContinuation({
			states,
			segments: withBiometrics,
			knownPlaces: inputs.knownPlaces,
			dayEndTs: bounds.endUtc,
		}),
	);

	// Physical-feasibility report on the SERVED timeline — every day, not just
	// the golden corpus. The cascade has no global physical invariant of its
	// own (each pass guards only its own seam), so this is where an impossible
	// output — a walking leg sustaining vehicle pace, a rail discontinuity —
	// becomes a logged defect instead of a confident line on the map. Log-only:
	// repair stays upstream in the passes; fabricating a correction here would
	// hide the defect the log exists to count.
	for (const v of checkWorldlineFeasibility(finalStates, points, biomForStaySplit.steps)) {
		console.error(`velocity ${date} user=${userId}: INFEASIBLE ${v.kind}: ${v.detail}`);
	}

	return {
		points,
		rawFixes: displayFixes,
		segments: withBiometrics,
		states: finalStates,
		episodes: buildEpisodes(finalStates, withBiometrics, points, displayFixes),
		battery,
		timing: phaseTimes,
	};
}

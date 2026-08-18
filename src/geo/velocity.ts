/**
 * Velocity pipeline: raw PhoneTrack GPS → Kalman filter → segment classification → OSM enrichment.
 *
 * Used by both the API route and the CLI tool.
 */

import { sql } from "kysely";
import { db } from "../db/pool.js";
import { getSyncState } from "../db/sync-state.js";
import { checkWorldlineFeasibility } from "../eval/worldline-feasibility.js";
import type { DayRequestInputs } from "../lean/fold-capture.js";
import { installLeanPasses } from "../lean/install.js";
import { assertLeanDaySupported, soloLeanDay } from "../lean/lean-day.js";
import { qualityFilterGpsViaLean } from "../lean/lean-gps-quality.js";
import { classifySegmentsViaLean, snapAllViaLean } from "../lean/lean-head.js";
import { filterGpsTrackViaLean } from "../lean/lean-kalman.js";
import type { NextcloudConfig } from "../nextcloud/phonetrack.js";
import { type DayState, segmentsToDayStates } from "../sleep/day-state.js";
import type { StayCandidate } from "../sleep/known-place-stays.js";
import type { HrPoint, SleepStageRecord, StepPoint } from "./biometrics.js";
import type { BiometricsSnapshot, ClassificationInputs } from "./classification-inputs.js";
import type { EnrichedSegment } from "./enriched-segment.js";
import { buildEpisodes, type EpisodeGeometry } from "./episode-geometry.js";
import { localSolarHour } from "./focus-places.js";
import { qualityFilterGps } from "./gps-quality.js";
import type { FilteredPoint } from "./kalman.js";
import { filterGpsTrack } from "./kalman.js";
import { loadClassificationInputs } from "./load-classification-inputs.js";
import { correctModeBySignature, gateCycling, type ModeStats } from "./mode-biometrics.js";
import { bestPlace, type NearbyWay, placeLabel } from "./osm.js";
import { isUncapturedLookup } from "./osm-adapter-fixture.js";
import { parseRailWayName } from "./passes/rail-reconcile.js";
import type { PlaceCandidate } from "./place-prior.js";
import { type KnownPlace, snapToPlace } from "./place-snap.js";
import { DRIVABLE_HIGHWAY_SUBTYPES, RAIL_ONLY_SUBTYPES } from "./rail-road-proximity.js";
import { effectiveMode } from "./segment-util.js";
import type { TransportMode } from "./segments.js";
import { classifySegments } from "./segments.js";
import { dateBoundsUtc, fitbitTsToUnix } from "./timezone.js";

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
function _hasOvernightPresence(startTs: number, endTs: number, lon: number): boolean {
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
const _RESIDENCE_SLEEP_THRESHOLD_H = 5;

/** Distinct visit-days a cluster needs before its mined `amenity_label`
 *  is allowed to short-circuit the venue scorer.
 *
 *  The label is documented as a "majority vote across the user's prior
 *  visits", and on a single-visit cluster there is no majority — it is one
 *  observation, promoted to an answer. Single-visit clusters dominate what
 *  this branch decides — 58 of the 73 labels the miner emits (measured
 *  2026-08-15, `refresh-focus-places --dry-run`; it was 40 of 55 before
 *  `c506a7b` exempted near-field votes from the dwell floor and the count
 *  went UP). Re-measure rather than quoting either figure. The venue scorer
 *  has strictly more evidence for those stays (opening hours, dwell shape,
 *  distance), and cannot run while the label pre-empts it.
 *
 *  This gate and `c506a7b` pull against each other — one emits more
 *  single-visit labels, the other declines to trust them — and that is
 *  deliberate, not an oversight. Graded together on a corpus copy with only
 *  the labels varied: 5 standing regressed rows -> 4, none lost. Do NOT
 *  collapse them into one distance rule: the label that most needed
 *  overriding here came from 10 m, unanimous, over 86 minutes, and was still
 *  wrong. See #789. */
const _MINED_LABEL_MIN_DAYS = 2;

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
function _applyBiometricSignature(
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
function _computeRailRoadProximity(wayResults: NearbyWay[][]): {
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
function _synthesizeStayCandidateSegment(stay: StayCandidate): EnrichedSegment {
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
function _toPlaceCandidate(p: NamedPlace): PlaceCandidate {
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
	installLeanPasses();
	const { userId, date, displayTz: tz } = inputs.identity;
	const _t0 = Date.now();
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
	const cleaned = timeSync("gpsQuality", () => qualityFilterGpsViaLean(inDay, () => qualityFilterGps(inDay)));

	// Place-snap: if a fix is unambiguously close to a known cluster (home,
	// work, etc.), pull it to the cluster centroid. Reduces GPS noise around
	// well-known locations and stabilises both segment timing and labels.
	const knownPlaces = inputs.knownPlaces;

	// FOLD_CAPTURE=<dir> records what the stages below were handed and what they
	// asked of the two callbacks no adapter sees, so the Lean day can be replayed
	// against it (#424). `undefined` — and free — unless set.
	//
	// Built here rather than beside the cascade it was written for: the OSM
	// enrichment loop asks `bestPlace` too (#430), and it runs long before.

	// ONE bridge call for the whole day, not one per fix (#975). The thunk is the
	// original per-fix `.map`; under `LEAN_HEAD=solo` it is never evaluated and
	// becomes the last reference to the TS `snapToPlace`.
	const snapped = snapAllViaLean(cleaned, knownPlaces, () =>
		knownPlaces.length > 0
			? cleaned.map((p) => {
					const r = snapToPlace({ lat: p.lat, lon: p.lon, accuracy: p.accuracy }, knownPlaces);
					return r.snapped ? { ...p, lat: r.lat, lon: r.lon, accuracy: r.accuracy } : p;
				})
			: cleaned,
	);

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

	const points = timeSync("kalman", () => filterGpsTrackViaLean(gpsPoints, () => filterGpsTrack(gpsPoints)));
	// The step whose output IS the fold's `segsRaw`, so this is the last TS
	// algorithm between the raw fixes and the day chain (#975).
	const segments = timeSync("segments", () =>
		classifySegmentsViaLean(points, stayPoints, () => classifySegments(points, stayPoints)),
	);

	// The inputs the Lean chain replays, and NONE of them come from the cascade —
	// `morningRaw` / `prevEveningRaw` are raw fixes, `rawSleep` is
	// `inputs.sleepWindows`, `dayEndTs` is a clock bound. Hoisted here from the
	// tail (#975) for exactly that reason: under `LEAN_DAY=solo` the fold's
	// request has to be built BEFORE the region it replaces, and this compiling
	// up here is the proof that the tail adds nothing to it.
	const rawSleep = inputs.sleepWindows;
	// The cross-day bracket for a day with NOTHING observed, resolved to a name
	// here because neither half of that resolution is reachable from the fold:
	// the bracket itself is two `presence_log` reads plus a `focus_places`
	// centroid (DB), and naming the centroid is a mirror read. `DayChain.Env`
	// takes the finished name, which is what `buildInferredStayState`'s doc has
	// prescribed since it was written.
	//
	// ⚠ GATED ON THE DAY BEING EMPTY so the lookup is not paid on every day. The
	// fold applies its own emptiness test as well and is the one that decides —
	// this gate is a cost optimisation, not the rule. Before #1055 the whole
	// inference lived past `solo`'s early return and simply stopped happening.
	const bracketPlace = await (async () => {
		if (points.length > 0 || segments.length > 0) return undefined;
		if (inputs.emptyDayBracket === null || inputs.emptyDayBracket === undefined) return undefined;
		const p = await bestPlace(inputs.osm, inputs.emptyDayBracket.centroidLat, inputs.emptyDayBracket.centroidLon, {
			preferResidential: false,
		});
		return p === null ? undefined : placeLabel(p);
	})();

	const downstreamInputs = {
		morningRaw: morningRaw.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon })),
		prevEveningRaw: prevEveningRaw.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon })),
		rawSleep: rawSleep.map((w) => ({
			startTs: w.startTs,
			endTs: w.endTs,
			tz: w.tz,
			minutesAsleep: w.minutesAsleep,
		})),
		dayEndTs: bounds.endUtc,
		dayStartTs: bounds.startUtc,
		dayTz: tz ?? null,
		bracketPlace,
	};

	/**
	 * The fold's request, in ONE place, built by whichever arm gets there first.
	 *
	 * `solo` builds it here and `shadow`/`on` build it at the tail, ~1,340 lines
	 * apart, and a second copy of this object literal is how the mode that serves
	 * production and the mode that stages it end up sending different requests —
	 * silently, because both would still be well-formed. So it is a closure over
	 * the values that are common, parameterised by the two that are not YET in
	 * scope at the earlier site.
	 *
	 * Those two are `biom` and `ms`, and they are parameters rather than reads of
	 * `inputs` only because the tail already has locals for them. They are the
	 * same values: `biomForStaySplit` is `inputs.biometrics` on both of its
	 * branches, and `modeStats` is `inputs.modeBiometrics` on both of its. That
	 * equality is what makes solo possible at all, so it is pinned by a test
	 * rather than left as a comment (`tests/lean-day-solo.test.ts`).
	 */
	const dayRequest = (biom: BiometricsSnapshot, ms: ModeStats[]): DayRequestInputs => ({
		segsRaw: segments,
		modeStats: ms,
		obs: {
			points: points.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon, speedKmh: p.speed_kmh })),
			rawFixes: inDay.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon, accuracy: p.accuracy })),
			displayFixes,
			steps: biom.steps.map((s) => ({ ts: s.ts, steps: s.steps })),
			hr: biom.hr.map((h) => ({ ts: h.ts, bpm: h.bpm })),
			sleep: biom.sleep.map((s) => ({ startTs: s.startTs, endTs: s.endTs })),
		},
		tail: downstreamInputs,
		// The answer tables start EMPTY. A serving caller has no recorded trace to
		// seed them from; the round loop fills them by asking.
		tzAt: [],
		bestPlace: [],
	});

	/**
	 * Physical-feasibility report on a timeline — every day, not just the golden corpus.
	 * The cascade has no global physical invariant of its own, each pass guarding only
	 * its own seam, so this is where an impossible output — a walking leg at vehicle
	 * pace, a rail discontinuity — becomes a logged defect instead of a confident line
	 * on the map. Log-only: repair stays upstream, and fabricating a correction here
	 * would hide the defect the log exists to count.
	 *
	 * Line membership for the valid-triple invariant (#181/#351) resolves through the
	 * adapter, memoised in prod. A line it cannot answer — an older fixture replaying
	 * without that trace key — is skipped, never a violation.
	 *
	 * Timed as its own phase because it sits INSIDE the Lean-covered bracket without
	 * being part of it: the Lean day produces the timeline, not this report, so a tenant
	 * would still pay for it. `leanCovered` subtracts it.
	 *
	 * ⚠ WHICH TIMELINE IT GRADES CHANGES UNDER `solo`, by decision rather than side
	 * effect (#975). The tail calls it on the TS states even when Lean serves, on the
	 * grounds that this is an invariant on the DAY and should not depend on a flag —
	 * but under solo there are no TS states, so that argument does not survive and it
	 * grades the SERVED ones. Skipping it under solo would silently drop the only
	 * global physical check on exactly the mode with no second arm to catch anything.
	 * The served timeline is the weaker guarantee; grading nothing is none at all.
	 */
	const reportFeasibility = async (timeline: DayState[], steps: readonly StepPoint[]): Promise<void> => {
		await time(
			"feasibility",
			(async () => {
				const labelledLines = new Set<string>();
				for (const s of timeline) {
					if (s.mode !== "train") continue;
					const line = parseRailWayName(s.wayName ?? undefined)?.line;
					if (line) labelledLines.add(line);
				}
				const lineStations = new Map<string, Awaited<ReturnType<typeof inputs.osm.stationsOnLine>>>();
				for (const line of labelledLines) {
					try {
						lineStations.set(line, await inputs.osm.stationsOnLine(line));
					} catch (e) {
						// This used to swallow EVERYTHING with the note "uncaptured in a fixture
						// trace — no membership, no assertion", which is the defect stated as if
						// it were the design: with no membership the rail-triple check has
						// nothing to test, so a stale fixture turned the feasibility gate into a
						// silent pass on exactly the days whose line labels moved. A live
						// adapter returning nothing is still fine — that is a genuine absence.
						if (isUncapturedLookup(e)) throw e;
					}
				}
				for (const v of checkWorldlineFeasibility(timeline, points, steps, lineStations)) {
					console.error(`velocity ${date} user=${userId}: INFEASIBLE ${v.kind}: ${v.detail}`);
				}
			})(),
		);
	};

	// Where the Lean `day` chain's input is produced, and therefore where the
	// region a Lean tenant would REPLACE begins (#431 gap 3). Everything below —
	// the OSM enrichment loop, the five corrections, the 38 passes, the sleep
	// attribution, the timeline and the episodes — is what `verified_cli day`
	// computes from `segsRaw`.
	//
	// Bracketed here rather than summed from `phaseTimes` because the phases do
	// not tile the region: the enrichment loop and the episode build are not
	// wrapped at all, so a sum would silently undercount the arm it is being
	// divided into. `phaseTimes.leanCovered` is set at the return sites below.
	const leanCoveredFrom = Date.now();

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

	// THE DAY IS THE LEAN FOLD. Between here and the return were ~1,420 lines of
	// TypeScript cascade — the OSM enrichment loop, the five corrections, the 38
	// passes, the sleep attribution, the timeline and the episodes — until #975
	// deleted them. `LEAN_DAY` had been `solo` on both surfaces since 2026-08-17,
	// so nothing had called any of it since.
	//
	// ⚠ The mode dispatch went with the arm. There is no `off`/`shadow`/`on`: each
	// was a way of talking about a second arm, and the honest rollback for a fold
	// defect is now a revert. The flag left in the manifests documents what this
	// pipeline is rather than selecting between arms.
	//
	// The fold runs HERE, right after the last input it consumes:
	//   segsRaw    `segments` — the classifier, which the fold does not redo
	//   modeStats  `inputs.modeBiometrics`
	//   obs        `points`, `inDay`, `displayFixes`, `inputs.biometrics`
	//   tail       raw fixes, clock bounds and the empty-day bracket — see
	//              `downstreamInputs`
	//
	// ⚠ AFTER the `enrich === false` return, on purpose and still load-bearing:
	// that path is a caller asking for raw segments with no OSM, biometrics or
	// sleep, and the fold does all three. Serving it there answers a different
	// question than the one asked.
	// The flag selects nothing now; this refuses a value that implies it does.
	assertLeanDaySupported();
	const served = await soloLeanDay(dayRequest(inputs.biometrics, inputs.modeBiometrics), inputs, `${date} ${userId}`);
	// The served timeline, because it is the only one — see `reportFeasibility`.
	await reportFeasibility(served.states, inputs.biometrics.steps);
	phaseTimes.leanCovered = Date.now() - leanCoveredFrom - (phaseTimes.feasibility ?? 0);
	return {
		points,
		rawFixes: displayFixes,
		segments: served.segs,
		states: served.states,
		episodes: served.episodes,
		battery,
		timing: phaseTimes,
	};
}

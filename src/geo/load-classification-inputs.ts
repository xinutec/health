/**
 * Production loader for `ClassificationInputs`.
 *
 * Phase 1 of `docs/proposals/2026-06-deterministic-fixtures.md`.
 *
 * Mirrors the eager-fetch path currently inlined at the top of
 * `computeVelocity`. Production wraps the classification pipeline by
 * calling `loadClassificationInputs` then `computeVelocity(inputs)`
 * (Phase 2 — refactor not yet applied). Tests load from a captured
 * fixture instead.
 *
 * Phase 1 covers only the eager loads. The lazy ones (OSM mirror,
 * decoded_days, rail_route_cache, presence_log) keep being fetched
 * from the DB inside the pipeline until their own phase migrates
 * them onto the inputs value. The `ClassificationInputs` type
 * evolves additively.
 *
 * No behaviour change: this file's queries are byte-for-byte the
 * same projections used inside `velocity.ts` today. Verified during
 * Phase 2 by running the existing golden suite — zero diff is the
 * acceptance criterion.
 */

import { db } from "../db/pool.js";
import { getSyncState } from "../db/sync-state.js";
import { loadDecode } from "../hmm/persist.js";
import type { NextcloudConfig } from "../nextcloud/phonetrack.js";
import { fetchTrackPointsRange, openPhoneTrack } from "../nextcloud/phonetrack.js";
import { loadDaySleepWindows } from "../sleep/load.js";
import { loadAllBusRoutes } from "./bus-route-cache.js";
import type {
	ClassificationInputs,
	DayIdentity,
	KnownPlaceProjection,
	MotionFix,
	RawPhonetrackFix,
} from "./classification-inputs.js";
import { parseHourProfile } from "./focus-places.js";
import { loadEmptyDayBracket } from "./infer-empty-day.js";
import type { ModeStats } from "./mode-biometrics.js";
import type { OsmAdapter } from "./osm-adapter.js";
import { dbOsmAdapter } from "./osm-adapter.js";
import { dateBoundsUtc } from "./timezone.js";
import { loadBiometrics } from "./velocity.js";
import type { VenuePriors } from "./venue-prior.js";

/** How far past the local day end to look for the battery-chart tail anchor.
 *  18 h reaches the next morning (covers an overnight idle/charge) without
 *  drawing a misleading slope to a reading days later when the phone was off. */
const BATTERY_TAIL_LOOKAHEAD_H = 18;

/** Load the full `ClassificationInputs` closure for one day from the
 *  production data sources. The Promise resolves to a serialisable
 *  value the pipeline can consume; nothing in the value holds a DB
 *  handle.
 *
 *  `osm` defaults to the production `dbOsmAdapter`. `capture-day-v2`
 *  passes a `RecordingOsmAdapter` wrapping it, so the OSM/Nominatim
 *  lookups the pipeline makes get recorded into the fixture; the
 *  replay harness then injects a `FixtureOsmAdapter`. The bounded
 *  row-set reads above are unaffected by the adapter choice. Phase B
 *  of `docs/proposals/2026-06-deterministic-fixtures.md`. */
export async function loadClassificationInputs(
	config: NextcloudConfig,
	identity: DayIdentity,
	osm: OsmAdapter = dbOsmAdapter,
): Promise<ClassificationInputs> {
	const { userId, date, displayTz } = identity;
	const bounds = dateBoundsUtc(date, displayTz);

	// Same day-string arithmetic as velocity.ts — UTC-midnight parse,
	// ±1 day, ISO date slice. Keeps the three PhoneTrack window
	// boundaries identical to the inlined version.
	const nextDay = shiftDay(date, +1);
	const prevDay = shiftDay(date, -1);
	const nextDayMorningEnd = `${nextDay}T12:00:00Z`;
	const prevDayEveningStart = `${prevDay}T12:00:00Z`;

	// Battery-tail look-ahead: the local day end (`bounds.endUtc`) up to
	// BATTERY_TAIL_LOOKAHEAD_H later. Captures the first reading after the day
	// when the phone went idle in the evening (charging) and only reported
	// again in the small hours — a window neither `today` (ends at local
	// midnight) nor `morning` (starts at next UTC midnight) covers.
	const dayEndIso = new Date(bounds.endUtc * 1000).toISOString();
	const tailEndIso = new Date((bounds.endUtc + BATTERY_TAIL_LOOKAHEAD_H * 3600) * 1000).toISOString();

	// PhoneTrack: open once, parallel range fetches. Mirrors the pattern at
	// velocity.ts:537-544 — windows off one session context, same call shape.
	const phoneTrackCtx = await openPhoneTrack(config, userId);
	const [today, morning, priorEvening, afterDay] = await Promise.all([
		fetchTrackPointsRange(phoneTrackCtx, date, nextDay),
		fetchTrackPointsRange(phoneTrackCtx, nextDay, nextDayMorningEnd),
		fetchTrackPointsRange(phoneTrackCtx, prevDayEveningStart, date),
		fetchTrackPointsRange(phoneTrackCtx, dayEndIso, tailEndIso),
	]);
	// `afterDay` is ascending by ts (fetchTrackPointsRange sorts), so the first
	// battery-bearing fix is the earliest reading after the day end.
	const tailFix = (afterDay as RawPhonetrackFix[]).find((p) => p.battery !== null);
	const batteryTail = tailFix ? { ts: tailFix.ts, level: tailFix.battery as number } : null;

	// Eager DB reads in parallel — known places, mode biometrics, and
	// the per-day biometric streams. The biometric loader does its own
	// three parallel queries (HR / sleep / steps), so we await the
	// composite. Failure on biometrics is non-fatal: prod has missing-
	// Fitbit days and the pipeline tolerates empty arrays. Mirrors the
	// `.catch` previously inlined inside `computeVelocity`.
	const [
		knownPlaces,
		modeBiometrics,
		biometrics,
		motionLog,
		hsmmDecode,
		railRouteCache,
		busRouteCache,
		homeTzRaw,
		sleepWindows,
		emptyDayBracket,
		venuePriors,
	] = await Promise.all([
		loadKnownPlacesQuery(userId),
		loadModeBiometricsQuery(userId),
		loadBiometrics(userId, bounds.startUtc, bounds.endUtc, displayTz).catch((e: unknown) => {
			console.warn(`loadBiometrics failed for user=${userId} date=${date}: ${e}`);
			return { hr: [], sleep: [], steps: [] };
		}),
		loadMotionLogQuery(userId, bounds.startUtc, bounds.endUtc),
		loadDecode(db(), userId, date),
		loadRailRouteCacheQuery(),
		loadAllBusRoutes(),
		getSyncState(userId, "home_tz"),
		loadDaySleepWindows(userId, date),
		loadEmptyDayBracket(userId, date),
		loadVenuePriorsQuery(userId),
	]);

	return {
		identity,
		phonetrack: {
			today: today as RawPhonetrackFix[],
			morning: morning as RawPhonetrackFix[],
			priorEvening: priorEvening as RawPhonetrackFix[],
		},
		batteryTail,
		knownPlaces,
		biometrics,
		motionLog,
		modeBiometrics,
		hsmmDecode,
		railRouteCache,
		busRouteCache,
		// OSM / Nominatim adapter — `dbOsmAdapter` in production (delegates
		// to the top-level functions in `osm.ts`), or a wrapping recorder
		// during fixture capture. The classification core reaches all OSM
		// access through this. Phase 6c / B of the deterministic-fixtures
		// proposal.
		osm,
		// Late impure reads lifted off the `computeVelocity` body so the
		// pipeline core stays DB-free (deterministic-fixtures Phase A).
		// `home_tz` defaults to Europe/Amsterdam, matching the inline
		// fallback the body used.
		homeTz: homeTzRaw ?? "Europe/Amsterdam",
		sleepWindows,
		emptyDayBracket,
		venuePriors,
	};
}

/** The day's `motion_log` rows — the per-fix heading/velocity/accuracy the
 *  Owntracks ingest persists (PDR groundwork, #296/#297). Bounded row-set
 *  read over the same local-day window as the biometric streams. Days
 *  before the 2026-07-01 ingest deploy simply return []. */
async function loadMotionLogQuery(userId: string, startUtc: number, endUtc: number): Promise<MotionFix[]> {
	const rows = await db()
		.selectFrom("motion_log")
		.select(["ts", "lat", "lon", "cog", "vel", "acc"])
		.where("user_id", "=", userId)
		.where("ts", ">=", startUtc)
		.where("ts", "<", endUtc)
		.orderBy("ts")
		.execute();
	return rows.map((r) => ({
		ts: r.ts,
		lat: Number(r.lat),
		lon: Number(r.lon),
		cogDeg: r.cog,
		velKmh: r.vel,
		accM: r.acc,
	}));
}

/** Load the user's mined venue-type priors, or null when never mined or
 *  the stored blob fails to parse (treated as no evidence, never fatal). */
async function loadVenuePriorsQuery(userId: string): Promise<VenuePriors | null> {
	const row = await db()
		.selectFrom("venue_type_priors")
		.select(["priors_json"])
		.where("user_id", "=", userId)
		.executeTakeFirst();
	if (!row) return null;
	try {
		return JSON.parse(row.priors_json) as VenuePriors;
	} catch (e: unknown) {
		console.warn(`venue_type_priors blob for user=${userId} failed to parse: ${e}`);
		return null;
	}
}

/** Pre-load the entire `rail_route_cache`. The table is global (not
 *  user-scoped) and small — a few hundred rows of polyline JSON in
 *  total, easily under 1 MB. `annotateSnappedPaths` does an in-memory
 *  `Map` lookup on what's loaded; routes the day doesn't use are
 *  simply ignored, no extra cost beyond the eager load. */
async function loadRailRouteCacheQuery(): Promise<Array<{ routeKey: string; geometryJson: string }>> {
	const rows = await db().selectFrom("rail_route_cache").select(["route_key", "geometry_json"]).execute();
	return rows.map((r) => ({ routeKey: r.route_key, geometryJson: r.geometry_json }));
}

function shiftDay(date: string, days: number): string {
	const d = new Date(date);
	d.setDate(d.getDate() + days);
	return d.toISOString().slice(0, 10);
}

/** focus_places projection used by `snapToPlace` + the place picker.
 *  Same SELECT columns and same row mapping as `loadKnownPlaces`
 *  inside `velocity.ts`. Phase 2 will collapse the duplication by
 *  removing the inline copy. */
async function loadKnownPlacesQuery(userId: string): Promise<KnownPlaceProjection[]> {
	const rows = await db()
		.selectFrom("focus_places")
		.select([
			"id",
			"centroid_lat",
			"centroid_lon",
			"radius_m",
			"display_name",
			"sleep_hours",
			"amenity_label",
			"unique_days",
			"hour_profile",
			"total_dwell_sec",
			"visit_count",
		])
		.where("user_id", "=", userId)
		.execute();
	return rows.map((r) => ({
		id: r.id,
		centroidLat: Number(r.centroid_lat),
		centroidLon: Number(r.centroid_lon),
		radiusM: r.radius_m,
		displayName: r.display_name,
		sleepHours: r.sleep_hours ?? 0,
		amenityLabel: r.amenity_label,
		uniqueDays: r.unique_days,
		hourProfile: parseHourProfile(r.hour_profile),
		totalDwellSec: Number(r.total_dwell_sec),
		visitCount: r.visit_count,
	}));
}

/** mode_biometrics projection — per-user per-mode biometric
 *  signatures. Same SELECT and row mapping as `loadModeBiometrics`
 *  inside `velocity.ts`. */
async function loadModeBiometricsQuery(userId: string): Promise<ModeStats[]> {
	const rows = await db().selectFrom("mode_biometrics").selectAll().where("user_id", "=", userId).execute();
	return rows.map((r) => ({
		mode: r.mode,
		hrMean: r.hr_mean !== null ? Number(r.hr_mean) : null,
		hrStd: r.hr_std !== null ? Number(r.hr_std) : null,
		hrSampleCount: r.hr_sample_count,
		cadenceMean: r.cadence_mean !== null ? Number(r.cadence_mean) : null,
		cadenceStd: r.cadence_std !== null ? Number(r.cadence_std) : null,
		cadenceSampleCount: r.cadence_sample_count,
		speedMean: r.speed_mean !== null ? Number(r.speed_mean) : null,
		speedStd: r.speed_std !== null ? Number(r.speed_std) : null,
		speedSampleCount: r.speed_sample_count,
		sampleCount: r.sample_count,
	}));
}

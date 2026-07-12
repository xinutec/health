/**
 * `ClassificationInputs` — the closure of inputs to the classification
 * pipeline for one (user, date).
 *
 * Phase 1 of `docs/proposals/2026-06-deterministic-fixtures.md`.
 *
 * The pipeline currently reads from a DB and the PhoneTrack HTTP API
 * at call time. That makes goldens non-deterministic: any of those
 * external states can drift between bless and check. The remedy is
 * to plumb every external read through a single typed value, so the
 * pipeline becomes `inputs → output` with no side fetches.
 *
 * Production loads this from the DB via `loadClassificationInputs`.
 * Tests load it from a captured fixture. Same pipeline, same value
 * shape, two sources.
 *
 * Phase 1 covers the eager loads that happen at the top of
 * `computeVelocity`:
 *
 *   - PhoneTrack fixes (three windows: today, next morning, prev evening)
 *   - Known places (focus_places projection used by snap)
 *   - Biometrics (HR, sleep, steps)
 *   - Per-user mode biometric signatures
 *
 * Later phases will add the lazy loads (OSM mirror, decoded_days,
 * rail_route_cache, presence_log) so the closure becomes complete.
 * The type evolves additively; callers consuming Phase 1 fields keep
 * working.
 */

import type { HmmSegment } from "../hmm/persist.js";
import type { RawSleepWindow } from "../sleep/load.js";
import type { HrPoint, SleepStageRecord, StepPoint } from "./biometrics.js";
import type { BusRoute } from "./bus-route-match.js";
import type { ModeStats } from "./mode-biometrics.js";
import type { OsmAdapter } from "./osm-adapter.js";
import type { PlaceConfirmation } from "./place-confirmation.js";
import type { KnownPlace } from "./place-snap.js";
import type { VenuePriors } from "./venue-prior.js";

/** A PhoneTrack fix as returned by `fetchTrackPointsRange`. Mirrors
 *  the prod loader's projection — we never strip fields between the
 *  loader and the pipeline. */
export interface RawPhonetrackFix {
	ts: number;
	lat: number;
	lon: number;
	altitude: number | null;
	speed: number | null;
	accuracy: number | null;
	battery: number | null;
}

/** A user's known cluster as the pipeline reads it. Extends
 *  `KnownPlace` (the geometry contract `snapToPlace` consumes) with
 *  the metadata the place picker, HSMM, and refineMode all use. Same
 *  shape currently called `NamedPlace` inside `velocity.ts` — that
 *  declaration will migrate to this one in a later phase. */
export interface KnownPlaceProjection extends KnownPlace {
	displayName: string | null;
	sleepHours: number;
	amenityLabel: string | null;
	uniqueDays: number;
	hourProfile: number[] | null;
	/** Total time spent at this cluster across all visits, seconds, and the
	 *  visit count — together the mean-dwell scale τ for the dwell-prior
	 *  continuation (#259). Optional so fixtures captured before the fields
	 *  existed replay as "no dwell prior" (0 → no continuation). */
	totalDwellSec?: number;
	visitCount?: number;
}

/** Identity portion: which day, in which timezone, for which user.
 *  Pulled out so it can be referenced before any input is loaded. */
export interface DayIdentity {
	userId: string;
	/** Local date string `YYYY-MM-DD` in `displayTz`. */
	date: string;
	/** IANA timezone — drives all local-clock derivations. */
	displayTz: string;
}

/** The three PhoneTrack windows the pipeline fetches at the top of
 *  `computeVelocity`. Same three calls, captured eagerly so tests
 *  don't open the HTTP connection. */
export interface PhonetrackWindows {
	/** Local-day fixes: `[date 00:00 local, next-day 00:00 local)`. */
	today: RawPhonetrackFix[];
	/** Next morning fixes (UTC midnight to next-day 12:00 UTC).
	 *  Feeds sleep-place attribution when sleep crosses midnight. */
	morning: RawPhonetrackFix[];
	/** Prior evening fixes (prev-day 12:00 UTC to date 00:00 UTC).
	 *  Feeds sleep-place when evening sleep started yesterday. */
	priorEvening: RawPhonetrackFix[];
}

export interface BiometricsSnapshot {
	hr: HrPoint[];
	sleep: SleepStageRecord[];
	steps: StepPoint[];
}

/** A `motion_log` row — the per-fix motion witness the Owntracks ingest
 *  persists alongside each position (PhoneTrack does not retain these).
 *  `cogDeg` is the phone-reported course over ground, the independent
 *  direction signal PDR needs (#296/#297); `velKmh` the phone's own speed
 *  in the Owntracks `vel` convention (km/h); `accM` reported accuracy.
 *  Rows exist only from the 2026-07-01 ingest deploy onward. */
export interface MotionFix {
	ts: number;
	lat: number;
	lon: number;
	cogDeg: number | null;
	velKmh: number | null;
	accM: number | null;
}

/** Pre-resolved cross-day bracket for the empty-day inference. A day
 *  with no GPS/biometric data is attributed to a focus place iff the
 *  prior day ended there AND the next day's dominant place is the same
 *  (`bracketedStayPlaceId`). The loader does the bounded DB work —
 *  the two `presence_log` reads and the `focus_places` centroid lookup
 *  — and hands the pure core only the resolved centroid; the core then
 *  names it through the OSM adapter. `null` when the day isn't
 *  bracketed (genuinely unknown) or the place can't be resolved. */
export interface EmptyDayBracket {
	centroidLat: number;
	centroidLon: number;
}

/**
 * The classification pipeline's input closure. Evolves additively as
 * later phases lift their external reads into named fields.
 *
 * Bounded sources (fixed query count, fixed-shape projection) are
 * row-set fields; unbounded sources (OSM, Nominatim — query count
 * and locations depend on pipeline-internal decisions) are adapter
 * fields. See `docs/proposals/2026-06-deterministic-fixtures.md`
 * → "Bounded vs unbounded sources".
 *
 * Phases landed so far:
 *   - Phase 1 / 2a: eager DB+HTTP loads (PhoneTrack, focus_places,
 *     biometrics, mode_biometrics) consolidated through this value.
 *   - Phase 4: `decoded_days[date]` for the HSMM place override.
 *   - Phase 5: `rail_route_cache` for train-segment snapped paths.
 *   - Phase 6c: `osm: OsmAdapter` (this revision; replaces the
 *     row-set `OsmSnapshot` field shipped in Phase 6b).
 *
 * Still-bounded-source-not-yet-lifted:
 *   - `presence_log[date-1]` (HSMM-only, lands in Phase 7).
 */
export interface ClassificationInputs {
	identity: DayIdentity;
	phonetrack: PhonetrackWindows;
	/** First phone-battery reading strictly after the local day end (within a
	 *  bounded look-ahead), or null. Lets the battery chart draw an angled line
	 *  from the day's last reading up to the next real point when the phone went
	 *  idle in the evening (e.g. charging) and stopped reporting — the next
	 *  reading then falls in the early hours of the following day. It lands in
	 *  the local-day-end..next-UTC-midnight gap that neither `today` nor
	 *  `morning` cover, so it is fetched separately. Display-only; optional, so
	 *  fixtures predating it replay with no tail (a no-op). */
	batteryTail?: { ts: number; level: number } | null;
	knownPlaces: KnownPlaceProjection[];
	biometrics: BiometricsSnapshot;
	/** Per-fix motion witness (`motion_log`) for the local day window —
	 *  heading/velocity/accuracy the phone reported with each fix. Consumed by
	 *  the heading eval (PDR Phase 0); nothing in the pipeline reads it yet.
	 *  Optional so fixtures captured before the field (and days predating the
	 *  2026-07-01 ingest) replay as "no motion data". */
	motionLog?: MotionFix[];
	modeBiometrics: ModeStats[];
	/** HSMM-decoded segments for this day from `decoded_days`, or
	 *  null when no decode exists yet (cron hasn't run, or the day
	 *  is too old / new for the rolling window). The velocity layer
	 *  reads this to override stationary-segment placeId attribution
	 *  with the HSMM's pick. Phase 4 of
	 *  `docs/proposals/2026-06-deterministic-fixtures.md`. */
	hsmmDecode: HmmSegment[] | null;
	/** Pre-computed rail-line geometries keyed by `<board> → <alight>`
	 *  string. `annotateSnappedPaths` looks up each train segment's
	 *  `wayName` against this set to attach a `snappedPath`. The cache
	 *  is global (not user-scoped) and small enough to load in full
	 *  for the day. Phase 5 of the deterministic-fixtures proposal. */
	railRouteCache: RailRouteEntry[];
	/** Mirrored OSM bus routes (`bus_route_cache`, filled offline by
	 *  refresh-bus-routes). `annotateBusRoutes` anchors each driving leg's
	 *  endpoints to a route's stops to name the bus (#252 / C-bus).
	 *  Optional — fixtures captured before the field existed (and any day
	 *  with an empty mirror) replay as "no bus routes", a no-op. */
	busRouteCache?: BusRoute[];
	/** OSM + Nominatim lookups, as an adapter interface. Production
	 *  injects `dbOsmAdapter` (delegates to the top-level functions in
	 *  `osm.ts`); test fixtures will inject `FixtureOsmAdapter`
	 *  (replays captured rows + Nominatim responses, lands Phase 6e).
	 *  Phase 6c of the deterministic-fixtures proposal. */
	osm: OsmAdapter;
	/** The user's `home_tz` sync-state value (already defaulted to
	 *  `Europe/Amsterdam` when unset). Used as the displayTz fallback
	 *  for segments no GPS fix covers. Lifted from the late
	 *  `getSyncState(userId, "home_tz")` read in `computeVelocity` so
	 *  the pipeline core stays DB-free. */
	homeTz: string;
	/** Main-sleep windows bracketing this day (today's morning sleep +
	 *  the night that starts this evening), from the `sleep` table.
	 *  Distinct from `biometrics.sleep` (per-stage records). Lifted from
	 *  the late `loadDaySleepWindows(userId, date)` read. */
	sleepWindows: RawSleepWindow[];
	/** Pre-resolved empty-day cross-day bracket, or null. Lifted from
	 *  the late `inferEmptyDayStates` DB reads (presence_log ×2 +
	 *  focus_places centroid). Only consumed when the day has no states
	 *  and no points. */
	emptyDayBracket: EmptyDayBracket | null;
	/** Mined venue-type visit-shape priors (`venue_type_priors` row for
	 *  this user), or null when never mined. Drives the venue-plausibility
	 *  ranking in `bestPlace` for stationary stays (#246). Optional so
	 *  fixtures captured before the field existed replay as "no priors". */
	venuePriors?: VenuePriors | null;
	/** The user's confirmed place labels (`place_confirmations`). The last word
	 *  on a venue the sensors cannot resolve — see `place-confirmation.ts`.
	 *  Optional so fixtures captured before the table existed replay as "none
	 *  confirmed". */
	placeConfirmations?: readonly PlaceConfirmation[];
}

/** A single `rail_route_cache` row, projected to the columns
 *  `annotateSnappedPaths` reads. */
export interface RailRouteEntry {
	routeKey: string;
	/** WKT-free JSON encoding of the route polyline: an array of
	 *  `{lat, lon}` objects. Same shape `annotateSnappedPaths` parses
	 *  out of `geometry_json` today. */
	geometryJson: string;
}

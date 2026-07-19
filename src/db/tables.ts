import type { Generated } from "kysely";
import type { FitbitSleepLogId } from "./branded.js";

// Each interface maps exactly to a MariaDB table.
// Column names match the SQL schema in schema.ts.
// `Generated<T>` marks columns with DEFAULT values.

export interface TokensTable {
	user_id: string;
	access_token: string;
	refresh_token: string;
	expires_at: Date;
	scopes: string | null;
	/** "active" or "needs_reauth". Mirrors nc_tokens.status — set when
	 *  the Fitbit token manager catches a 4xx refresh response, reset
	 *  on success or fresh /fitbit/callback. */
	status: Generated<string>;
	updated_at: Generated<Date>;
}

export interface SyncStateTable {
	user_id: string;
	key_name: string;
	value: string;
	updated_at: Generated<Date>;
}

export interface DailyActivityTable {
	user_id: string;
	date: string; // DATE as string in queries
	steps: number | null;
	calories_total: number | null;
	calories_active: number | null;
	distance_km: number | null;
	floors: number | null;
	elevation_m: number | null;
	minutes_sedentary: number | null;
	minutes_lightly_active: number | null;
	minutes_fairly_active: number | null;
	minutes_very_active: number | null;
	active_score: number | null;
	resting_heart_rate: number | null;
	synced_at: Generated<Date>;
}

export interface HeartRateIntradayTable {
	user_id: string;
	ts: string; // DATETIME as string — verbatim Fitbit wall-clock, immutable source of truth
	bpm: number;
	tz: string | null; // IANA tz the wall-clock was recorded in; see TIMEZONE.md
	ts_utc: string | null; // Derived UTC DATETIME; see docs/design/timezone.md
	tz_source: string | null; // Provenance: phonetrack | home_tz | manual | legacy | NULL
}

export interface StepsIntradayTable {
	user_id: string;
	ts: string; // DATETIME as string — verbatim Fitbit wall-clock, immutable source of truth
	steps: number;
	tz: string | null; // IANA tz the wall-clock was recorded in; see TIMEZONE.md
	ts_utc: string | null;
	tz_source: string | null;
}

export interface HeartRateZonesTable {
	user_id: string;
	date: string;
	zone_name: string;
	minutes: number | null;
	calories: number | null;
	min_bpm: number | null;
	max_bpm: number | null;
}

export interface SleepTable {
	user_id: string;
	/** Fitbit sleep log id. Branded bigint so it can't be silently
	 *  coerced to Number (which would round). See branded.ts. */
	log_id: FitbitSleepLogId;
	date: string;
	start_time: string;
	end_time: string;
	/** Sleep duration in ms. Schema is BIGINT (returned as bigint
	 *  after bigIntAsNumber:false flip). Never used in arithmetic
	 *  on the backend — purely passed through to JSON output where
	 *  BigInt.prototype.toJSON stringifies it. */
	duration_ms: bigint | null;
	efficiency: number | null;
	minutes_asleep: number | null;
	minutes_awake: number | null;
	minutes_deep: number | null;
	minutes_light: number | null;
	minutes_rem: number | null;
	minutes_wake: number | null;
	is_main_sleep: boolean | null;
	tz: string | null; // IANA tz of start_time/end_time wall-clocks; see docs/design/timezone.md
	start_time_utc: string | null; // Derived UTC DATETIME; see docs/design/timezone.md
	end_time_utc: string | null;
	tz_source: string | null;
}

export interface SleepStagesTable {
	user_id: string;
	/** FK to sleep.log_id; same branded type. */
	sleep_log_id: FitbitSleepLogId;
	ts: string;
	stage: string;
	duration_seconds: number;
	tz: string | null; // IANA tz the wall-clock was recorded in; see TIMEZONE.md
	ts_utc: string | null;
	tz_source: string | null;
}

export interface BodyTable {
	user_id: string;
	date: string;
	weight_kg: number | null;
	bmi: number | null;
	body_fat_pct: number | null;
}

export interface SpO2DailyTable {
	user_id: string;
	date: string;
	avg_value: number | null;
	min_value: number | null;
	max_value: number | null;
}

export interface SpO2IntradayTable {
	user_id: string;
	ts: string;
	value: number;
}

export interface HrvDailyTable {
	user_id: string;
	date: string;
	daily_rmssd: number | null;
	deep_rmssd: number | null;
}

/** Intraday (5-minute) HRV — full within-night resolution. `ts` is the
 *  verbatim Fitbit wall-clock DATETIME (string), as in heart_rate_intraday.
 *  DECIMAL columns come back as strings from node-mariadb. */
export interface HrvIntradayTable {
	user_id: string;
	ts: string;
	rmssd: number;
	coverage: number | null;
	hf: number | null;
	lf: number | null;
}

export interface BreathingRateTable {
	user_id: string;
	date: string;
	full_sleep_rate: number | null;
	deep_sleep_rate: number | null;
	light_sleep_rate: number | null;
	rem_sleep_rate: number | null;
}

export interface SkinTemperatureTable {
	user_id: string;
	date: string;
	relative_deviation: number | null;
}

export interface CardioFitnessTable {
	user_id: string;
	date: string;
	vo2_max: number | null;
}

export interface DevicesTable {
	user_id: string;
	device_id: string;
	device_version: string | null;
	type: string | null;
	battery: string | null;
	/** Numeric battery percent (0–100) from the Fitbit devices endpoint;
	 *  null for devices/older syncs that didn't report it. */
	battery_level: number | null;
	last_sync_time: string | null;
	updated_at: Generated<Date>;
}

/** Per-sync watch-battery history — one timestamped reading per Fitbit
 *  device sync, keyed by `last_sync_time` for idempotency. Plotted as the
 *  watch series on the day-view battery chart. */
export interface DeviceBatteryLogTable {
	user_id: string;
	device_id: string;
	last_sync_time: string;
	battery_level: number;
	device_version: string | null;
	recorded_at: Generated<Date>;
}

/** Per-fix motion witness (heading / velocity / accuracy) captured at the
 *  Owntracks ingest — the direction signal PhoneTrack drops but pedestrian
 *  dead-reckoning needs (#296). `cog` is course over ground in degrees. */
export interface MotionLogTable {
	user_id: string;
	ts: number;
	lat: number;
	lon: number;
	cog: number | null;
	vel: number | null;
	acc: number | null;
	recorded_at: Generated<Date>;
}

export interface SchemaMigrationsTable {
	version: number;
	applied_at: Generated<Date>;
}

export interface SessionsTable {
	id: string;
	user_id: string;
	display_name: string;
	expires_at: Date;
	created_at: Generated<Date>;
}

export interface NcTokensTable {
	user_id: string;
	access_token: string;
	refresh_token: string;
	expires_at: Date;
	/** "active" or "needs_reauth". Set to "needs_reauth" when a refresh
	 *  attempt is rejected with a 4xx (refresh token invalid or
	 *  rate-limited); reset to "active" on successful refresh or fresh
	 *  OAuth callback. /api/me surfaces this for the UI banner. */
	status: Generated<string>;
	updated_at: Generated<Date>;
}

export interface OsmCacheTable {
	query_type: string;
	lat_rounded: number;
	lon_rounded: number;
	result: string; // JSON
	cached_at: Generated<Date>;
}

/** A bounding box we've already fetched for one feature type. Queries
 *  that fall inside any of these are served from osm_features below
 *  without touching Overpass. Boxes grow lazily as the user travels. */
export interface OsmCoverageTable {
	id: Generated<number>;
	min_lat: number;
	max_lat: number;
	min_lon: number;
	max_lon: number;
	feature_type: string;
	fetched_at: Generated<Date>;
}

/** Mirrored OSM point features (stations, individual landmarks).
 *  Separate from `osm_lines` because `ST_Distance_Sphere` is
 *  POINT-POINT only in MariaDB — mixing geometry types in one table
 *  trips the optimizer into calling it on lines. */
export interface OsmPointsTable {
	/** OSM IDs are BIGINT in the schema and exceed 2^53 in recent
	 *  data, so they return as bigint at runtime. Callers that need
	 *  the value as a JS number should `Number(...)` at the boundary
	 *  (precision is not preserved for very large ids — only do this
	 *  if you intend to treat the id as opaque). */
	osm_id: bigint;
	osm_type: string;
	feature_type: string;
	subtype: string | null;
	name: string | null;
	tags_json: string | null;
	geom: string; // WKT POINT
}

/** Mirrored OSM line features (roads, rail lines, waterways). For
 *  distance queries we use ST_Distance (planar, in degrees) and
 *  convert to metres in JS — a sub-percent approximation at the
 *  city-scale distances we care about. */
export interface OsmLinesTable {
	/** OSM IDs are BIGINT in the schema and exceed 2^53 in recent
	 *  data, so they return as bigint at runtime. Callers that need
	 *  the value as a JS number should `Number(...)` at the boundary
	 *  (precision is not preserved for very large ids — only do this
	 *  if you intend to treat the id as opaque). */
	osm_id: bigint;
	osm_type: string;
	feature_type: string;
	subtype: string | null;
	name: string | null;
	tags_json: string | null;
	geom: string; // WKT LINESTRING
}

export interface ModeBiometricsTable {
	user_id: string;
	mode: string;
	hr_mean: number | null;
	hr_std: number | null;
	hr_sample_count: number;
	cadence_mean: number | null;
	cadence_std: number | null;
	cadence_sample_count: number;
	speed_mean: number | null;
	speed_std: number | null;
	speed_sample_count: number;
	sample_count: number;
	refreshed_at: Generated<Date>;
}

/** Share-token row. One per user; token rotation is DELETE +
 *  INSERT so the row reflects the *current* active token. */
export interface ShareTokensTable {
	user_id: string;
	token: string;
	days_back: number;
	created_at: Generated<Date>;
	last_accessed_at: Date | null;
}

/** Nextcloud app-password credentials. One row per linked user; the
 *  app password is treated as opaque and sent as HTTP Basic Auth on
 *  every NC request. Replaces the OAuth refresh-token flow. */
export interface NcCredentialsTable {
	user_id: string;
	login_name: string;
	app_password: string;
	status: Generated<string>; // 'active' | 'needs_reauth'
	created_at: Generated<Date>;
	updated_at: Generated<Date>;
}

export interface FocusPlacesTable {
	id: Generated<number>;
	user_id: string;
	centroid_lat: number;
	centroid_lon: number;
	radius_m: number;
	/** BIGINT in the schema — returns as bigint with bigIntAsNumber:false.
	 *  Sized in seconds, so it fits in Number safely; consumers that need
	 *  to do arithmetic should `Number(total_dwell_sec)` at the boundary. */
	total_dwell_sec: bigint;
	visit_count: number;
	unique_days: number;
	first_seen_ts: number;
	last_seen_ts: number;
	detected_label: string | null;
	display_name: string | null;
	sleep_hours: number | null;
	amenity_label: string | null;
	/** OSM subtype of the mined venue ("restaurant", "fitness_centre", …) —
	 *  the category behind `amenity_label`'s name. NULL when unmined. */
	amenity_kind: string | null;
	/** Hour-of-day dwell profile — 24 comma-joined permille integers, or
	 *  NULL on rows written before the column existed. Parsed by
	 *  `parseHourProfile`; consumed by the runtime place scorer. */
	hour_profile: string | null;
	refreshed_at: Generated<Date>;
}

/** Precomputed snapped rail geometry — the polyline a train run is
 *  drawn on, keyed by its `<board> → <alight>` station-pair label.
 *  Filled offline by the refresh-rail-routes CLI; the velocity
 *  pipeline only reads it. `geometry_json` is a JSON array of
 *  `{lat, lon}` vertices. Pure cache — safe to truncate and rebuild. */
export interface RailRouteCacheTable {
	route_key: string;
	geometry_json: string;
	computed_at: Generated<Date>;
}

/** Mirrored OSM `route=bus` relations — one row per relation (per travel
 *  direction), holding the route's ref, name, and ordered stop list as a
 *  JSON array of `{name, lat, lon, seq}`. Filled offline by the
 *  refresh-bus-routes CLI; the velocity pipeline reads it to name the bus
 *  a road-vehicle leg rode. `osm_relation_id` is BIGINT (returned as
 *  bigint); relation ids are well under 2^53 so the loader narrows to
 *  number for the matcher. Pure cache — safe to truncate and rebuild. */
export interface BusRouteCacheTable {
	osm_relation_id: bigint;
	route_ref: string;
	route_name: string | null;
	stops_json: string;
	computed_at: Generated<Date>;
}

/** One OSM rail route relation (subway/train/light_rail/tram): line
 *  ref/name + ordered stop-role members — the stations the service
 *  actually calls at (#364). Written by refresh-rail-stops (offline
 *  tiled Overpass mirror); read as served-station membership. Relation
 *  ids narrow to number like the bus cache. Pure cache — safe to
 *  truncate and rebuild. */
export interface RailStopsCacheTable {
	osm_relation_id: bigint;
	route_type: string;
	line_ref: string | null;
	line_name: string | null;
	stops_json: string;
	computed_at: Generated<Date>;
}

/** Per-day HMM decode cache. Each row holds the MAP segment sequence
 *  produced by the joint-sequence model for one (user, date). Cached
 *  so a request for a previously-decoded day serves directly from
 *  the persisted segments rather than re-running Viterbi.
 *
 *  `classifier_version` tags which version of the HMM model produced
 *  the decode. On model retrain (or any change that bumps
 *  `CURRENT_CLASSIFIER_VERSION`), stale rows are recognised by
 *  version mismatch and re-decoded on next read.
 *
 *  Pure cache — safe to truncate and rebuild. */
/** `presence_log` — per-(user, date) roll-up of the HSMM's per-minute
 *  output, used as the cross-day continuity seed for sparse-data days.
 *  Phase 1 of `docs/proposals/2026-06-presence-continuity.md`. Pure
 *  function of (decoded_days, focus_places, current code), rebuilt
 *  nightly. */
export interface PresenceLogTable {
	user_id: string;
	/** DATE in the user's displayTz, stored as 'YYYY-MM-DD'. */
	date: string;
	tz: string;
	/** focus_places.id assigned to the largest fraction of decoded
	 *  minutes on this day. Null when no focus_place dominates. */
	dominant_place_id: number | null;
	/** Fraction of the day's decoded minutes (0–1) assigned to
	 *  `dominant_place_id`. 1.0 = entire day at one place. */
	dominant_fraction: number;
	/** focus_places.id of the day's last decoded minute when it sits at
	 *  a known place; null otherwise. The next day's HSMM uses this as
	 *  the continuation candidate seed. */
	end_of_day_place_id: number | null;
	/** Wall-clock UTC time of that last decoded minute. Null when
	 *  `end_of_day_place_id` is null. */
	end_of_day_ts: Date | null;
	/** Posterior (0–1) the HSMM assigned to the end-of-day state. */
	end_of_day_posterior: number;
	computed_at: Generated<Date>;
}

/** `venue_type_priors` — per-user mined visit-shape priors for the
 *  venue-plausibility scorer (#246). `priors_json` holds the whole
 *  `VenuePriors` blob (bySubtype / byCategory / totalVisits); rebuilt in
 *  full by the weekly focus-places refresh from attribution-unambiguous
 *  stays. Pure derived data — safe to truncate and re-mine. */
export interface VenueTypePriorsTable {
	user_id: string;
	priors_json: string;
	/** How many attributed stays the blob was mined from (observability). */
	mined_stays: number;
	updated_at: Generated<Date>;
}

export interface DecodedDaysTable {
	user_id: string;
	/** DATE in the user's displayTz, stored as 'YYYY-MM-DD'. */
	date: string;
	classifier_version: number;
	/** JSON-serialised segment array. Shape defined by the HMM
	 *  decoder; consumers parse via the decoder's own type guards. */
	segments_json: string;
	decoded_at: Generated<Date>;
}

/** `learned_hmm_models` — persisted parameters of HMM emission
 *  distributions fit from heuristic-labeled minutes (Phase 2 of
 *  docs/proposals/2026-05-hmm-learned-emissions.md). One row per
 *  (user, version) tuple; `version` is a free-form label naming
 *  the model class and training run (e.g. `per-mode-gaussian-v1`).
 *
 *  `emissions_json` is the serialised `LearnedEmissionParameters`
 *  shape; consumers deserialise via the storage module. */
export interface LearnedHmmModelsTable {
	id: Generated<number>;
	user_id: string;
	version: string;
	notes: string | null;
	emissions_json: string;
	training_day_count: number;
	training_minute_count: number;
	trained_at: Generated<Date>;
}

// The full database interface — Kysely uses this to type-check every query
export interface Database {
	tokens: TokensTable;
	sync_state: SyncStateTable;
	daily_activity: DailyActivityTable;
	heart_rate_intraday: HeartRateIntradayTable;
	steps_intraday: StepsIntradayTable;
	heart_rate_zones: HeartRateZonesTable;
	sleep: SleepTable;
	sleep_stages: SleepStagesTable;
	body: BodyTable;
	spo2_daily: SpO2DailyTable;
	spo2_intraday: SpO2IntradayTable;
	hrv_daily: HrvDailyTable;
	hrv_intraday: HrvIntradayTable;
	breathing_rate: BreathingRateTable;
	skin_temperature: SkinTemperatureTable;
	cardio_fitness: CardioFitnessTable;
	devices: DevicesTable;
	device_battery_log: DeviceBatteryLogTable;
	motion_log: MotionLogTable;
	sessions: SessionsTable;
	nc_tokens: NcTokensTable;
	nc_credentials: NcCredentialsTable;
	share_tokens: ShareTokensTable;
	osm_cache: OsmCacheTable;
	osm_coverage: OsmCoverageTable;
	osm_points: OsmPointsTable;
	osm_lines: OsmLinesTable;
	focus_places: FocusPlacesTable;
	mode_biometrics: ModeBiometricsTable;
	rail_route_cache: RailRouteCacheTable;
	bus_route_cache: BusRouteCacheTable;
	rail_stops_cache: RailStopsCacheTable;
	decoded_days: DecodedDaysTable;
	presence_log: PresenceLogTable;
	learned_hmm_models: LearnedHmmModelsTable;
	venue_type_priors: VenueTypePriorsTable;
	schema_migrations: SchemaMigrationsTable;
}

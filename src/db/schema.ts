import type * as mariadb from "mariadb";

// Each migration runs exactly once, tracked by version number.
// To evolve the schema, add a new entry at the end — never modify existing ones.
const MIGRATIONS: readonly string[] = [
	// v1: initial schema
	`CREATE TABLE IF NOT EXISTS tokens (
    user_id VARCHAR(64) PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    scopes TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,
	`CREATE TABLE IF NOT EXISTS sync_state (
    user_id VARCHAR(64) NOT NULL,
    key_name VARCHAR(64) NOT NULL,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, key_name)
  )`,
	`CREATE TABLE IF NOT EXISTS daily_activity (
    user_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL,
    steps INT,
    calories_total INT,
    calories_active INT,
    distance_km DECIMAL(8,3),
    floors INT,
    elevation_m DECIMAL(8,2),
    minutes_sedentary INT,
    minutes_lightly_active INT,
    minutes_fairly_active INT,
    minutes_very_active INT,
    active_score INT,
    resting_heart_rate INT,
    synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, date)
  )`,
	`CREATE TABLE IF NOT EXISTS heart_rate_intraday (
    user_id VARCHAR(64) NOT NULL,
    ts DATETIME NOT NULL,
    bpm SMALLINT NOT NULL,
    PRIMARY KEY (user_id, ts)
  )`,
	`CREATE TABLE IF NOT EXISTS heart_rate_zones (
    user_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL,
    zone_name VARCHAR(32) NOT NULL,
    minutes INT,
    calories DECIMAL(8,2),
    min_bpm INT,
    max_bpm INT,
    PRIMARY KEY (user_id, date, zone_name)
  )`,
	`CREATE TABLE IF NOT EXISTS sleep (
    user_id VARCHAR(64) NOT NULL,
    log_id BIGINT NOT NULL,
    date DATE NOT NULL,
    start_time DATETIME NOT NULL,
    end_time DATETIME NOT NULL,
    duration_ms BIGINT,
    efficiency INT,
    minutes_asleep INT,
    minutes_awake INT,
    minutes_deep INT,
    minutes_light INT,
    minutes_rem INT,
    minutes_wake INT,
    is_main_sleep BOOLEAN,
    PRIMARY KEY (user_id, log_id),
    INDEX idx_sleep_user_date (user_id, date)
  )`,
	`CREATE TABLE IF NOT EXISTS sleep_stages (
    user_id VARCHAR(64) NOT NULL,
    sleep_log_id BIGINT NOT NULL,
    ts DATETIME NOT NULL,
    stage VARCHAR(16) NOT NULL,
    duration_seconds INT NOT NULL,
    PRIMARY KEY (user_id, sleep_log_id, ts)
  )`,
	`CREATE TABLE IF NOT EXISTS body (
    user_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL,
    weight_kg DECIMAL(5,2),
    bmi DECIMAL(4,1),
    body_fat_pct DECIMAL(4,1),
    PRIMARY KEY (user_id, date)
  )`,
	`CREATE TABLE IF NOT EXISTS spo2_daily (
    user_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL,
    avg_value DECIMAL(4,1),
    min_value DECIMAL(4,1),
    max_value DECIMAL(4,1),
    PRIMARY KEY (user_id, date)
  )`,
	`CREATE TABLE IF NOT EXISTS spo2_intraday (
    user_id VARCHAR(64) NOT NULL,
    ts DATETIME NOT NULL,
    value DECIMAL(4,1) NOT NULL,
    PRIMARY KEY (user_id, ts)
  )`,
	`CREATE TABLE IF NOT EXISTS hrv_daily (
    user_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL,
    daily_rmssd DECIMAL(8,2),
    deep_rmssd DECIMAL(8,2),
    PRIMARY KEY (user_id, date)
  )`,
	`CREATE TABLE IF NOT EXISTS breathing_rate (
    user_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL,
    full_sleep_rate DECIMAL(4,1),
    deep_sleep_rate DECIMAL(4,1),
    light_sleep_rate DECIMAL(4,1),
    rem_sleep_rate DECIMAL(4,1),
    PRIMARY KEY (user_id, date)
  )`,
	`CREATE TABLE IF NOT EXISTS skin_temperature (
    user_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL,
    relative_deviation DECIMAL(4,2),
    PRIMARY KEY (user_id, date)
  )`,
	`CREATE TABLE IF NOT EXISTS cardio_fitness (
    user_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL,
    vo2_max DECIMAL(4,1),
    PRIMARY KEY (user_id, date)
  )`,
	`CREATE TABLE IF NOT EXISTS devices (
    user_id VARCHAR(64) NOT NULL,
    device_id VARCHAR(64) NOT NULL,
    device_version VARCHAR(64),
    type VARCHAR(32),
    battery VARCHAR(16),
    last_sync_time DATETIME,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, device_id)
  )`,

	// v16: persistent sessions
	`CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    display_name VARCHAR(128) NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_sessions_expires (expires_at)
  )`,

	// v17: Nextcloud OAuth tokens (for PhoneTrack API access)
	`CREATE TABLE IF NOT EXISTS nc_tokens (
    user_id VARCHAR(64) PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,

	// v18: OSM query cache (Nominatim reverse geocoding + Overpass nearby ways).
	// Keyed by query type and rounded coordinates (~11m precision at 4 decimals).
	`CREATE TABLE IF NOT EXISTS osm_cache (
    query_type VARCHAR(32) NOT NULL,
    lat_rounded DECIMAL(7,4) NOT NULL,
    lon_rounded DECIMAL(7,4) NOT NULL,
    result LONGTEXT NOT NULL,
    cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (query_type, lat_rounded, lon_rounded)
  )`,

	// v19: Detected focus places (home, work, frequent café, ...). Refreshed
	// weekly by re-fetching the user's last 90 days from PhoneTrack and
	// running the focus-places pipeline. Whole table per user is rebuilt each
	// refresh — no stable IDs across rebuilds. Used by velocity.ts for
	// snap-to-place during live timeline rendering.
	`CREATE TABLE IF NOT EXISTS focus_places (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    centroid_lat DECIMAL(9,6) NOT NULL,
    centroid_lon DECIMAL(9,6) NOT NULL,
    radius_m INT NOT NULL,
    total_dwell_sec BIGINT NOT NULL,
    visit_count INT NOT NULL,
    unique_days INT NOT NULL,
    first_seen_ts INT UNSIGNED NOT NULL,
    last_seen_ts INT UNSIGNED NOT NULL,
    detected_label VARCHAR(32),
    refreshed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_fp_user (user_id),
    INDEX idx_fp_user_geo (user_id, centroid_lat, centroid_lon)
  )`,

	// v20: Auto-derived display name for the user's primary clusters
	// ("Home" — strongest overnight cluster, "Work" — strongest non-home
	// weekday-daytime cluster). NULL for places without a special role;
	// those fall back to OSM nearby-landmark labelling at render time.
	`ALTER TABLE focus_places ADD COLUMN IF NOT EXISTS display_name VARCHAR(64) NULL`,

	// v21: Per-cluster sum of stay durations where the stay covers any of
	// 02:00–06:00 local solar time (deep night). This is the residential /
	// "I sleep here sometimes" signal — robust to people who sleep
	// 22:00-09:00 or 02:00-10:00, robust to long café visits (which don't
	// cross deep night). Used by velocity.ts to label any stay at the
	// cluster with the address rather than the closest amenity, regardless
	// of this particular stay's time-of-day.
	`ALTER TABLE focus_places ADD COLUMN IF NOT EXISTS sleep_hours INT NULL`,

	// v22: Intraday step counts at Fitbit's finest resolution (1 minute).
	// Zero-step minutes are NOT stored — implicit zero saves ~5x rows for
	// a typical day (most minutes have no steps). Use COALESCE / LEFT JOIN
	// when querying if you need the dense per-minute series.
	`CREATE TABLE IF NOT EXISTS steps_intraday (
    user_id VARCHAR(64) NOT NULL,
    ts DATETIME NOT NULL,
    steps SMALLINT NOT NULL,
    PRIMARY KEY (user_id, ts)
  )`,

	// v23: Per-row IANA timezone for the watch's tz at recording time.
	// Fitbit returns wall-clock strings with no tz info; correct conversion
	// to UTC requires knowing which tz the watch was in when it recorded.
	// NULL = "not inferred yet"; read path falls back to home_tz then
	// requestTz. See TIMEZONE.md for the full design.
	`ALTER TABLE steps_intraday      ADD COLUMN IF NOT EXISTS tz VARCHAR(64) NULL`,
	`ALTER TABLE heart_rate_intraday ADD COLUMN IF NOT EXISTS tz VARCHAR(64) NULL`,
	`ALTER TABLE sleep_stages        ADD COLUMN IF NOT EXISTS tz VARCHAR(64) NULL`,

	// v24: Per-user mode biometric signatures. Mined from historical
	// (HR, cadence, speed) joint distribution per minute, labeled by
	// heuristic rules. Used by downstream classification to disambiguate
	// segments whose GPS-derived confidence is low (cycling-as-driving,
	// walking-as-driving). Refreshed periodically.
	`CREATE TABLE IF NOT EXISTS mode_biometrics (
    user_id              VARCHAR(64)  NOT NULL,
    mode                 VARCHAR(16)  NOT NULL,
    hr_mean              DECIMAL(5,1) NULL,
    hr_std               DECIMAL(5,1) NULL,
    hr_sample_count      INT          NOT NULL DEFAULT 0,
    cadence_mean         DECIMAL(6,1) NULL,
    cadence_std          DECIMAL(6,1) NULL,
    cadence_sample_count INT          NOT NULL DEFAULT 0,
    speed_mean           DECIMAL(6,1) NULL,
    speed_std            DECIMAL(6,1) NULL,
    speed_sample_count   INT          NOT NULL DEFAULT 0,
    sample_count         INT          NOT NULL,
    refreshed_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, mode)
  )`,

	// v25: Per-cluster amenity-name mining. Each focus_place gets an
	// optional venue label derived from majority-voting OSM amenity
	// lookups across all member stays (time-weighted). Fixes the
	// Bairro-Alto-vs-Kruidentuin case: per-visit OSM picker is sensitive
	// to GPS noise on a single visit; aggregating across many visits
	// converges on the venue the user is actually at.
	`ALTER TABLE focus_places ADD COLUMN IF NOT EXISTS amenity_label VARCHAR(128) NULL`,

	// v26: Nextcloud connection status. Tracks whether the stored
	// refresh token is still valid. Set to 'needs_reauth' when the
	// token manager catches a 4xx from Nextcloud's token endpoint
	// (refresh token rejected or rate-limited); reset to 'active' on
	// next successful refresh or fresh /auth/callback. /api/me reads
	// this so the UI can render a "Reconnect Nextcloud" banner without
	// triggering side-effects.
	`ALTER TABLE nc_tokens ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active'`,

	// v27: Same connection-status column for Fitbit tokens. Mirrors v26.
	// Sync today runs serially per-user so concurrent refresh wasn't
	// actually exploding the Fitbit brute-force counter — but the
	// architectural shape is identical to the NC bug we just fixed, so
	// fix it before it bites.
	`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active'`,

	// v28a: Local OSM mirror — coverage table. Each row records a
	// bounding box for which we've fetched OSM features of a given
	// type. Subsequent queries inside this box read from osm_features
	// (below) instead of hitting Overpass. Boxes grow lazily as the
	// user travels into uncovered areas. Overlap is fine — features
	// upsert by osm_id, no duplicates. Refresh is lazy too: any
	// query against a box with old fetched_at triggers a refetch.
	`CREATE TABLE IF NOT EXISTS osm_coverage (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    min_lat DECIMAL(9,6) NOT NULL,
    max_lat DECIMAL(9,6) NOT NULL,
    min_lon DECIMAL(9,6) NOT NULL,
    max_lon DECIMAL(9,6) NOT NULL,
    feature_type VARCHAR(32) NOT NULL,
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_bbox (feature_type, min_lat, max_lat, min_lon, max_lon)
  )`,

	// v28b: Local OSM mirror — features table. One row per OSM
	// node/way we care about. Geometry is GEOMETRY (not POINT) so the
	// same column holds POINT for station nodes and LINESTRING for
	// road/rail ways. ST_Distance_Sphere works for both — for a
	// LINESTRING it returns the distance to the nearest point on the
	// line, which is exactly what "is this road near here" means.
	// PRIMARY KEY (osm_type, osm_id) dedupes when overlapping coverage
	// boxes return the same feature. feature_type is the high-level
	// bucket (station, highway, railway, aeroway, landmark); subtype
	// is the OSM tag value (subway, motorway, etc.).
	// `geom GEOMETRY NOT NULL` — no column-level SRID attribute (MariaDB
	// 11.x rejects the `SRID 4326` clause syntax). The SRID is set
	// per-row at insert time via `ST_GeomFromText(wkt, 4326)`; the
	// SPATIAL INDEX and `ST_Distance_Sphere` both work without a
	// column-level SRID constraint.
	`CREATE TABLE IF NOT EXISTS osm_features (
    osm_id BIGINT NOT NULL,
    osm_type VARCHAR(16) NOT NULL,
    feature_type VARCHAR(32) NOT NULL,
    subtype VARCHAR(64),
    name VARCHAR(255),
    tags_json JSON,
    geom GEOMETRY NOT NULL,
    PRIMARY KEY (osm_type, osm_id),
    SPATIAL INDEX idx_geom (geom),
    INDEX idx_feature_type (feature_type)
  )`,

	// v29: Drop osm_features and split points and lines. MariaDB's
	// ST_Distance_Sphere supports POINT-POINT only; calling it on a
	// LINESTRING throws ER_GIS_UNSUPPORTED_ARGUMENT. The unified
	// `osm_features` table held both, and the optimizer occasionally
	// reached LINESTRING rows during the distance computation even
	// with a `subtype IN (...)` filter — producing the crash we saw
	// once nearbyStations was switched to the local mirror.
	//
	// Cleaner shape: separate tables per geometry type. Each table
	// has its own spatial index. nearbyStations queries osm_points;
	// linesAtPoint / nearbyWays query osm_lines. ST_Distance_Sphere
	// is only ever called on POINT-POINT (for both stations and the
	// query point). For point-to-line distance we use ST_Distance
	// with a degree-to-metre conversion done in JS (small-radius
	// approximation; sub-percent error at city-scale distances).
	`DROP TABLE IF EXISTS osm_features`,
	`CREATE TABLE IF NOT EXISTS osm_points (
    osm_id BIGINT NOT NULL,
    osm_type VARCHAR(16) NOT NULL,
    feature_type VARCHAR(32) NOT NULL,
    subtype VARCHAR(64),
    name VARCHAR(255),
    tags_json JSON,
    geom POINT NOT NULL,
    PRIMARY KEY (osm_type, osm_id),
    SPATIAL INDEX idx_geom (geom),
    INDEX idx_feature_type (feature_type)
  )`,
	`CREATE TABLE IF NOT EXISTS osm_lines (
    osm_id BIGINT NOT NULL,
    osm_type VARCHAR(16) NOT NULL,
    feature_type VARCHAR(32) NOT NULL,
    subtype VARCHAR(64),
    name VARCHAR(255),
    tags_json JSON,
    geom LINESTRING NOT NULL,
    PRIMARY KEY (osm_type, osm_id),
    SPATIAL INDEX idx_geom (geom),
    INDEX idx_feature_type (feature_type)
  )`,
	// Coverage will need re-fetching after this split — drop the
	// existing rows (no production data of value yet).
	`DELETE FROM osm_coverage`,

	// v30: Sleep summary table joins the per-row tz convention. The
	// `sleep` table stored Fitbit's local-time DATETIMEs without a tz
	// column, so consumers couldn't tell whether to interpret
	// start_time/end_time as UTC or local. (Sibling tables
	// heart_rate_intraday and steps_intraday store UTC + tz;
	// sleep_stages already stored local + tz. The sleep summary was
	// the gap.) Backfill of existing rows is a one-off CLI run; the
	// migration only adds the column. New ingestion populates it
	// from the user's TzSource.
	`ALTER TABLE sleep ADD COLUMN IF NOT EXISTS tz VARCHAR(64) NULL`,

	// v31a–c: Repair sleep-row duplication from the BigInt cutover and
	// add a uniqueness constraint that prevents recurrence.
	//
	// Background: Fitbit's 64-bit log_id used to be parsed as a JS
	// Number, losing precision. The bigIntAsNumber:false fix (and
	// BigInt-aware Fitbit JSON parser) made future syncs produce the
	// full-precision value. The first sync after that cutover for an
	// already-stored night inserts a SECOND row, because the PK
	// (user_id, log_id) sees a different log_id. Same logical sleep,
	// two DB rows, doubled sleep_stages.
	//
	// Fix: (a) drop the orphan-stage rows whose sleep_log_id belongs
	// to a non-canonical duplicate; (b) drop the duplicate sleep rows
	// themselves; (c) add a unique index on
	// (user_id, start_time, is_main_sleep) so future re-syncs UPSERT
	// the existing row rather than creating a new one. ON DUPLICATE
	// KEY UPDATE in syncSleep deliberately does NOT touch log_id, so
	// existing sleep_stages references remain valid; syncSleep
	// additionally looks up the canonical log_id after the upsert and
	// uses it for the stages INSERT.
	//
	// Canonical row per duplicate group: MIN(log_id). Arbitrary but
	// deterministic — both rows contain the same Fitbit payload.
	`DELETE ss FROM sleep_stages ss
   JOIN sleep s ON ss.user_id = s.user_id AND ss.sleep_log_id = s.log_id
   JOIN (
     SELECT user_id, start_time, is_main_sleep, MIN(log_id) AS keep_id
     FROM sleep
     GROUP BY user_id, start_time, is_main_sleep
     HAVING COUNT(*) > 1
   ) dup ON dup.user_id = s.user_id AND dup.start_time = s.start_time AND dup.is_main_sleep = s.is_main_sleep
   WHERE s.log_id <> dup.keep_id`,
	`DELETE s FROM sleep s
   JOIN (
     SELECT user_id, start_time, is_main_sleep, MIN(log_id) AS keep_id
     FROM sleep
     GROUP BY user_id, start_time, is_main_sleep
     HAVING COUNT(*) > 1
   ) dup ON dup.user_id = s.user_id AND dup.start_time = s.start_time AND dup.is_main_sleep = s.is_main_sleep
   WHERE s.log_id <> dup.keep_id`,
	`ALTER TABLE sleep ADD UNIQUE INDEX IF NOT EXISTS uniq_sleep_user_start_main (user_id, start_time, is_main_sleep)`,

	// v32: Nextcloud app-password credentials store. Replaces the
	// OAuth refresh-token dance that kept flipping nc_tokens to
	// needs_reauth (cross-pod refresh race against NC's single-use
	// refresh tokens). App passwords are long-lived: no expiry, no
	// refresh, just HTTP Basic Auth on every request. Migration only
	// adds the table; existing nc_tokens rows are left for the cleanup
	// commit that retires the OAuth code.
	`CREATE TABLE IF NOT EXISTS nc_credentials (
    user_id VARCHAR(64) NOT NULL PRIMARY KEY,
    login_name VARCHAR(255) NOT NULL,
    app_password TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,

	// v33: share_tokens. One row per user (PRIMARY KEY user_id); token
	// rotation is DELETE + INSERT, so the old token's row vanishes and
	// subsequent lookups by it 404. `days_back` is the rolling window
	// the recipient sees ending at today. `last_accessed_at` is for
	// "is this share still in use?" diagnostics — not load-bearing.
	`CREATE TABLE IF NOT EXISTS share_tokens (
    user_id VARCHAR(64) NOT NULL PRIMARY KEY,
    token VARCHAR(64) NOT NULL,
    days_back INT NOT NULL DEFAULT 7,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_accessed_at TIMESTAMP NULL,
    UNIQUE KEY uniq_share_token (token)
  )`,

	// v34: Three-tier timestamp storage on the intraday Fitbit tables.
	// `ts` (wall-clock DATETIME from Fitbit) stays immutable. New
	// columns: `ts_utc` (DATETIME interpreted by convention as UTC,
	// derived from `ts` + `tz`) and `tz_source` (provenance tag —
	// 'phonetrack' / 'home_tz' / 'manual' / 'legacy' / NULL).
	// See `docs/design/timezone.md`.
	// Columns only; the `(user_id, ts_utc)` index is deferred until
	// after the Phase B backfill populates `ts_utc` for historical
	// rows (building an index over a half-empty column is wasted
	// work and slow DDL inside the startup migration risks the pod's
	// liveness probe).
	`ALTER TABLE heart_rate_intraday
     ADD COLUMN IF NOT EXISTS ts_utc DATETIME NULL,
     ADD COLUMN IF NOT EXISTS tz_source VARCHAR(32) NULL`,
	`ALTER TABLE steps_intraday
     ADD COLUMN IF NOT EXISTS ts_utc DATETIME NULL,
     ADD COLUMN IF NOT EXISTS tz_source VARCHAR(32) NULL`,
	`ALTER TABLE sleep_stages
     ADD COLUMN IF NOT EXISTS ts_utc DATETIME NULL,
     ADD COLUMN IF NOT EXISTS tz_source VARCHAR(32) NULL`,

	// v35: Same three-tier storage on the sleep summary table. The
	// sleep summary has both `start_time` and `end_time` wall-clock
	// columns, so it gets two UTC siblings plus the shared
	// `tz_source` provenance tag.
	`ALTER TABLE sleep
     ADD COLUMN IF NOT EXISTS start_time_utc DATETIME NULL,
     ADD COLUMN IF NOT EXISTS end_time_utc   DATETIME NULL,
     ADD COLUMN IF NOT EXISTS tz_source VARCHAR(32) NULL`,

	// v36: Secondary index on `(user_id, ts_utc)` to drive Phase C
	// reads. Built manually online on prod (ALGORITHM=INPLACE,
	// LOCK=NONE) so the startup migration here is a no-op via IF NOT
	// EXISTS; fresh databases pay the index build at first boot.
	`ALTER TABLE heart_rate_intraday ADD INDEX IF NOT EXISTS idx_hri_user_ts_utc (user_id, ts_utc)`,
	`ALTER TABLE steps_intraday      ADD INDEX IF NOT EXISTS idx_si_user_ts_utc  (user_id, ts_utc)`,
	`ALTER TABLE sleep_stages        ADD INDEX IF NOT EXISTS idx_sst_user_ts_utc (user_id, ts_utc)`,

	// v37: OSM route-relation membership. A rail/metro line in OSM is a
	// `relation[route]`; its track ways frequently carry the line name
	// only on that relation, not on the way itself. Storing
	// way → route-name membership lets `queryRouteGeometry` assemble a
	// line's *complete* geometry instead of the fragmentary subset of
	// ways that happen to be name-tagged. One row per (way, route): a
	// way shared by two lines gets two rows.
	`CREATE TABLE IF NOT EXISTS osm_way_routes (
    osm_way_id BIGINT NOT NULL,
    route_name VARCHAR(255) NOT NULL,
    route_type VARCHAR(32) NOT NULL,
    PRIMARY KEY (osm_way_id, route_name),
    INDEX idx_route_name (route_name)
  )`,

	// rail_route_cache — precomputed snapped rail geometry, keyed by a
	// train run's `<board> → <alight>` station-pair label. The velocity
	// pipeline reads this with a single PK lookup and never runs the
	// expensive corridor query on the request path; the geometry is
	// (re)computed offline by the refresh-rail-routes CLI. A rail
	// route's drawn geometry is the same every time it is travelled, so
	// caching by route_key reuses the work across days. The whole table
	// is rebuildable from scratch — it is a cache, not a source of truth.
	`CREATE TABLE IF NOT EXISTS rail_route_cache (
    route_key VARCHAR(191) NOT NULL,
    geometry_json LONGTEXT NOT NULL,
    computed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (route_key)
  )`,

	// bus_route_cache — one row per OSM `route=bus` relation: the route's
	// rider-facing ref ("38"), name, and ordered stop list. Mirrored
	// offline by the refresh-bus-routes CLI (throttled Overpass) and read
	// on the request path to NAME the bus a road-vehicle leg rode
	// (`bus-route-match.ts`). A route's stop sequence is stable, so it is
	// keyed by relation, reused across every day it appears. Each OSM
	// travel direction is its own relation → its own row, opposite stop
	// order. Pure cache — rebuildable from scratch, safe to truncate.
	`CREATE TABLE IF NOT EXISTS bus_route_cache (
    osm_relation_id BIGINT NOT NULL,
    route_ref VARCHAR(64) NOT NULL,
    route_name VARCHAR(255) NULL,
    stops_json LONGTEXT NOT NULL,
    computed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (osm_relation_id),
    INDEX idx_bus_route_ref (route_ref)
  )`,

	// Hour-of-day dwell profile on focus_places. A normalised 24-bucket
	// histogram of where, across the local solar clock, a place's visits
	// spend their time — stored as 24 comma-joined permille integers.
	// Generalises the binary sleep_hours/awake split: it lets the runtime
	// place scorer route a stay to the right one of two co-located places
	// (a daytime café vs an evening residence) by time-of-day, where the
	// ~100 m distance term cannot. Mined fresh each nightly refresh; NULL
	// on rows written before this column existed (the runtime treats NULL
	// as "no time-of-day signal").
	`ALTER TABLE focus_places ADD COLUMN IF NOT EXISTS hour_profile VARCHAR(127) NULL`,

	// Secondary index on osm_lines.name. The HMM precondition work
	// (Phase 0b) needs `WHERE feature_type='railway' AND name=?` to
	// run fast — without this index it falls back to a full scan over
	// the 42k-row railway subset (~30s per line on a warm pool).
	// The index also benefits future queries that want "all ways of
	// line X" (e.g. line-membership disambiguation).
	`ALTER TABLE osm_lines ADD INDEX IF NOT EXISTS idx_osm_lines_name (name)`,

	// decoded_days: per-day HMM decode persistence cache (Phase 0c).
	// One row per (user, date) holds the MAP segment sequence produced
	// by the joint-sequence model. Cached so subsequent reads of a
	// previously-decoded day serve directly from persisted segments
	// without re-running Viterbi. On model retrain the
	// classifier_version mismatch invalidates stale rows.
	// Pure cache — safe to truncate and rebuild.
	`CREATE TABLE IF NOT EXISTS decoded_days (
    user_id            VARCHAR(64) NOT NULL,
    date               DATE NOT NULL,
    classifier_version INT NOT NULL,
    segments_json      MEDIUMTEXT NOT NULL,
    decoded_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, date),
    INDEX idx_user_version (user_id, classifier_version)
  )`,

	// learned_hmm_models: per-user fitted HMM emission parameters
	// (Phase 2 of docs/proposals/2026-05-hmm-learned-emissions.md).
	// One row per (user, version). emissions_json holds the
	// LearnedEmissionParameters blob; consumers deserialise via
	// loadLearnedEmissions. Versioned so we can iterate on the
	// model class without invalidating in-flight decodes.
	`CREATE TABLE IF NOT EXISTS learned_hmm_models (
    id                    INT NOT NULL AUTO_INCREMENT,
    user_id               VARCHAR(64) NOT NULL,
    version               VARCHAR(64) NOT NULL,
    notes                 TEXT NULL,
    emissions_json        MEDIUMTEXT NOT NULL,
    training_day_count    INT NOT NULL,
    training_minute_count INT NOT NULL,
    trained_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_user_version (user_id, version)
  )`,

	// presence_log: per-(user, date) roll-up of the HSMM's per-minute
	// output. Phase 1 of `docs/proposals/2026-06-presence-continuity.md`.
	// Pure function of (decoded_days, focus_places, current code) —
	// DELETE+INSERT rebuilt nightly from a bounded backfill window.
	// Stale rows from a prior algorithm version only live until the
	// next nightly run.
	`CREATE TABLE IF NOT EXISTS presence_log (
    user_id              VARCHAR(64) NOT NULL,
    date                 DATE NOT NULL,
    tz                   VARCHAR(64) NOT NULL,
    dominant_place_id    INT UNSIGNED NULL,
    dominant_fraction    FLOAT NOT NULL,
    end_of_day_place_id  INT UNSIGNED NULL,
    end_of_day_ts        TIMESTAMP NULL,
    end_of_day_posterior FLOAT NOT NULL,
    computed_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, date)
  )`,

	// venue_type_priors: per-user mined visit-shape priors for the
	// venue-plausibility scorer (#246). One row per user holding the
	// whole VenuePriors blob — rebuilt in full by the weekly
	// focus-places refresh from attribution-unambiguous stays (full
	// recompute, never incremental). Read once per day-pipeline run.
	`CREATE TABLE IF NOT EXISTS venue_type_priors (
    user_id     VARCHAR(64) NOT NULL,
    priors_json MEDIUMTEXT NOT NULL,
    mined_stays INT NOT NULL,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id)
  )`,

	// NOTE: migrations are tracked by ARRAY INDEX (schema_migrations.version =
	// position here). NEVER insert a new statement in the middle — it shifts
	// every later index, which are already marked applied, so the new one
	// silently never runs. ALWAYS APPEND new tables/ALTERs at the end.

	// Intraday (5-minute) HRV: full within-night resolution — RMSSD plus the
	// coverage fraction and HF/LF spectral power — where hrv_daily keeps only
	// the nightly summary. `ts` is the verbatim Fitbit wall-clock, mirroring
	// heart_rate_intraday. Filled by syncHrvIntraday (forward + backfill).
	`CREATE TABLE IF NOT EXISTS hrv_intraday (
    user_id VARCHAR(64) NOT NULL,
    ts DATETIME NOT NULL,
    rmssd DECIMAL(8,3) NOT NULL,
    coverage DECIMAL(5,3),
    hf DECIMAL(12,4),
    lf DECIMAL(12,4),
    PRIMARY KEY (user_id, ts)
  )`,

	// Numeric battery percentage for the current device snapshot. The
	// `devices.battery` column keeps only Fitbit's coarse string
	// (High/Medium/Low/Empty); `batteryLevel` is the 0–100 percent the
	// devices endpoint also returns (the Inspire 3 reports it).
	`ALTER TABLE devices ADD COLUMN battery_level TINYINT UNSIGNED NULL`,

	// Per-sync watch-battery history. Fitbit's devices endpoint reports
	// only the CURRENT level at the device's last sync, so each Fitbit
	// sync contributes one timestamped reading (keyed by last_sync_time
	// for idempotency). Read back for the day's watch-battery trace,
	// plotted alongside the PhoneTrack phone-battery series. `last_sync_time`
	// is the Fitbit wall-clock (no offset), like heart_rate_intraday.
	`CREATE TABLE IF NOT EXISTS device_battery_log (
    user_id        VARCHAR(64) NOT NULL,
    device_id      VARCHAR(64) NOT NULL,
    last_sync_time DATETIME NOT NULL,
    battery_level  TINYINT UNSIGNED NOT NULL,
    device_version VARCHAR(64),
    recorded_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, device_id, last_sync_time)
  )`,
	// Per-fix motion witness captured at the Owntracks ingest — the heading /
	// velocity / accuracy the phone reports alongside each position, which
	// PhoneTrack does not retain. `cog` (course over ground, degrees) is the
	// independent direction signal pedestrian dead-reckoning needs to tell an
	// out-and-back from a straight walk (#296). Keyed by (user_id, ts) so it
	// joins the GPS fixes by timestamp. Rows accumulate from deploy; a null cog
	// means the phone did not report a heading for that fix.
	`CREATE TABLE IF NOT EXISTS motion_log (
    user_id     VARCHAR(64) NOT NULL,
    ts          INT UNSIGNED NOT NULL,
    lat         DOUBLE NOT NULL,
    lon         DOUBLE NOT NULL,
    cog         SMALLINT,
    vel         SMALLINT,
    acc         SMALLINT,
    recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, ts)
  )`,

	// v38: OSM subtype of the mined amenity (the raw tag value —
	// "restaurant", "fitness_centre", "supermarket"), alongside the venue
	// NAME already in amenity_label. Lets consumers classify a place by
	// kind (coach filters non-training venues) instead of parsing the name.
	// NULL when no venue was confidently mined. Written by refresh-focus-places.
	`ALTER TABLE focus_places ADD COLUMN IF NOT EXISTS amenity_kind VARCHAR(64) NULL`,

	// place_confirmations — created 2026-07-12, RETIRED the same day; see the
	// DROP below. Migrations are append-only (a version already recorded in
	// schema_migrations must keep its index), so the CREATE stays even though
	// nothing ever reads the table.
	`CREATE TABLE IF NOT EXISTS place_confirmations (
      id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id     VARCHAR(64)  NOT NULL,
      lat         DECIMAL(9,6) NOT NULL,
      lon         DECIMAL(9,6) NOT NULL,
      radius_m    INT          NOT NULL DEFAULT 40,
      label       VARCHAR(128) NOT NULL,
      created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

	// …and drop it again.
	//
	// It let the user pick the right venue when the model could not, and it was
	// a cop-out: it moved the cost of an unsolved inference problem onto the
	// person using the system, and it would have quietly capped how good the
	// algorithm ever needed to get. The venue it could not name (Urban Social,
	// 2026-07-12) is still not named — that is now a bug to fix, which is the
	// point. See RULE 6 in docs/design/probabilistic-principles.md.
	//
	// Dropped rather than left dormant: a table that exists is a table someone
	// will wire back up.
	`DROP TABLE IF EXISTS place_confirmations`,
];

export async function migrate(conn: mariadb.Connection): Promise<void> {
	// MariaDB advisory lock so only one process runs migrations at a time.
	// Today health-auth has replicas=1 and sync runs as a separate cron, so
	// genuine concurrent migrations don't happen — but a rolling deploy or
	// scale-up could trigger two pods to call migrate() simultaneously, and
	// MariaDB DDL is non-transactional, so a race could double-fail or apply
	// half a migration. The lock is cheap insurance.
	const lockRows = (await conn.query("SELECT GET_LOCK('health_migrate', 30) AS got")) as Array<{ got: number | null }>;
	if (lockRows[0]?.got !== 1) {
		throw new Error("Failed to acquire schema_migrations advisory lock within 30s");
	}

	try {
		// Create tracking table (idempotent)
		await conn.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INT PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

		// Find which migrations have already run
		const applied = await conn.query("SELECT version FROM schema_migrations ORDER BY version");
		const appliedSet = new Set<number>(applied.map((r: { version: number }) => r.version));

		let ran = 0;
		for (let i = 0; i < MIGRATIONS.length; i++) {
			if (appliedSet.has(i)) continue;

			await conn.query(MIGRATIONS[i]);
			await conn.query("INSERT INTO schema_migrations (version) VALUES (?)", [i]);
			ran++;
		}

		if (ran > 0) {
			console.log(`Ran ${ran} migration(s) (${appliedSet.size} already applied, ${MIGRATIONS.length} total)`);
		} else {
			console.log(`Schema up to date (${MIGRATIONS.length} migrations)`);
		}
	} finally {
		await conn.query("SELECT RELEASE_LOCK('health_migrate')");
	}
}

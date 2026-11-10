//! The schema, applied at startup.
//!
//! ⚠ The array index is the version number. `schema_migrations` records which
//! indices have run, so inserting a statement anywhere but the end renumbers
//! every later migration: applied ones look unapplied and re-run, and the new
//! one is recorded under a version that already exists, never applied, while
//! the log says "schema is up to date". Append only, forever. The repeats and
//! placeholders below are what breaking this rule has cost.
//!
//! ⚠ MariaDB DDL is not transactional, so a half-applied statement stays
//! half-applied; the advisory lock stops two pods racing during a rolling
//! deploy.

use anyhow::{Context, Result};
use sqlx::MySqlPool;

/// Apply anything not yet recorded in `schema_migrations`.
pub async fn migrate(pool: &MySqlPool) -> Result<()> {
    // ⚠ An advisory lock: MariaDB DDL is non-transactional and a rolling deploy
    // can put two pods here at once.
    //
    // ⚠ One pinned connection for the lock's lifetime. `GET_LOCK` and
    // `RELEASE_LOCK` are per-connection, so as two pool queries the release can
    // land on another connection as a silent no-op, and a server process holds
    // `health_migrate` forever; the next pod then cannot start.
    let mut conn = pool
        .acquire()
        .await
        .context("acquiring a connection for the migration lock")?;

    let got: Option<i64> = sqlx::query_scalar("SELECT GET_LOCK('health_migrate', 30)")
        .fetch_one(&mut *conn)
        .await
        .context("acquiring the migration lock")?;
    if got != Some(1) {
        anyhow::bail!("could not acquire the health_migrate advisory lock within 30s");
    }

    let result = apply(pool).await;

    // ⚠ Released even when a migration failed, or one bad statement becomes a
    // stuck deployment. A failed release is loud: swallowing it is how a lock
    // held on the wrong connection hides.
    let released: Option<i64> = sqlx::query_scalar("SELECT RELEASE_LOCK('health_migrate')")
        .fetch_one(&mut *conn)
        .await
        .context("releasing the migration lock")?;
    if released != Some(1) {
        anyhow::bail!(
            "the migration lock was not released (RELEASE_LOCK returned {released:?}) — \
             this process would hold it for the life of its pool and block every other \
             migrator, which is what happened on 2026-08-23"
        );
    }
    result
}

async fn apply(pool: &MySqlPool) -> Result<()> {
    // ⚠ A fn-local literal array, not a module const: `DL-SQLX-SCHEMA-TRUTH`
    // replays an inline or fn-local array as the schema and type-checks every
    // other query in this crate against it. A const path is opaque to it.
    //
    // Oldest first; the index is the version. Append only.
    let migrations: [&str; 100] = [
        r#"CREATE TABLE IF NOT EXISTS tokens (
    user_id VARCHAR(64) PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    scopes TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )"#,
        r#"CREATE TABLE IF NOT EXISTS sync_state (
    user_id VARCHAR(64) NOT NULL,
    key_name VARCHAR(64) NOT NULL,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, key_name)
  )"#,
        r#"CREATE TABLE IF NOT EXISTS daily_activity (
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
  )"#,
        r#"CREATE TABLE IF NOT EXISTS heart_rate_intraday (
    user_id VARCHAR(64) NOT NULL,
    ts DATETIME NOT NULL,
    bpm SMALLINT NOT NULL,
    PRIMARY KEY (user_id, ts)
  )"#,
        r#"CREATE TABLE IF NOT EXISTS heart_rate_zones (
    user_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL,
    zone_name VARCHAR(32) NOT NULL,
    minutes INT,
    calories DECIMAL(8,2),
    min_bpm INT,
    max_bpm INT,
    PRIMARY KEY (user_id, date, zone_name)
  )"#,
        r#"CREATE TABLE IF NOT EXISTS sleep (
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
  )"#,
        r#"CREATE TABLE IF NOT EXISTS sleep_stages (
    user_id VARCHAR(64) NOT NULL,
    sleep_log_id BIGINT NOT NULL,
    ts DATETIME NOT NULL,
    stage VARCHAR(16) NOT NULL,
    duration_seconds INT NOT NULL,
    PRIMARY KEY (user_id, sleep_log_id, ts)
  )"#,
        r#"CREATE TABLE IF NOT EXISTS body (
    user_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL,
    weight_kg DECIMAL(5,2),
    bmi DECIMAL(4,1),
    body_fat_pct DECIMAL(4,1),
    PRIMARY KEY (user_id, date)
  )"#,
        r#"CREATE TABLE IF NOT EXISTS spo2_daily (
    user_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL,
    avg_value DECIMAL(4,1),
    min_value DECIMAL(4,1),
    max_value DECIMAL(4,1),
    PRIMARY KEY (user_id, date)
  )"#,
        r#"CREATE TABLE IF NOT EXISTS spo2_intraday (
    user_id VARCHAR(64) NOT NULL,
    ts DATETIME NOT NULL,
    value DECIMAL(4,1) NOT NULL,
    PRIMARY KEY (user_id, ts)
  )"#,
        r#"CREATE TABLE IF NOT EXISTS hrv_daily (
    user_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL,
    daily_rmssd DECIMAL(8,2),
    deep_rmssd DECIMAL(8,2),
    PRIMARY KEY (user_id, date)
  )"#,
        r#"CREATE TABLE IF NOT EXISTS breathing_rate (
    user_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL,
    full_sleep_rate DECIMAL(4,1),
    deep_sleep_rate DECIMAL(4,1),
    light_sleep_rate DECIMAL(4,1),
    rem_sleep_rate DECIMAL(4,1),
    PRIMARY KEY (user_id, date)
  )"#,
        r#"CREATE TABLE IF NOT EXISTS skin_temperature (
    user_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL,
    relative_deviation DECIMAL(4,2),
    PRIMARY KEY (user_id, date)
  )"#,
        r#"CREATE TABLE IF NOT EXISTS cardio_fitness (
    user_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL,
    vo2_max DECIMAL(4,1),
    PRIMARY KEY (user_id, date)
  )"#,
        r#"CREATE TABLE IF NOT EXISTS devices (
    user_id VARCHAR(64) NOT NULL,
    device_id VARCHAR(64) NOT NULL,
    device_version VARCHAR(64),
    type VARCHAR(32),
    battery VARCHAR(16),
    last_sync_time DATETIME,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, device_id)
  )"#,
        r#"CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    display_name VARCHAR(128) NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_sessions_expires (expires_at)
  )"#,
        r#"CREATE TABLE IF NOT EXISTS nc_tokens (
    user_id VARCHAR(64) PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )"#,
        r#"CREATE TABLE IF NOT EXISTS osm_cache (
    query_type VARCHAR(32) NOT NULL,
    lat_rounded DECIMAL(7,4) NOT NULL,
    lon_rounded DECIMAL(7,4) NOT NULL,
    result LONGTEXT NOT NULL,
    cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (query_type, lat_rounded, lon_rounded)
  )"#,
        r#"CREATE TABLE IF NOT EXISTS focus_places (
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
  )"#,
        r#"ALTER TABLE focus_places ADD COLUMN IF NOT EXISTS display_name VARCHAR(64) NULL"#,
        r#"ALTER TABLE focus_places ADD COLUMN IF NOT EXISTS sleep_hours INT NULL"#,
        r#"CREATE TABLE IF NOT EXISTS steps_intraday (
    user_id VARCHAR(64) NOT NULL,
    ts DATETIME NOT NULL,
    steps SMALLINT NOT NULL,
    PRIMARY KEY (user_id, ts)
  )"#,
        r#"ALTER TABLE steps_intraday      ADD COLUMN IF NOT EXISTS tz VARCHAR(64) NULL"#,
        r#"ALTER TABLE heart_rate_intraday ADD COLUMN IF NOT EXISTS tz VARCHAR(64) NULL"#,
        r#"ALTER TABLE sleep_stages        ADD COLUMN IF NOT EXISTS tz VARCHAR(64) NULL"#,
        r#"CREATE TABLE IF NOT EXISTS mode_biometrics (
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
  )"#,
        r#"ALTER TABLE focus_places ADD COLUMN IF NOT EXISTS amenity_label VARCHAR(128) NULL"#,
        r#"ALTER TABLE nc_tokens ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active'"#,
        r#"ALTER TABLE tokens ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active'"#,
        r#"CREATE TABLE IF NOT EXISTS osm_coverage (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    min_lat DECIMAL(9,6) NOT NULL,
    max_lat DECIMAL(9,6) NOT NULL,
    min_lon DECIMAL(9,6) NOT NULL,
    max_lon DECIMAL(9,6) NOT NULL,
    feature_type VARCHAR(32) NOT NULL,
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_bbox (feature_type, min_lat, max_lat, min_lon, max_lon)
  )"#,
        r#"CREATE TABLE IF NOT EXISTS osm_features (
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
  )"#,
        r#"DROP TABLE IF EXISTS osm_features"#,
        r#"CREATE TABLE IF NOT EXISTS osm_points (
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
  )"#,
        r#"CREATE TABLE IF NOT EXISTS osm_lines (
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
  )"#,
        r#"DELETE FROM osm_coverage"#,
        r#"ALTER TABLE sleep ADD COLUMN IF NOT EXISTS tz VARCHAR(64) NULL"#,
        r#"DELETE ss FROM sleep_stages ss
   JOIN sleep s ON ss.user_id = s.user_id AND ss.sleep_log_id = s.log_id
   JOIN (
     SELECT user_id, start_time, is_main_sleep, MIN(log_id) AS keep_id
     FROM sleep
     GROUP BY user_id, start_time, is_main_sleep
     HAVING COUNT(*) > 1
   ) dup ON dup.user_id = s.user_id AND dup.start_time = s.start_time AND dup.is_main_sleep = s.is_main_sleep
   WHERE s.log_id <> dup.keep_id"#,
        r#"DELETE s FROM sleep s
   JOIN (
     SELECT user_id, start_time, is_main_sleep, MIN(log_id) AS keep_id
     FROM sleep
     GROUP BY user_id, start_time, is_main_sleep
     HAVING COUNT(*) > 1
   ) dup ON dup.user_id = s.user_id AND dup.start_time = s.start_time AND dup.is_main_sleep = s.is_main_sleep
   WHERE s.log_id <> dup.keep_id"#,
        r#"ALTER TABLE sleep ADD UNIQUE INDEX IF NOT EXISTS uniq_sleep_user_start_main (user_id, start_time, is_main_sleep)"#,
        r#"CREATE TABLE IF NOT EXISTS nc_credentials (
    user_id VARCHAR(64) NOT NULL PRIMARY KEY,
    login_name VARCHAR(255) NOT NULL,
    app_password TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )"#,
        r#"CREATE TABLE IF NOT EXISTS share_tokens (
    user_id VARCHAR(64) NOT NULL PRIMARY KEY,
    token VARCHAR(64) NOT NULL,
    days_back INT NOT NULL DEFAULT 7,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_accessed_at TIMESTAMP NULL,
    UNIQUE KEY uniq_share_token (token)
  )"#,
        r#"ALTER TABLE heart_rate_intraday
     ADD COLUMN IF NOT EXISTS ts_utc DATETIME NULL,
     ADD COLUMN IF NOT EXISTS tz_source VARCHAR(32) NULL"#,
        r#"ALTER TABLE steps_intraday
     ADD COLUMN IF NOT EXISTS ts_utc DATETIME NULL,
     ADD COLUMN IF NOT EXISTS tz_source VARCHAR(32) NULL"#,
        r#"ALTER TABLE sleep_stages
     ADD COLUMN IF NOT EXISTS ts_utc DATETIME NULL,
     ADD COLUMN IF NOT EXISTS tz_source VARCHAR(32) NULL"#,
        r#"ALTER TABLE sleep
     ADD COLUMN IF NOT EXISTS start_time_utc DATETIME NULL,
     ADD COLUMN IF NOT EXISTS end_time_utc   DATETIME NULL,
     ADD COLUMN IF NOT EXISTS tz_source VARCHAR(32) NULL"#,
        r#"ALTER TABLE heart_rate_intraday ADD INDEX IF NOT EXISTS idx_hri_user_ts_utc (user_id, ts_utc)"#,
        r#"ALTER TABLE steps_intraday      ADD INDEX IF NOT EXISTS idx_si_user_ts_utc  (user_id, ts_utc)"#,
        r#"ALTER TABLE sleep_stages        ADD INDEX IF NOT EXISTS idx_sst_user_ts_utc (user_id, ts_utc)"#,
        r#"CREATE TABLE IF NOT EXISTS osm_way_routes (
    osm_way_id BIGINT NOT NULL,
    route_name VARCHAR(255) NOT NULL,
    route_type VARCHAR(32) NOT NULL,
    PRIMARY KEY (osm_way_id, route_name),
    INDEX idx_route_name (route_name)
  )"#,
        r#"CREATE TABLE IF NOT EXISTS rail_route_cache (
    route_key VARCHAR(191) NOT NULL,
    geometry_json LONGTEXT NOT NULL,
    computed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (route_key)
  )"#,
        r#"CREATE TABLE IF NOT EXISTS bus_route_cache (
    osm_relation_id BIGINT NOT NULL,
    route_ref VARCHAR(64) NOT NULL,
    route_name VARCHAR(255) NULL,
    stops_json LONGTEXT NOT NULL,
    computed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (osm_relation_id),
    INDEX idx_bus_route_ref (route_ref)
  )"#,
        r#"ALTER TABLE focus_places ADD COLUMN IF NOT EXISTS hour_profile VARCHAR(127) NULL"#,
        r#"ALTER TABLE osm_lines ADD INDEX IF NOT EXISTS idx_osm_lines_name (name)"#,
        r#"CREATE TABLE IF NOT EXISTS decoded_days (
    user_id            VARCHAR(64) NOT NULL,
    date               DATE NOT NULL,
    classifier_version INT NOT NULL,
    segments_json      MEDIUMTEXT NOT NULL,
    decoded_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, date),
    INDEX idx_user_version (user_id, classifier_version)
  )"#,
        r#"CREATE TABLE IF NOT EXISTS learned_hmm_models (
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
  )"#,
        r#"CREATE TABLE IF NOT EXISTS presence_log (
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
  )"#,
        r#"CREATE TABLE IF NOT EXISTS venue_type_priors (
    user_id     VARCHAR(64) NOT NULL,
    priors_json MEDIUMTEXT NOT NULL,
    mined_stays INT NOT NULL,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id)
  )"#,
        r#"CREATE TABLE IF NOT EXISTS hrv_intraday (
    user_id VARCHAR(64) NOT NULL,
    ts DATETIME NOT NULL,
    rmssd DECIMAL(8,3) NOT NULL,
    coverage DECIMAL(5,3),
    hf DECIMAL(12,4),
    lf DECIMAL(12,4),
    PRIMARY KEY (user_id, ts)
  )"#,
        r#"ALTER TABLE devices ADD COLUMN battery_level TINYINT UNSIGNED NULL"#,
        r#"CREATE TABLE IF NOT EXISTS device_battery_log (
    user_id        VARCHAR(64) NOT NULL,
    device_id      VARCHAR(64) NOT NULL,
    last_sync_time DATETIME NOT NULL,
    battery_level  TINYINT UNSIGNED NOT NULL,
    device_version VARCHAR(64),
    recorded_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, device_id, last_sync_time)
  )"#,
        r#"CREATE TABLE IF NOT EXISTS motion_log (
    user_id     VARCHAR(64) NOT NULL,
    ts          INT UNSIGNED NOT NULL,
    lat         DOUBLE NOT NULL,
    lon         DOUBLE NOT NULL,
    cog         SMALLINT,
    vel         SMALLINT,
    acc         SMALLINT,
    recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, ts)
  )"#,
        r#"ALTER TABLE focus_places ADD COLUMN IF NOT EXISTS amenity_kind VARCHAR(64) NULL"#,
        r#"CREATE TABLE IF NOT EXISTS place_confirmations (
      id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id     VARCHAR(64)  NOT NULL,
      lat         DECIMAL(9,6) NOT NULL,
      lon         DECIMAL(9,6) NOT NULL,
      radius_m    INT          NOT NULL DEFAULT 40,
      label       VARCHAR(128) NOT NULL,
      created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"#,
        r#"DROP TABLE IF EXISTS place_confirmations"#,
        r#"CREATE TABLE IF NOT EXISTS rail_stops_cache (
    osm_relation_id BIGINT NOT NULL,
    route_type VARCHAR(32) NOT NULL,
    line_ref VARCHAR(64) NULL,
    line_name VARCHAR(255) NULL,
    stops_json LONGTEXT NOT NULL,
    computed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (osm_relation_id)
  )"#,
        r#"ALTER TABLE bus_route_cache ADD COLUMN IF NOT EXISTS tile_key VARCHAR(32) NULL"#,
        r#"ALTER TABLE bus_route_cache ADD INDEX IF NOT EXISTS idx_bus_route_tile (tile_key)"#,
        // Rail gets the tile ownership bus has: without it the rail mirror
        // rewrites the whole table, and a partial run drops every relation in
        // a tile that failed while the summary reads like a healthy refresh.
        r#"ALTER TABLE rail_stops_cache ADD COLUMN IF NOT EXISTS tile_key VARCHAR(32) NULL"#,
        r#"ALTER TABLE rail_stops_cache ADD INDEX IF NOT EXISTS idx_rail_stops_tile (tile_key)"#,
        // ⚠ `is_main_sleep` does not belong in an identity key. Google writes a
        // session in progress with no `metadata/mainSleep` (read as `false`),
        // and once scored the revision no longer matches its row, so it can
        // only insert a contradictory twin. One person cannot begin two sleeps
        // at the same instant, so the start instant is the identity. The
        // collapse below is a guard; production had no duplicate starts.
        //
        // ⚠ Versions 69-72 are burned. These four sleep statements were first
        // inserted mid-array, so a database recorded 69-72 without applying
        // them (re-running four idempotent `IF NOT EXISTS` statements instead).
        // The placeholders consume those numbers so the real statements get
        // fresh versions; `schema_migrations` is not edited by hand. Append
        // below them, never above.
        r#"DO 0"#,
        r#"DO 0"#,
        r#"DO 0"#,
        r#"DO 0"#,
        r#"DELETE ss FROM sleep_stages ss
   JOIN sleep s ON ss.user_id = s.user_id AND ss.sleep_log_id = s.log_id
   JOIN (
     SELECT user_id, start_time, MIN(log_id) AS keep_id
     FROM sleep
     GROUP BY user_id, start_time
     HAVING COUNT(*) > 1
   ) dup ON dup.user_id = s.user_id AND dup.start_time = s.start_time
   WHERE s.log_id <> dup.keep_id"#,
        r#"DELETE s FROM sleep s
   JOIN (
     SELECT user_id, start_time, MIN(log_id) AS keep_id
     FROM sleep
     GROUP BY user_id, start_time
     HAVING COUNT(*) > 1
   ) dup ON dup.user_id = s.user_id AND dup.start_time = s.start_time
   WHERE s.log_id <> dup.keep_id"#,
        r#"ALTER TABLE sleep ADD UNIQUE INDEX IF NOT EXISTS uniq_sleep_user_start (user_id, start_time)"#,
        r#"ALTER TABLE sleep DROP INDEX IF EXISTS uniq_sleep_user_start_main"#,
        // ⚠ A deliberate repeat of index 76; do not tidy it away. Databases
        // that ran an earlier build recorded version 77 without applying what
        // now sits there, so this must live at 78. `IF EXISTS` makes it safe on
        // a fresh database.
        r#"ALTER TABLE sleep DROP INDEX IF EXISTS uniq_sleep_user_start_main"#,
        // The mined prior as it stood at an anchor date, so a past day is named
        // from what was known then.
        //
        // A separate table, not a column on `venue_type_priors`: it wants a
        // different primary key, and an additive table leaves the old row and
        // its read path untouched for a pod predating it.
        //
        // `as_of` is a DATE: the day the mining window ended, the grain a
        // day-level read asks for. A timestamp would allow two snapshots a day
        // with no rule for which one the day means.
        //
        // Mining re-clusters from scratch, so re-running it changes what past
        // days were called even with no new evidence; freezing each run keeps
        // a past label stable.
        r#"CREATE TABLE IF NOT EXISTS venue_type_prior_snapshots (
    user_id     VARCHAR(64) NOT NULL,
    as_of       DATE NOT NULL,
    priors_json MEDIUMTEXT NOT NULL,
    mined_stays INT NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, as_of)
  )"#,
        // ⚠ Append only; see the header.
        //
        // What the serving path could not answer, so a job can fetch it later.
        // The fold declines rather than guesses, and without a record the same
        // coordinate went unanswered on every fold.
        //
        // `kind` is `osm_cache.query_type` for the geocode kinds
        // (`nominatim_z16`, `nominatim_z18`): the drain writes straight back
        // into the cache the fold reads, in one vocabulary.
        //
        // `attempts` and `last_error` let a key that cannot be fetched stop
        // being retried while staying visible; deleting it would bring it back
        // on the next fold, an invisible loop against a rate-limited service.
        r#"CREATE TABLE IF NOT EXISTS osm_fetch_queue (
    kind        VARCHAR(32) NOT NULL,
    fetch_key   VARCHAR(160) NOT NULL,
    asked_count INT NOT NULL DEFAULT 1,
    attempts    INT NOT NULL DEFAULT 0,
    last_error  VARCHAR(255) NULL,
    first_seen  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (kind, fetch_key),
    INDEX idx_ofq_due (kind, attempts, last_seen)
  )"#,
        // The OwnTracks proxy's decision, one row per POST; pod stdout does not
        // survive a rollout. No coordinates here (those are `motion_log`'s):
        // this is what the phone reported and what it was told.
        r#"CREATE TABLE IF NOT EXISTS owntracks_decisions (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id      VARCHAR(64) NOT NULL,
    ts           INT UNSIGNED NOT NULL,
    fixes        SMALLINT NOT NULL,
    local_hour   TINYINT NULL,
    phone_mode   TINYINT NULL,
    prev_profile VARCHAR(16) NULL,
    profile      VARCHAR(16) NOT NULL,
    monitoring   TINYINT NOT NULL,
    interval_s   INT NULL,
    recorded_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_od_user_ts (user_id, ts)
  )"#,
        // The battery reading's instant, when the source gives one: Google's
        // `pairedDevices` does (UTC), Fitbit's devices.json gave only the
        // watch's wall clock. The reader prefers it.
        r#"ALTER TABLE device_battery_log ADD COLUMN IF NOT EXISTS ts_utc DATETIME NULL"#,
        // A named `building=hotel` is a venue (`Landmarks.VENUE_BUILDINGS`):
        // rows fetched before that rule move to the landmark bucket, as a
        // refetch would put them.
        r#"UPDATE osm_lines SET feature_type = 'landmark'
   WHERE feature_type = 'building' AND subtype = 'hotel' AND name IS NOT NULL"#,
        r#"UPDATE osm_points SET feature_type = 'landmark'
   WHERE feature_type = 'building' AND subtype = 'hotel' AND name IS NOT NULL"#,
        // SpO2 readings carry their instant, as steps and heart rate do: a
        // reading served under two offsets is one reading.
        r#"ALTER TABLE spo2_intraday ADD COLUMN IF NOT EXISTS ts_utc DATETIME NULL"#,
        // Recorded workouts from Google: typed summary plus the whole point in
        // `raw`, keyed by Google's point id.
        r#"CREATE TABLE IF NOT EXISTS exercise_sessions (
    user_id       VARCHAR(64) NOT NULL,
    point_id      VARCHAR(32) NOT NULL,
    platform      VARCHAR(32) NULL,
    source        VARCHAR(128) NULL,
    exercise_type VARCHAR(48) NULL,
    display_name  VARCHAR(128) NULL,
    start_utc     DATETIME NOT NULL,
    end_utc       DATETIME NOT NULL,
    start_ts      DATETIME NOT NULL,
    end_ts        DATETIME NOT NULL,
    active_s      INT NULL,
    steps         INT NULL,
    distance_m    DOUBLE NULL,
    calories_kcal DOUBLE NULL,
    avg_hr        DOUBLE NULL,
    has_gps       TINYINT(1) NULL,
    update_time   VARCHAR(40) NULL,
    raw           JSON NOT NULL,
    PRIMARY KEY (user_id, point_id),
    INDEX idx_exercise_start (user_id, start_utc)
  )"#,
        // The raw archive of every Google type with no table of its own: time
        // in columns, the rest of the point in `payload`.
        r#"CREATE TABLE IF NOT EXISTS google_points (
    user_id        VARCHAR(64) NOT NULL,
    data_type      VARCHAR(48) NOT NULL,
    start_utc      DATETIME(3) NOT NULL,
    end_utc        DATETIME(3) NULL,
    start_ts       DATETIME(3) NULL,
    start_offset_s INT NULL,
    end_offset_s   INT NULL,
    source         VARCHAR(160) NOT NULL,
    payload        JSON NOT NULL,
    PRIMARY KEY (user_id, data_type, start_utc, source)
  )"#,
        // Up to three points per minute from ONE source, differing (mid-2024
        // activity-level): the key gains their number (`archive::number_points`).
        r#"ALTER TABLE google_points ADD COLUMN IF NOT EXISTS seq SMALLINT NOT NULL DEFAULT 0,
   DROP PRIMARY KEY, ADD PRIMARY KEY (user_id, data_type, start_utc, source, seq)"#,
        // ⚠ A repeat of 87, on purpose. The exercise_routes CREATE below was
        // once inserted at 87, so production skipped it and recorded this
        // ALTER as 88. A fresh database runs it twice, harmlessly.
        r#"ALTER TABLE google_points ADD COLUMN IF NOT EXISTS seq SMALLINT NOT NULL DEFAULT 0,
   DROP PRIMARY KEY, ADD PRIMARY KEY (user_id, data_type, start_utc, source, seq)"#,
        // The GPS track of a recorded workout, as Google's TCX export, one row
        // per session asked. A refusal keeps its status with a NULL document,
        // so a session is asked once.
        r#"CREATE TABLE IF NOT EXISTS exercise_routes (
    user_id     VARCHAR(64) NOT NULL,
    point_id    VARCHAR(32) NOT NULL,
    fetched_at  DATETIME NOT NULL,
    http_status SMALLINT NOT NULL,
    bytes       INT NOT NULL DEFAULT 0,
    trackpoints INT NULL,
    positions   INT NULL,
    tcx         MEDIUMTEXT NULL,
    PRIMARY KEY (user_id, point_id)
  )"#,
        // A landmark box remembers the venue-tag vocabulary it was fetched
        // under (`osm_mirror::venue_vocab`): a box fetched before a tag joined
        // has none of that tag's features, and counting it as coverage would
        // keep them out for 180 days. A read under another vocabulary does not
        // see it.
        r#"ALTER TABLE osm_coverage ADD COLUMN IF NOT EXISTS vocab VARCHAR(16) NULL"#,
        // A walk's drawn result, keyed by a hash of every input the drawing
        // reads and by the code that drew it (`walk_memo`). Rows of another
        // code version are cleared when a server starts.
        r#"CREATE TABLE IF NOT EXISTS walk_memo (
    code_version CHAR(32) NOT NULL,
    memo_key CHAR(32) NOT NULL,
    value MEDIUMTEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (code_version, memo_key)
  )"#,
        // What a share link shows beyond the health tables. On by default, so
        // every link issued before this keeps showing what it showed.
        r#"ALTER TABLE share_tokens
     ADD COLUMN IF NOT EXISTS share_location BOOLEAN NOT NULL DEFAULT TRUE"#,
        // `stationsOnLine` reads every distinct railway line name once per fold
        // (`MirrorSource::rail_line_names`); a composite index serves it from
        // the index alone instead of a row scan.
        r#"ALTER TABLE osm_lines ADD INDEX IF NOT EXISTS idx_osm_lines_type_name (feature_type, name)"#,
        // When each tile of a route mirror last answered (`cli::mirror`): a
        // refresh fetches only the tiles that are due. Its own table because a
        // tile can answer and own no rows — a relation crossing several tiles
        // is stored under one of them.
        r#"CREATE TABLE IF NOT EXISTS osm_mirror_tile (
    mode VARCHAR(8) NOT NULL,
    tile_key VARCHAR(32) NOT NULL,
    refreshed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (mode, tile_key)
  )"#,
        // Seeded from the rows already held, so the first incremental run does
        // not re-fetch tiles that are fresh.
        r#"INSERT IGNORE INTO osm_mirror_tile (mode, tile_key, refreshed_at)
     SELECT 'rail', tile_key, MAX(computed_at) FROM rail_stops_cache
     WHERE tile_key IS NOT NULL GROUP BY tile_key"#,
        r#"INSERT IGNORE INTO osm_mirror_tile (mode, tile_key, refreshed_at)
     SELECT 'bus', tile_key, MAX(computed_at) FROM bus_route_cache
     WHERE tile_key IS NOT NULL GROUP BY tile_key"#,
        // What a decode's inputs were complete through (`decode_freshness`): a
        // decode is stale once they reach further. NULL on the rows written
        // before it, which read as stale and are decoded again once.
        r#"ALTER TABLE decoded_days ADD COLUMN IF NOT EXISTS inputs_through BIGINT NULL"#,
        // The Fitbit Web API is closed and its client is gone; nothing reads
        // the per-user token table or the device roster it kept (the watch's
        // battery is `device_battery_log`, written from Google). Dropped on
        // his word, a dump taken first.
        r#"DROP TABLE IF EXISTS tokens"#,
        r#"DROP TABLE IF EXISTS devices"#,
    ];

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    )
    .execute(pool)
    .await
    .context("creating schema_migrations")?;

    let applied: Vec<i64> = sqlx::query_scalar("SELECT version FROM schema_migrations")
        .fetch_all(pool)
        .await
        .context("reading applied migrations")?;

    let mut ran = 0usize;
    let mut version: i64 = -1;
    // ⚠ A plain `for` over the literal array, so `DL-SQLX-SCHEMA-TRUTH` can
    // resolve every statement; `.iter().enumerate()` defeats it, so the index
    // is counted here.
    for stmt in migrations {
        version += 1;
        if applied.contains(&version) {
            continue;
        }
        // ⚠ Statement first, record second. The other order marks a migration
        // applied that then failed, and nothing would ever retry it.
        sqlx::query(stmt)
            .execute(pool)
            .await
            .with_context(|| format!("applying migration {version}"))?;
        sqlx::query("INSERT INTO schema_migrations (version) VALUES (?)")
            .bind(version)
            .execute(pool)
            .await
            .with_context(|| format!("recording migration {version}"))?;
        ran += 1;
    }

    if ran > 0 {
        tracing::info!(
            ran,
            already = applied.len(),
            total = migrations.len(),
            "applied migration(s)"
        );
    } else {
        tracing::info!(total = migrations.len(), "schema is up to date");
    }
    Ok(())
}

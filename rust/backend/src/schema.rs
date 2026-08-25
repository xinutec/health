//! The schema, applied at startup (#982).
//!
//! ⚠ THE ARRAY INDEX IS THE VERSION NUMBER. `schema_migrations` records which
//! indices have run, so INSERTING a statement anywhere but the end renumbers
//! every migration after it: already-applied ones look unapplied and re-run,
//! and the new one is recorded under a version that already exists. APPEND
//! ONLY, forever.
//!
//! ⚠ Transcribed from `src/db/schema.ts` MECHANICALLY — its template literals
//! extracted in order, with a check that nothing but commas sat between them.
//! A hand copy of 67 statements is a transcription error waiting to happen, and
//! the failure would be a column that quietly exists in one implementation and
//! not the other.
//!
//! ⚠ The extraction had to strip `//` comments FIRST. Several of them contain
//! backticks (`ALTER TABLE …`), and a naive scan for backtick pairs split
//! across comment text and produced 101 "statements" instead of 67. The gap
//! check is what caught it; without one the generated file would have been
//! confidently wrong.
//!
//! ⚠ MariaDB DDL is NOT transactional, so a half-applied statement stays
//! half-applied. The advisory lock is what stops two pods racing during a
//! rolling deploy and each applying half of one.

use anyhow::{Context, Result};
use sqlx::MySqlPool;

/// Apply anything not yet recorded in `schema_migrations`.
pub async fn migrate(pool: &MySqlPool) -> Result<()> {
    // ⚠ An advisory lock, because MariaDB DDL is non-transactional and a
    // rolling deploy can put two pods here at once. Today there is one replica
    // and sync is a separate cron, so this is insurance rather than a fix — but
    // it is cheap and the failure it prevents is a half-applied schema.
    // ⚠ ONE PINNED CONNECTION for the whole lock lifetime. `GET_LOCK` and
    // `RELEASE_LOCK` are PER-CONNECTION in MariaDB, and running them as two
    // pool queries can take the lock on connection A and release it on
    // connection B — where the release is a silent no-op returning NULL, and A
    // holds `health_migrate` for as long as it stays in the pool. That is
    // FOREVER for a server process.
    //
    // Measured in production 2026-08-23: the Rust backend served fine, and the
    // node pod behind it could not start — "could not acquire the migration
    // lock within 30s" — because this process was still holding it. The
    // rollback deadlocked (node would not start until Rust exited, Rust would
    // not be terminated until node was ready) and needed manual intervention.
    //
    // `src/db/schema.ts` gets this right with `withConnection`; this did not.
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

    // ⚠ Released even when a migration FAILED. Holding it would block every
    // later pod from trying, turning one bad statement into a stuck deployment.
    //
    // ⚠ And a FAILED RELEASE IS LOUD. This used to be `.unwrap_or(None)`, which
    // is how the defect above stayed invisible: the release ran on the wrong
    // connection, returned NULL, and was discarded. A lock this process still
    // holds is not a detail to swallow.
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
    // ⚠ A fn-local literal array, NOT a module const. `DL-SQLX-SCHEMA-TRUTH`
    // resolves an inline or fn-local array and replays it as the schema —
    // which is what lets it type-check every other query in this crate against
    // the real columns. It found two genuine unsigned-decode bugs the moment
    // this file existed. A const path is opaque to it.
    //
    // ⚠ Oldest first, and the INDEX IS THE VERSION. Append only.
    let migrations: [&str; 69] = [
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
        // ⚠ RAIL GETS THE SAME TILE OWNERSHIP BUS HAS HAD, 2026-08-25. Without
        // it the rail mirror DELETEs the whole table and rewrites what it
        // found, so a partial run drops every relation living only in a tile
        // that failed — measured that day at 10 of 18 tiles, 441 relations
        // found against 268 cached. The count going UP is what makes it
        // invisible: the summary reads like a healthy refresh that found MORE
        // data (#1134, #1153).
        r#"ALTER TABLE rail_stops_cache ADD COLUMN IF NOT EXISTS tile_key VARCHAR(32) NULL"#,
        r#"ALTER TABLE rail_stops_cache ADD INDEX IF NOT EXISTS idx_rail_stops_tile (tile_key)"#,
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
    // ⚠ A plain `for` over the const literal array, so `DL-SQLX-SCHEMA-TRUTH`
    // can resolve every statement and replay the schema. That replay is what
    // lets it type-check every OTHER query in this crate against the real
    // columns — it found two genuine unsigned-decode bugs the moment this file
    // existed. `.iter().enumerate()` defeated it, so the index is counted here
    // instead.
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

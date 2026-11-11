//! The backend entrypoint.
//!
//! `backend <subcommand>` — `backend --help` for the list (`argv.rs`). The dispatch is
//! here; what each subcommand does lives under `cli/`, grouped by what it
//! touches. The three that carry production:
//!
//!   check  — read the config, open the pool, and prove both against the real
//!            database. READ-ONLY, so it is safe to point at production.
//!   sync   — the Google Health ingestion: weight, then every stream of the
//!            roster, for the one user the Google account belongs to.
//!   serve  — the HTTP server. THE server: `health-auth` runs this and nothing
//!            else does.
//!
//! ⚠ `sync` logs every stream's outcome and FAILS SOFT per stream: one
//! unreachable endpoint must not stop the rest. So a run can exit 0 having
//! written no rows, and `backend freshness` asks the outcome question
//! instead, on its own schedule.

use anyhow::{Context, Result};
use backend::{
    classification_inputs, config::Config, db, lean, routes, state::AppState, sync_state,
};

mod cli;
use cli::census::*;
use cli::day::*;
use cli::decode::*;
use cli::mirror::*;
use cli::refresh::*;
use cli::session::*;

#[tokio::main]
async fn main() -> Result<()> {
    // ⚠ First, and fatal if it fails: the rate-limit policy and the backfill
    // cursor arithmetic live in Lean, and a sync that cannot decide would spend
    // an unchecked budget and walk an unbounded cursor.
    lean::init().context("starting the Lean runtime")?;

    use backend::argv::Command as C;
    match backend::argv::parse().command {
        C::Check => check().await,
        C::Serve => serve().await,
        // ⚠ An unrecognised flag is refused (clap), never ignored: this one
        // selects whether durable backfill state is written.
        C::Sync => sync().await,
        // ⚠ The tz is the DISPLAY tz and it is a separate thing from `home_tz`:
        // it bounds the local day, and a fixture captured for a trip abroad
        // carries the zone the day was LIVED in, not the one the profile stores.
        C::Inputs(d) => inputs(&d.user, &d.date, d.display_tz.as_deref()).await,
        // Reads a golden fixture rather than the database on purpose: the head's
        // oracle is the frozen capture in the same file as its `inputs`.
        C::Head { fixture } => head(&fixture),
        C::Day { fixture } => day(&fixture),
        // The CLI can ask for the raw arm: `?walkMatch=0` is the map's A/B
        // baseline.
        C::Velocity {
            day: d,
            no_walk_match,
        } => velocity(&d.user, &d.date, d.display_tz.as_deref(), !no_walk_match).await,
        C::LocationsCheck { user, date } => locations_check(&user, &date).await,
        C::MintSession { user } => mint_session(&user).await,
        C::DropSession { cookie } => drop_session(&cookie).await,
        // The CronJob passes `90`; the default of 30 is part of the contract for
        // anyone running it by hand.
        C::RefreshPresenceLog { lookback_days } => {
            // `DbConfig::from_env`, not `Config::from_env`: this touches only
            // the database.
            let dbcfg =
                backend::config::DbConfig::from_env().context("reading database configuration")?;
            let pool = db::connect(&dbcfg.url())
                .await
                .context("connecting to the database")?;
            let r = refresh_presence_log(&pool, lookback_days, None).await;
            pool.close().await;
            r
        }
        // The weekly place miner. `--places-out`/`--dry` are measurement flags,
        // single user only (the file is per-user).
        C::RefreshFocusPlaces {
            user,
            lookback_days,
            dry,
            places_out,
            as_of,
        } => {
            let sinks = MineSinks {
                dry,
                places_out,
                // End of that civil day in UTC, so the day itself is inside the
                // window rather than cut off at its start.
                as_of: as_of.map(|d| {
                    d.and_hms_opt(23, 59, 59)
                        .expect("23:59:59 is a time")
                        .and_utc()
                }),
            };
            // `DbConfig::from_env`, not `Config::from_env`: the Nextcloud
            // credentials come from the database.
            let dbcfg =
                backend::config::DbConfig::from_env().context("reading database configuration")?;
            let pool = db::connect(&dbcfg.url())
                .await
                .context("connecting to the database")?;
            let r = refresh_focus_places(
                &pool,
                user.as_deref(),
                lookback_days.unwrap_or(FOCUS_DEFAULT_LOOKBACK_DAYS),
                &sinks,
            )
            .await;
            pool.close().await;
            r
        }
        C::RefreshRailRoutes { window_days } => {
            refresh_rail_routes(window_days.unwrap_or(RAIL_DEFAULT_WINDOW_DAYS)).await
        }
        // The nightly HSMM decoder.
        //
        // The date is positional: a numeric second argument is a day count,
        // anything else a date.
        //
        // ⚠ `--dry-run` decodes and prints, writing nothing; the write
        // overwrites `(user_id, date)`, so a checking run would destroy the
        // row it checks against.
        C::DecodeDay {
            user,
            when,
            dry_run,
        } => {
            let (dates, days) = match when {
                None => (Vec::new(), None),
                Some(w) => match w.parse::<i64>() {
                    Ok(n) => (Vec::new(), Some(n)),
                    Err(_) => (vec![w], None),
                },
            };
            decode_day(user.as_deref(), &dates, days, dry_run).await
        }
        // The serving path records what it could not geocode; this fetches it.
        // Never inline.
        C::FetchGeocodes { dry_run, limit } => fetch_geocodes(dry_run, limit).await,
        // The Overpass half of the same queue. Its default limit is lower than
        // the geocode drain's: ~5 MB requests against a two-slot public
        // endpoint, and one box usually clears many keys.
        C::FetchOsm {
            dry_run,
            limit,
            kind,
        } => fetch_osm(dry_run, limit, kind.as_deref()).await,
        // Both halves, continuously, beside the serving pod: what a fold
        // declined, and the ground around fixes as they arrive.
        C::WatchFetchQueue { interval_s } => watch_fetch_queue(interval_s).await,
        // The decodes, continuously, beside the serving pod: what a read
        // found stale, then the newest stale day held; one process per day.
        C::WatchDecodeQueue {
            interval_s,
            window_days,
        } => watch_decode_queue(interval_s, window_days).await,
        // Several days in one process, so the arena's high-water is visible;
        // `velocity` restarts the process each time.
        C::VelocityMany { user, dates } => velocity_many(&user, &dates).await,
        C::RefreshRailStops { dry_run } => refresh_rail_stops(dry_run).await,
        C::RefreshBusRoutes { dry_run } => refresh_bus_routes(dry_run).await,
        C::RowsCheck { user, since, date } => {
            let cfg = Config::from_env().context("reading configuration")?;
            let pool = db::connect(&cfg.db.url())
                .await
                .context("connecting to the database")?;
            let r = backend::rows_check::run(&pool, &user, &since, &date).await;
            pool.close().await;
            r
        }
        // The decision line, surviving the pod.
        C::OwntracksLog { user, limit } => owntracks_log(&user, limit).await,
        C::GoogleProbe => backend::google::probe::run().await,
        C::Coverage => coverage().await,
        // The case file's heart-rate pages read these through prod-db.sh.
        C::RestHr {
            json,
            user,
            since,
            until,
        } => rest_hr(&user, &since, until.as_deref(), json).await,
        C::HrTrend {
            json,
            since,
            averages,
        } => match averages.as_deref() {
            Some([from, boundary]) => hr_trend_averages(from, boundary).await,
            _ => hr_trend(since.as_deref().unwrap_or("2026-06-03"), json).await,
        },
        C::HrvHistory => hrv_history().await,
        C::ZonesCensus => zones_census().await,
        C::VenuePriorSnapshots { user, out_dir } => venue_prior_snapshots(&user, &out_dir).await,
        C::Freshness => freshness().await,
        C::MirrorCheck { fixture } => mirror_check(&fixture).await,
        // The golden-day writer.
        C::CaptureDay {
            user,
            date,
            out,
            display_tz,
        } => capture_day(&user, &date, display_tz.as_deref(), &out).await,
        C::RecaptureWalkable { user, fixture } => recapture_walkable(&user, &fixture).await,
        C::RecaptureAsks { user, fixture } => recapture_asks(&user, &fixture).await,
        // The decoder's cost, apart from its model build.
        C::DecodeBench { runs, days } => decode_bench(runs, &days),
        C::DayLive(d) => day_live(&d.user, &d.date, d.display_tz.as_deref(), false).await,
        C::DayMirror(d) => day_live(&d.user, &d.date, d.display_tz.as_deref(), true).await,
    }
}

/// Run one Google Health ingestion pass: weight, then every stream.
///
/// ⚠ It does not migrate the schema: two processes racing to apply migrations
/// is worse than a missing one, and the server migrates on every start. So
/// this must not be the first thing run against a fresh database.
///
/// The zone lookup is built once: `tzf-rs` decompresses its polygon set on
/// construction, the expensive part, and is then queried per fix.
async fn sync() -> Result<()> {
    cli::init_tracing();

    let cfg = Config::from_env()?;
    let pool = db::connect(&cfg.db.url()).await?;
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .context("building the HTTP client")?;
    backend::google::run::run(&pool, &http).await;
    Ok(())
}

/// Serve the HTTP surface.
///
/// Production's server, answering `health.xinutec.org`. It binds `AUTH_PORT`,
/// which the manifest sets; the 8081 default is for local runs.
async fn serve() -> Result<()> {
    cli::init_tracing();

    let cfg = Config::from_env()?;
    let pool = db::connect(&cfg.db.url()).await?;
    // ⚠ `AUTH_PORT`, not `PORT`: production does not set `PORT`, and binding
    // 8081 would leave a pod healthy from inside while the Service and the
    // readiness probe expect 3000. One name, no fallback spelling.
    let port: u16 = std::env::var("AUTH_PORT")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.parse()
                .with_context(|| format!("AUTH_PORT is not a port number: {s:?}"))
        })
        .transpose()?
        .unwrap_or(8081);

    // Bounded, for the same reason the pool is: a hung Nextcloud or Google must
    // not tie up a pod.
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    // Before serving: errors against a half-applied schema look like data
    // problems.
    backend::schema::migrate(&pool)
        .await
        .context("applying the schema")?;

    // Remembered walks, for this process only. A failure costs speed, not
    // answers: every walk is then drawn.
    if let Err(e) = backend::walk_memo::init(&pool).await {
        tracing::warn!(error = %format!("{e:#}"), "walk memo off");
    }

    // A sweep, because the per-request path deletes a session only when its
    // owner returns with the cookie; dormant accounts would keep rows forever.
    let sweep_pool = pool.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(6 * 60 * 60));
        loop {
            ticker.tick().await;
            let now_ms = chrono::Utc::now().timestamp_millis();
            match backend::auth::session::cleanup_expired(&sweep_pool, now_ms).await {
                // Silent when there was nothing to do: a line every six hours
                // saying "0" trains a reader to skip the line that says 400.
                Ok(0) => {}
                Ok(n) => tracing::info!(swept = n, "expired session(s) removed"),
                Err(e) => tracing::error!(error = %format!("{e:#}"), "session sweep failed"),
            }
        }
    });

    // Today's train rides on a route first ridden today, drawn without waiting
    // for the nightly job (`backend::rail_route`).
    backend::rail_route::start(pool.clone());

    let state = AppState::new(pool, cfg, http);
    // Warm the walk memo a minute after start, once the pod has settled.
    let warm = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        routes::velocity::warm_recent(&warm).await;
    });
    let app = routes::router(state);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .with_context(|| format!("binding port {port}"))?;
    tracing::info!("health backend (rust) listening on {port}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            // SIGTERM is what Kubernetes sends; without this the pod is killed
            // mid-request at the end of the grace period instead of draining.
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("installing SIGTERM handler");
            tokio::select! {
                _ = term.recv() => {}
                _ = tokio::signal::ctrl_c() => {}
            }
            tracing::info!("shutting down");
        })
        .await
        .context("serving")?;
    Ok(())
}

/// Prove the config and the pool against the real database, and read nothing
/// anybody's privacy depends on.
///
/// Nothing in a unit test executes SQL, and compiling says nothing about bind
/// order, credentials, or whether the schema is what the code thinks.
///
/// ⚠ It prints counts, never values: the row and distinct-key counts prove
/// `sync_state` is reachable and decodes, without putting anyone's data on a
/// terminal.
async fn check() -> Result<()> {
    let cfg = Config::from_env().context("reading configuration")?;
    println!(
        "config: db {}:{}/{} user={} nextcloud={}",
        cfg.db.host,
        cfg.db.port,
        cfg.db.database,
        cfg.db.user,
        cfg.nextcloud_base_url.as_deref().unwrap_or("<unset>")
    );

    let pool = db::connect(&cfg.db.url()).await?;

    // The connection itself.
    let one: i64 = sqlx::query_scalar("SELECT 1")
        .fetch_one(&pool)
        .await
        .context("SELECT 1")?;
    println!("db: SELECT 1 -> {one}");

    // That the session zone pin actually took. Asserting it rather than
    // trusting `after_connect` to have run: a pool option that silently did not
    // apply would leave every DB-clock timestamp off by the server's offset,
    // and nothing else in this binary would notice.
    let tz: String = sqlx::query_scalar("SELECT @@session.time_zone")
        .fetch_one(&pool)
        .await
        .context("reading session time_zone")?;
    println!("db: session time_zone = {tz}");
    if tz != "+00:00" {
        anyhow::bail!(
            "session time_zone is {tz:?}, expected \"+00:00\" — the UTC pin did not apply"
        );
    }

    // The cursor table, which is the first thing any scheduled work reads.
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_state")
        .fetch_one(&pool)
        .await
        .context("counting sync_state")?;
    let keys: i64 = sqlx::query_scalar("SELECT COUNT(DISTINCT key_name) FROM sync_state")
        .fetch_one(&pool)
        .await
        .context("counting sync_state keys")?;
    println!("sync_state: {rows} row(s), {keys} distinct key(s)");

    // The typed read path, through the same function scheduled work will use.
    // A key nobody stores, so the answer is a known `None` and this asserts the
    // ABSENT case decodes rather than the present one — the case a wrong column
    // type would still pass.
    let missing = sync_state::get(&pool, "\u{0}no-such-user", "\u{0}no-such-key").await?;
    if missing.is_some() {
        anyhow::bail!("sync_state::get returned a value for a key that cannot exist");
    }
    println!("sync_state: absent-key read decodes as None");

    // The day-input loaders. Counts, not contents: this runs against production
    // and the rows are real places and movement. The point is that the SQL
    // executes: column names, bind order, the decode of every DECIMAL and
    // nullable.
    // dev-lint: allow-pii the one account the service holds
    let user = std::env::var("CHECK_USER").unwrap_or_else(|_| "pippijn".into());
    let places = classification_inputs::known_places(&pool, &user).await?;
    let modes = classification_inputs::mode_biometrics(&pool, &user).await?;
    let rail = classification_inputs::rail_route_cache(&pool).await?;
    // As of NOW, which is every event — and it exercises the `priorsAsOf` round
    // trip rather than stepping around it, which is the point of this check.
    let priors =
        classification_inputs::venue_priors(&pool, &user, chrono::Utc::now().timestamp()).await?;
    let len = |v: &serde_json::Value| v.as_array().map_or(0, Vec::len);
    // ⚠ Values, not just counts. `focus_places.centroid_lat` is DECIMAL, which
    // the driver hands back as a string; rows of 0.0 print the same count as
    // real ones.
    let zero_centroids = places.as_array().map_or(0, |a| {
        a.iter()
            .filter(|p| p["centroidLat"].as_f64() == Some(0.0))
            .count()
    });
    println!(
        "inputs[{user}]: focus_places {} · mode_biometrics {} · rail_route_cache {} · venue_priors {}",
        len(&places),
        len(&modes),
        len(&rail),
        if priors.is_null() {
            "absent"
        } else {
            "present"
        },
    );
    // ⚠ An empty read is not a working read: each of these is populated in
    // production, so empty means the wrong column or user.
    if len(&places) == 0 || len(&modes) == 0 || len(&rail) == 0 {
        anyhow::bail!(
            "a day-input loader came back empty for {user} — production has rows in all three,              so this is a query that ran and found nothing, not an empty database"
        );
    }

    if zero_centroids > 0 {
        anyhow::bail!(
            "{zero_centroids} focus place(s) decoded to centroidLat 0.0 — a DECIMAL that did not \
             decode reads as zero, and null island is not where anyone lives"
        );
    }
    println!(
        "inputs[{user}]: centroids decoded non-zero: {}",
        len(&places) - zero_centroids
    );

    // The watch-battery trace, here for its decodes, which fail only on real
    // rows: `battery_level` is `TINYINT UNSIGNED` and `last_sync_time` a
    // `DATETIME` that sqlx will not hand back as text.
    //
    // ⚠ Asserts levels are not all zero: a failed decode defaulted to 0 draws a
    // watch empty at every sync, a well-formed chart a row count passes.
    let home_tz = sync_state::get(&pool, &user, "home_tz")
        .await?
        .unwrap_or_else(|| "Europe/Amsterdam".into());
    let latest: Option<(Option<chrono::NaiveDateTime>,)> =
        sqlx::query_as("SELECT MAX(last_sync_time) FROM device_battery_log WHERE user_id = ?")
            .bind(&user)
            .fetch_optional(&pool)
            .await
            .context("reading the newest device_battery_log row")?;
    match latest.and_then(|(t,)| t) {
        None => println!("watch_battery[{user}]: no rows — nothing to decode"),
        Some(newest) => {
            let date = newest.format("%Y-%m-%d").to_string();
            let b = backend::timezone::date_bounds_utc(&date, Some(&home_tz))?;
            let series =
                backend::watch_battery::load(&pool, &user, &home_tz, b.start_utc, b.end_utc)
                    .await?;
            let levels: std::collections::BTreeSet<i64> = series.iter().map(|(_, l)| *l).collect();
            println!(
                "watch_battery[{user}]: {} sample(s) on its newest day, {} distinct level(s)",
                series.len(),
                levels.len()
            );
            // An empty series is not a failure: the newest row's civil day may
            // hold only that one reading. Every level reading zero cannot
            // happen on real data.
            if !series.is_empty() && levels == std::collections::BTreeSet::from([0]) {
                anyhow::bail!(
                    "every watch-battery level decoded to 0 — an integer that did not decode \
                     reads as zero, and a watch that is empty at every sync is not a watch"
                );
            }
        }
    }

    // ⚠ The same hazard one column over: `hour_profile` is a comma-separated
    // per-mille list, and read as JSON every profile decodes as absent. A
    // place has no profile before it is mined, so some nulls are right; all
    // nulls is a format error.
    let profiled = places.as_array().map_or(0, |a| {
        a.iter()
            .filter(|p| p["hourProfile"].as_array().is_some_and(|h| h.len() == 24))
            .count()
    });
    if profiled == 0 {
        anyhow::bail!(
            "not one of {} focus places has a 24-bucket hour profile — production mines them, so \
             this is the stored FORMAT being misread, not an unmined user",
            len(&places)
        );
    }
    println!("inputs[{user}]: hour profiles with 24 buckets: {profiled}");

    // These need a date, chosen from the data: the newest day with a
    // current-version decode. A hardcoded day would rot into "production is
    // empty"; this one makes `hsmm_decode` non-null by construction, so a
    // loader returning null for every day shows.
    let check_date: Option<String> = sqlx::query_scalar(
        "SELECT DATE_FORMAT(MAX(date), '%Y-%m-%d') FROM decoded_days \
         WHERE user_id = ? AND classifier_version = ?",
    )
    .bind(&user)
    .bind(classification_inputs::CLASSIFIER_VERSION)
    .fetch_one(&pool)
    .await
    .context("choosing a check date from decoded_days")?;
    let Some(check_date) = check_date else {
        anyhow::bail!(
            "{user} has no decoded_days row at the current classifier version — the decode \
             cron has not run for this user. ⚠ This message named a TypeScript writer \
             drifting from a Rust reader until 2026-09-01; there is no TypeScript writer \
             (#975) and CLASSIFIER_VERSION now has a single declaration, so a drift between \
             two copies is no longer one of the things this can mean"
        );
    };

    let buses = classification_inputs::bus_route_cache(&pool).await?;
    let rail_stops = classification_inputs::rail_stops_cache(&pool).await?;
    let decode = classification_inputs::hsmm_decode(&pool, &user, &check_date).await?;
    // ⚠ This resolves the zone as the loader does: `None` would print UTC-read
    // windows and look healthy while production reads them an hour later.
    let home_tz = crate::sync_state::get(&pool, &user, "home_tz").await?;
    let sleeps =
        classification_inputs::sleep_windows(&pool, &user, &check_date, home_tz.as_deref()).await?;
    println!(
        "inputs[{user}] @{check_date}: bus_route_cache {} · rail_stops_cache {} · \
         decoded_days {} segment(s) · sleep_windows {}",
        len(&buses),
        len(&rail_stops),
        len(&decode),
        len(&sleeps),
    );
    if len(&buses) == 0 || len(&rail_stops) == 0 {
        anyhow::bail!(
            "a mirror cache came back empty — both are populated in production, and these two \
             loaders DROP a malformed row silently, so empty is the shape a wrong column name \
             takes here rather than an error"
        );
    }
    if decode.is_null() || len(&decode) == 0 {
        anyhow::bail!(
            "decoded_days({user}, {check_date}) is empty, but the date was chosen BECAUSE it has \
             a row — so this is the version filter or the bind order, not missing data"
        );
    }

    // ⚠ Values again: a BIGINT that fails to decode reads as 0, and routes
    // numbered zero print the same count as real ones.
    let zero_ids = |v: &serde_json::Value| {
        v.as_array().map_or(0, |a| {
            a.iter()
                .filter(|r| r["osmRelationId"].as_f64().unwrap_or(0.0) == 0.0)
                .count()
        })
    };
    if zero_ids(&buses) > 0 || zero_ids(&rail_stops) > 0 {
        anyhow::bail!(
            "{} bus and {} rail relation id(s) decoded to 0 — OSM has no relation 0",
            zero_ids(&buses),
            zero_ids(&rail_stops)
        );
    }

    // Sleep windows are the only loader here that COMPUTES rather than copies:
    // `start_time` is a wall clock and the timestamp comes from a tz conversion.
    // A conversion that silently produced nothing reads as 0 (1970), and an
    // inverted window reads as a plausible-looking pair of numbers, so both are
    // named. A day with no main sleep is legitimate and is not an error.
    for w in sleeps.as_array().into_iter().flatten() {
        let (a, b) = (
            w["startTs"].as_i64().unwrap_or(0),
            w["endTs"].as_i64().unwrap_or(0),
        );
        if a <= 0 || b <= a {
            anyhow::bail!(
                "sleep window [{a}, {b}] for {user} on {check_date} is not a forward interval in \
                 the present — the wall-clock conversion did not run"
            );
        }
    }
    println!(
        "inputs[{user}] @{check_date}: {} sleep window(s), all forward",
        len(&sleeps)
    );

    // The last SQL loader. `biometrics` computes (six queries, three of them a
    // wall-clock fallback), so an empty stream is how most failures look.
    let home_tz = sync_state::get(&pool, &user, "home_tz")
        .await?
        .unwrap_or_else(|| "Europe/Amsterdam".into());
    let bounds = backend::timezone::date_bounds_utc(&check_date, Some(&home_tz))
        .with_context(|| format!("bounding {check_date} in {home_tz}"))?;
    let bio = classification_inputs::biometrics(
        &pool,
        &user,
        bounds.start_utc,
        bounds.end_utc,
        Some(&home_tz),
        Some(&home_tz),
    )
    .await?;
    let bracket = classification_inputs::empty_day_bracket(&pool, &user, &check_date).await?;
    println!(
        "inputs[{user}] @{check_date}: hr {} · sleep stages {} · stepped minutes {} · bracket {}",
        len(&bio["hr"]),
        len(&bio["sleep"]),
        len(&bio["steps"]),
        if bracket.is_null() { "none" } else { "present" },
    );
    // ⚠ HR cannot be empty on a decoded day: the decoder reads these streams.
    // Sleep and steps can be (a watch off the wrist, a still day), so they are
    // reported, not enforced.
    if len(&bio["hr"]) == 0 {
        anyhow::bail!(
            "no heart rate for {user} on {check_date}, a day that HAS a decode — the window \
             bounds or the ts_utc filter, not a missing watch"
        );
    }
    // ⚠ A bpm of 0 is an undecoded DECIMAL, and `ROUND(AVG(bpm))` returns one.
    let dead_bpm = bio["hr"]
        .as_array()
        .map_or(0, |a| a.iter().filter(|p| p["bpm"] == 0).count());
    if dead_bpm > 0 {
        anyhow::bail!("{dead_bpm} heart-rate minute(s) decoded to 0 bpm — nobody survives that");
    }

    // PhoneTrack: the only input that is not SQL and needs the network. Last,
    // so a Nextcloud outage cannot hide a database problem.
    //
    // ⚠ Zero fixes is not a working fetch: a revoked app password, a wrong base
    // URL and a phone left at home all return an empty array. So this asserts
    // fixes on a day with a decode, which the decoder built from GPS.
    let base_url = cfg
        .nextcloud_base_url
        .clone()
        .unwrap_or_else(|| classification_inputs::DAY_NEXTCLOUD_BASE_URL.to_string());
    let pt = backend::nextcloud::phonetrack::PhoneTrack::open(
        reqwest::Client::new(),
        &pool,
        &base_url,
        &user,
    )
    .await
    .context("opening PhoneTrack")?;
    let fetched = pt
        .fetch_window(&pool, bounds.start_utc, bounds.end_utc)
        .await
        .context("fetching the check day's PhoneTrack fixes")?;
    println!(
        "inputs[{user}] @{check_date}: phonetrack {} fix(es) from {} device(s), {} failed",
        fetched.points.len(),
        pt.device_count(),
        fetched.failed_devices,
    );
    if fetched.points.is_empty() {
        anyhow::bail!(
            "no PhoneTrack fixes for {user} on {check_date}, a day that HAS an HSMM decode — the \
             decoder runs on GPS, so the TypeScript saw fixes here and this arm did not"
        );
    }
    // ⚠ A partial walk fails the check: unlike the loader, which prefers a
    // partial day to none, this exists to say the path works.
    if fetched.failed_devices > 0 {
        anyhow::bail!(
            "{} PhoneTrack device(s) failed — these fixes are a subset, and a gap in them is \
             indistinguishable from a phone that was switched off",
            fetched.failed_devices
        );
    }

    pool.close().await;
    println!("check: OK");
    Ok(())
}

//! The backend entrypoint.
//!
//! Three subcommands:
//!
//!   check  — read the config, open the pool, and prove both against the real
//!            database. READ-ONLY, so it is safe to point at production.
//!   sync   — the port of `dist/sync.js`: Fitbit ingestion, forward then
//!            backward, for every linked user. `--forward-only` runs the
//!            forward pass alone and touches NO backfill state, which is the
//!            form that is safe to run beside the live cron.
//!   serve  — the HTTP skeleton. NOT production's server; `src/server.ts` still
//!            owns every real route.
//!
//! ⚠ `sync` NO LONGER EXITS 2. It did, and the reason it did still holds: a
//! `sync` returning 0 having done nothing shows as a healthy scheduled run while
//! data silently stops. That guard is now carried by the code rather than by the
//! stub — the run fails loudly when it cannot read its users or reach Lean, and
//! reports a spent rate budget as the ordinary ending it is.
//!
//! ⚠ IT IS NOT WIRED INTO THE CRONJOB. `health-sync` still runs `dist/sync.js`.
//! Nothing switches over until this has been run by hand against production and
//! its writes compared with the TypeScript's.

use anyhow::{Context, Result};
use backend::fold_converge::Answerer;
use backend::{
    classification_inputs, config::Config, db, fitbit, lean, routes, state::AppState, sync_state,
};

#[tokio::main]
async fn main() -> Result<()> {
    // ⚠ BEFORE ANYTHING ELSE, AND FATAL IF IT FAILS. The rate-limit policy and
    // the backfill cursor arithmetic live in Lean, so a process that could not
    // start the runtime cannot decide anything — and a sync that ran without
    // being able to decide would spend a budget nobody checked and walk a cursor
    // nobody bounded. Refusing to start is the safe failure; limping is not.
    lean::init().context("starting the Lean runtime")?;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or_default();
    let flags = &args[args.len().min(1)..];
    match cmd {
        "check" => check().await,
        "serve" => serve().await,
        "sync" => {
            // ⚠ An UNRECOGNISED flag is refused, never ignored. The one flag
            // here selects whether durable backfill state is written, so a
            // typo silently falling through to the full run is the one outcome
            // this must not have.
            let passes = match flags {
                [] => fitbit::run::Passes::All,
                [f] if f == "--forward-only" => fitbit::run::Passes::Forward,
                _ => {
                    eprintln!("usage: backend sync [--forward-only]");
                    std::process::exit(64);
                }
            };
            sync(passes).await
        }
        "inputs" => {
            // ⚠ The tz is the DISPLAY tz and it is a separate thing from
            // `home_tz`: it bounds the local day, and a fixture captured for a
            // trip abroad carries the zone the day was LIVED in, not the one the
            // profile stores. They coincide for a user at home, which is exactly
            // why passing one for the other would go unnoticed.
            let (user, date, tz) = match flags {
                [user, date] => (user, date, None),
                [user, date, tz] => (user, date, Some(tz.as_str())),
                _ => {
                    eprintln!("usage: backend inputs <user> <date> [display-tz]");
                    std::process::exit(64);
                }
            };
            inputs(user, date, tz).await
        }
        "head" => {
            // Reads a golden fixture rather than the database on purpose: the
            // head's oracle is the frozen `expected.tsArm.capture` sitting in
            // the same file as the `inputs` it was computed from, so the whole
            // chain is checkable with no DB, no network and no Node.
            let [fixture] = flags else {
                eprintln!("usage: backend head <fixture.json>");
                std::process::exit(64);
            };
            head(fixture)
        }
        "day" => {
            let [fixture] = flags else {
                eprintln!("usage: backend day <fixture.json>");
                std::process::exit(64);
            };
            day(fixture)
        }
        "velocity" => {
            let (user, date, tz) = match flags {
                [user, date] => (user, date, None),
                [user, date, tz] => (user, date, Some(tz.as_str())),
                _ => {
                    eprintln!("usage: backend velocity <user> <date> [display-tz]");
                    std::process::exit(64);
                }
            };
            velocity(user, date, tz).await
        }
        "mirror-check" => {
            let [fixture] = flags else {
                eprintln!("usage: backend mirror-check <fixture.json>");
                std::process::exit(64);
            };
            mirror_check(fixture).await
        }
        sub @ ("day-live" | "day-mirror") => {
            let (user, date, tz) = match flags {
                [user, date] => (user, date, None),
                [user, date, tz] => (user, date, Some(tz.as_str())),
                _ => {
                    eprintln!("usage: backend {sub} <user> <date> [display-tz]");
                    std::process::exit(64);
                }
            };
            day_live(user, date, tz, sub == "day-mirror").await
        }
        "" => {
            eprintln!(
                "usage: backend <check|serve|sync [--forward-only]|inputs <user> <date>|head <fixture.json>|day <fixture.json>|day-live <user> <date>|day-mirror <user> <date>|mirror-check <fixture.json>|velocity <user> <date>>"
            );
            std::process::exit(64);
        }
        other => {
            eprintln!(
                "backend: unknown subcommand {other:?} — expected check, serve, sync, inputs, head, day, day-live, day-mirror, mirror-check or velocity"
            );
            std::process::exit(64);
        }
    }
}

/// Print the day's DB inputs as JSON, for diffing against the TypeScript.
///
/// ⚠ THIS IS THE PARITY INSTRUMENT, not a convenience. `backend check` proves
/// each query EXECUTES; it cannot prove the answer is the same one
/// `load-classification-inputs.ts` produces, and those are different claims —
/// a query can run, return rows, and still read the wrong column. The module
/// header says the honest comparison is both arms against one database with the
/// JSON diffed, and this is the half of that which did not exist.
///
/// Compare against a golden fixture's `inputs`, which IS the TypeScript
/// loader's output for that day:
///
///   scripts/prod-db.sh backend inputs pippijn 2026-08-13 > /tmp/rust.json
///   jq -S '{sleepWindows, hsmmDecode}' tests/golden/days/2026-08-13-pippijn.json
///
/// ⚠ ONLY THE PER-DAY FIELDS COMPARE CLEANLY. `busRouteCache`,
/// `railStopsCache`, `railRouteCache`, `knownPlaces` and `venuePriors` are
/// global or re-mined, so a fixture's copy is a snapshot of a moving table and a
/// difference there is drift, not a defect. `sleepWindows` and `hsmmDecode` are
/// fixed history for a past day and are the ones that mean something.
///
/// ⚠ REAL LOCATION DATA on stdout — where the user was and when. Redirect to
/// /tmp, never into the repo: both health repos are public.
async fn inputs(user: &str, date: &str, display_tz: Option<&str>) -> Result<()> {
    let cfg = Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    // The day's UTC bounds, for the window `motion_log` is read over. The tz is
    // the user's stored home zone, exactly as the TypeScript resolves it.
    let home_tz = sync_state::get(&pool, user, "home_tz")
        .await?
        .unwrap_or_else(|| "Europe/Amsterdam".into());
    // Defaults to `home_tz` when not given, which is what a day at home means.
    let display_tz = display_tz.unwrap_or(&home_tz);
    let bounds = backend::timezone::date_bounds_utc(date, Some(display_tz))
        .with_context(|| format!("bounding {date} in {display_tz}"))?;
    // ⚠ The DAY path's base URL has a default; the SYNC path's is an Option.
    // See `DAY_NEXTCLOUD_BASE_URL` — collapsing the two would either break
    // sync's "no PhoneTrack configured" case or blank every timeline.
    let base_url = cfg
        .nextcloud_base_url
        .clone()
        .unwrap_or_else(|| classification_inputs::DAY_NEXTCLOUD_BASE_URL.to_string());
    let out = classification_inputs::load(
        &pool,
        &reqwest::Client::new(),
        &base_url,
        &classification_inputs::DayIdentity {
            user_id: user,
            date,
            display_tz,
        },
        bounds,
        Some(&home_tz),
    )
    .await?;
    pool.close().await;
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}

/// Run one Fitbit ingestion pass over every linked user.
///
/// # ⚠ NOT YET AT PARITY WITH `dist/sync.js` — one thing is missing
///
/// Named here rather than left to be discovered from a diff, because it is a
/// silent absence: the run would look healthy and simply not do it.
///
///   * **`migrate()`**, below.
///
/// The Google Health weight sync USED to be the other entry and now runs — see
/// [`backend::google`]. It is still inert without `GH_*` and `GH_USER_ID`.
///
/// # It does NOT migrate the schema, and the TypeScript's `sync.ts` does
///
/// `dist/sync.js` calls `migrate()` on startup, so whichever of the sync cron
/// and the server started first brought the schema up. This does not, because
/// two processes racing to apply migrations is a worse failure than a missing
/// one, and `health-auth` already migrates on every start. ⚠ That means this
/// binary must not be the FIRST thing to run against a fresh database.
///
/// # The zone lookup is built once
///
/// `tzf-rs` decompresses its polygon set on construction, which is the
/// expensive part; the finder is then queried per fix. Building it per user, or
/// per row, is how a lookup that costs microseconds becomes one that costs
/// hundreds of milliseconds.
async fn sync(passes: fitbit::run::Passes) -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cfg = Config::from_env()?;
    let pool = db::connect(&cfg.db.url()).await?;
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .context("building the HTTP client")?;

    let polygons = fitbit::tz_source::PolygonLookup::new();
    let lookup = |lat: f64, lon: f64| polygons.zone(lat, lon);

    fitbit::run::run(
        &pool,
        &http,
        &cfg.fitbit.client_id,
        &cfg.fitbit.client_secret,
        cfg.nextcloud_base_url.as_deref(),
        &lookup,
        passes,
    )
    .await
}

/// Serve the HTTP surface.
///
/// ⚠ NOT PRODUCTION'S SERVER. `src/server.ts` owns every real route; this binds
/// the skeleton so the config → pool → axum stack is exercised by something
/// other than a unit test. `PORT` defaults to 8081 rather than the TypeScript
/// server's port: the two must be able to run side by side on one host during
/// the port, and defaulting to the same number would make the first accidental
/// double-start look like a crash.
async fn serve() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cfg = Config::from_env()?;
    let pool = db::connect(&cfg.db.url()).await?;
    let port: u16 = std::env::var("PORT")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.parse()
                .with_context(|| format!("PORT is not a port number: {s:?}"))
        })
        .transpose()?
        .unwrap_or(8081);

    // Bounded, for the same reason the pool is: a hung Nextcloud or Fitbit must
    // not tie up a pod.
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    let app = routes::router(AppState::new(pool, cfg, http));
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
/// This is the same shape of evidence `mirror.rs` was landed with: the port was
/// only believable once a query had run against the live server, because
/// nothing in a unit test executes SQL and "it compiles" says nothing about
/// bind order, credentials, or whether the schema is what the code thinks.
///
/// ⚠ It prints COUNTS and never values. `sync_state` holds cursors keyed by
/// user; the row count and the distinct-key count prove the table is reachable
/// and the decode path works without putting anyone's data on a terminal.
async fn check() -> Result<()> {
    let cfg = Config::from_env().context("reading configuration")?;
    println!(
        "config: db {}:{}/{} user={} fitbit_client={} nextcloud={}",
        cfg.db.host,
        cfg.db.port,
        cfg.db.database,
        cfg.db.user,
        // The client ID is not a secret (it ships in the OAuth redirect); the
        // SECRET is never printed, and its presence is reported as a boolean.
        cfg.fitbit.client_id,
        cfg.nextcloud_base_url.as_deref().unwrap_or("<unset>")
    );
    println!(
        "config: fitbit client secret {}",
        if cfg.fitbit.client_secret.is_empty() {
            "EMPTY"
        } else {
            "present"
        }
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

    // The day-input loaders (#982). Counts, not contents: this runs against
    // PRODUCTION and the rows are real places and real movement.
    //
    // ⚠ The point is that the SQL EXECUTES — column names, bind order, and the
    // decode of every DECIMAL and every nullable. None of that is exercised by
    // compiling, and none of it is exercised by a unit test, because no unit
    // test in this crate runs SQL. It is the same bar `sync_state` above is
    // held to, and for the same reason.
    let user = std::env::var("CHECK_USER").unwrap_or_else(|_| "pippijn".into());
    let places = classification_inputs::known_places(&pool, &user).await?;
    let modes = classification_inputs::mode_biometrics(&pool, &user).await?;
    let rail = classification_inputs::rail_route_cache(&pool).await?;
    let priors = classification_inputs::venue_priors(&pool, &user).await?;
    let len = |v: &serde_json::Value| v.as_array().map_or(0, Vec::len);
    // ⚠ VALUES, NOT JUST COUNTS. `focus_places.centroid_lat` is DECIMAL, which
    // the driver hands back as a STRING — the TypeScript wraps every one in
    // `Number(...)` for exactly that reason. A row count proves the query ran;
    // it does not prove one coordinate decoded, and 117 rows of 0.0 print
    // identically to 117 real ones. This check had that hole when it was written.
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
    // ⚠ A read that returns NOTHING is not a read that worked. Every one of
    // these is populated in production, so an empty answer means a query that
    // ran against the wrong column or the wrong user and said so quietly.
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

    // The watch-battery trace (#982). ⚠ Here for the DECODES, which fail only on
    // real rows: `battery_level` is `TINYINT UNSIGNED` and `last_sync_time` is a
    // `DATETIME` that sqlx will not hand back as text.
    //
    // ⚠ The assertion is that levels are NOT ALL ZERO, and that is the whole
    // point of putting it here. The first version of the loader defaulted a
    // failed decode to 0, which draws a watch reporting EMPTY at every sync — a
    // well-formed chart, indistinguishable from a real flat battery, and a row
    // count would have printed OK for it.
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
            let series = backend::fitbit::watch_battery::load(
                &pool,
                &user,
                &home_tz,
                b.start_utc,
                b.end_utc,
            )
            .await?;
            let levels: std::collections::BTreeSet<i64> = series.iter().map(|(_, l)| *l).collect();
            println!(
                "watch_battery[{user}]: {} sample(s) on its newest day, {} distinct level(s)",
                series.len(),
                levels.len()
            );
            // ⚠ An EMPTY series is not a failure: the newest row's own civil day
            // in the home zone may hold only that one reading, and the collapse
            // can leave it. What cannot happen on real data is every level
            // reading zero.
            if !series.is_empty() && levels == std::collections::BTreeSet::from([0]) {
                anyhow::bail!(
                    "every watch-battery level decoded to 0 — an integer that did not decode \
                     reads as zero, and a watch that is empty at every sync is not a watch"
                );
            }
        }
    }

    // ⚠ THE SAME HAZARD ONE COLUMN OVER, and it was live: `hour_profile` is a
    // comma-separated per-mille list, the first port read it as JSON, and all
    // 117 profiles decoded to "absent" while this check printed OK — because
    // the check looked at centroids and nothing else. A place legitimately has
    // no profile before it is mined, so SOME nulls are right and ALL nulls is
    // the shape a format error takes here.
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

    // The second tranche (#982). These need a DATE, and picking one by hand
    // would be a check that rots: the corpus moves and a hardcoded day
    // eventually has no decode, at which point the assertions below turn into
    // "production is empty" and get deleted by whoever is unblocking a deploy.
    //
    // So the date is CHOSEN FROM THE DATA — the newest day this user has a
    // current-version decode for. That makes `hsmm_decode` non-null BY
    // CONSTRUCTION, which is the point: a loader that returned null for every
    // day would otherwise be indistinguishable from a day that has no decode.
    let check_date: Option<String> = sqlx::query_scalar(
        "SELECT DATE_FORMAT(MAX(date), '%Y-%m-%d') FROM decoded_days \
         WHERE user_id = ? AND classifier_version = 7",
    )
    .bind(&user)
    .fetch_one(&pool)
    .await
    .context("choosing a check date from decoded_days")?;
    let Some(check_date) = check_date else {
        anyhow::bail!(
            "{user} has no decoded_days row at the current classifier version — either the \
             decode cron has not run, or CLASSIFIER_VERSION has drifted between the TypeScript \
             that writes and the Rust that reads"
        );
    };

    let buses = classification_inputs::bus_route_cache(&pool).await?;
    let rail_stops = classification_inputs::rail_stops_cache(&pool).await?;
    let decode = classification_inputs::hsmm_decode(&pool, &user, &check_date).await?;
    let sleeps = classification_inputs::sleep_windows(&pool, &user, &check_date).await?;
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

    // ⚠ VALUES AGAIN, and the same hazard as the centroids: a BIGINT that fails
    // to decode reads as 0, and 995 routes numbered zero print the same count
    // as 995 real ones.
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

    // The last of the SQL loaders (#982). `biometrics` is the one that COMPUTES
    // — six queries, three of them a wall-clock fallback — so an empty stream
    // is the shape most of its failure modes take.
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
    // ⚠ HR is the one that cannot legitimately be empty on a decoded day: the
    // date was chosen because it HAS an HSMM decode, and the decoder reads
    // these streams. Sleep and steps can be genuinely empty (a watch off the
    // wrist, a day sat still), so they are reported and not enforced.
    if len(&bio["hr"]) == 0 {
        anyhow::bail!(
            "no heart rate for {user} on {check_date}, a day that HAS a decode — the window \
             bounds or the ts_utc filter, not a missing Fitbit"
        );
    }
    // ⚠ A bpm of 0 is what a DECIMAL that did not decode looks like, and
    // `ROUND(AVG(bpm))` returns a DECIMAL. This is the third column in this
    // file to hit that trap.
    let dead_bpm = bio["hr"]
        .as_array()
        .map_or(0, |a| a.iter().filter(|p| p["bpm"] == 0).count());
    if dead_bpm > 0 {
        anyhow::bail!("{dead_bpm} heart-rate minute(s) decoded to 0 bpm — nobody survives that");
    }

    // PhoneTrack — the only input that is not SQL, and the only one this check
    // cannot reach without the network. Run last so a Nextcloud outage does not
    // hide a database problem behind it.
    //
    // ⚠ ZERO FIXES IS NOT PROOF OF A WORKING FETCH. A revoked app password, a
    // wrong base URL and a phone left at home all produce an empty array, and
    // the pipeline reads an empty day as "stationary at the bracketed place".
    // So this asserts fixes exist on a day that HAS a decode — the decoder runs
    // on GPS, so a decoded day had fixes when the TypeScript looked.
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
    // ⚠ A partial walk is a FAILED check here, not a warning. Unlike the loader
    // — which prefers a partial day to none — this exists to say the path works,
    // and a path that half works is the case it is meant to catch.
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

/// Print the capture and battery trace the head computes from a fixture's inputs.
///
/// The parity instrument for #982's second half. `backend check` proves the
/// stages RUN, which is strictly weaker than proving they agree; this prints
/// what a diff can be taken of.
///
/// ⚠ DIFF THE TEXT, NOT THROUGH `jq`. jq parses both sides to doubles, so
/// `25.0 == 25` and it calls a rendering difference clean — which is how three
/// wrong fields survived the loaders' first parity pass. `tests/head_corpus.rs`
/// does this over the whole corpus; this is for looking at one day.
fn head(fixture: &str) -> Result<()> {
    let text = std::fs::read_to_string(fixture).with_context(|| format!("reading {fixture}"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&text).with_context(|| format!("parsing {fixture}"))?;
    let name = std::path::Path::new(fixture)
        .file_stem()
        .and_then(|s| s.to_str())
        .context("the fixture path has no file name")?;
    let (date, user) = name
        .split_once('-')
        .and_then(|_| Some((name.get(..10)?, name.get(11..)?)))
        .with_context(|| format!("{name} is not <YYYY-MM-DD>-<user>"))?;
    let inputs = parsed.get("inputs").context("the fixture has no inputs")?;
    let cap = backend::head::capture(inputs, date, user)?;
    // The battery trace rides alongside rather than inside: the fold's capture
    // shape has no room for it — the TypeScript computes the chart BESIDE the
    // fold, not in it — and `backend day` reads this same struct.
    let battery = backend::head::run(inputs, date)?.battery;
    println!(
        "{}",
        serde_json::json!({ "capture": cap, "battery": battery })
    );
    Ok(())
}

/// Run a whole day from a golden fixture: inputs → head → request → fold.
///
/// The chain end to end with no Node and no database. `head` prints what the
/// fold is asked; this prints what it answers, having walked the converge loop
/// against the fixture's own OSM row set.
///
/// The oracle is `expected.velocity` in the same file. This prints the timeline
/// rather than judging it — `tests/day_corpus.rs` is what compares.
fn day(fixture: &str) -> Result<()> {
    let text = std::fs::read_to_string(fixture).with_context(|| format!("reading {fixture}"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&text).with_context(|| format!("parsing {fixture}"))?;
    let name = std::path::Path::new(fixture)
        .file_stem()
        .and_then(|s| s.to_str())
        .context("the fixture path has no file name")?;
    let (date, user) = name
        .split_once('-')
        .and_then(|_| Some((name.get(..10)?, name.get(11..)?)))
        .with_context(|| format!("{name} is not <YYYY-MM-DD>-<user>"))?;
    let inputs = parsed.get("inputs").context("the fixture has no inputs")?;

    let cap = backend::head::capture(inputs, date, user)?;
    let rows = inputs
        .get("osmRowSet")
        .context("the fixture has no osmRowSet to answer from")?;
    let mut answerer = backend::rowset_answerer::RowSetAnswerer::new(rows)?;
    let r = backend::fold_converge::converge(&cap, inputs, inputs.get("osmTrace"), &mut answerer)?;

    // ⚠ On stderr, so stdout stays a clean timeline to diff. A walk that left
    // keys unanswered produced a timeline from DEFAULTS for them, and that is
    // not the same day — it has to be visible without reading the JSON.
    eprintln!(
        "{date} {user}: {} round(s), {} key(s) answered, {} unanswerable",
        r.rounds,
        r.answered,
        r.unanswerable.len()
    );
    for m in &r.unanswerable {
        eprintln!("  UNANSWERED {}({})", m.what, m.key);
    }
    println!("{}", r.out);
    Ok(())
}

/// Build `/velocity`'s response for one day, from PRODUCTION.
///
/// # ⚠ What this covers, and what it does not
///
/// The route's GATE — auth, the share window, parameter validation — is
/// `tests/velocity_route.rs`, and none of it runs here: this calls the handler's
/// assembly directly with no session. What it covers is the half no test can,
/// because it needs a database and the OSM mirror: that the day actually
/// assembles into a response, with every key the frontend reads present and
/// populated.
///
/// The clip is applied here too, so the printed body is what a request would
/// receive rather than the cached value behind it.
///
/// ⚠ REAL LOCATION DATA on stdout. Redirect to /tmp, never into the repo: both
/// health repos are public.
async fn velocity(user: &str, date: &str, display_tz: Option<&str>) -> Result<()> {
    let cfg = Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let st = backend::state::AppState::new(pool.clone(), cfg, reqwest::Client::new());

    let started = std::time::Instant::now();
    let body = backend::routes::velocity::compute(&st, user, date, display_tz).await?;
    let compute_ms = started.elapsed().as_millis();

    // ⚠ The per-request clip, so this prints what a CALLER sees. Skipping it
    // would print the cached value, which for today is a day asserting a future
    // that has not happened.
    let now_s = chrono::Utc::now().timestamp();
    let states = body
        .get("states")
        .and_then(serde_json::Value::as_array)
        .map(|s| lean::clip_inferred_future(s, now_s))
        .transpose()?
        .unwrap_or_default();
    let clipped = states.len();
    let mut body = body;
    let before = body["states"].as_array().map_or(0, Vec::len);
    body["states"] = serde_json::Value::Array(states);
    pool.close().await;

    // ⚠ COUNTS on stderr, body on stdout. A key that is present but EMPTY is the
    // failure this exists to catch — an assembled response with no points reads
    // as a quiet day rather than as a broken join.
    let len = |k: &str| {
        body.get(k)
            .and_then(serde_json::Value::as_array)
            .map_or(0, Vec::len)
    };
    // ⚠ The TIMING rides on this line too. `fold` dominates, and its cost is
    // round trips — so `mirrorQueries` beside it is what makes the number
    // comparable to an in-cluster run instead of a figure from a laptop over an
    // SSH tunnel (~50x, measured 2026-08-17).
    let t = |k: &str| {
        body.pointer(&format!("/timing/{k}"))
            .cloned()
            .unwrap_or(serde_json::Value::Null)
    };
    eprintln!(
        "velocity[{user}] {date}: {compute_ms} ms — load {} · head {} · fold {} \
         ({} mirror quer(ies), {} round(s), {} key(s)) · watchBattery {}",
        t("load"),
        t("head"),
        t("fold"),
        t("mirrorQueries"),
        t("rounds"),
        t("answered"),
        t("watchBattery"),
    );
    eprintln!(
        "velocity[{user}] {date}: points {} · rawFixes {} · segments {} · \
         states {before}->{clipped} · episodes {} · battery {} · watchBattery {}",
        len("points"),
        len("rawFixes"),
        len("segments"),
        len("episodes"),
        len("battery"),
        len("watchBattery"),
    );
    for k in [
        "points", "rawFixes", "segments", "states", "episodes", "battery",
    ] {
        if body.get(k).is_none() {
            anyhow::bail!("the response has no `{k}` — the frontend reads it");
        }
    }
    println!("{body}");
    Ok(())
}

/// Does the LIVE MIRROR answer a golden day's OSM questions the way its captured
/// row set does?
///
/// # ⚠ Why a count of answered keys is not evidence
///
/// `day-mirror` reports how many keys the mirror answered, and every failure
/// mode this source has produces an ANSWER rather than a decline: a swapped
/// `lat`/`lon` in the box WKT selects rows from the wrong hemisphere, a
/// misspelled `feature_type` selects none, and both come back as "no ways within
/// 50 m" — well-formed, plausible, and wrong. The coverage gate does not catch
/// either, because coverage is about the AREA and these are about the query.
///
/// So this asks both sources the same questions. The fixture's row set was
/// extracted from this same mirror, so agreement is the expected result and a
/// disagreement is either a real defect or the mirror having moved since the
/// capture — which the FIELDS that moved distinguish, not the count.
///
/// Run against production on 2026-08-22, and this is the baseline a future run
/// compares against:
///
///     2026-08-13   136 questions   135 agree   0 declined
///                  nearbyWays: 1 differ (57 -> 58), a row the mirror has gained
///     2026-04-29   120 questions   117 agree   0 declined
///                  nearbyWays: 3 differ, all same-width, all `name`/`subtype`
///
/// ⚠ The older day differs MORE, and no difference anywhere moved `distanceM`.
/// Both facts are what OSM drift looks like and neither is what a defect in this
/// source would look like: a wrong box or a wrong bucket answers EMPTY, and a
/// coordinate read by the wrong path moves every distance derived from it.
///
/// ⚠ REPORTS COUNTS, NEVER CONTENT. The answers carry street and venue names at
/// coordinates the user stood on; both health repos are public, and this runs
/// with a terminal open.
async fn mirror_check(fixture: &str) -> Result<()> {
    /// The tables a row source can answer. `nearbyWays` spells no radius in its
    /// key — the answerer uses the default.
    const TABLES: [&str; 3] = ["nearbyWays", "nearbyStations", "linesAtPoint"];

    let text = std::fs::read_to_string(fixture).with_context(|| format!("reading {fixture}"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&text).with_context(|| format!("parsing {fixture}"))?;
    let inputs = parsed.get("inputs").context("the fixture has no inputs")?;
    let rows = inputs
        .get("osmRowSet")
        .context("the fixture has no osmRowSet")?;
    let trace = inputs
        .get("osmTrace")
        .context("the fixture has no osmTrace")?;

    // The questions: every coordinate the day actually asked about, spelled the
    // way the fold spells a miss — bit patterns, not decimals.
    let mut asks: Vec<backend::lean::Miss> = Vec::new();
    for table in TABLES {
        let Some(keys) = trace.get(table).and_then(serde_json::Value::as_object) else {
            continue;
        };
        for k in keys.keys() {
            let p: Vec<&str> = k.split('|').collect();
            let (Some(Ok(la)), Some(Ok(lo))) = (
                p.first().map(|s| s.parse::<f64>()),
                p.get(1).map(|s| s.parse::<f64>()),
            ) else {
                continue;
            };
            let key = match p.get(2).and_then(|s| s.parse::<f64>().ok()) {
                Some(r) => format!("{}|{}|{}", la.to_bits(), lo.to_bits(), r.to_bits()),
                None => format!("{}|{}", la.to_bits(), lo.to_bits()),
            };
            asks.push(backend::lean::Miss {
                what: table.to_string(),
                key,
            });
        }
    }
    eprintln!("{} question(s) from the fixture's trace", asks.len());

    // The offline arm: the rows the fixture carries.
    let mut offline = backend::rowset_answerer::RowSetAnswerer::new(rows)?;
    let from_rows: Vec<Option<serde_json::Value>> = asks
        .iter()
        .map(|m| Ok(offline.answer(m)?.map(|(_, v)| v)))
        .collect::<Result<_>>()?;

    // The live arm.
    let cfg = Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .context("the system clock is before the epoch")?
        .as_millis() as i64;
    let questions = asks.clone();
    let from_mirror =
        backend::mirror_source::with_mirror_answerer(pool.clone(), now_ms, move |answerer| {
            questions
                .iter()
                .map(|m| Ok(answerer.answer(m)?.map(|(_, v)| v)))
                .collect::<Result<Vec<_>>>()
        })
        .await?;
    pool.close().await;

    /// Answers are `[lat, lon, rows]` or `[lat, lon, radius, rows]` — the row
    /// list is the last element either way.
    fn rows_of(v: &serde_json::Value) -> &[serde_json::Value] {
        v.as_array()
            .and_then(|a| a.last())
            .and_then(serde_json::Value::as_array)
            .map_or(&[], Vec::as_slice)
    }

    /// WHICH FIELDS moved between two answers of the same width.
    ///
    /// ⚠ The classification is the point, not the count. Two explanations fit a
    /// same-width difference and they call for opposite work:
    ///
    ///   * only `distanceM` — the two arms read the stored coordinate by
    ///     different paths. The capture came through the TypeScript driver's
    ///     TEXT rendering of a `DOUBLE`; this reads `ST_X`/`ST_Y` in the binary
    ///     protocol. A coordinate whose text form does not round-trip differs in
    ///     the last ULP and moves every distance computed from it. That would be
    ///     a defect in THIS port.
    ///   * `name`, `subtype` or `osmId` — OSM itself moved since the capture.
    ///     Nothing to fix; the fixture is a photograph of an older mirror.
    fn moved_fields(want: &serde_json::Value, got: &serde_json::Value) -> Vec<String> {
        let mut fields = std::collections::BTreeSet::new();
        for (w, g) in rows_of(want).iter().zip(rows_of(got)) {
            match (w.as_object(), g.as_object()) {
                (Some(w), Some(g)) => {
                    for k in w.keys().chain(g.keys()) {
                        if w.get(k) != g.get(k) {
                            fields.insert(k.clone());
                        }
                    }
                }
                // `linesAtPoint` answers with bare strings.
                _ if w != g => {
                    fields.insert("<value>".to_string());
                }
                _ => {}
            }
        }
        fields.into_iter().collect()
    }

    let mut agree = 0usize;
    let mut declined = 0usize;
    #[allow(clippy::type_complexity)]
    let mut differ: std::collections::BTreeMap<&str, Vec<(usize, usize, Vec<String>)>> =
        Default::default();
    for ((m, want), got) in asks.iter().zip(&from_rows).zip(&from_mirror) {
        match (want, got) {
            (Some(w), Some(g)) if w == g => agree += 1,
            // ⚠ A decline is NOT a difference to average away. It means the
            // mirror has no coverage row for an area the capture had rows for,
            // which is a finding about the mirror rather than about this port.
            (_, None) => declined += 1,
            (Some(w), Some(g)) => differ.entry(m.what.as_str()).or_default().push((
                rows_of(w).len(),
                rows_of(g).len(),
                moved_fields(w, g),
            )),
            (None, Some(_)) => {
                // The fixture could not answer and the mirror could. Nothing in
                // these three tables should do this; count it as a difference so
                // it cannot pass silently.
                differ.entry(m.what.as_str()).or_default().push((
                    0,
                    1,
                    vec!["<unanswerable offline>".into()],
                ));
            }
        }
    }

    eprintln!("agree: {agree}   mirror declined: {declined}");
    for (table, ds) in &differ {
        // ⚠ COUNTS AND FIELD NAMES, never values: a value here is a street the
        // user walked down.
        let empties = ds.iter().filter(|(_, g, _)| *g == 0).count();
        let widths = ds.iter().filter(|(w, g, _)| w != g).count();
        eprintln!(
            "  {table}: {} differ — {empties} where the MIRROR ANSWERED EMPTY, \
             {widths} with a different row count",
            ds.len()
        );
        for (w, g, fields) in ds.iter().take(12) {
            eprintln!(
                "      ({w} -> {g}) fields that moved: {}",
                fields.join(", ")
            );
        }
    }
    if differ.is_empty() && declined == 0 {
        eprintln!(
            "the live mirror and the captured row set give the same answer to every question"
        );
    }
    Ok(())
}

/// Run a day from the PRODUCTION database, either measuring the OSM gap or
/// answering it from the mirror.
///
/// The offline `day` proves the chain on a fixture, which carries an
/// `osmRowSet` and an `osmTrace` the loader does not produce. Production has
/// neither: `ClassificationInputs.osm` is an ADAPTER there, not data.
///
/// **`day-live`** walks with `RecordOnly`, which answers nothing. The keys it
/// reports are exactly what a live answerer has to supply — a measurement, not
/// a failure; `fold_converge`'s own note calls `RecordOnly` "how a day is
/// MEASURED". ⚠ Its timeline was built from DEFAULTS for every key listed, so
/// it is not a day to judge.
///
/// **`day-mirror`** walks with [`mirror_source::MirrorSource`], which answers
/// what the local OSM mirror covers. What it still reports as unanswerable is
/// the residue: areas nobody has fetched, plus the three tables no row set can
/// answer (`reverseGeocode`, `nearbyLandmarks`, `transitStops` — see
/// `rowset_answerer`'s catch-all).
///
/// ⚠ Its timeline is NOT the timeline production serves and is not a re-bless
/// candidate. The mirror source hands Lean every candidate in the box rather
/// than MariaDB's `ORDER BY ST_Distance … LIMIT 50`, which is the point (#413)
/// and means the two disagree by construction.
///
/// ⚠ REAL LOCATION DATA on stdout — where the user was and when. Redirect to
/// /tmp, never into the repo: both health repos are public.
async fn day_live(
    user: &str,
    date: &str,
    display_tz: Option<&str>,
    from_mirror: bool,
) -> Result<()> {
    let cfg = Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let home_tz = sync_state::get(&pool, user, "home_tz")
        .await?
        .unwrap_or_else(|| "Europe/Amsterdam".into());
    let display_tz = display_tz.unwrap_or(&home_tz);
    let bounds = backend::timezone::date_bounds_utc(date, Some(display_tz))
        .with_context(|| format!("bounding {date} in {display_tz}"))?;
    let base_url = cfg
        .nextcloud_base_url
        .clone()
        .unwrap_or_else(|| classification_inputs::DAY_NEXTCLOUD_BASE_URL.to_string());
    let inputs = classification_inputs::load(
        &pool,
        &reqwest::Client::new(),
        &base_url,
        &classification_inputs::DayIdentity {
            user_id: user,
            date,
            display_tz,
        },
        bounds,
        Some(&home_tz),
    )
    .await?;

    let cap = backend::head::capture(&inputs, date, user)?;
    let segs = cap
        .get("segsRaw")
        .and_then(serde_json::Value::as_array)
        .map_or(0, Vec::len);
    let pts = cap
        .pointer("/obs/points")
        .and_then(serde_json::Value::as_array)
        .map_or(0, Vec::len);
    eprintln!("head: {pts} smoothed point(s), {segs} segment(s)");

    let r = if from_mirror {
        // ⚠ The clock is read HERE and passed down. Lean's coverage rule takes
        // `nowMs` as an argument so the decision does not depend on when it was
        // asked, and a walk whose staleness cutoff moves mid-day would answer
        // two identical questions differently.
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .context("the system clock is before the epoch")?
            .as_millis() as i64;
        backend::mirror_source::converge_from_mirror(
            pool.clone(),
            cap.clone(),
            inputs.clone(),
            now_ms,
        )
        .await?
    } else {
        // No trace: production has no recording to seed the tables from, and
        // passing one would answer questions this measurement exists to count.
        backend::fold_converge::converge(
            &cap,
            &inputs,
            None,
            &mut backend::fold_converge::RecordOnly,
        )?
    };
    pool.close().await;

    let mut by_table: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
    for m in &r.unanswerable {
        *by_table.entry(m.what.as_str()).or_default() += 1;
    }
    eprintln!(
        "fold: {} round(s); {} key(s) answered; {} key(s) a live answerer must supply",
        r.rounds,
        r.answered,
        r.unanswerable.len()
    );
    for (table, n) in &by_table {
        eprintln!("  {table}: {n}");
    }
    // ⚠ `bestPlace` has an EXPECTED decline that is not a gap, and the count
    // alone cannot tell it from one. The fold asks a stay's naming question once
    // before `tzAt` has resolved its zone and again after; the blank spelling is
    // a question asked too early, and answering it with UTC would put a second
    // row on the table for the same stay keyed differently. Splitting it here is
    // what makes "4 unanswered" readable as "4 early asks, none missed".
    let early = r
        .unanswerable
        .iter()
        .filter(|m| m.what == "bestPlace" && m.key.split('|').nth(4).is_none_or(str::is_empty))
        .count();
    if by_table.contains_key("bestPlace") {
        eprintln!("  ...of which bestPlace asked before its timezone resolved: {early}");
    }
    println!("{}", r.out);
    Ok(())
}

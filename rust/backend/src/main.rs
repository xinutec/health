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
            let [user, date] = flags else {
                eprintln!("usage: backend inputs <user> <date>");
                std::process::exit(64);
            };
            inputs(user, date).await
        }
        "" => {
            eprintln!("usage: backend <check|serve|sync [--forward-only]|inputs <user> <date>>");
            std::process::exit(64);
        }
        other => {
            eprintln!(
                "backend: unknown subcommand {other:?} — expected check, serve, sync or inputs"
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
async fn inputs(user: &str, date: &str) -> Result<()> {
    let cfg = Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    // The day's UTC bounds, for the window `motion_log` is read over. The tz is
    // the user's stored home zone, exactly as the TypeScript resolves it.
    let home_tz = sync_state::get(&pool, user, "home_tz")
        .await?
        .unwrap_or_else(|| "Europe/Amsterdam".into());
    let bounds = backend::timezone::date_bounds_utc(date, Some(&home_tz))
        .with_context(|| format!("bounding {date} in {home_tz}"))?;
    let out = classification_inputs::load_partial(
        &pool,
        user,
        date,
        bounds.start_utc,
        bounds.end_utc,
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

    pool.close().await;
    println!("check: OK");
    Ok(())
}

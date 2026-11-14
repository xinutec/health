//! One day, end to end: `inputs`, `head`, `day`, `velocity`, `velocity-many`,
//! `mirror-check`, `locations-check`, and the live day fold behind them.

use anyhow::{Context, Result};
use backend::lean::Answerer;
use backend::{classification_inputs, config::Config, db, lean, sync_state};

/// Print the day's DB inputs as JSON, to diff against a golden fixture's
/// `inputs`: `backend check` proves a query runs, this shows what it reads.
///
///   scripts/prod-db.sh backend inputs "$USER" <date> > /tmp/rust.json
///   jq -S '{sleepWindows, hsmmDecode}' tests/golden/days/<date>-$USER.json
///
/// Only per-day fields compare cleanly (`sleepWindows`, `hsmmDecode`); the
/// caches, places and priors are global or re-mined.
///
/// ⚠ Real location data on stdout. Redirect to /tmp, never into the repo:
/// both health repos are public.
pub(crate) async fn inputs(user: &str, date: &str, display_tz: Option<&str>) -> Result<()> {
    let cfg = Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    // The day's UTC bounds, for the window `motion_log` is read over, in the
    // user's stored home zone.
    let home_tz = sync_state::home_tz(&pool, user).await?;
    // Defaults to `home_tz` when not given, which is what a day at home means.
    let display_tz = display_tz.unwrap_or(&home_tz);
    let bounds = backend::timezone::date_bounds_utc(date, Some(display_tz))
        .with_context(|| format!("bounding {date} in {display_tz}"))?;
    // The day path's base URL has a default; the sync path's is an Option.
    // See `DAY_NEXTCLOUD_BASE_URL`: merging them would break one or the other.
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

/// Print the capture and battery trace the head computes from a fixture's
/// inputs. Diff the text, not through `jq` (`25.0 == 25`).
pub(crate) fn head(fixture: &str) -> Result<()> {
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
    // The battery trace rides beside the fold's capture, which has no room for
    // it; `backend day` reads this same struct.
    let battery = backend::head::run(inputs, date)?.battery;
    println!(
        "{}",
        serde_json::json!({ "capture": cap, "battery": battery })
    );
    Ok(())
}

/// Run a whole day from a golden fixture with no database: inputs → head →
/// request → fold, asks answered from the recorded trace then the row set, as
/// the corpus does. `tests/corpus/day.rs` compares against `expected.velocity`.
pub(crate) fn day(fixture: &str) -> Result<()> {
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
    let mut inputs = parsed
        .get("inputs")
        .context("the fixture has no inputs")?
        .clone();
    // The frozen twin's blessed decode stands in for the stored row, as the
    // corpus gate reads it; a fixture without one (a history capture) folds on
    // the decode it carries.
    if let Some(stored) = backend::decode_fixture::stored_decode(date, user)? {
        inputs["hsmmDecode"] = stored;
    }
    let inputs = &inputs;

    let cap = backend::head::capture(inputs, date, user)?;
    let rows = inputs
        .get("osmRowSet")
        .context("the fixture has no osmRowSet to answer from")?;
    let trace = backend::osm_trace::TraceAnswerer::from_fixture(
        &parsed,
        fixture,
        backend::osm_trace::Sections::ALL,
    )
    .map_err(|e| anyhow::anyhow!(e))?;
    let mut answerer =
        backend::lean::Chain(trace, backend::rowset_answerer::RowSetAnswerer::new(rows)?);
    let r = backend::fold::run_day(&cap, inputs, &mut answerer)?;

    // On stderr, so stdout stays a clean timeline to diff. A fold with
    // declined asks used defaults for them and is not the same day.
    let declined = r.declined();
    eprintln!(
        "{date} {user}: {} ask(s), {} answered, {} declined",
        r.asks.len(),
        r.answered(),
        declined.len()
    );
    for m in &declined {
        eprintln!("  DECLINED {}({})", m.what, m.key);
    }
    // The host side of the asks, by label (`fold::Ledger`), on stderr with the
    // counts: the fixture path has no `timing` map to carry it, and stdout is
    // the timeline.
    let ledger = backend::fold::LEDGER.take();
    if !ledger.is_empty() {
        let parts: Vec<String> = ledger
            .iter()
            .map(|(k, (n, ns))| format!("{k} {} ms ×{n}", ns / 1_000_000))
            .collect();
        eprintln!("  host: {}", parts.join(", "));
    }
    println!("{}", r.out);
    Ok(())
}

/// Build `/velocity`'s response for one day from production, calling the
/// handler's assembly directly (the route's gate is
/// `tests/suite/velocity_route.rs`): does the day assemble with every key the
/// frontend reads? The clip is applied.
///
/// ⚠ Real location data on stdout. Redirect to /tmp, never into the repo:
/// both health repos are public.
pub(crate) async fn velocity(
    user: &str,
    date: &str,
    display_tz: Option<&str>,
    walk_match: bool,
) -> Result<()> {
    let cfg = Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let st = backend::state::AppState::new(pool.clone(), cfg, reqwest::Client::new());

    let started = std::time::Instant::now();
    let body =
        backend::routes::velocity::compute_with(&st, user, date, display_tz, walk_match).await?;
    let compute_ms = started.elapsed().as_millis();

    // The per-request clip, so this prints what a caller sees; the cached value
    // for today asserts a future that has not happened.
    let now_s = chrono::Utc::now().timestamp();
    let states = body
        .get("states")
        .and_then(serde_json::Value::as_array)
        .map(|s| lean::clip_future(s, now_s, None))
        .transpose()?
        .unwrap_or_default();
    let clipped = states.len();
    let mut body = body;
    let before = body["states"].as_array().map_or(0, Vec::len);
    body["states"] = serde_json::Value::Array(states);
    pool.close().await;

    // Counts on stderr, body on stdout. A present but empty key is the failure
    // this catches: no points reads as a quiet day, not a broken join.
    let len = |k: &str| {
        body.get(k)
            .and_then(serde_json::Value::as_array)
            .map_or(0, Vec::len)
    };
    // The timing too. `fold` dominates and its cost is round trips, so
    // `mirrorQueries` beside it makes a laptop-over-SSH figure (~50x slower)
    // comparable to an in-cluster run.
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
        "points", "rawFixes", "segments", "states", "episodes", "journeys", "battery",
    ] {
        if body.get(k).is_none() {
            anyhow::bail!("the response has no `{k}` — the frontend reads it");
        }
    }
    println!("{body}");
    Ok(())
}

/// Does the live mirror answer a golden day's OSM questions as its captured row
/// set does? A count of answered keys proves nothing (a swapped `lat`/`lon`
/// answers "no ways", well-formed and wrong), so both sources get the same
/// questions. Drift moves `name`/`subtype`, more on older days; a defect empties
/// answers or moves every distance. Reports counts only: the answers name
/// places the user stood, and both health repos are public.
pub(crate) async fn mirror_check(fixture: &str) -> Result<()> {
    /// The tables a row source can answer (`nearbyWays` uses the default
    /// radius). Without `nearbyLandmarks` the check passed while every stay's
    /// landmarks answered empty.
    const TABLES: [&str; 4] = [
        "nearbyWays",
        "nearbyStations",
        "linesAtPoint",
        "nearbyLandmarks",
    ];

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
    let mut asks: Vec<backend::lean::Ask> = Vec::new();
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
            asks.push(backend::lean::Ask {
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
        .map(|m| offline.answer(m))
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
                .map(|m| answerer.answer(m))
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

    /// Which fields moved between two answers of the same width: only
    /// `distanceM` is a defect here (two paths reading the stored coordinate);
    /// `name`, `subtype` or `osmId` is OSM drift since the capture.
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
    #[expect(
        clippy::type_complexity,
        reason = "a map from source to the rows that differ, built once here"
    )]
    let mut differ: std::collections::BTreeMap<&str, Vec<(usize, usize, Vec<String>)>> =
        Default::default();
    for ((m, want), got) in asks.iter().zip(&from_rows).zip(&from_mirror) {
        match (want, got) {
            (Some(w), Some(g)) if w == g => agree += 1,
            // A decline is a finding about the mirror (no coverage where the
            // capture had rows), not a difference to average away.
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
        // Counts and field names, never values: a value is a street the user
        // walked down.
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

/// Run a day from the production database. `day-live` folds with `NoAnswers`,
/// declining everything, so it reports what a live answerer must supply (its
/// timeline is not one to judge). `day-mirror` walks the mirror and reports
/// the residue: unfetched areas and tables rows cannot answer. Neither is a
/// re-bless candidate; the corpus is.
///
/// ⚠ Real location data on stdout. Redirect to /tmp, never into the repo:
/// both health repos are public.
pub(crate) async fn day_live(
    user: &str,
    date: &str,
    display_tz: Option<&str>,
    from_mirror: bool,
) -> Result<()> {
    let cfg = Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let home_tz = sync_state::home_tz(&pool, user).await?;
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
    let pts = cap
        .pointer("/obs/points")
        .and_then(serde_json::Value::as_array)
        .map_or(0, Vec::len);
    eprintln!("head: {pts} smoothed point(s)");

    let r = if from_mirror {
        // The clock is read here and passed down: Lean's coverage rule takes
        // `nowMs`, so one walk cannot answer the same question two ways as
        // its staleness cutoff moves.
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .context("the system clock is before the epoch")?
            .as_millis() as i64;
        backend::mirror_source::fold_from_mirror(pool.clone(), cap.clone(), inputs.clone(), now_ms)
            .await?
    } else {
        // Nothing answers, so every ask is a key a live answerer must supply —
        // which is the measurement this arm exists to take.
        backend::fold::run_day(&cap, &inputs, &mut backend::lean::NoAnswers)?
    };
    pool.close().await;

    let declined = r.declined();
    let by_table = r.declined_by_table();
    eprintln!(
        "fold: {} ask(s); {} answered; {} a live answerer must supply",
        r.asks.len(),
        r.answered(),
        declined.len()
    );
    for (table, n) in &by_table {
        eprintln!("  {table}: {n}");
    }
    // `bestPlace` has an expected decline (the blank ask before `tzAt`
    // resolves), reported apart so it does not read as a miss.
    let early = declined
        .iter()
        .filter(|m| m.what == "bestPlace" && m.key.split('|').nth(4).is_none_or(str::is_empty))
        .count();
    if by_table.contains_key("bestPlace") {
        eprintln!("  ...of which bestPlace asked before its timezone resolved: {early}");
    }
    println!("{}", r.out);
    Ok(())
}

/// Render `/locations` for one day: floats (every fix's lat, lon, altitude,
/// speed and accuracy) and order (devices concatenated, then stably sorted, so
/// equal timestamps expose device order).
pub(crate) async fn locations_check(user: &str, date: &str) -> Result<()> {
    let cfg = Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    // The API path's default, not `None`-means-unconfigured: `NC_BASE_URL` is
    // empty on the serving pod, and bailing would test a configuration this
    // endpoint never sees.
    let base = cfg
        .nextcloud_base_url
        .clone()
        .unwrap_or_else(|| backend::classification_inputs::DAY_NEXTCLOUD_BASE_URL.to_string());

    let next = lean::next_day(date)?;
    let pt = backend::nextcloud::phonetrack::PhoneTrack::open(
        reqwest::Client::new(),
        &pool,
        &base,
        user,
    )
    .await?;
    let fetched = pt.fetch_range(&pool, date, &next).await?;
    // Reported, not swallowed: a non-zero count means `points` is a subset.
    if fetched.failed_devices > 0 {
        eprintln!(
            "locations-check: {} device(s) FAILED — this is a subset of the day",
            fetched.failed_devices
        );
    }
    let out: Vec<serde_json::Value> = fetched
        .points
        .iter()
        .map(|p| {
            // Through the JS number rule, as the route does, so this prints the
            // endpoint's rendering, not its own.
            use backend::row_json::{js_number_opt, js_number_value};
            serde_json::json!({
                "ts": p.ts,
                "lat": js_number_value(p.lat),
                "lon": js_number_value(p.lon),
                "altitude": js_number_opt(p.altitude),
                "speed": js_number_opt(p.speed),
                "accuracy": js_number_opt(p.accuracy),
                "battery": js_number_opt(p.battery),
            })
        })
        .collect();
    println!("locations\t{}", serde_json::to_string(&out)?);
    pool.close().await;
    Ok(())
}

/// Write a golden fixture for one day from the live database and the mirror:
/// `{meta, inputs, expected}`. The fold runs against the mirror recording every
/// answer (matcher reads as `osmTrace`, other rows as `osmRowSet`, declines with
/// them) and the timeline becomes `expected.statesOut`.
///
/// ⚠ Real location data in the file. `tests/golden` is gitignored and its
/// inner repository has no remote: commit there before overwriting a day, so a
/// re-capture can be reverted. Nothing here prints a coordinate.
pub(crate) async fn capture_day(
    user: &str,
    date: &str,
    display_tz: Option<&str>,
    out: &str,
) -> Result<()> {
    backend::lean::init().context("starting the Lean runtime")?;
    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let home_tz = sync_state::home_tz(&pool, user).await?;
    let display_tz = display_tz.unwrap_or(&home_tz).to_string();
    let bounds = backend::timezone::date_bounds_utc(date, Some(&display_tz))
        .with_context(|| format!("bounding {date} in {display_tz}"))?;
    let base_url = cfg
        .nextcloud_base_url
        .clone()
        .unwrap_or_else(|| classification_inputs::DAY_NEXTCLOUD_BASE_URL.to_string());
    let mut inputs = classification_inputs::load(
        &pool,
        &reqwest::Client::new(),
        &base_url,
        &classification_inputs::DayIdentity {
            user_id: user,
            date,
            display_tz: &display_tz,
        },
        bounds,
        Some(&home_tz),
    )
    .await?;
    let cap = backend::head::capture(&inputs, date, user)?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let (folded, row_set, mut trace, geocodes) =
        backend::mirror_source::fold_from_mirror_recording(
            pool.clone(),
            cap,
            inputs.clone(),
            now_ms,
        )
        .await?;
    pool.close().await;
    if let (Some(g), Some(t)) = (geocodes, trace.as_object_mut()) {
        t.insert("reverseGeocode".into(), g);
    }
    let answer: serde_json::Value =
        serde_json::from_str(&folded.out).context("the fold's answer is not JSON")?;
    let states = answer
        .get("states")
        .cloned()
        .context("the fold's answer has no states")?;
    let n_states = states.as_array().map_or(0, Vec::len);
    let by_table = folded.declined_by_table();
    let o = inputs
        .as_object_mut()
        .context("the inputs are not an object")?;
    o.insert("osmTrace".into(), trace);
    o.insert("osmRowSet".into(), row_set);
    let fixture = serde_json::json!({
        "meta": {
            "fixtureFormatVersion": 1,
            "capturedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "capturedAtCodeSha": std::env::var("GIT_SHA").unwrap_or_else(|_| "unknown".into()),
            "date": date,
            "user": user,
            "tz": display_tz,
            "description": "",
            // Without it a fixture cannot notice a capture setting moving, and
            // `check_capture_inputs` passes everything unstamped.
            "captureInputs": backend::osm_trace::capture_inputs(),
        },
        "inputs": inputs,
        // `velocity` is the same timeline: the corpus judges `statesOut`, and
        // `backend day` prints against `velocity`.
        "expected": { "statesOut": states.clone(), "velocity": states },
    });
    let text = fixture.to_string();
    std::fs::write(out, &text).with_context(|| format!("writing {out}"))?;
    eprintln!(
        "captured {date} for {user}: {} ask(s), {} answered, {n_states} state(s), {} MiB -> {out}",
        folded.asks.len(),
        folded.answered(),
        text.len() / (1024 * 1024)
    );
    for (table, n) in &by_table {
        eprintln!("  declined {table}: {n}");
    }
    Ok(())
}

/// Several days through the serving path in one process, for memory: the Lean
/// arena never returns memory, so the high-water is the heaviest day's, which
/// only a production-image Job under cgroup accounting shows. Read-only but a
/// production actor (connections, read locks). Repeat a day at the end: the
/// high-water does not fall back on a light one.
pub(crate) async fn velocity_many(user: &str, dates: &[String]) -> Result<()> {
    backend::lean::init().context("starting the Lean runtime")?;
    // The fold needs the database and nothing else; a measurement job must hold
    // no credential that could write a health stream.
    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let st = backend::state::AppState::new(pool.clone(), cfg, reqwest::Client::new());

    use backend::fold::rss_mib;
    println!("RSS before any fold   {:>5} MiB", rss_mib());
    let mut high = rss_mib();
    for (i, date) in dates.iter().enumerate() {
        let before = rss_mib();
        let t0 = std::time::Instant::now();
        // The same entry point as the HTTP route (slot, fold, heap handed
        // back, the trim). A cheaper harness would switch off the walk
        // matcher, the term most likely to ratchet.
        let body = backend::routes::velocity::fold_day(&st, user, date, None, true).await?;
        let ms = t0.elapsed().as_millis();
        let after = rss_mib();
        let states = body
            .get("states")
            .and_then(serde_json::Value::as_array)
            .map_or(0, Vec::len);
        // The high-water is the quantity: a fold that allocates and frees
        // leaves the arena grown, and `after` alone hides it.
        high = high.max(after);
        println!(
            "fold {:>2}  {date}  RSS {before:>4} -> {after:>4} MiB  ({:+})  high {high:>4}  \
             {states:>3} state(s)  {ms:>6} ms",
            i + 1,
            after as i64 - before as i64,
        );
        if let Some(t) = body.get("timing") {
            println!("         timing {t}");
        }
        // `VELOCITY_MANY_OUT=<dir>`: each day's served body, its timing left
        // out, to compare two builds of the same day.
        if let Some(dir) = std::env::var_os("VELOCITY_MANY_OUT") {
            let mut b = body.clone();
            if let Some(o) = b.as_object_mut() {
                o.remove("timing");
            }
            std::fs::write(
                std::path::Path::new(&dir).join(format!("{date}.json")),
                b.to_string(),
            )
            .context("writing VELOCITY_MANY_OUT")?;
        }
    }
    pool.close().await;
    println!("high-water            {high:>5} MiB");
    // The container's number, not this process's: the Lean workers share the
    // cgroup and the OOM killer judges the sum. The deploy's smoke step reads
    // this line.
    match backend::fold::cgroup_memory() {
        Some((peak, oom)) => println!("cgroup peak           {peak:>5} MiB  oom_kill {oom}"),
        None => println!("cgroup peak               - MiB  (no cgroup v2 here)"),
    }
    Ok(())
}

/// `recapture-walkable`: re-record only a golden fixture's `walkableRoads` from
/// the live mirror, in place ([`backend::mirror_source::rerecord_walkable`]).
/// This brings in every OSM edit since the capture: read what moves before
/// blessing, a `wayName` move especially.
pub(crate) async fn recapture_walkable(user: &str, fixture_path: &str) -> Result<()> {
    backend::lean::init().context("starting the Lean runtime")?;
    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let text =
        std::fs::read_to_string(fixture_path).with_context(|| format!("reading {fixture_path}"))?;
    let mut fixture: serde_json::Value =
        serde_json::from_str(&text).with_context(|| format!("parsing {fixture_path}"))?;
    let date = fixture
        .pointer("/meta/date")
        .and_then(serde_json::Value::as_str)
        .context("the fixture has no meta.date")?
        .to_string();
    let before = fixture
        .pointer("/inputs/osmTrace/walkableRoads")
        .and_then(serde_json::Value::as_object)
        .map_or(0, serde_json::Map::len);
    let now_ms = chrono::Utc::now().timestamp_millis();
    let (folded, section) = backend::mirror_source::rerecord_walkable(
        pool.clone(),
        fixture.clone(),
        user.to_string(),
        date.clone(),
        now_ms,
    )
    .await?;
    pool.close().await;
    let after = section.as_object().map_or(0, serde_json::Map::len);
    let trace = fixture
        .pointer_mut("/inputs/osmTrace")
        .and_then(serde_json::Value::as_object_mut)
        .context("the fixture has no osmTrace to merge into")?;
    trace.insert("walkableRoads".into(), section);
    let meta = fixture
        .get_mut("meta")
        .and_then(serde_json::Value::as_object_mut)
        .context("the fixture has no meta")?;
    let stamp = meta
        .entry("captureInputs")
        .or_insert_with(|| serde_json::json!({}));
    if let Some(o) = stamp.as_object_mut() {
        o.insert(
            "walkableRoadSubtypes".into(),
            backend::osm_trace::capture_inputs()["walkableRoadSubtypes"].clone(),
        );
    }
    meta.insert(
        "walkableRecapturedAt".into(),
        serde_json::json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    );
    std::fs::write(fixture_path, fixture.to_string())
        .with_context(|| format!("writing {fixture_path}"))?;
    eprintln!(
        "re-recorded walkableRoads for {date}: {before} -> {after} key(s); \
         fold {} ask(s), {} answered -> {fixture_path}",
        folded.asks.len(),
        folded.answered()
    );
    for (table, n) in &folded.declined_by_table() {
        eprintln!("  declined {table}: {n}");
    }
    Ok(())
}

/// `recapture-asks USER FIXTURE`: answer from the live mirror only the lookups
/// the fixture's own record cannot, and add those answers to it. Nothing the
/// day was blessed on changes; see [`backend::mirror_source::rerecord_unanswered`].
pub(crate) async fn recapture_asks(user: &str, fixture_path: &str) -> Result<()> {
    backend::lean::init().context("starting the Lean runtime")?;
    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let text =
        std::fs::read_to_string(fixture_path).with_context(|| format!("reading {fixture_path}"))?;
    let mut fixture: serde_json::Value =
        serde_json::from_str(&text).with_context(|| format!("parsing {fixture_path}"))?;
    let date = fixture
        .pointer("/meta/date")
        .and_then(serde_json::Value::as_str)
        .context("the fixture has no meta.date")?
        .to_string();
    let now_ms = chrono::Utc::now().timestamp_millis();
    // The fold that asks is the gate's: on the frozen twin's blessed decode,
    // not the capture's own, so the lookups re-recorded are the ones the
    // served day makes. The fixture written back keeps its capture.
    let mut folding = fixture.clone();
    if let Some(stored) = backend::decode_fixture::stored_decode(&date, user)? {
        folding["inputs"]["hsmmDecode"] = stored;
    }
    let (folded, matcher, geocodes, rows) = backend::mirror_source::rerecord_unanswered(
        pool.clone(),
        folding,
        user.to_string(),
        date.clone(),
        now_ms,
    )
    .await?;
    pool.close().await;
    // Rows belong in `osmRowSet`, whose shape this does not merge: a day that
    // needs them needs a full `capture-day`.
    anyhow::ensure!(
        rows == 0,
        "{date}: the mirror served {rows} map row(s) the fixture lacks; re-capture the day instead"
    );
    let trace = fixture
        .pointer_mut("/inputs/osmTrace")
        .and_then(serde_json::Value::as_object_mut)
        .context("the fixture has no osmTrace to merge into")?;
    let mut added = 0usize;
    let sections = matcher
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| (k.clone(), v.clone()))
        .chain(geocodes.map(|g| ("reverseGeocode".to_string(), g)));
    for (table, answers) in sections {
        let dst = trace
            .entry(table)
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .context("an osmTrace section is not an object")?;
        for (key, answer) in answers.as_object().into_iter().flatten() {
            if !dst.contains_key(key) {
                dst.insert(key.clone(), answer.clone());
                added += 1;
            }
        }
    }
    std::fs::write(fixture_path, fixture.to_string())
        .with_context(|| format!("writing {fixture_path}"))?;
    eprintln!(
        "{date}: {added} answer(s) added; fold {} ask(s), {} answered -> {fixture_path}",
        folded.asks.len(),
        folded.answered()
    );
    Ok(())
}

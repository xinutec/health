//! One day, end to end: `inputs`, `head`, `day`, `velocity`, `velocity-many`,
//! `mirror-check`, `locations-check`, and the live day fold behind them.

use anyhow::{Context, Result};
use backend::lean::Answerer;
use backend::{classification_inputs, config::Config, db, lean, sync_state};

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
pub(crate) async fn inputs(user: &str, date: &str, display_tz: Option<&str>) -> Result<()> {
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
/// The chain end to end with no database. The fold's asks are answered from
/// the fixture's recorded trace first and its OSM row set second — the same
/// pair the corpus gates replay against.
///
/// The oracle is `expected.velocity` in the same file. This prints the timeline
/// rather than judging it — `tests/corpus/day.rs` is what compares.
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
    let inputs = parsed.get("inputs").context("the fixture has no inputs")?;

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

    // ⚠ On stderr, so stdout stays a clean timeline to diff. A fold that had
    // asks declined produced a timeline from DEFAULTS for them, and that is
    // not the same day — it has to be visible without reading the JSON.
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
        "points", "rawFixes", "segments", "states", "episodes", "journeys", "battery",
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
pub(crate) async fn mirror_check(fixture: &str) -> Result<()> {
    /// The tables a row source can answer. `nearbyWays` spells no radius in its
    /// key — the answerer uses the default.
    ///
    /// ⚠ `nearbyLandmarks` BELONGS HERE, and its absence is what let #1054 run.
    /// This check reported 148/148 agreement on 2026-08-22 while the landmark
    /// shaping was answering an EMPTY list for every stay in every day — the
    /// one table that puts a venue name on a timeline was the one table not
    /// compared. A check that omits the thing it is trusted to cover reads as
    /// evidence and is not.
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
    #[allow(
        clippy::type_complexity,
        reason = "a map from source to the rows that differ, built once here"
    )]
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
/// **`day-live`** folds with `NoAnswers`, which declines everything. The keys
/// it reports are exactly what a live answerer has to supply — a measurement,
/// not a failure. ⚠ Its timeline was built from DEFAULTS for every key listed,
/// so it is not a day to judge.
///
/// **`day-mirror`** walks with [`mirror_source::MirrorSource`], which answers
/// what the local OSM mirror covers. What it still reports as unanswerable is
/// the residue: areas nobody has fetched, plus the three tables no row set can
/// answer (`reverseGeocode`, `nearbyLandmarks`, `transitStops` — see
/// `rowset_answerer`'s catch-all).
///
/// ⚠ Its timeline is not a re-bless candidate — the corpus is what the re-bless
/// compares. The mirror source hands Lean every candidate in the box rather than
/// MariaDB's `ORDER BY ST_Distance … LIMIT 50`, which is the point (#413).
///
/// ⚠ HOW FAR IT DIVERGES FROM PRODUCTION IS UNMEASURED. #413 records 0 of 315
/// timeline states differing for the oracle swap alone, so "they disagree by
/// construction" is a stronger claim than anything measured.
///
/// ⚠ REAL LOCATION DATA on stdout — where the user was and when. Redirect to
/// /tmp, never into the repo: both health repos are public.
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
    // ⚠ `bestPlace` has an EXPECTED decline that is not a gap, and the count
    // alone cannot tell it from one. The fold asks a stay's naming question once
    // before `tzAt` has resolved its zone and again after; the blank spelling is
    // a question asked too early, and answering it with UTC would put a second
    // row on the table for the same stay keyed differently. Splitting it here is
    // what makes "4 unanswered" readable as "4 early asks, none missed".
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

/// Render `/locations` for one day and print it, for diffing against the
/// TypeScript (#982).
///
/// ⚠ What this actually tests is FLOATS AND ORDER, which no unit test here can
/// reach. Each fix carries lat, lon, altitude, speed and accuracy as JSON
/// numbers that cross V8 on one side and serde_json on the other —
/// `Verified.RowShape` refuses DOUBLE columns for exactly that reason, so
/// "these render identically" is a claim that has to be measured. And both
/// implementations concatenate across devices before a STABLE sort by `ts`, so
/// equal timestamps expose the device-walk order: a `HashMap` iteration in Rust
/// against a JSON object's insertion order in TypeScript.
///
/// Its TypeScript twin (`scripts/locations-check-ts.mjs`) is deleted with the
/// rest of the `dist/` callers (#1225); this is the only arm now.
pub(crate) async fn locations_check(user: &str, date: &str) -> Result<()> {
    let cfg = Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    // ⚠ The API path's default, NOT `None`-means-unconfigured. NC_BASE_URL is
    // empty on the serving pod and the TypeScript defaults it, so a check that
    // bailed here would be measuring a configuration this endpoint never sees.
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
    // ⚠ Reported, not swallowed: a non-zero count means `points` is a SUBSET,
    // so a diff against it would be comparing two different questions.
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
            // ⚠ Through the JS number rule, exactly as the route does — a
            // check that serialised these differently would be diffing its own
            // rendering rather than the endpoint's.
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

/// Several days through the SERVING path, in ONE process (#1071).
///
/// # Why this is a VERB and not an example
///
/// The Lean arena never returns memory to the OS, so a process's high-water is
/// set by the heaviest thing it has ever done. Measuring that needs several
/// DIFFERENT days without restarting — and measuring it where it MATTERS needs
/// Linux cgroup accounting, which means a Job, which means the production
/// image.
///
/// ⚠ **IT HAS TO BE THIS BINARY.** A debug image would measure a different
/// artefact than production serves, which for a memory question gives up the
/// one thing worth having. Pippijn's call, 2026-09-20: "We should be allowed to
/// debug the one running in prod." The image already ships thirteen read-only
/// diagnostic verbs; this is the fourteenth.
///
/// ⚠ **WHY THE LIVE POD CANNOT ANSWER IT.** Measured 2026-09-20: the serving
/// pod had folded ONE day in 25 hours. Accumulation across a pod's life is not
/// observable when that life contains one fold, so the load has to be driven.
///
/// ⚠ **READ-ONLY, AND STILL A PRODUCTION ACTOR.** `compute_with` only reads,
/// but it takes connections and read locks like any client.
///
/// ⚠ Repeat a day at the END to prove the ratchet: if the high-water tracked
/// the CURRENT day it would fall back on a light one. It does not.
pub(crate) async fn velocity_many(user: &str, dates: &[String]) -> Result<()> {
    backend::lean::init().context("starting the Lean runtime")?;
    // ⚠ `from_env_batch`, NOT `from_env`. The fold needs the DATABASE and
    // nothing else; `from_env` demands the Fitbit credentials and this died in
    // its first Job on `missing required env var FITBIT_CLIENT_ID`. Carrying
    // them would also hand a MEASUREMENT job the ability to write to a health
    // stream, which is the posture every other batch verb refuses.
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
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
        // ⚠ The SAME entry point the HTTP route uses — slot, fold, heap handed
        // back. Anything cheaper would measure a path production does not
        // take: the walk matcher, the term most likely to be ratcheting, is
        // exactly what a cheaper harness switches off, and `compute_with` alone
        // would skip the trim the route runs (#1071).
        let body = backend::routes::velocity::fold_day(&st, user, date, None, true).await?;
        let ms = t0.elapsed().as_millis();
        let after = rss_mib();
        let states = body
            .get("states")
            .and_then(serde_json::Value::as_array)
            .map_or(0, Vec::len);
        // ⚠ The HIGH-WATER is the quantity, not the current reading: a fold that
        // allocates and frees leaves the arena grown, and `after` alone hides it.
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
    }
    pool.close().await;
    println!("high-water            {high:>5} MiB");
    // ⚠ THE CONTAINER'S number, not this process's: the Lean workers sit beside
    // it in the same cgroup, and the OOM killer judges the sum. The deploy's
    // smoke step reads this line.
    match backend::fold::cgroup_memory() {
        Some((peak, oom)) => println!("cgroup peak           {peak:>5} MiB  oom_kill {oom}"),
        None => println!("cgroup peak               - MiB  (no cgroup v2 here)"),
    }
    Ok(())
}

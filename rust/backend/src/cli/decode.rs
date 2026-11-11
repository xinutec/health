//! The HSMM decode of a day and the OSM rows it needs: `decode-day` and the
//! day-level OSM loaders shared with `day-live`.

use anyhow::{Context, Result};
use backend::rail_route::{RAIL_CORRIDOR_LINE_LIMIT, line_bits, parse_point_wkt};
use backend::{db, decode_fixture};

/// Persist a day's HSMM decode, overwriting any existing row.
///
/// ⚠ `classifier_version` is read back: `loadDecode` returns null on a mismatch
/// so readers re-decode rather than serve stale segments. A wrong number here
/// fails nothing; every reader just discards the row and recomputes, which
/// looks like a slow cache.
pub(crate) async fn save_decode(
    pool: &sqlx::MySqlPool,
    user_id: &str,
    date: &str,
    segments: &serde_json::Value,
    inputs_through: i64,
) -> Result<()> {
    // `decoded_at` is the write's own moment, every write: it defaulted only on
    // the first insert, so a re-decode kept the first decode's time.
    sqlx::query(
        "INSERT INTO decoded_days (user_id, date, classifier_version, segments_json, inputs_through) \
         VALUES (?, ?, ?, ?, ?) \
         ON DUPLICATE KEY UPDATE classifier_version = VALUES(classifier_version), \
                                 segments_json = VALUES(segments_json), \
                                 inputs_through = VALUES(inputs_through), \
                                 decoded_at = CURRENT_TIMESTAMP",
    )
    .bind(user_id)
    .bind(date)
    .bind(CLASSIFIER_VERSION)
    .bind(serde_json::to_string(segments)?)
    .bind(inputs_through)
    .execute(pool)
    .await
    .with_context(|| format!("writing decoded_days for {user_id} {date}"))?;
    Ok(())
}

/// Declared once, in `classification_inputs`.
use crate::classification_inputs::CLASSIFIER_VERSION;

/// Decode a day's HSMM and persist it to `decoded_days`.
///
/// The whole model is built and decoded in Lean: `assemblesegments` takes raw
/// `edges`/`nodes`/`obs`/`places`, builds the route-graph model, the coverage
/// map and the trellis, decodes, and groups the path into segments. Nothing
/// here constructs a model, so no tens-of-MiB quantised payload crosses.
pub(crate) async fn decode_day(
    user: Option<&str>,
    dates: &[String],
    days: Option<i64>,
    dry_run: bool,
) -> Result<()> {
    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    backend::schema::migrate(&pool).await?;
    let st = backend::state::AppState::new(pool.clone(), cfg, reqwest::Client::new());

    let users: Vec<String> = match user {
        Some(u) => vec![u.to_string()],
        None => sqlx::query_scalar("SELECT user_id FROM nc_tokens")
            .fetch_all(&pool)
            .await
            .context("listing users")?,
    };

    let (mut attempted, mut failed, mut written) = (0u32, 0u32, 0u32);
    for user_id in &users {
        let tz = backend::sync_state::home_tz(&pool, user_id).await?;
        let targets: Vec<String> = if dates.is_empty() {
            backend::classification_inputs::decode_window(
                chrono::Utc::now(),
                days.unwrap_or(DECODE_DEFAULT_DAYS),
            )
        } else {
            dates.to_vec()
        };

        // The days are independent: `DECODE_JOBS` of them decode at once (each
        // in its own task, the Lean decode a blocking call), 1 by default — the
        // cluster's job has one CPU. A Mac re-decode of the history sets it to
        // the cores it can spare; a heavy day's worker peaks near half a GiB.
        let jobs: usize = std::env::var("DECODE_JOBS")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|n| *n >= 1)
            .unwrap_or(1);
        let gate = std::sync::Arc::new(tokio::sync::Semaphore::new(jobs));
        let mut tasks = tokio::task::JoinSet::new();
        for date in targets.clone() {
            let (st, pool, user_id, tz, gate) = (
                st.clone(),
                pool.clone(),
                user_id.clone(),
                tz.clone(),
                gate.clone(),
            );
            tasks.spawn(async move {
                let _permit = gate.acquire_owned().await;
                let r = decode_one(&st, &pool, &user_id, &date, &tz, dry_run).await;
                (date, r)
            });
        }
        while let Some(joined) = tasks.join_next().await {
            let (date, result) = joined.context("a decode task panicked")?;
            attempted += 1;
            match result {
                Ok(n) => {
                    // `decode_one` already printed the dry-run line.
                    if !dry_run {
                        eprintln!("[{user_id} {date}] {n} segments");
                    }
                    written += 1;
                }
                Err(e) => {
                    // One bad day must not strand the rest of the window; the
                    // refusal below catches every day failing.
                    eprintln!("[{user_id} {date}] decode failed: {e:#}");
                    failed += 1;
                }
            }
        }
    }

    // ⚠ A dry run wrote nothing and must not say "written": this line is what
    // gets grepped to learn whether the row was replaced.
    eprintln!(
        "decode-day: {written} {}, {failed} failed of {attempted} day(s)",
        if dry_run {
            "decoded (DRY RUN, nothing written)"
        } else if std::env::var_os("DECODE_HANDOFF").is_some() {
            "handed to the decode watch (nothing written here)"
        } else {
            "written"
        }
    );
    // ⚠ Refuse rather than report success on nothing, as `refresh-rail-routes`
    // does: every day failing is a broken run; a day with no data is not.
    if failed > 0 && failed == attempted {
        pool.close().await;
        anyhow::bail!(
            "every one of the {attempted} day(s) failed to decode — refusing to report a \
             successful run over no evidence (#1134)"
        );
    }
    pool.close().await;
    Ok(())
}

/// One day: gather, decode in Lean, persist.
pub(crate) async fn decode_one(
    st: &backend::state::AppState,
    pool: &sqlx::MySqlPool,
    user_id: &str,
    date: &str,
    tz: &str,
    dry_run: bool,
) -> Result<usize> {
    let bounds = backend::timezone::date_bounds_utc(date, Some(tz))?;
    let loaded_at = chrono::Utc::now().timestamp();
    // Where building the request goes, one line a decode: the loader's reads,
    // then each step below.
    let mut clock = std::time::Instant::now();
    let mut steps: Vec<(&'static str, u128)> = Vec::new();
    let mut step = |name: &'static str, steps: &mut Vec<(&'static str, u128)>| {
        steps.push((name, clock.elapsed().as_millis()));
        clock = std::time::Instant::now();
    };
    let (inputs, reads) = backend::classification_inputs::load_timed(
        pool,
        &st.http,
        &backend::config::focus_nc_base_url(),
        &backend::classification_inputs::DayIdentity {
            user_id,
            date,
            display_tz: tz,
        },
        bounds,
        Some(tz),
    )
    .await?;
    step("load", &mut steps);
    // A day that observes nothing has nothing to decode. Where its bracket
    // agrees — the day before ended at a place and the day after was mostly
    // there (`empty_day_bracket`) — it is one stay there, written as its
    // decode; with no bracket it stays undecoded, which is the rule's own
    // answer: it does not guess.
    if inputs.get("emptyDayBracket").is_some_and(|b| !b.is_null()) {
        let h = backend::head::run(&inputs, date)?;
        if h.points.is_empty()
            && let Some(place) =
                backend::classification_inputs::empty_day_bracket_place(pool, user_id, date).await?
        {
            let segments = serde_json::json!([{
                "startTs": bounds.start_utc, "endTs": bounds.end_utc,
                "mode": "stationary", "placeId": place, "lineName": null,
            }]);
            if dry_run {
                println!("{}", serde_json::to_string(&segments[0])?);
                eprintln!(
                    "[{user_id} {date}] DRY RUN — a bracketed day: 1 segment, nothing written"
                );
                return Ok(1);
            }
            let inputs_through = backend::decode_freshness::horizon(
                bounds.end_utc,
                inputs
                    .pointer("/biometrics/stepsThrough")
                    .and_then(serde_json::Value::as_i64),
                loaded_at,
            );
            save_decode(pool, user_id, date, &segments, inputs_through).await?;
            return Ok(1);
        }
    }
    // `head::capture` owns the observation tensor; nothing here rebuilds it.
    let cap = backend::head::capture(&inputs, date, user_id)?;
    let obs = cap.get("obs").context("capture has no obs")?.clone();
    step("capture", &mut steps);

    // ── the route graph, from the mirror ────────────────────────────────────
    let (ways, stops) = route_graph_rows(pool, user_id, &obs).await?;
    step("graph rows", &mut steps);
    let (edges, nodes) = backend::lean::build_wire_graph(&ways, &stops)?;
    step("graph wire", &mut steps);
    // The graph's size is evidence: `emitLeg` is a margin test (a station is
    // named only when every rival trails by `MARGIN_NATS`), so the number of
    // stations in range decides whether a leg resolves, and two runs that box
    // different regions resolve differently with identical scoring.
    println!(
        "graph {date}: {} ways, {} stops -> {} edges, {} nodes",
        ways.len(),
        stops.len(),
        edges.as_array().map_or(0, Vec::len),
        nodes.as_array().map_or(0, Vec::len)
    );

    // ── the observation tensor's raw materials ──────────────────────────────
    // ⚠ The tensor is built in Lean, not here: shipping 1440 assembled rows is
    // the payload this design avoids. What crosses is the day's fixes and two
    // impure lookups, a timezone and an OSM query.
    //
    // Outliers are dropped once, here, and the same cleaned list feeds both
    // the tensor and the proximity lookups, so the two cannot disagree.
    let cleaned = backend::lean::drop_gps_outliers(&gps_fixes(&obs)?)?;
    step("outliers", &mut steps);
    // ⚠ The decoder's places are not `focus_places` rows: `knownPlaces` names
    // the columns (`centroidLat`, `totalDwellSec`, `displayName`), the decode
    // wire the concepts (`lat`, `dwell`, `name`). The row shape is refused by
    // name; see `decode_places` and its request test.
    let places = backend::classification_inputs::decode_places(inputs.get("knownPlaces"))?;
    let osm = day_osm(pool, bounds.start_utc, bounds.end_utc, &cleaned, &places).await?;
    println!("osm {date}: {}", osm.note);
    step("osm", &mut steps);

    // ⚠ The chain seed is four fields: `priorPlaceId` alone is refused with
    // `property not found: hoursSince`.
    let continuity = load_continuity(pool, user_id, date, &places).await?;
    step("continuity", &mut steps);
    let mut slow = reads.clone();
    slow.sort_by_key(|(_, ms)| std::cmp::Reverse(*ms));
    println!(
        "request {date}: {} · load's slowest reads {}",
        steps
            .iter()
            .map(|(n, ms)| format!("{n} {ms} ms"))
            .collect::<Vec<_>>()
            .join(", "),
        slow.iter()
            .take(4)
            .map(|(n, ms)| format!("{n} {ms} ms"))
            .collect::<Vec<_>>()
            .join(", ")
    );

    let mut req = serde_json::json!({
        "observation": {
            "startUtc": bounds.start_utc,
            "points": cleaned.iter().map(|p| serde_json::json!({
                "ts": p.ts, "lat": p.lat, "lon": p.lon, "speedKmh": p.speed_kmh,
                "accuracyM": p.accuracy_m
            })).collect::<Vec<_>>(),
            "hr": obs.get("hr").cloned().unwrap_or(serde_json::json!([])),
            "steps": obs.get("steps").cloned().unwrap_or(serde_json::json!([])),
            "sleep": obs.get("sleep").cloned().unwrap_or(serde_json::json!([])),
            "localCtx": backend::timezone::local_ctx_table(bounds.start_utc, bounds.end_utc, tz)?,
            "proximity": osm.proximity,
        },
        "edges": edges,
        "nodes": nodes,
        "places": places,
        // ⚠ Absent is not neutral: `parseAssemble` reads a missing
        // `placeNearLine` as the empty set, which drops every place→line hard
        // zero, and the decode looks plausible while permitting forbidden
        // boardings.
        "placeNearLine": osm.place_near_line,
        "railStopRelations": inputs.get("railStopsCache").cloned().unwrap_or(serde_json::Value::Null),
        "continuity": continuity,
        // `maxD` is absent on purpose: it is the trellis depth, and
        // `Verified.Hsmm.Assemble.DEFAULT_MAX_DURATION` holds it. The decoder
        // parameters (`DECODER_PARAMS`, below) carry their own.
        "flags": {},
        "date": date,
        "tz": tz,
    });
    // The fitted decoder (`backend::decoder_params`): its numbers and form, from
    // the Secret the pod mounts. Without it a decode would be the unfitted model
    // and stored as if it were the served one, so none is an error.
    let params = backend::decoder_params::from_env(date)?.context(
        "no decoder record: set DECODER_PARAMS_JSON (the pod's Secret) or DECODER_PARAMS",
    )?;
    backend::decoder_params::apply(&mut req, &params)?;
    // What these inputs were complete through, taken as they were loaded.
    let inputs_through = backend::decode_freshness::horizon(
        bounds.end_utc,
        inputs
            .pointer("/biometrics/stepsThrough")
            .and_then(serde_json::Value::as_i64),
        loaded_at,
    );
    // `DECODE_HANDOFF=<path>`: the request and what its inputs are complete
    // through, for the decode watch's own worker to decode from the day's
    // previous run (`decode_today`); nothing decodes or writes here.
    if let Ok(path) = std::env::var("DECODE_HANDOFF") {
        let handoff = serde_json::json!({ "request": req, "inputsThrough": inputs_through });
        std::fs::write(&path, serde_json::to_vec(&handoff)?)
            .with_context(|| format!("writing {path}"))?;
        return Ok(0);
    }

    // `DECODE_REQ_DUMP=<dir>`: the live request, as `<dir>/<date>.json`, to set
    // beside a frozen day's (`examples/dump_decode_request`) when the two decode
    // differently.
    if let Ok(dir) = std::env::var("DECODE_REQ_DUMP") {
        let path = std::path::Path::new(&dir).join(format!("{date}.json"));
        std::fs::write(&path, req.to_string())
            .with_context(|| format!("writing {}", path.display()))?;
    }
    // `DECODE_CAPTURE=<dir>`: the day as a frozen decoder fixture, format 3 —
    // the request itself beside an empty `expected`, which `DECODE_BLESS` fills
    // (`decode_fixture::request` reads it back). A capture never writes the
    // database: it refuses outside a dry run.
    if let Ok(dir) = std::env::var("DECODE_CAPTURE") {
        anyhow::ensure!(dry_run, "DECODE_CAPTURE is a dry-run tool: pass --dry-run");
        let path = std::path::Path::new(&dir).join(format!("{date}-{user_id}.json"));
        let fx = serde_json::json!({
            "meta": { "fixtureFormatVersion": 3, "date": date, "tz": tz, "user": user_id },
            "request": req,
            "expected": [],
        });
        std::fs::write(&path, serde_json::to_string(&fx)?)
            .with_context(|| format!("writing {}", path.display()))?;
    }
    // Blocking Lean work: the runtime moves its other tasks off this thread, so
    // `DECODE_JOBS` days decode side by side.
    //
    // ⚠ `None` is degenerate: Lean found no viable path. That is a real answer
    // about the day, and must not be written as zero segments, which would
    // read as "decoded, nothing happened".
    let Some(segments) = tokio::task::block_in_place(|| backend::lean::assemble_segments(&req))?
    else {
        anyhow::bail!("the decode is degenerate — no viable path");
    };
    let segments = backend::row_json::render_segments(&segments)?;
    let n = segments.as_array().map_or(0, Vec::len);
    if dry_run {
        // One segment per line, exactly as `segments_json` holds it (field
        // order, encodings, absent versus null), so two runs compare by `diff`.
        for seg in segments.as_array().unwrap_or(&Vec::new()) {
            println!("{}", serde_json::to_string(seg)?);
        }
        eprintln!("[{user_id} {date}] DRY RUN — {n} segments, nothing written");
        return Ok(n);
    }
    save_decode(pool, user_id, date, &segments, inputs_through).await?;
    Ok(n)
}

/// The prior day's end-of-day seed, shaped as `parseContinuity` reads it, or
/// `null`, a legitimate chain start.
///
/// ⚠ Four fields, not one: `priorPlaceId` alone is refused with `property not
/// found: hoursSince`. `priorPlaceCoord` is a `[lat, lon]` pair on the wire.
///
/// Three absences, read separately though all answer null: no row (a chain
/// start), a NULL `end_of_day_place_id` (the day ended nowhere known), and no
/// `end_of_day_ts` (the seed's staleness is unknown).
///
/// ⚠ sqlx types that fail on real rows only: `presence_log.*_place_id` is INT
/// UNSIGNED, so `u64`; `end_of_day_posterior` is FLOAT, so `f32`, widened
/// exactly.
///
/// The timestamp is read with `UNIX_TIMESTAMP`, mirroring the `FROM_UNIXTIME`
/// that `refresh-presence-log` writes it with, so the seed's staleness does
/// not depend on the session timezone.
///
/// The coordinate comes from the places already in hand, so it is one the
/// trellis has a state for. A prior place that is no longer a focus place
/// yields a null coord, the documented ungated case.
pub(crate) async fn load_continuity(
    pool: &sqlx::MySqlPool,
    user_id: &str,
    date: &str,
    places: &serde_json::Value,
) -> Result<serde_json::Value> {
    use sqlx::Row as _;
    let prev = backend::classification_inputs::shift_day(date, -1)?;
    let Some(row) = sqlx::query(
        "SELECT end_of_day_place_id, \
                CAST(UNIX_TIMESTAMP(end_of_day_ts) AS SIGNED) AS end_of_day_unix, \
                end_of_day_posterior \
         FROM presence_log WHERE user_id = ? AND date = ?",
    )
    .bind(user_id)
    .bind(&prev)
    .fetch_optional(pool)
    .await
    .context("reading the prior day's presence_log")?
    else {
        return Ok(serde_json::Value::Null);
    };
    let Some(place_id) = row.try_get::<Option<u64>, _>("end_of_day_place_id")? else {
        return Ok(serde_json::Value::Null);
    };
    let Some(last_fix) = row.try_get::<Option<i64>, _>("end_of_day_unix")? else {
        return Ok(serde_json::Value::Null);
    };
    let posterior = f64::from(row.try_get::<f32, _>("end_of_day_posterior")?);

    // ⚠ UTC midnight of the decoded date, not local midnight nor the day's
    // `startUtc`: in London those differ by an hour for half the year, and
    // the difference lands in the continuity factor's time decay.
    let today_start = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .with_context(|| format!("{date:?} is not a YYYY-MM-DD date"))?
        .and_hms_opt(0, 0, 0)
        .context("midnight is representable")?
        .and_utc()
        .timestamp();
    let hours_since = (((today_start - last_fix) as f64) / 3600.0).max(0.0);

    let coord = places
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .find(|p| p.get("id").and_then(serde_json::Value::as_u64) == Some(place_id))
        .and_then(|p| Some(serde_json::json!([p.get("lat")?, p.get("lon")?])))
        .unwrap_or(serde_json::Value::Null);

    Ok(serde_json::json!({
        "priorPlaceId": place_id,
        "priorPlaceCoord": coord,
        "hoursSince": hours_since,
        "priorPosterior": posterior,
    }))
}

/// `head::capture`'s `obs.points` as fixes.
///
/// ⚠ These are the velocity pipeline's points, not the raw ones. `rawFixes`
/// builds the route-graph bbox, a wider set on purpose, so the graph contains
/// the day even where the pipeline dropped fixes.
pub(crate) fn gps_fixes(obs: &serde_json::Value) -> Result<Vec<backend::lean::GpsFix>> {
    let rows = obs
        .get("points")
        .and_then(serde_json::Value::as_array)
        .context("capture's obs has no points")?;
    let f = |r: &serde_json::Value, k: &str| -> Result<f64> {
        r.get(k)
            .and_then(serde_json::Value::as_f64)
            .with_context(|| format!("a fix has no numeric {k}"))
    };
    rows.iter()
        .map(|r| {
            Ok(backend::lean::GpsFix {
                ts: r
                    .get("ts")
                    .and_then(serde_json::Value::as_i64)
                    .context("a fix has no ts")?,
                lat: f(r, "lat")?,
                lon: f(r, "lon")?,
                speed_kmh: f(r, "speedKmh")?,
                accuracy_m: r.get("accuracyM").and_then(serde_json::Value::as_f64),
            })
        })
        .collect()
}

/// Everything the decode needs from OSM, gathered in one trip to the mirror.
///
/// ⚠ Two unrelated questions through one door, because the mirror is
/// blocking-thread only: `with_mirror_answerer`'s closure cannot await, and a
/// second `MirrorSource` built on a runtime worker aborts the process.
pub(crate) struct DayOsm {
    /// The sparse `[minuteTs, road, rail]` table, opaque — it goes into the
    /// assemble request unread.
    pub(crate) proximity: serde_json::Value,
    /// `"{placeId}|{lineName}"` keys the transition matrix hard-zeroes against.
    pub(crate) place_near_line: Vec<String>,
    /// What the mirror could and could not answer, for the run's log line.
    pub(crate) note: String,
}

pub(crate) async fn day_osm(
    pool: &sqlx::MySqlPool,
    start_utc: i64,
    end_utc: i64,
    points: &[backend::lean::GpsFix],
    places: &serde_json::Value,
) -> Result<DayOsm> {
    let pts: Vec<(i64, f64, f64)> = points.iter().map(|p| (p.ts, p.lat, p.lon)).collect();
    let plan = backend::lean::proximity_queries(start_utc, end_utc, &pts)?;
    let minute_count = plan.minutes.as_array().map_or(0, Vec::len);
    let asked = plan.queries.len();

    // The line list is Lean's; see `lean::known_lines`.
    let lines = backend::lean::known_lines()?;
    let place_coords: Vec<(i64, f64, f64)> = places
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|p| {
            Some((
                p.get("id")?.as_i64()?,
                p.get("lat")?.as_f64()?,
                p.get("lon")?.as_f64()?,
            ))
        })
        .collect();

    let queries = plan.queries.clone();
    let now_ms = chrono::Utc::now().timestamp_millis();
    let want_lines = lines.clone();
    let (answers, stations) =
        backend::mirror_source::with_mirror_answerer(pool.clone(), now_ms, move |ans| {
            let mut out = Vec::with_capacity(queries.len());
            for q in &queries {
                // ⚠ `None` is "the mirror could not vouch for this coordinate",
                // not "nothing here": an empty way list would tell the decoder
                // there is no railway within 300 m, evidence against rail.
                let Some(ways) = ans.nearby_ways(q.lat(), q.lon())? else {
                    continue;
                };
                out.push(backend::lean::ProximityAnswer::new(q, ways));
            }
            let mut sts: Vec<(String, Vec<(f64, f64)>)> = Vec::with_capacity(want_lines.len());
            for line in &want_lines {
                // Same distinction, opposite consequence: a declined line is
                // skipped, so no place gains a pair for it. An empty list is a
                // line no way carries, a real answer.
                let Some(rows) = ans.stations_serving(line)? else {
                    continue;
                };
                sts.push((line.clone(), station_coords(&rows)));
            }
            Ok((out, sts))
        })
        .await?;

    let (proximity, unanswered) = backend::lean::proximity_table(&plan.minutes, &answers)?;
    let place_near_line = backend::lean::place_near_line(&place_coords, &stations)?;
    let covered = minute_count - unanswered;
    let station_total: usize = stations.iter().map(|(_, s)| s.len()).sum();
    // The log reports what was asked as well as what came back: only the
    // ratio shows a day decoded against a mirror that mostly declined.
    Ok(DayOsm {
        note: format!(
            "proximity {covered}/{minute_count} minutes from {}/{asked} queries; \
             place-line {} of {} lines, {station_total} stations, {} pairs",
            answers.len(),
            stations.len(),
            lines.len(),
            place_near_line.len()
        ),
        proximity,
        place_near_line,
    })
}

/// `[name, latBits, lonBits]` triples → coordinates.
///
/// The bit patterns are parsed only to ask; they go back out as bit patterns
/// on the `placenearline` request, so Lean measures from the mirror's exact
/// coordinate.
pub(crate) fn station_coords(rows: &[serde_json::Value]) -> Vec<(f64, f64)> {
    rows.iter()
        .filter_map(|r| {
            let a = r.as_array()?;
            let bits = |i: usize| -> Option<f64> {
                Some(f64::from_bits(a.get(i)?.as_str()?.parse().ok()?))
            };
            Some((bits(1)?, bits(2)?))
        })
        .collect()
}

/// The corridor polygon around a set of points, with `ROUTE_GRAPH_MARGIN_M`
/// added. One formula for the way box and the station box, so varying the two
/// compares boxes, not latitude corrections.
pub(crate) fn bbox_poly(pts: &[(f64, f64)]) -> String {
    let (mut mnla, mut mxla, mut mnlo, mut mxlo) = (
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
    );
    for (la, lo) in pts {
        mnla = mnla.min(*la);
        mxla = mxla.max(*la);
        mnlo = mnlo.min(*lo);
        mxlo = mxlo.max(*lo);
    }
    let d_lat = ROUTE_GRAPH_MARGIN_M / 111_320.0;
    let mid = (mnla + mxla) / 2.0;
    let d_lon = ROUTE_GRAPH_MARGIN_M / (111_320.0 * (mid * std::f64::consts::PI / 180.0).cos());
    format!(
        "POLYGON(({} {},{} {},{} {},{} {},{} {}))",
        mnlo - d_lon,
        mnla - d_lat,
        mxlo + d_lon,
        mnla - d_lat,
        mxlo + d_lon,
        mxla + d_lat,
        mnlo - d_lon,
        mxla + d_lat,
        mnlo - d_lon,
        mnla - d_lat
    )
}

/// The rail/road ways and station points covering a day's fixes.
///
/// The bbox comes from the day's own observations, so a day away from home
/// still gets a graph that contains it.
pub(crate) async fn route_graph_rows(
    pool: &sqlx::MySqlPool,
    user_id: &str,
    obs: &serde_json::Value,
) -> Result<(Vec<serde_json::Value>, Vec<serde_json::Value>)> {
    use sqlx::Row as _;

    // ⚠ The track is boxed by the day: a day away from home would otherwise
    // have no rail to match against.
    let mut pts: Vec<(f64, f64)> = Vec::new();
    if let Some(rows) = obs.get("rawFixes").and_then(serde_json::Value::as_array) {
        for r in rows {
            if let (Some(la), Some(lo)) = (
                r.get("lat").and_then(serde_json::Value::as_f64),
                r.get("lon").and_then(serde_json::Value::as_f64),
            ) {
                pts.push((la, lo));
            }
        }
    }
    if pts.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let poly = bbox_poly(&pts);

    let line_rows = sqlx::query(
        "SELECT osm_type, osm_id, name, subtype, tags_json, ST_AsText(geom) AS wkt \
         FROM osm_lines WHERE feature_type = 'railway' \
           AND MBRIntersects(geom, ST_GeomFromText(?, 4326)) LIMIT ?",
    )
    .bind(&poly)
    .bind(RAIL_CORRIDOR_LINE_LIMIT)
    .fetch_all(pool)
    .await
    .context("querying route-graph ways")?;

    let mut ways = Vec::with_capacity(line_rows.len());
    for r in &line_rows {
        let wkt: String = r.try_get("wkt")?;
        let geom = line_bits(&wkt);
        if geom.len() < 2 {
            continue;
        }
        let ty: String = r.try_get("osm_type")?;
        let id: i64 = r.try_get("osm_id")?;
        ways.push(serde_json::json!({
            "id": format!("{ty}:{id}"),
            "geometry": geom,
            "name": r.try_get::<Option<String>, _>("name")?,
            "subtype": r.try_get::<Option<String>, _>("subtype")?,
            "tags": tag_pairs(r.try_get::<Option<String>, _>("tags_json")?.as_deref()),
        }));
    }

    // ⚠ The stations are not boxed by the day. `emitLeg` names a station only
    // when every rival trails by `MARGIN_NATS`, so the candidate pool is a
    // threshold; cut to the day's extent it lowers the bar, and a leg resolves
    // by where the phone was rather than where the train went.
    //
    // Measured on one ride day, changing only the boxes:
    //
    //     day ways,      day stops        3706 / 694     17 of 18
    //     whole lines,   day stops        4885 / 694     17 of 18
    //     lifetime ways, lifetime stops  38559 / 9474    18 of 18
    //     day ways,      lifetime stops   3706 / 9474    18 of 18   ← this
    //
    // The station pool decides it; the track is irrelevant. This is also the
    // cheap arm: station points carry no geometry, and a lifetime way box
    // overruns `RAIL_CORRIDOR_LINE_LIMIT` (sized for the day box), truncating
    // with no `ORDER BY`, which once decoded a ride with no stations at all.
    let stops_poly = {
        let rows = sqlx::query(
            // `CAST(… AS CHAR)`: `centroid_lat/lon` are DECIMAL, which sqlx
            // will not decode as f64.
            "SELECT CAST(centroid_lat AS CHAR) AS la, CAST(centroid_lon AS CHAR) AS lo \
             FROM focus_places WHERE user_id = ?",
        )
        .bind(user_id)
        .fetch_all(pool)
        .await
        .context("reading focus_places for the station box")?;
        let mut p: Vec<(f64, f64)> = Vec::with_capacity(rows.len());
        for r in &rows {
            let la: String = r.try_get("la")?;
            let lo: String = r.try_get("lo")?;
            p.push((la.parse()?, lo.parse()?));
        }
        // A user with no focus places falls back to the day box: `bbox_poly`
        // on nothing is a box of infinities.
        if p.is_empty() {
            poly.clone()
        } else {
            bbox_poly(&p)
        }
    };
    let pt_rows = sqlx::query(
        "SELECT name, tags_json, ST_AsText(geom) AS wkt FROM osm_points \
         WHERE feature_type = 'railway' \
           AND MBRIntersects(geom, ST_GeomFromText(?, 4326))",
    )
    .bind(&stops_poly)
    .fetch_all(pool)
    .await
    .context("querying route-graph stops")?;

    let mut stops = Vec::with_capacity(pt_rows.len());
    for r in &pt_rows {
        let wkt: String = r.try_get("wkt")?;
        let Some((lat, lon)) = parse_point_wkt(&wkt) else {
            continue;
        };
        stops.push(serde_json::json!({
            "latBits": backend::fold_payload::bits(lat),
            "lonBits": backend::fold_payload::bits(lon),
            "name": r.try_get::<Option<String>, _>("name")?,
            "tags": tag_pairs(r.try_get::<Option<String>, _>("tags_json")?.as_deref()),
        }));
    }
    Ok((ways, stops))
}

/// `tags_json` → `[[k, v], …]`.
///
/// ⚠ Pairs, not an object: `BackendEntry` reads two-element arrays, and the
/// object spelling parses to nothing, so every stay would answer no venues.
pub(crate) fn tag_pairs(raw: Option<&str>) -> Vec<serde_json::Value> {
    let Some(v) = raw.and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok()) else {
        return Vec::new();
    };
    v.as_object().map_or_else(Vec::new, |m| {
        m.iter()
            .filter_map(|(k, val)| val.as_str().map(|s| serde_json::json!([k, s])))
            .collect()
    })
}

/// Margin (m) around a day's fixes when reading its route graph.
pub(crate) const ROUTE_GRAPH_MARGIN_M: f64 = 1500.0;
/// Days the warm-cache cron decodes by default.
pub(crate) const DECODE_DEFAULT_DAYS: i64 = 14;

/// One `verified_cli decodeprof` child on one request, wrapped in BSD
/// `time -l` where it exists so the child's CPU time comes back beside its
/// answer: `(answer, user+sys ms)`. `None` where the wrapper is absent or
/// prints another shape (GNU `time`), never a guess.
fn decodeprof(
    cli: &std::path::Path,
    req: &serde_json::Value,
    runs: usize,
) -> Result<(serde_json::Value, Option<u64>)> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut req = req.clone();
    req["runs"] = serde_json::json!(runs);
    let wrapper = std::path::Path::new("/usr/bin/time");
    let mut cmd = if wrapper.is_file() {
        let mut c = Command::new(wrapper);
        c.arg("-l").arg(cli);
        c
    } else {
        Command::new(cli)
    };
    let mut child = cmd
        .arg("decodeprof")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("spawning {}", cli.display()))?;
    {
        let mut stdin = child.stdin.take().context("the child has no stdin")?;
        stdin.write_all(serde_json::to_string(&req)?.as_bytes())?;
    }
    let out = child.wait_with_output()?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    anyhow::ensure!(
        out.status.success(),
        "decodeprof exited {}:\n{stderr}",
        out.status
    );
    let v: serde_json::Value =
        serde_json::from_slice(&out.stdout).context("decodeprof answer is not JSON")?;
    // BSD `time`: "        1.23 real         1.10 user         0.05 sys"
    let cpu = stderr
        .lines()
        .find(|l| l.contains(" real ") && l.contains(" user "))
        .and_then(|l| {
            let t: Vec<&str> = l.split_whitespace().collect();
            let field = |k: &str| {
                t.iter()
                    .position(|w| *w == k)
                    .and_then(|i| i.checked_sub(1))
                    .and_then(|i| t.get(i))
                    .and_then(|s| s.parse::<f64>().ok())
            };
            Some(((field("user")? + field("sys")?) * 1000.0).round() as u64)
        });
    Ok((v, cpu))
}

/// `backend decode-bench [--runs N] [DAY…]`: the HSMM decoder's cost per
/// frozen day, apart from its model build.
///
/// The instrument for a trellis change. `hsmm_decode_corpus` proves a decode
/// still exact, but its wall (~170 s) swings 2× run to run and cannot see a
/// 10% decoder change. This runs `verified_cli decodeprof` on each fixture's
/// request, which builds the `PData` once and times `sDecode` N times.
///
/// Two numbers per day, because the machine is rarely quiet:
/// * wall min/median/max of the N decodes: the cost when nothing else runs;
///   the spread is the machine's.
/// * CPU per decode: the child's user+sys with N decodes minus the same child
///   with none, over N. The build, parse and read cancel, and CPU time barely
///   moves under a neighbour's build where wall doubles.
///
/// Compare two arms by swapping `VERIFIED_CLI`, interleaved (A/B/A). Prints
/// the day, the trellis shape and the times, never a coordinate.
pub(crate) fn decode_bench(runs: usize, days: &[String]) -> Result<()> {
    anyhow::ensure!(runs > 0, "decode-bench needs at least one run");
    let Some(mut names) = decode_fixture::fixture_names()? else {
        anyhow::bail!(
            "no decode corpus at {}",
            decode_fixture::corpus_dir().display()
        );
    };
    if !days.is_empty() {
        names.retain(|n| days.iter().any(|d| n.starts_with(d.as_str())));
        anyhow::ensure!(!names.is_empty(), "no fixture matches {days:?}");
    }
    let cli = backend::lean_worker::verified_cli_path()?;
    println!(
        "{:<22} {:>5} {:>4} {:>5} {:>9} {:>9} {:>9} {:>9} {:>11}",
        "day", "T", "S", "maxD", "build ms", "min ms", "med ms", "max ms", "cpu/dec ms"
    );
    let (mut sum_min, mut sum_cpu, mut cpu_days) = (0u64, 0u64, 0usize);
    for name in &names {
        let req = decode_fixture::request(&decode_fixture::read(name)?)?;
        let (_, cpu0) =
            decodeprof(cli, &req, 0).with_context(|| format!("{name}: build-only child"))?;
        let (v, cpu_n) =
            decodeprof(cli, &req, runs).with_context(|| format!("{name}: {runs}-run child"))?;
        let mut ms: Vec<u64> = v["decodeMs"]
            .as_array()
            .context("decodeMs")?
            .iter()
            .filter_map(serde_json::Value::as_u64)
            .collect();
        anyhow::ensure!(
            ms.len() == runs,
            "{name}: {} timings for {runs} runs",
            ms.len()
        );
        ms.sort_unstable();
        let cpu = match (cpu0, cpu_n) {
            (Some(a), Some(b)) => Some(b.saturating_sub(a) / runs as u64),
            _ => None,
        };
        let day = name.trim_end_matches(".json");
        println!(
            "{day:<22} {:>5} {:>4} {:>5} {:>9} {:>9} {:>9} {:>9} {:>11}",
            v["T"],
            v["S"],
            v["maxD"],
            v["buildMs"],
            ms[0],
            ms[ms.len() / 2],
            ms[ms.len() - 1],
            cpu.map_or_else(|| "n/a".to_string(), |c| c.to_string())
        );
        // The build's phases, when the binary reports them.
        if let Some(ph) = v
            .get("buildPhasesMs")
            .and_then(serde_json::Value::as_object)
        {
            println!(
                "{:<22} build phases ms: emit+entry {} · transitions {} · durations {}",
                "", ph["emitEntry"], ph["transitions"], ph["durations"]
            );
        }
        sum_min += ms[0];
        if let Some(c) = cpu {
            sum_cpu += c;
            cpu_days += 1;
        }
    }
    println!(
        "{} day(s), {runs} run(s) each, sum of per-day wall minima {sum_min} ms, sum of per-day cpu/decode {sum_cpu} ms over {cpu_days} day(s)",
        names.len()
    );
    Ok(())
}

/// `backend watch-decode-queue`: the decoder beside the serving pod.
///
/// Each turn takes the day a read queued (`decode_freshness`), else the newest
/// stale day among the stored decodes in `window_days` and today, and decodes
/// it in a child `decode-day` process: one process over many days held memory
/// until killed, one per day stays flat. After a write, that day's presence
/// row. A failure counts an attempt in the queue, so a day that keeps failing
/// stops being tried.
///
/// No `migrate()` here: `backend serve` does it, in the same pod.
pub(crate) async fn watch_decode_queue(interval_s: u64, window_days: i64) -> Result<()> {
    use backend::decode_freshness as fresh;
    use backend::fetch_queue as queue;
    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let exe = std::env::current_exe().context("locating this binary")?;
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .context("installing the SIGTERM handler")?;
    let mut today_worker: Option<TodayWorker> = None;
    eprintln!(
        "decode watch: idle every {interval_s}s, decodes kept current over {window_days} day(s)"
    );
    loop {
        let next = match next_stale_day(&pool, window_days).await {
            Ok(n) => n,
            Err(e) => {
                eprintln!("decode watch: choosing a day failed: {e:#}");
                None
            }
        };
        let Some((user_id, date)) = next else {
            tokio::select! {
                _ = term.recv() => break,
                _ = tokio::time::sleep(std::time::Duration::from_secs(interval_s)) => continue,
            }
        };
        let key = fresh::queue_key(&user_id, &date);
        let started = std::time::Instant::now();
        // Today's request comes back to this loop, which decodes it on its own
        // worker from the day's previous run; every other day decodes whole in
        // the child.
        let today = match is_today(&pool, &user_id, &date).await {
            Ok(t) => t,
            Err(e) => {
                eprintln!("decode watch: is {date} today for {user_id}: {e:#}");
                false
            }
        };
        let handoff = std::env::temp_dir().join(format!("decode-handoff-{user_id}-{date}.json"));
        let _ = std::fs::remove_file(&handoff);
        let mut cmd = tokio::process::Command::new(&exe);
        cmd.args(["decode-day", &user_id, &date]).kill_on_drop(true);
        if today {
            cmd.env("DECODE_HANDOFF", &handoff);
        }
        let status = tokio::select! {
            _ = term.recv() => break,
            s = cmd.status() => s,
        };
        match status {
            Ok(s) if s.success() => {
                let handed = std::fs::read(&handoff).ok();
                let _ = std::fs::remove_file(&handoff);
                let outcome = match handed {
                    Some(bytes) => tokio::select! {
                        _ = term.recv() => break,
                        r = decode_today(&mut today_worker, &pool, &user_id, &date, &bytes) => r,
                    },
                    None => Ok(String::new()),
                };
                match outcome {
                    Ok(note) => {
                        queue::done(&pool, fresh::QUEUE_KIND, &key).await?;
                        if let Err(e) =
                            super::refresh::refresh_presence_log(&pool, 1, Some((&user_id, &date)))
                                .await
                        {
                            eprintln!("decode watch: presence row for {user_id} {date}: {e:#}");
                        }
                        eprintln!(
                            "decode watch: {user_id} {date} decoded in {}s{note}",
                            started.elapsed().as_secs()
                        );
                    }
                    Err(e) => {
                        eprintln!("decode watch: {user_id} {date} failed: {e:#}");
                        queue::failed(&pool, fresh::QUEUE_KIND, &key, &format!("{e:#}")).await?;
                    }
                }
            }
            Ok(s) => {
                eprintln!("decode watch: {user_id} {date} failed ({s})");
                queue::failed(
                    &pool,
                    fresh::QUEUE_KIND,
                    &key,
                    &format!("decode-day exited {s}"),
                )
                .await?;
            }
            Err(e) => {
                eprintln!("decode watch: could not run decode-day for {user_id} {date}: {e:#}");
                queue::failed(&pool, fresh::QUEUE_KIND, &key, "decode-day did not start").await?;
            }
        }
    }
    eprintln!("decode watch: shutting down");
    pool.close().await;
    Ok(())
}

/// Today's own Lean worker: a `verified_cli serve` the decode watch keeps, so
/// a decode of today resumes from the previous one (`assemblesegmentsinc`,
/// docs/proposals/2026-11-incremental-today.md). Dropped on any failure; the
/// next decode of today is then a full one.
struct TodayWorker {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    lines: std::io::Lines<std::io::BufReader<std::process::ChildStdout>>,
}

impl TodayWorker {
    fn spawn() -> Result<Self> {
        use std::io::BufRead;
        use std::process::Stdio;
        let cli = backend::lean_worker::verified_cli_path()?;
        let mut child = std::process::Command::new(cli)
            .arg("serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| format!("spawning {}", cli.display()))?;
        let stdin = child.stdin.take().context("today's worker has no stdin")?;
        let stdout = child
            .stdout
            .take()
            .context("today's worker has no stdout")?;
        Ok(Self {
            child,
            stdin,
            lines: std::io::BufReader::new(stdout).lines(),
        })
    }

    fn call(&mut self, req: &serde_json::Value) -> Result<serde_json::Value> {
        use std::io::Write;
        writeln!(self.stdin, "{req}").context("writing to today's worker")?;
        self.stdin.flush().context("flushing today's worker")?;
        let line = self
            .lines
            .next()
            .context("today's worker closed its stdout")?
            .context("reading today's worker")?;
        let v: serde_json::Value =
            serde_json::from_str(&line).context("today's worker answered something not JSON")?;
        if let Some(e) = v.get("error") {
            anyhow::bail!("today's worker: {e}");
        }
        Ok(v["result"].clone())
    }
}

impl Drop for TodayWorker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Whether `date` is the user's today in their home timezone.
async fn is_today(pool: &sqlx::MySqlPool, user_id: &str, date: &str) -> Result<bool> {
    let tz = backend::sync_state::home_tz(pool, user_id).await?;
    Ok(backend::timezone::local_date_at(chrono::Utc::now().timestamp(), Some(&tz))? == date)
}

/// Today's handed-off request, decoded on `worker` from the day's previous run
/// and written as `decode_one` writes it. The note says what was reused.
async fn decode_today(
    worker: &mut Option<TodayWorker>,
    pool: &sqlx::MySqlPool,
    user_id: &str,
    date: &str,
    handoff: &[u8],
) -> Result<String> {
    let handoff: serde_json::Value = serde_json::from_slice(handoff).context("the hand-off")?;
    let inputs_through = handoff["inputsThrough"]
        .as_i64()
        .context("the hand-off has no inputsThrough")?;
    let mut req = handoff["request"].clone();
    req["mode"] = "assemblesegmentsinc".into();
    req["todayKey"] = format!(
        "{user_id}|{date}|{}+v{CLASSIFIER_VERSION}",
        std::env::var("GIT_SHA").unwrap_or_else(|_| "dev".into())
    )
    .into();
    let w = match worker.take() {
        Some(w) => w,
        None => TodayWorker::spawn()?,
    };
    let (w, answer) = tokio::task::spawn_blocking(move || {
        let mut w = w;
        let a = w.call(&req);
        (w, a)
    })
    .await
    .context("today's decode task")?;
    // A worker that failed a call is not trusted with the next one.
    let answer = answer?;
    *worker = Some(w);
    if answer
        .get("degenerate")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
    {
        anyhow::bail!("the decode is degenerate — no viable path");
    }
    let segments = backend::row_json::render_segments(&answer["segments"])?;
    save_decode(pool, user_id, date, &segments, inputs_through).await?;
    Ok(format!(" ({})", answer["incremental"]))
}

/// What a read queued, else the newest stale day among the stored decodes in
/// the window and today; a day whose attempts ran out is not offered again.
async fn next_stale_day(
    pool: &sqlx::MySqlPool,
    window_days: i64,
) -> Result<Option<(String, String)>> {
    use backend::decode_freshness as fresh;
    use backend::fetch_queue as queue;
    if let Some(p) = queue::due(pool, fresh::QUEUE_KIND, 1)
        .await?
        .into_iter()
        .next()
        && let Some(day) = fresh::parse_key(&p.key)
    {
        return Ok(Some(day));
    }
    let exhausted: std::collections::HashSet<String> = sqlx::query_scalar(
        "SELECT fetch_key FROM osm_fetch_queue WHERE kind = ? AND attempts >= ?",
    )
    .bind(fresh::QUEUE_KIND)
    .bind(queue::MAX_ATTEMPTS)
    .fetch_all(pool)
    .await
    .context("reading the exhausted decodes")?
    .into_iter()
    .collect();
    let now = chrono::Utc::now();
    let users: Vec<String> = sqlx::query_scalar("SELECT user_id FROM nc_tokens")
        .fetch_all(pool)
        .await
        .context("listing users")?;
    for user_id in users {
        let tz = backend::sync_state::home_tz(pool, &user_id).await?;
        let today = backend::timezone::local_date_at(now.timestamp(), Some(&tz))?;
        let cutoff = (chrono::NaiveDate::parse_from_str(&today, "%Y-%m-%d")?
            - chrono::Duration::days(window_days))
        .format("%Y-%m-%d")
        .to_string();
        let mut dates: Vec<String> = sqlx::query_scalar(
            "SELECT CAST(date AS CHAR) FROM decoded_days WHERE user_id = ? AND date >= ? ORDER BY date DESC",
        )
        .bind(&user_id)
        .bind(&cutoff)
        .fetch_all(pool)
        .await
        .context("listing the stored decodes")?;
        if !dates.contains(&today) {
            dates.insert(0, today.clone());
        }
        let steps_through: Option<i64> =
            backend::classification_inputs::steps_through(pool, &user_id)
                .await?
                .as_i64();
        for date in dates {
            if exhausted.contains(&fresh::queue_key(&user_id, &date)) {
                continue;
            }
            let end = backend::timezone::date_bounds_utc(&date, Some(&tz))?.end_utc;
            let horizon = fresh::horizon(end, steps_through, now.timestamp());
            if fresh::freshness(pool, &user_id, &date, horizon).await? != fresh::Freshness::Current
            {
                // Through the queue, so its attempts are counted.
                queue::record(pool, fresh::QUEUE_KIND, &fresh::queue_key(&user_id, &date)).await;
                return Ok(Some((user_id, date)));
            }
        }
    }
    Ok(None)
}

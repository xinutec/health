//! The HSMM decode of a day and the OSM rows it needs: `decode-day` and the
//! day-level OSM loaders shared with `day-live`.

use super::refresh::*;
use anyhow::{Context, Result};
use backend::db;

/// Persist a day's HSMM decode, overwriting any existing row.
///
/// ⚠ `classifier_version` is RECORDED, not just written: `loadDecode` returns
/// null on a version mismatch so consumers re-decode rather than serve stale
/// segments. Writing the wrong number here does not fail — it makes every
/// reader silently discard the row and recompute, which looks like a slow
/// cache rather than a bug.
pub(crate) async fn save_decode(
    pool: &sqlx::MySqlPool,
    user_id: &str,
    date: &str,
    segments: &serde_json::Value,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO decoded_days (user_id, date, classifier_version, segments_json) \
         VALUES (?, ?, ?, ?) \
         ON DUPLICATE KEY UPDATE classifier_version = VALUES(classifier_version), \
                                 segments_json = VALUES(segments_json)",
    )
    .bind(user_id)
    .bind(date)
    .bind(CLASSIFIER_VERSION)
    .bind(serde_json::to_string(segments)?)
    .execute(pool)
    .await
    .with_context(|| format!("writing decoded_days for {user_id} {date}"))?;
    Ok(())
}

/// ⚠ ONE DECLARATION, in `classification_inputs`. This was a second copy until
/// 2026-09-01, kept in step by a comment pointing at a TypeScript file that no
/// longer exists.
use crate::classification_inputs::CLASSIFIER_VERSION;

/// Decode a day's HSMM and persist it to `decoded_days`.
///
/// Tier 2 of #982 — the node cron is `src/cli/decode-day.ts`, daily at 06:00.
///
/// ⚠ THE WHOLE MODEL IS BUILT AND DECODED IN LEAN. `assemblesegments` takes raw
/// `edges`/`nodes`/`obs`/`places`, builds the route-graph model, the coverage
/// map and the trellis, decodes, and groups the path into segments. Nothing
/// here constructs a model, and the 33-40 MiB quantised payload the TypeScript
/// ships per day (#411) never exists.
///
/// ⚠ NOT ported, deliberately: `runLeanShadow`, `runWalkShadow` and ten
/// `logLean*Ledger` calls — about 40% of `decodeAndPersist`. They exist to A/B
/// the TypeScript arm against Lean. With one arm they measure nothing, and
/// keeping them would mean keeping the arm they measure.
pub(crate) async fn decode_day(
    user: Option<&str>,
    dates: &[String],
    days: Option<i64>,
    dry_run: bool,
) -> Result<()> {
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
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
        let tz = backend::sync_state::get(&pool, user_id, "home_tz")
            .await?
            .unwrap_or_else(|| "Europe/London".into());
        let targets: Vec<String> = if dates.is_empty() {
            backend::classification_inputs::decode_window(
                chrono::Utc::now(),
                days.unwrap_or(DECODE_DEFAULT_DAYS),
            )
        } else {
            dates.to_vec()
        };

        for date in &targets {
            attempted += 1;
            match decode_one(&st, &pool, user_id, date, &tz, dry_run).await {
                Ok(n) => {
                    // ⚠ `decode_one` ALREADY PRINTED the dry-run line, including
                    // the fact that nothing was written. Printing "{n} segments"
                    // again here said it twice and said it wrong the second time.
                    if !dry_run {
                        eprintln!("[{user_id} {date}] {n} segments");
                    }
                    written += 1;
                }
                Err(e) => {
                    // ⚠ One bad day must not strand the rest — the cron decodes
                    // a window and a single unparseable day is not a reason to
                    // leave the other thirteen stale. The refusal below is what
                    // makes that safe.
                    eprintln!("[{user_id} {date}] decode failed: {e:#}");
                    failed += 1;
                }
            }
        }
    }

    // ⚠ A DRY RUN WROTE NOTHING AND MUST NOT SAY "written". The 2026-08-25 dry
    // run reported `1 written, 0 failed` while writing nothing at all — a label
    // that contradicts the flag it was given is worse than no label, because it
    // is the line somebody greps to find out whether the row was replaced.
    eprintln!(
        "decode-day: {written} {}, {failed} failed of {attempted} day(s)",
        if dry_run {
            "decoded (DRY RUN, nothing written)"
        } else {
            "written"
        }
    );
    // ⚠ REFUSE rather than report success on nothing. Same rule as
    // `refresh-rail-routes`, and for the same reason: a batch job's success must
    // be predicated on evidence having been gathered, never on the absence of an
    // error. Every day failing is a broken run; a day with no data is not.
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
    let inputs = backend::classification_inputs::load(
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
    // `head::capture` owns the observation tensor; nothing here rebuilds it.
    let cap = backend::head::capture(&inputs, date, user_id)?;
    let obs = cap.get("obs").context("capture has no obs")?.clone();

    // ── the route graph, from the mirror ────────────────────────────────────
    let (ways, stops) = route_graph_rows(pool, user_id, &obs).await?;
    let (edges, nodes) = backend::lean::build_wire_graph(&ways, &stops)?;
    // ⚠ THE GRAPH'S SIZE IS EVIDENCE, not chatter. `emitLeg` is a MARGIN test —
    // a side names a station only when every alternative naming a different one
    // trails by `MARGIN_NATS` — so the number of competing stations in range
    // decides whether a leg resolves at all. Two arms that box different regions
    // resolve differently with identical scoring, which is #1190, and this line
    // is what makes that visible in a run rather than inferable from a diff.
    println!(
        "graph {date}: {} ways, {} stops -> {} edges, {} nodes",
        ways.len(),
        stops.len(),
        edges.as_array().map_or(0, Vec::len),
        nodes.as_array().map_or(0, Vec::len)
    );

    // ── the observation tensor's raw materials ──────────────────────────────
    // ⚠ THE TENSOR IS NOT BUILT HERE AND MUST NOT BE. Lean builds it from these
    // (#411): shipping 1440 assembled rows instead is the 33-40 MiB per day the
    // port exists to delete. What crosses is the day's fixes and two lookup
    // tables that are not pure — a timezone and an OSM query.
    //
    // ⚠ OUTLIERS ARE DROPPED ONCE, HERE, and the same cleaned list feeds both the
    // tensor and the proximity lookups. The TypeScript cleans in two places
    // (`buildHsmmModel` and the `computeMinuteProximity` call) and the two agree
    // only because they clean the same input; doing it once is the same result
    // with one fewer way to disagree.
    let cleaned = backend::lean::drop_gps_outliers(&gps_fixes(&obs)?)?;
    // ⚠ THE DECODER'S PLACES ARE NOT `focus_places` ROWS. `knownPlaces` names
    // the columns (`centroidLat`, `totalDwellSec`, `displayName`); the decode
    // wire names the concepts (`lat`, `dwell`, `name`). Sending the row shape is
    // refused by name — see `decode_places`, which is the second field-shape
    // defect this path shipped and the reason there is a test for the request.
    let places = backend::classification_inputs::decode_places(inputs.get("knownPlaces"))?;
    let osm = day_osm(pool, bounds.start_utc, bounds.end_utc, &cleaned, &places).await?;
    println!("osm {date}: {}", osm.note);

    // ⚠ THE CHAIN SEED, AND IT IS FOUR FIELDS RATHER THAN ONE. Sending only
    // `priorPlaceId` is refused with `property not found: hoursSince` — the
    // third field-shape defect on this request, and the third found by probing
    // the parser instead of reading the struct.
    let continuity = load_continuity(pool, user_id, date, &places).await?;

    let req = serde_json::json!({
        "observation": {
            "startUtc": bounds.start_utc,
            "points": cleaned.iter().map(|p| serde_json::json!({
                "ts": p.ts, "lat": p.lat, "lon": p.lon, "speedKmh": p.speed_kmh
            })).collect::<Vec<_>>(),
            "hr": obs.get("hr").cloned().unwrap_or(serde_json::json!([])),
            "steps": obs.get("steps").cloned().unwrap_or(serde_json::json!([])),
            "sleep": obs.get("sleep").cloned().unwrap_or(serde_json::json!([])),
            "localCtx": backend::timezone::local_ctx_table(bounds.start_utc, tz)?,
            "proximity": osm.proximity,
            "imputeCadence": flag("USE_CADENCE_IMPUTATION"),
        },
        "edges": edges,
        "nodes": nodes,
        "places": places,
        // ⚠ ABSENT IS NOT NEUTRAL. `parseAssemble` treats a missing
        // `placeNearLine` as the EMPTY SET, which removes every place→line hard
        // zero instead of adding them — so the decode runs, looks plausible, and
        // permits boardings the TypeScript forbids.
        "placeNearLine": osm.place_near_line,
        "railStopRelations": inputs.get("railStopsCache").cloned().unwrap_or(serde_json::Value::Null),
        "continuity": continuity,
        // ⚠ THE THREE C4 FLAGS, READ FROM THE ENV AS THE TypeScript READS THEM.
        // All three are `1` in `decodeFlags` and have been since C4 landed, so a
        // Rust-side `true` would decode production correctly and diverge the
        // moment anyone replays a day with `scripts/prod-db.sh` — which mirrors
        // the pod env precisely so that cannot happen.
        //
        // ⚠ `maxD` IS DELIBERATELY ABSENT: it is the model's own trellis depth,
        // and `Verified.Hsmm.Assemble.DEFAULT_MAX_DURATION` is where it lives.
        // Spelling 240 here would be a second copy that nothing compares.
        "flags": {
            "reacquireRobust": flag("USE_REACQUIRE_ROBUST_SPEED"),
            "segEvidence": flag("USE_SEGMENT_EVIDENCE"),
            "chainContext": flag("USE_CHAIN_CONTEXT"),
        },
        "date": date,
        "tz": tz,
    });

    // ⚠ `None` is DEGENERATE — Lean found no viable path. That is a real answer
    // about the day, not a fault, and it must not be written as zero segments:
    // an empty row would read as "decoded, nothing happened".
    let Some(segments) = backend::lean::assemble_segments(&req)? else {
        anyhow::bail!("the decode is degenerate — no viable path");
    };
    let segments = backend::row_json::render_segments(&segments)?;
    let n = segments.as_array().map_or(0, Vec::len);
    if dry_run {
        // ⚠ ONE SEGMENT PER LINE, in exactly the form `segments_json` would hold
        // — same field order, same encodings, same absent-versus-null. That is
        // the point: it makes the parity check `diff` against
        // the deleted `scripts/dump-decoded-segments.mjs`, which printed node's row the same
        // way, instead of a structural comparison nothing can quite trust.
        for seg in segments.as_array().unwrap_or(&Vec::new()) {
            println!("{}", serde_json::to_string(seg)?);
        }
        eprintln!("[{user_id} {date}] DRY RUN — {n} segments, nothing written");
        return Ok(n);
    }
    save_decode(pool, user_id, date, &segments).await?;
    Ok(n)
}

/// The prior day's end-of-day seed, shaped as `parseContinuity` reads it — or
/// `null`, which is a legitimate chain start rather than a fault.
///
/// ⚠ FOUR FIELDS, NOT ONE. `priorPlaceId` alone is refused with `property not
/// found: hoursSince`. `priorPlaceCoord` is a `[lat, lon]` PAIR on the wire
/// even though the
/// TypeScript's own type is an object — `lean/experiments/compare-assemble-*.mts`
/// convert it the same way.
///
/// ⚠ THREE ABSENCES, AND THEY ARE DIFFERENT. No ROW at all is a chain start; a
/// row whose `end_of_day_place_id` is NULL is a day that ended nowhere known;
/// a row with no `end_of_day_ts` cannot say how stale the seed is. The
/// TypeScript returns null for all three and so does this — but they are read
/// separately so a future reader can tell them apart if that ever matters.
///
/// ⚠ `u64`, NOT `i64` — `presence_log.*_place_id` is INT UNSIGNED, which sqlx
/// treats as a distinct type and refuses to hand back as signed. It fails at
/// RUNTIME on real rows only.
///
/// ⚠ `end_of_day_posterior` is `FLOAT`, so it reads as `f32`. Asking for `f64`
/// fails on real rows the same way, and the widening is exact — the node driver
/// hands the TypeScript the same widened value.
///
/// ⚠ `UNIX_TIMESTAMP`, MIRRORING THE `FROM_UNIXTIME` THE WRITE USES. Reading the
/// `TIMESTAMP` as a naive local datetime would make the staleness of the seed
/// depend on the session timezone, and `refresh-presence-log` a few hundred
/// lines down writes it through `FROM_UNIXTIME(?)`. Symmetry is the check.
///
/// ⚠ THE COORD COMES FROM THE PLACES ALREADY IN HAND, not a second query. The
/// TypeScript re-reads `focus_places` unfiltered; taking it from the list the
/// decoder was just given means the seed's coordinate is the same one the
/// trellis has a state for. A prior place that is no longer a focus place
/// yields a null coord, which is the documented un-gated case.
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

    // ⚠ UTC MIDNIGHT OF THE DECODED DATE, not local midnight and not the day's
    // own `startUtc`. The TypeScript measures from `new Date(`${date}T00:00:00Z`)`,
    // so in London the two differ by an hour for half the year — and the
    // difference lands straight in the continuity factor's time decay.
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

/// A decode feature flag, with the TypeScript's own semantics: set and exactly
/// `"1"` is on, anything else — including unset — is off.
///
/// ⚠ NOT DEFAULTED TO `true`. Production sets all three (`decodeFlags` in
/// `kubes/dhall/apps/health.dhall`) and has since C4, so defaulting on would be
/// right in the cluster and wrong everywhere else — and `scripts/prod-db.sh`
/// mirrors the pod env precisely so that a Mac replay decodes the same day the
/// cron wrote. A parity tool that does not mirror the env is not a parity tool.
pub(crate) fn flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| v == "1")
}

/// `head::capture`'s `obs.points` as fixes.
///
/// ⚠ THESE ARE THE VELOCITY PIPELINE'S POINTS, not the raw ones. `rawFixes` is
/// what the route-graph bbox is built from — a wider set on purpose, since the
/// graph must contain the day even where the pipeline dropped fixes.
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
            })
        })
        .collect()
}

/// Everything the decode needs from OSM, gathered in ONE trip to the mirror.
///
/// ⚠ THE TWO HALVES TRAVEL TOGETHER BECAUSE THE MIRROR IS BLOCKING-THREAD ONLY.
/// `with_mirror_answerer` is the only door and its closure cannot await, so a
/// second call would be a second `MirrorSource`, a second connection, and a
/// second chance to construct one on a runtime worker — which aborts the
/// process rather than returning an error. They are unrelated questions asked
/// through one door, not one question.
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

    // ⚠ THE LINE LIST IS LEAN'S — see `lean::known_lines`.
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
                // NOT "nothing here". Sending it back as an empty way list would
                // tell the decoder there is no railway within 300 m, which is
                // evidence against rail rather than the absence of evidence
                // (#976).
                let Some(ways) = ans.nearby_ways(q.lat(), q.lon())? else {
                    continue;
                };
                out.push(backend::lean::ProximityAnswer::new(q, ways));
            }
            let mut sts: Vec<(String, Vec<(f64, f64)>)> = Vec::with_capacity(want_lines.len());
            for line in &want_lines {
                // ⚠ Same distinction, opposite consequence: a declined line is
                // SKIPPED, so no place gains a pair for it. An empty list is a
                // line no way carries and is a real answer.
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
    // ⚠ THE LINE REPORTS WHAT WAS ASKED AS WELL AS WHAT CAME BACK. `2/18
    // queries` and `18/18 queries` produce tables that look equally healthy, and
    // only the ratio says a day was decoded against a mirror that mostly
    // declined (#976, and the shape #1134 reports for the Overpass crons).
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
/// ⚠ THE BIT PATTERNS ARE PARSED ONLY TO ASK. They go straight back out as bit
/// patterns on the `placenearline` request, so the coordinate Lean measures from
/// is the one the mirror answered with, to the last digit.
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
/// added. ⚠ ONE FORMULA for both the way box and the station box — the #1190
/// experiment varies them independently, and two copies of the latitude
/// correction would make that comparison meaningless.
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
/// ⚠ The bbox comes from the day's OWN observations, not a fixed region: a day
/// spent outside the home metro would otherwise get a graph that does not
/// contain it, and the decode would silently have no rail to match against.
pub(crate) async fn route_graph_rows(
    pool: &sqlx::MySqlPool,
    user_id: &str,
    obs: &serde_json::Value,
) -> Result<(Vec<serde_json::Value>, Vec<serde_json::Value>)> {
    use sqlx::Row as _;

    // ⚠ THE TRACK IS BOXED BY THE DAY. A day spent outside the home metro would
    // otherwise get a graph that does not contain it, and the decode would
    // silently have no rail to match against.
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
        let geom = parse_linestring_wkt(&wkt);
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

    // ⚠ THE STATIONS ARE **NOT** BOXED BY THE DAY, and that is the whole of
    // #1190. `emitLeg` names a station only when every alternative naming a
    // DIFFERENT one trails by `MARGIN_NATS` — so the candidate pool is a
    // threshold, and cutting it to the day's own extent lowers the bar. A leg
    // then resolves because of where the phone happened to be, not because of
    // where the train went, and the same ride resolves differently on two days.
    //
    // ⚠ MEASURED, not reasoned, 2026-08-26 — and three explanations died first.
    // Four arms against node's row for the same day, changing only the boxes:
    //
    //     day ways,      day stops        3706 / 694     17 of 18
    //     WHOLE lines,   day stops        4885 / 694     17 of 18
    //     lifetime ways, lifetime stops  38559 / 9474    18 of 18
    //     day ways,      LIFETIME stops   3706 / 9474    18 of 18   ← this
    //
    // A clean 2x2: the station pool decides it and the track is irrelevant.
    // Loading every line end to end — 32% more way rows — moved nothing.
    //
    // ⚠ AND IT IS THE CHEAP ONE. Node's arm boxes both by the lifetime places,
    // which is 38 559 way rows carrying geometry; this is 3706 of those plus
    // station POINTS, which carry none. `RAIL_CORRIDOR_LINE_LIMIT` is 12 000 and
    // sized for the day box — under the lifetime box it truncates with no
    // `ORDER BY`, and the measured cost of that was a Metropolitan ride decoded
    // as a short Jubilee ride with no stations at all.
    let stops_poly = {
        let rows = sqlx::query(
            // ⚠ `CAST(… AS CHAR)`: `centroid_lat/lon` are DECIMAL, which sqlx
            // refuses to hand back as f64 — and it fails on REAL ROWS ONLY.
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
        // ⚠ A USER WITH NO FOCUS PLACES FALLS BACK TO THE DAY BOX rather than
        // to an empty one. `bbox_poly` on nothing is a box of infinities, which
        // MariaDB would reject or answer strangely; the day box is at least the
        // stations the ride passed.
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
/// ⚠ PAIRS, not an object. `BackendEntry` reads them as two-element arrays, and
/// the object spelling parses to nothing — which made `nearbyLandmarks` answer
/// `[]` for every stay while every count read as answered (#1054).
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
/// The TypeScript's `--days N` default for the warm-cache cron.
pub(crate) const DECODE_DEFAULT_DAYS: i64 = 14;

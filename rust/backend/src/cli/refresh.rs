//! The nightly refresh crons: focus places, presence log, rail routes, rail
//! stops, bus routes.

use super::mirror::*;
use anyhow::{Context, Result};
use backend::db;

/// Extra outputs riding the production mining path, so a measured population
/// is exactly what the cron mines rather than a separate harness's guess.
pub(crate) struct MineSinks {
    pub(crate) soft_out: Option<String>,
    pub(crate) hard_out: Option<String>,
    pub(crate) dry: bool,
    /// The mined places as they would be written — the id each matched, the
    /// centroid, the visit count and spread — before the amenity vote; a dry
    /// run with no other sink stops there.
    pub(crate) places_out: Option<String>,
    /// Mine as the window stood on this instant rather than now.
    ///
    /// ⚠ A measurement flag: answering a day this way re-clusters per day
    /// served (one 730-day mine is ~273,000 points), far too slow to serve.
    pub(crate) as_of: Option<chrono::DateTime<chrono::Utc>>,
}

/// Rebuild `focus_places` and `venue_type_priors` from PhoneTrack history.
///
/// The geometry (stays, clusters, splitting, hour profiles, identity) is
/// `ServeEntry`'s `focus` mode; the amenity vote is
/// `Verified.Geo.FocusMining.mineCluster`; this is the IO around them.
///
/// `radius_m` is always [`FOCUS_RADIUS_M`].
pub(crate) async fn refresh_focus_places(
    pool: &sqlx::MySqlPool,
    only_user: Option<&str>,
    lookback_days: i64,
    sinks: &MineSinks,
) -> Result<()> {
    backend::schema::migrate(pool).await?;

    let users: Vec<String> = match only_user {
        Some(u) => vec![u.to_string()],
        None => sqlx::query_scalar("SELECT user_id FROM nc_tokens")
            .fetch_all(pool)
            .await
            .context("listing users with Nextcloud linked")?,
    };
    if users.is_empty() {
        eprintln!("refresh-focus-places: no users with Nextcloud linked");
        return Ok(());
    }

    for user_id in &users {
        if let Err(e) = refresh_focus_places_one(pool, user_id, lookback_days, sinks).await {
            // One user's failure must neither strand the others nor read as
            // success.
            eprintln!("refresh-focus-places: [{user_id}] FAILED: {e:#}");
            return Err(e);
        }
    }
    Ok(())
}

pub(crate) async fn refresh_focus_places_one(
    pool: &sqlx::MySqlPool,
    user_id: &str,
    lookback_days: i64,
    sinks: &MineSinks,
) -> Result<()> {
    use sqlx::Row as _;

    // ── 1. the point history ────────────────────────────────────────────────
    // ⚠ Not `Config::nextcloud_base_url`: that is None in production, where
    // "no PhoneTrack source" is a real state for the sync, and this cron has
    // always fetched from the default host.
    let nc_base_url = backend::config::focus_nc_base_url();
    let ctx = backend::nextcloud::phonetrack::PhoneTrack::open(
        reqwest::Client::new(),
        pool,
        &nc_base_url,
        user_id,
    )
    .await
    .with_context(|| format!("opening PhoneTrack for {user_id}"))?;

    // ⚠ The window's anchor is a parameter. Filtering mined events by time
    // cuts their counts but not their labels, since each stay's subtype comes
    // from a cluster built over the whole window; only anchoring the window
    // asks what was knowable on a past day.
    let anchor = sinks.as_of.unwrap_or_else(chrono::Utc::now);
    let day = |n: i64| -> String {
        (anchor - chrono::Duration::days(n))
            .format("%Y-%m-%d")
            .to_string()
    };

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut points: Vec<(i64, f64, f64, Option<f64>)> = Vec::new();
    let mut failed_devices = 0usize;
    let mut offset = lookback_days;
    while offset > 0 {
        let start = day(offset);
        let end = day((offset - FOCUS_FETCH_CHUNK_DAYS).max(0));
        let fetched = ctx
            .fetch_range(pool, &start, &end)
            .await
            .with_context(|| format!("fetching PhoneTrack {start}..{end}"))?;
        failed_devices += fetched.failed_devices;
        for p in fetched.points {
            // Chunk bounds are shared, so the same fix arrives twice.
            let k = format!("{}/{:.6}/{:.6}", p.ts, p.lat, p.lon);
            if seen.insert(k) {
                points.push((p.ts, p.lat, p.lon, p.accuracy));
            }
        }
        offset -= FOCUS_FETCH_CHUNK_DAYS;
    }
    points.sort_by_key(|p| p.0);

    // ⚠ Refuse to write on a partial history. The write below ends in
    // `DELETE FROM focus_places`, and with a failed device `points` is a
    // subset: real places match nothing and are deleted. Skipping a week
    // keeps the previous snapshot.
    if failed_devices > 0 {
        anyhow::bail!(
            "[{user_id}] {failed_devices} PhoneTrack device(s) failed — refusing to rebuild \
             focus_places from a partial history, the previous snapshot stands (#1140)"
        );
    }
    if points.is_empty() {
        eprintln!("[{user_id}] no PhoneTrack history in last {lookback_days}d, skipping");
        return Ok(());
    }
    eprintln!("[{user_id}] {} points over {lookback_days}d", points.len());

    // ── 2. sleep windows, for `sleepHoursFromFitbit` ────────────────────────
    let sleep_rows = sqlx::query(
        "SELECT start_time, end_time FROM sleep WHERE user_id = ? AND is_main_sleep = 1",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .context("reading sleep windows")?;
    let sleep_windows: Vec<[i64; 2]> = sleep_rows
        .iter()
        .map(|r| {
            let s: chrono::NaiveDateTime = r.try_get("start_time")?;
            let e: chrono::NaiveDateTime = r.try_get("end_time")?;
            Ok([s.and_utc().timestamp(), e.and_utc().timestamp()])
        })
        .collect::<Result<Vec<_>>>()?;
    eprintln!(
        "[{user_id}] {} Fitbit sleep window(s) for mining",
        sleep_windows.len()
    );

    // ── 3. the existing rows, for identity matching ─────────────────────────
    // ⚠ Two sqlx traps, both seen only on real rows:
    //
    //   * `centroid_lat`/`centroid_lon` are DECIMAL(9,6), which sqlx cannot
    //     decode without `rust_decimal`, so they are cast to CHAR and parsed,
    //     as in `classification_inputs`.
    //   * `id` and `first_seen_ts` are INT UNSIGNED, which decodes as none of
    //     the signed types; reading `id` as `i64` failed in production.
    let old_rows = sqlx::query(
        "SELECT id, CAST(centroid_lat AS CHAR) AS centroid_lat, \
         CAST(centroid_lon AS CHAR) AS centroid_lon, first_seen_ts \
         FROM focus_places WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .context("reading focus_places")?;
    let old: Vec<serde_json::Value> = old_rows
        .iter()
        .map(|r| {
            let id: u64 = r.try_get("id")?;
            let lat: f64 = r.try_get::<String, _>("centroid_lat")?.parse()?;
            let lon: f64 = r.try_get::<String, _>("centroid_lon")?.parse()?;
            let fs: u64 = r.try_get("first_seen_ts")?;
            Ok(serde_json::json!([
                id,
                backend::fold_payload::bits(lat),
                backend::fold_payload::bits(lon),
                fs
            ]))
        })
        .collect::<Result<Vec<_>>>()?;

    // ── 4. the geometry, from Lean ──────────────────────────────────────────
    // The request build, the decode and the one-assignment-per-cluster
    // invariant are in `lean::focus_places`, in the library so tests reach
    // them.
    let focus = backend::lean::focus_places(&points, &sleep_windows, &old)?;
    let mined = &focus.mined;
    let names = &focus.names;
    let assignments = &focus.assignments;
    let deleted = &focus.deleted;
    // Floats cross from Lean as IEEE-754 bit patterns in decimal strings.
    let bitsf = |v: &serde_json::Value| -> Option<f64> {
        v.as_str()?.parse::<u64>().ok().map(f64::from_bits)
    };
    let has_fitbit_sleep = !sleep_windows.is_empty();
    eprintln!(
        "[{user_id}] {} cluster(s), {} to delete",
        mined.len(),
        deleted.len()
    );
    if let Some(path) = &sinks.places_out {
        let rows: Vec<serde_json::Value> = mined
            .iter()
            .zip(assignments.iter())
            .map(|(c, a)| {
                serde_json::json!({
                    "id": a,
                    "lat": c.get("lat").and_then(bitsf),
                    "lon": c.get("lon").and_then(bitsf),
                    "visits": c.get("stays").and_then(|v| v.as_array()).map_or(0, Vec::len),
                    "visitSs": c.get("visitSs").and_then(bitsf),
                })
            })
            .collect();
        std::fs::write(path, serde_json::to_string_pretty(&rows)?)
            .with_context(|| format!("writing {path}"))?;
        eprintln!("[{user_id}] places -> {path} ({} cluster(s))", rows.len());
        if sinks.dry && sinks.hard_out.is_none() && sinks.soft_out.is_none() {
            return Ok(());
        }
    }

    // ── 5. the amenity vote, per cluster ────────────────────────────────────
    // ⚠ Two phases, forced by the mirror. `MirrorSource` may only be touched
    // from a blocking thread (a query from a runtime worker aborts the
    // process), so every OSM lookup happens inside `with_mirror_answerer`'s
    // closure, which cannot await. So: resolve the timezones first (pure CPU),
    // hand plain data across, and bring the labels back.
    let zones = backend::tz_lookup::PolygonLookup::new();

    struct PendingStay {
        lat: f64,
        lon: f64,
        start_ts: i64,
        end_ts: i64,
        local_hour: i64,
        duration_sec: i64,
        samples: Vec<(u32, u32)>,
    }
    struct PendingCluster {
        lat: f64,
        lon: f64,
        stays: Vec<PendingStay>,
    }

    let mut pending: Vec<PendingCluster> = Vec::with_capacity(mined.len());
    let mut residential = 0usize;
    for c in mined {
        let clat = c.get("lat").and_then(bitsf).context("cluster has no lat")?;
        let clon = c.get("lon").and_then(bitsf).context("cluster has no lon")?;
        let empty = Vec::new();
        let stays = c.get("stays").and_then(|v| v.as_array()).unwrap_or(&empty);

        // ⚠ The residence gate. A cluster the user sleeps at is not mined:
        // `amenity_label` stays null and the runtime falls through to the
        // residential-address lookup. Without the gate, hotels and a clinic
        // the user slept at were labelled, writing where the user slept and
        // what kind of place it was, and it read as better coverage.
        //
        // The skip comes before the per-stay loop, so these stays train no
        // prior either; an empty `stays` list does both.
        let cluster_sleep_h = if has_fitbit_sleep {
            c.get("sleepFitbitH").and_then(bitsf)
        } else {
            c.get("sleepH").and_then(bitsf)
        }
        .unwrap_or(0.0);
        if cluster_sleep_h >= RESIDENCE_SLEEP_THRESHOLD_H {
            residential += 1;
            pending.push(PendingCluster {
                lat: clat,
                lon: clon,
                stays: Vec::new(),
            });
            continue;
        }

        let mut ps = Vec::with_capacity(stays.len());
        for s in stays {
            let a = s.as_array().context("a stay is not an array")?;
            let start = a
                .first()
                .and_then(serde_json::Value::as_i64)
                .context("stay startTs")?;
            let end = a
                .get(1)
                .and_then(serde_json::Value::as_i64)
                .context("stay endTs")?;
            let slat = a.get(2).and_then(bitsf).context("stay lat")?;
            let slon = a.get(3).and_then(bitsf).context("stay lon")?;
            let dur = a
                .get(5)
                .and_then(serde_json::Value::as_i64)
                .context("stay durationSec")?;
            // ⚠ A stay with no resolvable zone is skipped, not defaulted to
            // UTC: `localHour` and the opening-hours samples are venue-local,
            // and a wrong clock votes for the wrong venue.
            let Some(tz) = zones.zone(slat, slon) else {
                continue;
            };
            ps.push(PendingStay {
                lat: slat,
                lon: slon,
                start_ts: start,
                end_ts: end,
                local_hour: i64::from(backend::timezone::local_hour_of((start + end) / 2, &tz)?),
                duration_sec: dur,
                samples: backend::timezone::local_stay_samples(start, end, &tz)?,
            });
        }
        pending.push(PendingCluster {
            lat: clat,
            lon: clon,
            stays: ps,
        });
    }

    let now_ms = chrono::Utc::now().timestamp_millis();
    let (voted, flat_stays, unanswered) =
        backend::mirror_source::with_mirror_answerer(pool.clone(), now_ms, move |ans| {
            let mut out: Vec<backend::lean::MinedCluster> = Vec::with_capacity(pending.len());
            // Per cluster: did the mirror fail to answer for any of its stays?
            let mut unanswered: Vec<bool> = Vec::with_capacity(pending.len());
            // The soft-mining population is by construction the stays the hard
            // miner sees: collected in the same loop, after the residence skip
            // and the mirror-could-not-answer skip.
            let mut flat: Vec<backend::lean::MineStay> = Vec::new();
            for c in pending {
                let mut ms: Vec<backend::lean::MineStay> = Vec::with_capacity(c.stays.len());
                let mut missed = false;
                for s in c.stays {
                    // ⚠ `None` means the mirror could not answer, not "no
                    // venues here", so the stay casts no vote rather than a
                    // vote for nothing.
                    let Some(shaped) = ans.nearby_landmarks(s.lat, s.lon)? else {
                        missed = true;
                        continue;
                    };
                    ms.push(backend::lean::MineStay {
                        start_ts: s.start_ts,
                        end_ts: s.end_ts,
                        local_hour: s.local_hour,
                        duration_sec: s.duration_sec,
                        samples: s.samples,
                        landmarks: shaped,
                    });
                }
                let centroid = ans
                    .nearby_landmarks(c.lat, c.lon)?
                    .unwrap_or_else(|| serde_json::json!([]));
                flat.extend(ms.iter().cloned());
                out.push(backend::lean::mine_cluster(&ms, &centroid)?);
                unanswered.push(missed);
            }
            Ok((out, flat, unanswered))
        })
        .await?;

    let mut attributed_all: Vec<backend::lean::AttributedStay> = Vec::new();
    let mut labels: Vec<(Option<String>, Option<String>)> = Vec::with_capacity(voted.len());
    let mut mine_ok = 0usize;
    for m in voted {
        if m.amenity_label.is_some() {
            mine_ok += 1;
        }
        attributed_all.extend(m.attributed);
        labels.push((m.amenity_label, m.amenity_kind));
    }
    // ⚠ One label per mined cluster, or the write below pairs a cluster with
    // another cluster's venue.
    if labels.len() != mined.len() {
        anyhow::bail!(
            "mined {} cluster(s) but got {} label(s)",
            mined.len(),
            labels.len()
        );
    }
    eprintln!(
        "[{user_id}] amenity mining: {mine_ok}/{} clusters labelled, {} attributed stay(s), \
         {residential} skipped as residential, {} the mirror could not fully answer \
         (an empty vote there keeps the stored label)",
        mined.len(),
        attributed_all.len(),
        unanswered.iter().filter(|&&u| u).count()
    );

    // ── 6. the priors blob — a full recompute, never incremental ────────────
    let priors = backend::lean::mine_priors(&attributed_all)?;

    // ── the measurement sinks, before any write ─────────────────────────────
    if let Some(path) = &sinks.hard_out {
        std::fs::write(path, serde_json::to_string_pretty(&priors)?)
            .with_context(|| format!("writing {path}"))?;
        eprintln!(
            "[{user_id}] hard priors -> {path} ({} attributed stay(s))",
            attributed_all.len()
        );
    }
    if let Some(path) = &sinks.soft_out {
        let (blob, rep) = backend::lean::mine_priors_soft(&flat_stays)?;
        eprintln!(
            "[{user_id}] soft priors -> {path}: ess {:.1} vs hard {} · {}/{} stay(s) teaching · \
             mean other {:.3}",
            rep.ess,
            attributed_all.len(),
            rep.stays_teaching,
            rep.stays_total,
            rep.mean_other
        );
        std::fs::write(path, serde_json::to_string_pretty(&blob)?)
            .with_context(|| format!("writing {path}"))?;
    }
    if sinks.dry {
        eprintln!("[{user_id}] --dry: NOT writing venue_type_priors or focus_places");
        return Ok(());
    }

    // ⚠ A backfill writes the snapshot and nothing else. `--as-of` in the past
    // re-mines history for a day that never had a snapshot; everything else
    // here describes now (`venue_type_priors` is what every request reads,
    // `focus_places` is rewritten below), and a backfill would replace the
    // present with the past. `--as-of` today is an ordinary run.
    let backfill = sinks
        .as_of
        .is_some_and(|d| d.date_naive() < chrono::Utc::now().date_naive());

    // ⚠ One transaction from here: the prior, its snapshot and the places it
    // was mined with land together. A half-applied refresh would leave a prior
    // with no snapshot of it, or rows deleted whose replacements were never
    // written, which the dashboard reads as places the user stopped going to.
    let mut tx = pool
        .begin()
        .await
        .context("opening the refresh transaction")?;

    if !backfill {
        sqlx::query(
            "INSERT INTO venue_type_priors (user_id, priors_json, mined_stays) VALUES (?, ?, ?) \
             ON DUPLICATE KEY UPDATE priors_json = VALUES(priors_json), \
                                     mined_stays = VALUES(mined_stays)",
        )
        .bind(user_id)
        .bind(serde_json::to_string(&priors)?)
        .bind(attributed_all.len() as i64)
        .execute(&mut *tx)
        .await
        .context("writing venue_type_priors")?;
    }

    // The same blob, frozen at the day this run's window ended, beside the row
    // above (which every reader expects), never instead of it.
    //
    // ⚠ This is what keeps a past label stable: mining re-clusters from
    // scratch, so re-running it rewrites what past days were called. Only a
    // stored anchor keeps the answer.
    //
    // An upsert, so re-mining an anchor replaces it: the newest run for a date
    // is the one to keep.
    let anchor = sinks
        .as_of
        .unwrap_or_else(chrono::Utc::now)
        .format("%Y-%m-%d")
        .to_string();
    sqlx::query(
        "INSERT INTO venue_type_prior_snapshots (user_id, as_of, priors_json, mined_stays) \
         VALUES (?, ?, ?, ?) \
         ON DUPLICATE KEY UPDATE priors_json = VALUES(priors_json), \
                                 mined_stays = VALUES(mined_stays)",
    )
    .bind(user_id)
    .bind(&anchor)
    .bind(serde_json::to_string(&priors)?)
    .bind(attributed_all.len() as i64)
    .execute(&mut *tx)
    .await
    .context("writing venue_type_prior_snapshots")?;
    eprintln!(
        "[{user_id}] priors snapshot stored as of {anchor} ({} stay(s))",
        attributed_all.len()
    );

    if backfill {
        // ⚠ Stops here because of the DELETE below: a backfill's clusters are
        // the past's, and applying them would replace the places the user goes
        // to now. The snapshot is all a backfill produces.
        eprintln!(
            "[{user_id}] backfill as of {anchor}: snapshot only — NOT touching \
             venue_type_priors or focus_places, which describe now"
        );
        tx.commit().await.context("committing the snapshot")?;
        return Ok(());
    }

    // ── 7. the places ───────────────────────────────────────────────────────
    if !deleted.is_empty() {
        // `QueryBuilder`, not `format!`: an interpolated SQL string trips the
        // audit lint, and this statement has a variable-length parameter list.
        let mut qb: sqlx::QueryBuilder<sqlx::MySql> =
            sqlx::QueryBuilder::new("DELETE FROM focus_places WHERE id IN (");
        let mut sep = qb.separated(", ");
        for id in deleted {
            sep.push_bind(*id);
        }
        qb.push(")");
        qb.build()
            .execute(&mut *tx)
            .await
            .context("deleting stale focus_places")?;
    }

    let mut home_tz: Option<String> = None;
    for (i, c) in mined.iter().enumerate() {
        let id = c
            .get("id")
            .and_then(serde_json::Value::as_i64)
            .context("cluster id")?;
        let clat = c.get("lat").and_then(bitsf).context("cluster lat")?;
        let clon = c.get("lon").and_then(bitsf).context("cluster lon")?;
        let dwell = c
            .get("dwell")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0);
        let unique_days = c
            .get("uniqueDays")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0);
        let detected = c.get("label").and_then(|v| v.as_str()).unwrap_or("other");
        let profile = c.get("profile").and_then(|v| v.as_str()).unwrap_or("");
        // Fitbit-confirmed hours when there are any, else the local-clock
        // 02:00–06:00 heuristic.
        let sleep_h: f64 = if has_fitbit_sleep {
            c.get("sleepFitbitH").and_then(bitsf)
        } else {
            c.get("sleepH").and_then(bitsf)
        }
        .unwrap_or(0.0);
        let empty = Vec::new();
        let stays = c.get("stays").and_then(|v| v.as_array()).unwrap_or(&empty);
        let visit_count = stays.len() as i64;
        let mut ts: Vec<(i64, i64)> = stays
            .iter()
            .filter_map(|s| {
                let a = s.as_array()?;
                Some((a.first()?.as_i64()?, a.get(1)?.as_i64()?))
            })
            .collect();
        ts.sort_unstable();
        let (first_seen, last_seen) = match (ts.first(), ts.last()) {
            (Some(f), Some(l)) => (f.0, l.1),
            _ => continue,
        };
        let display_name = names.get(&id);
        let (amenity_label, amenity_kind) = &labels[i];

        // ⚠ A cluster the mirror could not answer for keeps its stored label
        // when this vote came out empty: no answer is not "no venue". A re-mine
        // during a mirror refile once stored 45 labels where a later run found
        // 59. A vote that answered empty still clears the label.
        let keep_label = amenity_label.is_none() && unanswered.get(i).copied().unwrap_or(false);

        if let Some(old_id) = assignments[i] {
            // ⚠ The UPDATE preserves `id` and `first_seen_ts`: downstream
            // references hold the id, and a re-mine must not look like a new
            // place.
            sqlx::query(
                "UPDATE focus_places SET centroid_lat = ?, centroid_lon = ?, radius_m = ?, \
                   total_dwell_sec = ?, visit_count = ?, unique_days = ?, last_seen_ts = ?, \
                   detected_label = ?, display_name = ?, sleep_hours = ?, \
                   amenity_label = IF(?, amenity_label, ?), amenity_kind = IF(?, amenity_kind, ?), \
                   hour_profile = ?, refreshed_at = CURRENT_TIMESTAMP \
                 WHERE id = ?",
            )
            .bind(clat)
            .bind(clon)
            .bind(FOCUS_RADIUS_M)
            .bind(dwell)
            .bind(visit_count)
            .bind(unique_days)
            .bind(last_seen)
            .bind(detected)
            .bind(display_name)
            .bind(sleep_h.round() as i64)
            .bind(keep_label)
            .bind(amenity_label)
            .bind(keep_label)
            .bind(amenity_kind)
            .bind(profile)
            .bind(old_id)
            .execute(&mut *tx)
            .await
            .with_context(|| format!("updating focus_place {old_id}"))?;
        } else {
            sqlx::query(
                "INSERT INTO focus_places (user_id, centroid_lat, centroid_lon, radius_m, \
                   total_dwell_sec, visit_count, unique_days, first_seen_ts, last_seen_ts, \
                   detected_label, display_name, sleep_hours, amenity_label, amenity_kind, \
                   hour_profile) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(user_id)
            .bind(clat)
            .bind(clon)
            .bind(FOCUS_RADIUS_M)
            .bind(dwell)
            .bind(visit_count)
            .bind(unique_days)
            .bind(first_seen)
            .bind(last_seen)
            .bind(detected)
            .bind(display_name)
            .bind(sleep_h.round() as i64)
            .bind(amenity_label)
            .bind(amenity_kind)
            .bind(profile)
            .execute(&mut *tx)
            .await
            .context("inserting a focus_place")?;
        }

        // The residence zone, for read-time fallback. The first Home wins; if
        // no cluster qualifies, the stored value is left alone.
        if home_tz.is_none() && display_name.map(String::as_str) == Some("Home") {
            home_tz = zones.zone(clat, clon);
        }
    }

    if let Some(tz) = &home_tz {
        // In the transaction, so a failed refresh rolls the zone back with the
        // rows it was derived from.
        backend::sync_state::set_with(&mut *tx, user_id, "home_tz", tz)
            .await
            .context("writing home_tz")?;
        eprintln!("[{user_id}] home_tz = {tz}");
    }

    tx.commit().await.context("committing the refresh")?;
    eprintln!("[{user_id}] focus_places refreshed ({} rows)", mined.len());
    Ok(())
}

/// ⚠ A constant, not a measured spread: four call sites read this column, one
/// only notices values above 40 m, and every stored row carries 25.
pub(crate) const FOCUS_RADIUS_M: i64 = 25;

/// Fitbit-confirmed sleep hours at or above which a cluster is a RESIDENCE and
/// is not mined for a venue name at all. See the gate-0 note at its use.
pub(crate) const RESIDENCE_SLEEP_THRESHOLD_H: f64 = 5.0;
/// Days per PhoneTrack request. Shared chunk bounds are why the fetch dedups.
pub(crate) const FOCUS_FETCH_CHUNK_DAYS: i64 = 7;
/// Days of history mined when the cron passes none.
pub(crate) const FOCUS_DEFAULT_LOOKBACK_DAYS: i64 = 180;

/// Pool each rail route's historic GPS corridor and snap it, filling
/// `rail_route_cache`.
///
/// Two passes: walk the window pooling every train leg's fixes per route key,
/// then snap each pooled cloud once.
///
/// The snap is all Lean: `Verified.Geo.RailSnap` builds the graph, fuses
/// vertices and finds the path, and the `railsnap` serve mode gets the raw
/// ways, so none of that can drift on this side of the boundary.
pub(crate) async fn refresh_rail_routes(window_days: i64) -> Result<()> {
    // This pod sets DB_* and NC_* and nothing else. A config that demanded
    // more is what failed `refresh-presence-log` and `refresh-focus-places` in
    // production, both times AFTER the job had done real work.
    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    backend::schema::migrate(&pool).await?;
    let st = backend::state::AppState::new(pool.clone(), cfg, reqwest::Client::new());

    let users: Vec<String> = sqlx::query_scalar("SELECT user_id FROM nc_tokens")
        .fetch_all(&pool)
        .await
        .context("listing users with Nextcloud linked")?;
    if users.is_empty() {
        eprintln!("refresh-rail-routes: no users with Nextcloud linked");
        pool.close().await;
        return Ok(());
    }

    /// One route's pooled evidence: every train leg's fixes on that key, plus a
    /// representative window. The stored geometry carries no timestamps, so any
    /// instance's window will do for the interpolation.
    struct RouteAcc {
        fixes: Vec<(f64, f64)>,
        start_ts: f64,
        end_ts: f64,
    }
    // Ordered, so the upsert order and the log are stable run to run; this
    // job's output is read by eye when a route looks wrong.
    let mut by_route: std::collections::BTreeMap<String, RouteAcc> =
        std::collections::BTreeMap::new();
    // Counted so an empty result can be told apart from a broken one.
    let (mut days_attempted, mut days_failed) = (0u32, 0u32);

    for user_id in &users {
        let tz = backend::sync_state::get(&pool, user_id, "home_tz")
            .await
            .context("reading home_tz")?
            .unwrap_or_else(|| "Europe/London".into());
        eprintln!("[{user_id}] scanning {window_days}-day window (tz={tz})");

        for offset in 0..=window_days {
            let date = (chrono::Utc::now() - chrono::Duration::days(offset))
                .format("%Y-%m-%d")
                .to_string();
            // A day that will not compute is skipped with a warning: the
            // pooled corridor is a union over many days and degrades
            // gracefully.
            days_attempted += 1;
            let result =
                match backend::routes::velocity::compute(&st, user_id, &date, Some(&tz)).await {
                    Ok(r) => r,
                    Err(e) => {
                        eprintln!("[{user_id} {date}] velocity failed: {e:#}");
                        days_failed += 1;
                        continue;
                    }
                };
            let empty = Vec::new();
            let segments = result
                .get("segments")
                .and_then(serde_json::Value::as_array)
                .unwrap_or(&empty);
            let points = result
                .get("points")
                .and_then(serde_json::Value::as_array)
                .unwrap_or(&empty);

            for seg in segments {
                // `refinedMode`, else `mode`.
                let mode = seg
                    .get("refinedMode")
                    .and_then(serde_json::Value::as_str)
                    .or_else(|| seg.get("mode").and_then(serde_json::Value::as_str))
                    .unwrap_or("");
                if mode != "train" {
                    continue;
                }
                let Some(way_name) = seg.get("wayName").and_then(serde_json::Value::as_str) else {
                    continue;
                };
                let (Some(s), Some(e)) = (
                    seg.get("startTs").and_then(serde_json::Value::as_f64),
                    seg.get("endTs").and_then(serde_json::Value::as_f64),
                ) else {
                    continue;
                };
                let in_win: Vec<(f64, f64)> = points
                    .iter()
                    .filter(|p| {
                        p.get("ts")
                            .and_then(serde_json::Value::as_f64)
                            .is_some_and(|t| t >= s && t <= e)
                    })
                    .filter_map(|p| Some((p.get("lat")?.as_f64()?, p.get("lon")?.as_f64()?)))
                    .collect();
                if in_win.is_empty() {
                    continue;
                }
                by_route
                    .entry(way_name.to_string())
                    .and_modify(|a| a.fixes.extend_from_slice(&in_win))
                    .or_insert(RouteAcc {
                        fixes: in_win,
                        start_ts: s,
                        end_ts: e,
                    });
            }
        }
    }
    eprintln!(
        "refresh-rail-routes: {} route key(s) pooled from {days_attempted} day(s), {days_failed} failed",
        by_route.len()
    );

    // ⚠ Refuse rather than report success on nothing. Zero routes is a real
    // answer (weeks without a train) but looks the same as every day failing;
    // this job once had all its days die on a read-only `/tmp`, pooled 0
    // routes and exited SUCCEEDED. So the test is the failure count, never the
    // route count.
    if days_failed > 0 && days_failed == days_attempted {
        pool.close().await;
        anyhow::bail!(
            "every one of the {days_attempted} day(s) scanned failed to compute — refusing to \
             report a successful refresh over no evidence (#1134)"
        );
    }
    // A majority failing is not fatal — the corridor is a union over many days —
    // but it must be LOUD: a thin corridor snaps to a WORSE path, not to none.
    if days_failed * 2 > days_attempted {
        eprintln!(
            "⚠ refresh-rail-routes: {days_failed} of {days_attempted} days failed — the pooled \
             corridor is thinner than it should be and any route snapped from it is suspect"
        );
    }

    let mut routes: Vec<(String, serde_json::Value)> = Vec::new();
    for (key, acc) in &by_route {
        let snapped =
            match backend::rail_route::geometry(&pool, key, acc.start_ts, acc.end_ts, &acc.fixes)
                .await?
            {
                Some(g) => Some(g),
                None => relation_route_geometry(key, acc.start_ts, acc.end_ts, &acc.fixes).await?,
            };
        match snapped {
            Some(geom) if geom.len() >= 2 => {
                eprintln!(
                    "  resolved route → {} pts ({} historic fixes)",
                    geom.len(),
                    acc.fixes.len()
                );
                routes.push((key.clone(), serde_json::Value::Array(geom)));
            }
            _ => eprintln!(
                "  route left un-snapped ({} historic fixes — thin or disconnected)",
                acc.fixes.len()
            ),
        }
    }

    eprintln!(
        "Computed {} route geometries; upserting into rail_route_cache",
        routes.len()
    );
    if !routes.is_empty() {
        // ⚠ Upsert, never wipe-and-rebuild: a DELETE-all dropped every route
        // not ridden inside the window, so older days drew their rides raw, and
        // it would discard the serving path's miss-driven fills.
        let mut tx = pool.begin().await.context("opening the rail transaction")?;
        for (key, geom) in &routes {
            sqlx::query(
                "INSERT INTO rail_route_cache (route_key, geometry_json) VALUES (?, ?) \
                 ON DUPLICATE KEY UPDATE geometry_json = VALUES(geometry_json), \
                                         computed_at = CURRENT_TIMESTAMP",
            )
            .bind(key)
            .bind(serde_json::to_string(geom)?)
            .execute(&mut *tx)
            .await
            .with_context(|| format!("upserting rail route {key}"))?;
        }
        tx.commit().await.context("committing rail_route_cache")?;
    }
    eprintln!("rail_route_cache upserted: {} routes", routes.len());
    pool.close().await;
    Ok(())
}

/// How far around a ride's fixes its two stations are looked for (m): a TGV's
/// fixes can be kilometres off the track and miss a terminus.
pub(crate) const RELATION_STATION_MARGIN_M: f64 = 5000.0;
/// A train relation serves a station when one of its stops is within this (m).
pub(crate) const RELATION_STOP_RADIUS_M: f64 = 500.0;
/// The candidate relations whose track is fetched, at most.
pub(crate) const RELATION_MAX_CANDIDATES: usize = 3;
/// Overpass budget per request (ms).
pub(crate) const RELATION_TIMEOUT_MS: u64 = 120_000;

/// One Overpass request through the shared client and its mirror fallback; the
/// body's `elements`, or an error the caller turns into "leave it raw".
///
/// ⚠ Asks for a slot first and retries a refusal once, as the tile mirror
/// does. Unpaced, a night's lookups at a two-slot allowance came back 429 and
/// 504 on most rides.
async fn overpass_elements(
    client: &reqwest::Client,
    query: &str,
) -> Result<Vec<serde_json::Value>> {
    use backend::overpass::{Outcome, fetch_attempt, wait_for_slot};
    wait_for_slot(client, super::mirror::SLOT_WAIT_CAP_S).await;
    let mut outcome = fetch_attempt(client, query, RELATION_TIMEOUT_MS, 0).await;
    if outcome.may_retry() {
        wait_for_slot(client, super::mirror::SLOT_WAIT_CAP_S).await;
        let again = fetch_attempt(client, query, RELATION_TIMEOUT_MS, 1).await;
        outcome = match (outcome, again) {
            (
                Outcome::AllFailed {
                    errors: mut first, ..
                },
                Outcome::AllFailed { errors, answered },
            ) => {
                first.extend(errors.into_iter().map(|e| format!("retry: {e}")));
                Outcome::AllFailed {
                    errors: first,
                    answered,
                }
            }
            (_, other) => other,
        };
    }
    match outcome {
        backend::overpass::Outcome::Ok(body) => backend::overpass::elements(&body),
        backend::overpass::Outcome::Permanent { status } => {
            anyhow::bail!("Overpass refused the query ({status})")
        }
        backend::overpass::Outcome::AllFailed { errors, .. } => {
            anyhow::bail!("Overpass unreachable: {}", errors.join("; "))
        }
    }
}

/// A long mainline ride's track from the OSM route relation of the service
/// ridden — the fallback when the mirror holds no connected track between the
/// two stations, which is every ride longer than the area its fixes fetched (a
/// TGV across France).
///
/// One request finds both stations by the label's names near the fixes and
/// the train relations stopping at each; their intersection is the services
/// that ran between them. Each candidate's ways are routed over by
/// `RailSnap.snapOnRelation`, and the path closest to the pooled fixes (by
/// median distance, `RailSnap.medianDistanceToPath`) is kept. `None` means
/// leave it raw: no relation serves both, Overpass failed, or none joins the
/// two stations.
pub(crate) async fn relation_route_geometry(
    key: &str,
    start_ts: f64,
    end_ts: f64,
    fixes: &[(f64, f64)],
) -> Result<Option<Vec<serde_json::Value>>> {
    let label = key.split(" · ").next().unwrap_or(key);
    let Some((board, alight)) = label.split_once(" → ") else {
        return Ok(None);
    };
    if fixes.is_empty() || board == alight {
        return Ok(None);
    }
    let (mut s, mut w, mut n, mut e) = (90.0f64, 180.0f64, -90.0f64, -180.0f64);
    for (la, lo) in fixes {
        s = s.min(*la);
        n = n.max(*la);
        w = w.min(*lo);
        e = e.max(*lo);
    }
    let d_lat = RELATION_STATION_MARGIN_M / 111_320.0;
    let d_lon = RELATION_STATION_MARGIN_M
        / (111_320.0 * (((s + n) / 2.0) * std::f64::consts::PI / 180.0).cos());
    let bbox = format!("{},{},{},{}", s - d_lat, w - d_lon, n + d_lat, e + d_lon);
    let esc = |t: &str| t.replace('\\', "\\\\").replace('"', "\\\"");
    let kinds = r#"[~"^(railway|public_transport)$"~"^(station|halt|stop|stop_position)$"]"#;
    let r = RELATION_STOP_RADIUS_M;
    let query = format!(
        "[out:json][timeout:90];\
         node[\"name\"=\"{b}\"]{kinds}({bbox})->.b;\
         node[\"name\"=\"{a}\"]{kinds}({bbox})->.a;\
         .b out;.a out;\
         (node(around.b:{r})[\"public_transport\"=\"stop_position\"];.b;)->.bs;\
         rel(bn.bs)[\"route\"=\"train\"]->.rb;\
         (node(around.a:{r})[\"public_transport\"=\"stop_position\"];.a;)->.as;\
         rel(bn.as)[\"route\"=\"train\"]->.ra;\
         rel.rb.ra;out ids;",
        b = esc(board),
        a = esc(alight),
    );
    let client = reqwest::Client::new();
    let els = match overpass_elements(&client, &query).await {
        Ok(els) => els,
        Err(err) => {
            eprintln!("  relation lookup for the route failed, left raw: {err:#}");
            return Ok(None);
        }
    };
    let at = |name: &str| {
        els.iter().find_map(|el| {
            (el.get("type")?.as_str()? == "node" && el.pointer("/tags/name")?.as_str()? == name)
                .then(|| Some((el.get("lat")?.as_f64()?, el.get("lon")?.as_f64()?)))?
        })
    };
    let (Some(board_pt), Some(alight_pt)) = (at(board), at(alight)) else {
        eprintln!("  a station of the route is not in OSM by its name near the fixes, left raw");
        return Ok(None);
    };
    let rel_ids: Vec<u64> = els
        .iter()
        .filter(|el| el.get("type").and_then(serde_json::Value::as_str) == Some("relation"))
        .filter_map(|el| el.get("id")?.as_u64())
        .take(RELATION_MAX_CANDIDATES)
        .collect();
    eprintln!("  {} train relation(s) serve both stations", rel_ids.len());

    let mut best: Option<(f64, Vec<serde_json::Value>)> = None;
    for id in rel_ids {
        let q = format!("[out:json][timeout:120];rel({id});way(r);out geom;");
        let ways_el = match overpass_elements(&client, &q).await {
            Ok(v) => v,
            Err(err) => {
                eprintln!("  relation {id}: track fetch failed: {err:#}");
                continue;
            }
        };
        let ways: Vec<serde_json::Value> = ways_el
            .iter()
            .filter_map(|wy| {
                let coords: Vec<serde_json::Value> = wy
                    .get("geometry")?
                    .as_array()?
                    .iter()
                    .filter_map(|p| {
                        Some(serde_json::json!([
                            backend::fold_payload::bits(p.get("lat")?.as_f64()?),
                            backend::fold_payload::bits(p.get("lon")?.as_f64()?)
                        ]))
                    })
                    .collect();
                (coords.len() >= 2).then(|| {
                    serde_json::json!({
                        "name": wy.pointer("/tags/name"),
                        "subtype": wy.pointer("/tags/railway"),
                        "coords": coords,
                    })
                })
            })
            .collect();
        let Some((score, path)) =
            backend::lean::relation_route(start_ts, end_ts, &ways, board_pt, alight_pt, fixes)?
        else {
            eprintln!("  relation {id}: no path joins the two stations");
            continue;
        };
        eprintln!(
            "  relation {id}: {} pts, fixes' median distance {score:.0} m",
            path.len()
        );
        if best.as_ref().is_none_or(|(b, _)| score < *b) {
            best = Some((score, path));
        }
    }
    Ok(best.map(|(_, p)| p))
}

/// Days of history the rail pass pools by default.
pub(crate) const RAIL_DEFAULT_WINDOW_DAYS: i64 = 21;

/// Rebuild `presence_log` from `decoded_days` over a bounded window.
///
/// The rule is `Verified.PresenceLog.computeRow`; this is the IO around it.
///
/// An upsert: a DELETE+INSERT would drop the rows outside the window every run.
///
/// ⚠ Rows are processed in query order and each day's segments in stored
/// order. The rollup's tie-break keeps the place seen first, so re-ordering
/// either changes which place a day is attributed to.
pub(crate) async fn refresh_presence_log(
    pool: &sqlx::MySqlPool,
    lookback: i64,
    only: Option<(&str, &str)>,
) -> Result<()> {
    use sqlx::Row as _;

    backend::schema::migrate(pool).await?;

    // The cutoff is a UTC civil date, whatever anyone's zone.
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(lookback))
        .format("%Y-%m-%d")
        .to_string();
    eprintln!("refresh-presence-log: lookback={lookback}d (cutoff={cutoff})");

    // One day, for the decode worker after it writes that day's decode.
    let days = match only {
        Some((user_id, date)) => sqlx::query(
            "SELECT user_id, date, segments_json FROM decoded_days WHERE user_id = ? AND date = ?",
        )
        .bind(user_id)
        .bind(date)
        .fetch_all(pool)
        .await
        .context("reading decoded_days")?,
        None => {
            sqlx::query("SELECT user_id, date, segments_json FROM decoded_days WHERE date >= ?")
                .bind(&cutoff)
                .fetch_all(pool)
                .await
                .context("reading decoded_days")?
        }
    };
    eprintln!(
        "refresh-presence-log: {} decoded day(s) in window",
        days.len()
    );

    let mut tz_by_user: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let (mut inserted, mut skipped) = (0u32, 0u32);

    for row in days {
        let user_id: String = row.try_get("user_id").context("decoded_days.user_id")?;
        // `date` is a DATE column, read as a string like the rest of this
        // binary does, so the value written back is the value read.
        let date: String = row
            .try_get::<chrono::NaiveDate, _>("date")
            .map(|d| d.format("%Y-%m-%d").to_string())
            .context("decoded_days.date")?;
        let segments_json: String = row
            .try_get("segments_json")
            .context("decoded_days.segments_json")?;

        if !tz_by_user.contains_key(&user_id) {
            let tz: Option<String> = sqlx::query_scalar(
                "SELECT value FROM sync_state WHERE user_id = ? AND key_name = 'home_tz'",
            )
            .bind(&user_id)
            .fetch_optional(pool)
            .await
            .context("reading home_tz")?
            .flatten();
            tz_by_user.insert(
                user_id.clone(),
                tz.unwrap_or_else(|| "Europe/London".into()),
            );
        }
        let tz = &tz_by_user[&user_id];

        // Bad JSON is skipped with a warning; one corrupt day must not stop
        // the rest.
        let Ok(segments) = serde_json::from_str::<serde_json::Value>(&segments_json) else {
            eprintln!("refresh-presence-log: bad JSON for {user_id} {date}");
            skipped += 1;
            continue;
        };

        let Some(r) = backend::lean::presence_row(&segments)? else {
            skipped += 1;
            continue;
        };

        sqlx::query(
            "INSERT INTO presence_log \
               (user_id, date, tz, dominant_place_id, dominant_fraction, \
                end_of_day_place_id, end_of_day_ts, end_of_day_posterior) \
             VALUES (?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), ?) \
             ON DUPLICATE KEY UPDATE \
               tz = VALUES(tz), \
               dominant_place_id = VALUES(dominant_place_id), \
               dominant_fraction = VALUES(dominant_fraction), \
               end_of_day_place_id = VALUES(end_of_day_place_id), \
               end_of_day_ts = VALUES(end_of_day_ts), \
               end_of_day_posterior = VALUES(end_of_day_posterior)",
        )
        .bind(&user_id)
        .bind(&date)
        .bind(tz)
        .bind(r.dominant_place_id)
        .bind(r.dominant_fraction)
        .bind(r.end_of_day_place_id)
        .bind(r.end_of_day_ts)
        .bind(r.end_of_day_posterior)
        .execute(pool)
        .await
        .with_context(|| format!("writing presence_log for {user_id} {date}"))?;
        inserted += 1;
    }

    eprintln!("refresh-presence-log: inserted {inserted}, skipped {skipped}");
    Ok(())
}

/// Refresh `rail_stops_cache` from OSM.
///
/// Fetches only the DUE tiles (`due_tiles`) and replaces each one that answered;
/// every other tile keeps what it had. The run fails when most of the area has
/// gone stale (`Verified.Geo.OsmMirrorRefresh`).
// dev-lint: allow-sqlx the retirement is its own decision, taken before the mirrors answer
pub(crate) async fn refresh_rail_stops(dry_run: bool) -> Result<()> {
    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    backend::schema::migrate(&pool).await?;

    let Some(plan) = mirror_plan(&pool).await? else {
        pool.close().await;
        return Ok(());
    };

    // ⚠ Before the fetch: a key the plan can no longer emit will never be
    // refreshed, whatever the mirrors say tonight, so retiring it needs only
    // the plan. Its own transaction, because it is its own decision.
    if !dry_run {
        retire_unplannable(&pool, &plan, "rail").await?;
    }

    let due = due_tiles(&pool, "rail", &plan).await?;
    eprintln!(
        "rail: {} of {} tiles due (not answered in {REFRESH_DAYS} days)",
        due.len(),
        plan.tiles.len()
    );
    let client = reqwest::Client::new();
    let h = mirror_fetch(&client, "rail", &due).await?;
    eprintln!(
        "refresh-rail-stops: {} relations, {}",
        h.routes.len(),
        mirror_coverage_line(h.succeeded.len(), due.len())
    );

    // The dry run stops here, before the transaction, having run everything a
    // real run decides before it writes.
    if dry_run {
        eprintln!(
            "DRY RUN — this run would replace {} of {} due tiles with {} relation(s)",
            h.succeeded.len(),
            due.len(),
            h.routes.len()
        );
        pool.close().await;
        return Ok(());
    }

    let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM rail_stops_cache")
        .fetch_one(&pool)
        .await
        .context("counting rail_stops_cache")?;
    let mut tx = pool
        .begin()
        .await
        .context("opening the merge transaction")?;
    // A run is authoritative ONLY for the tiles that answered. Every other tile
    // keeps what it had, so the mirror cannot shrink because Overpass 502'd
    // somewhere.
    for key in &h.succeeded {
        sqlx::query("DELETE FROM rail_stops_cache WHERE tile_key = ?")
            .bind(key)
            .execute(&mut *tx)
            .await
            .with_context(|| format!("clearing tile {key}"))?;
    }
    for (tile, r) in h.routes.values() {
        // Upsert: a relation crossing tiles can be held under a tile not
        // fetched tonight and still come back from one that answered.
        sqlx::query(
            "INSERT INTO rail_stops_cache (osm_relation_id, route_type, line_ref, line_name, stops_json, tile_key) \
             VALUES (?, ?, ?, ?, ?, ?) \
             ON DUPLICATE KEY UPDATE route_type = VALUES(route_type), line_ref = VALUES(line_ref), \
               line_name = VALUES(line_name), stops_json = VALUES(stops_json), \
               tile_key = VALUES(tile_key), computed_at = CURRENT_TIMESTAMP",
        )
        .bind(r.osm_relation_id)
        .bind(r.route_type.as_deref().unwrap_or(""))
        .bind(r.route_ref.as_deref())
        .bind(r.route_name.as_deref())
        .bind(serde_json::to_string(&r.stops)?)
        .bind(tile)
        .execute(&mut *tx)
        .await
        .with_context(|| format!("writing relation {}", r.osm_relation_id))?;
    }
    mark_refreshed(&mut tx, "rail", &h.succeeded).await?;
    tx.commit().await.context("committing the merge")?;
    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM rail_stops_cache")
        .fetch_one(&pool)
        .await
        .unwrap_or(existing);
    eprintln!(
        "rail_stops_cache merged: {}/{} due tiles replaced, {} kept their existing rows — {existing} -> {after} relations",
        h.succeeded.len(),
        due.len(),
        h.failures
    );

    // Asked AFTER the write: what answered is stored either way, and this
    // decides only whether the run fails.
    let stale = stale_tiles(&pool, "rail", &plan).await?;
    pool.close().await;
    if let Some(why) = backend::lean::mirror_staleness(after, stale, plan.tiles.len(), STALE_DAYS)?
    {
        anyhow::bail!("{why}");
    }
    Ok(())
}

/// Retire the rows no future run can reach: keys the plan can no longer emit.
///
/// ⚠ The tile grid moves. The plan comes from mined focus places and
/// `tile_key` is the south-west corner to four decimals, so a shifted bbox
/// renames every tile, and the merge's per-tile `DELETE` names only current
/// keys. Rows under old names, and `tile_key IS NULL` rows from before the
/// column, would stay forever; `classification_inputs::bus_route_cache` reads
/// the table unfiltered, so they reached the bus matcher (a third of the rows
/// when measured).
///
/// Independent of coverage, so the caller runs it before the refusal.
pub(crate) async fn retire_unplannable(
    pool: &sqlx::MySqlPool,
    plan: &backend::lean::MirrorPlan,
    mode: &str,
) -> Result<()> {
    use backend::lean;
    let planned: std::collections::BTreeSet<String> =
        plan.tiles.iter().map(lean::tile_key).collect();
    let mut tx = pool.begin().await.context("opening the retirement")?;

    // The table name cannot be bound and the SQL must stay literal for
    // `DL-SQLX-SCHEMA-TRUTH`, so each arm names its own statements.
    let present: Vec<String> = match mode {
        "bus" => sqlx::query_scalar(
            "SELECT DISTINCT tile_key FROM bus_route_cache WHERE tile_key IS NOT NULL",
        )
        .fetch_all(&mut *tx)
        .await
        .context("listing bus_route_cache tiles")?,
        _ => sqlx::query_scalar(
            "SELECT DISTINCT tile_key FROM rail_stops_cache WHERE tile_key IS NOT NULL",
        )
        .fetch_all(&mut *tx)
        .await
        .context("listing rail_stops_cache tiles")?,
    };

    let mut retired = 0u64;
    for key in present.iter().filter(|k| !planned.contains(*k)) {
        let n = match mode {
            "bus" => sqlx::query(
                "DELETE FROM bus_route_cache WHERE tile_key = ? \
                 AND computed_at < DATE_SUB(NOW(), INTERVAL ? DAY)",
            ),
            _ => sqlx::query(
                "DELETE FROM rail_stops_cache WHERE tile_key = ? \
                 AND computed_at < DATE_SUB(NOW(), INTERVAL ? DAY)",
            ),
        }
        .bind(key)
        .bind(ORPHAN_RETIRE_DAYS)
        .execute(&mut *tx)
        .await
        .with_context(|| format!("retiring orphaned tile {key}"))?
        .rows_affected();
        if n > 0 {
            eprintln!("  retired {n} row(s) under orphaned tile {key}");
            retired += n;
        }
    }

    let n = match mode {
        "bus" => sqlx::query(
            "DELETE FROM bus_route_cache WHERE tile_key IS NULL \
             AND computed_at < DATE_SUB(NOW(), INTERVAL ? DAY)",
        ),
        _ => sqlx::query(
            "DELETE FROM rail_stops_cache WHERE tile_key IS NULL \
             AND computed_at < DATE_SUB(NOW(), INTERVAL ? DAY)",
        ),
    }
    .bind(ORPHAN_RETIRE_DAYS)
    .execute(&mut *tx)
    .await
    .context("retiring pre-tile_key rows")?
    .rows_affected();
    if n > 0 {
        eprintln!("  retired {n} row(s) written before tile_key existed");
        retired += n;
    }

    tx.commit().await.context("committing the retirement")?;
    // Logged even at zero: a run that retires nothing and one that never
    // reached the retirement must look different.
    eprintln!(
        "{mode}: retired {retired} unplannable row(s) across {} planned tile(s)",
        planned.len()
    );
    Ok(())
}

/// Refresh `bus_route_cache` from OSM.
///
/// The rail arm's shape: only the due tiles, each replaced if it answered, and a
/// failure when most of the area has gone stale.
// dev-lint: allow-sqlx the retirement is its own decision, taken before the mirrors answer
pub(crate) async fn refresh_bus_routes(dry_run: bool) -> Result<()> {
    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    backend::schema::migrate(&pool).await?;

    let Some(plan) = mirror_plan(&pool).await? else {
        pool.close().await;
        return Ok(());
    };

    // ⚠ Before the fetch, as in the rail arm.
    if !dry_run {
        retire_unplannable(&pool, &plan, "bus").await?;
    }

    let due = due_tiles(&pool, "bus", &plan).await?;
    eprintln!(
        "bus: {} of {} tiles due (not answered in {REFRESH_DAYS} days)",
        due.len(),
        plan.tiles.len()
    );
    let client = reqwest::Client::new();
    let h = mirror_fetch(&client, "bus", &due).await?;
    eprintln!(
        "refresh-bus-routes: {} routes, {}",
        h.routes.len(),
        mirror_coverage_line(h.succeeded.len(), due.len())
    );

    // ⚠ Same placement as the rail arm: before the write.
    if dry_run {
        eprintln!(
            "DRY RUN — this run would replace {} of {} due tiles with {} route(s)",
            h.succeeded.len(),
            due.len(),
            h.routes.len()
        );
        pool.close().await;
        return Ok(());
    }

    let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bus_route_cache")
        .fetch_one(&pool)
        .await
        .context("counting bus_route_cache")?;
    let mut tx = pool
        .begin()
        .await
        .context("opening the merge transaction")?;
    for key in &h.succeeded {
        sqlx::query("DELETE FROM bus_route_cache WHERE tile_key = ?")
            .bind(key)
            .execute(&mut *tx)
            .await
            .with_context(|| format!("clearing tile {key}"))?;
    }
    for (tile, r) in h.routes.values() {
        // Upsert, as in the rail arm.
        sqlx::query(
            "INSERT INTO bus_route_cache (osm_relation_id, route_ref, route_name, stops_json, tile_key) \
             VALUES (?, ?, ?, ?, ?) \
             ON DUPLICATE KEY UPDATE route_ref = VALUES(route_ref), route_name = VALUES(route_name), \
               stops_json = VALUES(stops_json), tile_key = VALUES(tile_key), computed_at = CURRENT_TIMESTAMP",
        )
        .bind(r.osm_relation_id)
        .bind(r.route_ref.as_deref().unwrap_or(""))
        .bind(r.route_name.as_deref())
        .bind(serde_json::to_string(&r.stops)?)
        .bind(tile)
        .execute(&mut *tx)
        .await
        .with_context(|| format!("writing route {}", r.osm_relation_id))?;
    }
    mark_refreshed(&mut tx, "bus", &h.succeeded).await?;
    tx.commit().await.context("committing the merge")?;

    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bus_route_cache")
        .fetch_one(&pool)
        .await
        .unwrap_or(existing);
    eprintln!(
        "bus_route_cache merged: {}/{} due tiles replaced, {} kept their existing rows — {existing} -> {after} routes",
        h.succeeded.len(),
        due.len(),
        h.failures
    );

    let stale = stale_tiles(&pool, "bus", &plan).await?;
    pool.close().await;
    if let Some(why) = backend::lean::mirror_staleness(after, stale, plan.tiles.len(), STALE_DAYS)?
    {
        anyhow::bail!("{why}");
    }
    Ok(())
}

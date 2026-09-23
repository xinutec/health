//! The nightly refresh crons: focus places, presence log, rail routes, rail
//! stops, bus routes.

use super::mirror::*;
use anyhow::{Context, Result};
use backend::db;

/// Rebuild `focus_places` and `venue_type_priors` from PhoneTrack history.
///
/// Tier 2 of #982 — the node cron is `src/cli/refresh-focus-places.ts`, which
/// runs Sundays 04:00. The geometry (stays, clusters, splitting, hour profiles,
/// identity) is `ServeEntry`'s `focus` mode; the amenity vote is
/// `Verified.Geo.FocusMining.mineCluster`; everything here is the IO around
/// them.
///
/// ⚠ NOT ported, deliberately: `--explain`, `--dry-run`'s census listings and
/// `--emit-known-places`. They are ~400 of the TypeScript's 754 lines and are
/// diagnostics for decisions the guards now pin.
///
/// ⚠ `radius_m` is written as the LITERAL 25, on both the INSERT and the
/// UPDATE, because that is what the TypeScript writes and what all 128 prod
/// rows carry. `clusterSpreadM` feeds a console report and nothing else — it is
/// deliberately not ported, and writing a measured spread here would be a
/// behaviour change four call sites can see.
/// The #343 P0 measurement sinks: extra outputs riding the prod mining path,
/// so the A/B population can never drift from what the cron actually mines
/// (the July harness mined 528 stays where prod mines 306 — this is why the
/// loop is not a separate harness).
pub(crate) struct MineSinks {
    pub(crate) soft_out: Option<String>,
    pub(crate) hard_out: Option<String>,
    pub(crate) dry: bool,
    /// Mine as the window stood on this instant rather than now (#1405).
    ///
    /// ⚠ A MEASUREMENT FLAG, and it must stay one until somebody has costed
    /// it. Answering a day this way means re-clustering per day served, and one
    /// 730-day mine is 272,977 points into 372 clusters — that cannot go near
    /// the serving path.
    pub(crate) as_of: Option<chrono::DateTime<chrono::Utc>>,
}

impl MineSinks {
    pub(crate) fn active(&self) -> bool {
        self.soft_out.is_some() || self.hard_out.is_some() || self.dry
    }
}

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
            // ⚠ One user's failure must not strand the others, and must not
            // read as success either. The TypeScript lets the whole process
            // die here.
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
    // ⚠ `Config::nextcloud_base_url` is None IN PRODUCTION (#1037) — the sync
    // path types it nullable because "no PhoneTrack source" is a real state
    // there. THIS cron does not share that: its TypeScript has its own schema
    // with `.default("https://dash.xinutec.org")`, so it has always fetched
    // against that host whether or not `NC_BASE_URL` was set.
    //
    // Reading the shared config here would make the Rust arm quietly unable to
    // fetch anything in the exact deployment the node cron works in.
    let nc_base_url = backend::config::focus_nc_base_url();
    let ctx = backend::nextcloud::phonetrack::PhoneTrack::open(
        reqwest::Client::new(),
        pool,
        &nc_base_url,
        user_id,
    )
    .await
    .with_context(|| format!("opening PhoneTrack for {user_id}"))?;

    // ⚠ THE WINDOW'S ANCHOR IS A PARAMETER (#1405). Mining always counted back
    // from NOW, which is why an as-of-the-day prior could not be reconstructed:
    // filtering the mined events by timestamp cuts their COUNTS but not their
    // LABELS, because every stay's subtype comes from a cluster built over the
    // whole window — including the part after the cut. Anchoring the window
    // itself is the only way to ask what was knowable on a past day.
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
            // The TypeScript's dedup key, verbatim: chunk bounds are shared, so
            // the same fix arrives twice.
            let k = format!("{}/{:.6}/{:.6}", p.ts, p.lat, p.lon);
            if seen.insert(k) {
                points.push((p.ts, p.lat, p.lon, p.accuracy));
            }
        }
        offset -= FOCUS_FETCH_CHUNK_DAYS;
    }
    points.sort_by_key(|p| p.0);

    // ⚠ REFUSE TO WRITE ON A PARTIAL HISTORY (#1140). The write path below ends
    // in `DELETE FROM focus_places`, and a device whose points call failed makes
    // `points` a SUBSET — real places then match nothing, and get deleted. The
    // TypeScript does not check this: it logs a per-device warning and carries
    // on, so one flaky device on one Sunday silently drops rows and the run
    // still reports success.
    //
    // Skipping a week is strictly better: the previous snapshot stands.
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
    // ⚠ TWO sqlx traps in one row, both of which fail on REAL rows only and
    // neither of which a fixture would show:
    //
    //   * `centroid_lat`/`centroid_lon` are DECIMAL(9,6). sqlx cannot hand back
    //     a MySQL DECIMAL at all without `rust_decimal`, so they are CAST to
    //     CHAR and parsed — the same thing `classification_inputs` does, for
    //     the same reason.
    //   * `id` and `first_seen_ts` are INT UNSIGNED, which is a DISTINCT sqlx
    //     type that decodes as none of the signed forms. Reading `id` as `i64`
    //     failed in production on 2026-08-24 with "Rust type `i64` (as SQL type
    //     `BIGINT`) is not compatible with SQL type `INT UNSIGNED`" — after the
    //     job had already fetched 79,262 points.
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
    // invariant are `lean::focus_places`, moved there so a test can reach them
    // (#1424) — this function is DB-backed and lives in the binary crate, which
    // put the whole of `focus` out of reach of every gate.
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

    // ── 5. the amenity vote, per cluster ────────────────────────────────────
    // ⚠ TWO PHASES, and the split is forced by the mirror. `MirrorSource` may
    // only be touched from a blocking thread — constructing it on a runtime
    // worker and letting a query reach it ABORTS THE PROCESS — so every OSM
    // lookup has to happen inside `with_mirror_answerer`'s closure, which is
    // `FnOnce + Send + 'static` and cannot await.
    //
    // So: resolve the timezones first (pure CPU, no IO), hand a plain data
    // structure across, and bring the labels back out.
    let zones = backend::fitbit::tz_source::PolygonLookup::new();

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

        // ⚠ GATE 0, THE RESIDENCE GATE. A cluster the user SLEEPS at is not
        // mined at all — `amenity_label` stays null and the runtime falls
        // through to the residential-address lookup. Populating it would be
        // dead data an older code path could mis-pick up.
        //
        // ⚠ ITS ABSENCE IS NOT VISIBLE AS A SHORTFALL: without it the arm
        // labels 88 of 128 clusters
        // where production labels 82. Every one of the six extra was a place
        // with 6-36 sleep hours — hotels, a guest house, a clinic. So the miss
        // wrote WHERE HE SLEPT AND WHAT KIND OF PLACE IT WAS into a column the
        // TypeScript deliberately leaves empty, and it read as better coverage.
        //
        // ⚠ The skip is BEFORE the per-stay loop in the TypeScript, so these
        // stays train NO prior either — that is the 95-vs-77 attributed-stay
        // gap, not a separate bug. An empty `stays` list here reproduces both:
        // `mineCluster` casts no vote and attributes nothing.
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
            // ⚠ A stay with no resolvable zone is SKIPPED, not defaulted to
            // UTC. `localHour` and the opening-hours samples are both
            // venue-local, and a wrong clock votes for the wrong venue rather
            // than declining to vote.
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
    let (voted, flat_stays) =
        backend::mirror_source::with_mirror_answerer(pool.clone(), now_ms, move |ans| {
            let mut out: Vec<backend::lean::MinedCluster> = Vec::with_capacity(pending.len());
            // #343 P0: the soft-mining population is BY CONSTRUCTION the stays the
            // hard miner sees — collected inside the same loop, after the residence
            // skip (empty `stays`) and the mirror-could-not-answer skip.
            let mut flat: Vec<backend::lean::MineStay> = Vec::new();
            for c in pending {
                let mut ms: Vec<backend::lean::MineStay> = Vec::with_capacity(c.stays.len());
                for s in c.stays {
                    // ⚠ `None` means the MIRROR could not answer, which is NOT
                    // "no venues here". This stay then casts no vote, rather than
                    // a vote for nothing (#976, and the empty-landmarks day of
                    // #1054).
                    let Some(shaped) = ans.nearby_landmarks(s.lat, s.lon)? else {
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
            }
            Ok((out, flat))
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
         {residential} skipped as residential",
        mined.len(),
        attributed_all.len()
    );

    // ── 6. the priors blob — a full recompute, never incremental ────────────
    let priors = backend::lean::mine_priors(&attributed_all)?;

    // ── #343 P0 sinks, before any write ─────────────────────────────────────
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

    // ⚠ **A BACKFILL WRITES THE SNAPSHOT AND NOTHING ELSE (#1405).**
    //
    // `--as-of` in the PAST re-mines history to manufacture a snapshot for a day
    // that never had one. Everything else this function writes describes NOW:
    // `venue_type_priors` is the current blob every present-day request reads,
    // and `focus_places` is DELETED and rewritten below. Letting a backfill
    // through both would replace today's clusters and today's prior with May's
    // — it would corrupt the present in order to describe the past, which is
    // the exact inversion of what the caller asked for.
    //
    // `--as-of` set to TODAY is not a backfill: it is an ordinary run that
    // happens to name its own anchor, and it writes everything.
    let backfill = sinks
        .as_of
        .is_some_and(|d| d.date_naive() < chrono::Utc::now().date_naive());

    if !backfill {
        sqlx::query(
            "INSERT INTO venue_type_priors (user_id, priors_json, mined_stays) VALUES (?, ?, ?) \
             ON DUPLICATE KEY UPDATE priors_json = VALUES(priors_json), \
                                     mined_stays = VALUES(mined_stays)",
        )
        .bind(user_id)
        .bind(serde_json::to_string(&priors)?)
        .bind(attributed_all.len() as i64)
        .execute(pool)
        .await
        .context("writing venue_type_priors")?;
    }

    // The same blob, FROZEN at the day this run's window ended (#1405).
    //
    // ⚠ BESIDE the row above, never instead of it. That row is what every
    // reader predating this expects, including a pod mid-rollout, and the
    // snapshot is additive history.
    //
    // ⚠ THIS IS THE HALF THAT MAKES A PAST LABEL STABLE. Mining re-clusters
    // from scratch, so the prior is not a stable function of its own window —
    // re-running it rewrites what past days were called. Filtering the mined
    // events by timestamp does NOT fix that, because each stay's subtype comes
    // from a cluster built across the whole window; only anchoring the window
    // does, and only a stored anchor keeps the answer.
    //
    // `ON DUPLICATE KEY UPDATE` so re-mining the same anchor replaces it rather
    // than failing: the newest run for a date is the one to keep, and a refresh
    // that cannot write is worse than one that overwrites its own earlier try.
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
    .execute(pool)
    .await
    .context("writing venue_type_prior_snapshots")?;
    eprintln!(
        "[{user_id}] priors snapshot stored as of {anchor} ({} stay(s))",
        attributed_all.len()
    );

    if backfill {
        // ⚠ STOPS HERE, and the reason is the DELETE below. `focus_places` is
        // rewritten from THIS run's clusters, and a backfill's clusters are
        // May's — applying them would delete the places the user goes to now
        // and replace them with where they went in the spring. The snapshot
        // above is the entire product of a backfill.
        eprintln!(
            "[{user_id}] backfill as of {anchor}: snapshot only — NOT touching \
             venue_type_priors or focus_places, which describe now"
        );
        return Ok(());
    }

    // ── 7. the write, in one transaction ────────────────────────────────────
    // ⚠ The DELETE and the upserts must land together. A half-applied refresh
    // leaves rows deleted whose replacements were never written, and the
    // dashboard reads that as places the user stopped going to.
    let mut tx = pool
        .begin()
        .await
        .context("opening the focus_places transaction")?;

    if !deleted.is_empty() {
        // ⚠ `QueryBuilder`, not `format!`: a interpolated SQL string trips the
        // audit lint, and this is the one statement here with a
        // variable-length parameter list.
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
        // 02:00–06:00 heuristic — the TypeScript's choice, on the same test.
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

        if let Some(old_id) = assignments[i] {
            // ⚠ UPDATE preserves `id` and `first_seen_ts` — the original "first
            // time we observed this place". Rewriting either would break the
            // foreign-key references downstream consumers hold, and would make
            // a re-mine look like a new place.
            sqlx::query(
                "UPDATE focus_places SET centroid_lat = ?, centroid_lon = ?, radius_m = ?, \
                   total_dwell_sec = ?, visit_count = ?, unique_days = ?, last_seen_ts = ?, \
                   detected_label = ?, display_name = ?, sleep_hours = ?, amenity_label = ?, \
                   amenity_kind = ?, hour_profile = ?, refreshed_at = CURRENT_TIMESTAMP \
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
            .bind(amenity_label)
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

        // The residence zone, for read-time fallback. First Home wins, as in
        // the TypeScript; if no cluster qualifies, the stored value is left
        // alone rather than cleared.
        if home_tz.is_none() && display_name.map(String::as_str) == Some("Home") {
            home_tz = zones.zone(clat, clon);
        }
    }

    if let Some(tz) = &home_tz {
        // ⚠ Inside the transaction, so a half-failed refresh rolls the zone
        // back with the rows it was derived from.
        backend::sync_state::set_with(&mut *tx, user_id, "home_tz", tz)
            .await
            .context("writing home_tz")?;
        eprintln!("[{user_id}] home_tz = {tz}");
    }

    tx.commit().await.context("committing focus_places")?;
    eprintln!("[{user_id}] focus_places refreshed ({} rows)", mined.len());
    Ok(())
}

/// ⚠ The LITERAL the TypeScript writes, and what all 128 prod rows carry. Four
/// call sites read this column and one of them only notices values above 40 m,
/// so writing a measured cluster spread here would be a behaviour change, not a
/// refinement (#789).
pub(crate) const FOCUS_RADIUS_M: i64 = 25;

/// Fitbit-confirmed sleep hours at or above which a cluster is a RESIDENCE and
/// is not mined for a venue name at all. See the gate-0 note at its use.
pub(crate) const RESIDENCE_SLEEP_THRESHOLD_H: f64 = 5.0;
/// The TypeScript's `FETCH_CHUNK_DAYS`. Shared chunk bounds are why the fetch
/// above dedups.
pub(crate) const FOCUS_FETCH_CHUNK_DAYS: i64 = 7;
/// The TypeScript's `DEFAULT_LOOKBACK_DAYS`. ⚠ 180, not the 90 its own header
/// comment claims — the cron passes no argument, so this is what production
/// actually mines.
pub(crate) const FOCUS_DEFAULT_LOOKBACK_DAYS: i64 = 180;

/// Pool each rail route's historic GPS corridor and snap it, filling
/// `rail_route_cache`.
///
/// Tier 2 of #982 — the node cron is `src/cli/refresh-rail-routes.ts`, nightly
/// at 05:00. Two passes, as there: walk the window pooling every train leg's
/// fixes per route key, then snap each pooled cloud once.
///
/// ⚠ THE SNAP IS ENTIRELY LEAN. `Verified.Geo.RailSnap` holds `buildRailGraph`,
/// `edgeWeight`, `bridgeGaps`, `shortestPath` and `nearestVertex` (123 guards),
/// and the `railsnap` serve mode hands it the RAW ways. The TypeScript builds
/// the graph shell-side and asks Lean only for `dijkstraC`; rebuilding it in
/// Rust would put the vertex fusion and the corridor weighting back on this
/// side of the boundary, which is the half that drifts (#1003).
pub(crate) async fn refresh_rail_routes(window_days: i64) -> Result<()> {
    // ⚠ `from_env_batch`, NOT `from_env`: this pod sets DB_* and NC_* and no
    // FITBIT_*, and the day pipeline never touches Fitbit. The strict config
    // here is what failed `refresh-presence-log` and `refresh-focus-places` in
    // production, both times AFTER the job had done real work.
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
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
    // ⚠ INSERTION-ORDERED. A `HashMap` here would make the upsert order — and
    // so the log — vary run to run for no reason, and this job's output is read
    // by eye when a route looks wrong.
    let mut by_route: std::collections::BTreeMap<String, RouteAcc> =
        std::collections::BTreeMap::new();
    // ⚠ Counted so an EMPTY result can be told apart from a BROKEN one.
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
            // ⚠ A day that will not compute is SKIPPED with a warning, not an
            // abort — one bad day must not cost the other twenty. The
            // TypeScript does the same, and the pooled corridor degrades
            // gracefully because it is a union over many days.
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
                // `refinedMode ?? mode`, the TypeScript's precedence.
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

    // ⚠ REFUSE rather than report success on nothing. Zero routes is a
    // LEGITIMATE answer — three weeks without a train ride — but it is
    // indistinguishable from every day having failed, and the two need opposite
    // responses. That is #1134's shape (`refresh-bus-routes` reports success
    // after refreshing 2 of 18 tiles), and THIS subcommand reproduced it on its
    // first run: 2026-08-25, all 22 days died with "Read-only file system"
    // (#1106 — the batch pods lack the `/tmp` emptyDir the Deployment has), it
    // pooled 0 routes, upserted 0, and exited SUCCEEDED.
    //
    // The discriminator is the FAILURE count, never the route count.
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
        match rail_route_geometry(&pool, key, acc.start_ts, acc.end_ts, &acc.fixes).await? {
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
        // ⚠ UPSERT, never a wipe-and-rebuild. A DELETE-all here silently dropped
        // every route key not ridden inside the scan window, so browsing an
        // older day drew its rides raw forever — and it would also discard the
        // serving path's miss-driven fills for routes that never recur.
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

/// The corridor around a pooled fix cloud, snapped — `computeRailRoute`'s twin.
///
/// Corridor-weighted snap first; if that refuses (thin cloud, ambiguous
/// corridor) and the key names a line, route between the two stations over ONLY
/// that line's ways. `None` means LEAVE IT RAW — never a guessed path.
///
/// ⚠ The line-restricted retry passes the SAME way list. Lean's
/// `snapTrainSegmentOnLine` does the filtering itself with `wayOnLine`, so
/// nothing is asked of this caller beyond the full list — which is why the
/// fallback needs no second query and no station lookup here.
pub(crate) async fn rail_route_geometry(
    pool: &sqlx::MySqlPool,
    key: &str,
    start_ts: f64,
    end_ts: f64,
    fixes: &[(f64, f64)],
) -> Result<Option<Vec<serde_json::Value>>> {
    use sqlx::Row as _;

    if fixes.is_empty() {
        return Ok(None);
    }
    // The bbox the corridor is scanned over, padded like `corridorBox`.
    let (mut min_lat, mut max_lat) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut min_lon, mut max_lon) = (f64::INFINITY, f64::NEG_INFINITY);
    for (la, lo) in fixes {
        min_lat = min_lat.min(*la);
        max_lat = max_lat.max(*la);
        min_lon = min_lon.min(*lo);
        max_lon = max_lon.max(*lo);
    }
    // ⚠ A METRES margin converted to degrees, with the longitude term corrected
    // for latitude — NOT a fixed degree pad. A constant 0.01 deg would be ~1.1 km
    // north-south everywhere but only ~700 m east-west in London and ~1.1 km at
    // the equator, so the corridor would silently narrow the further north the
    // ride was. This mirrors `corridorBox`.
    let d_lat = RAIL_CORRIDOR_MARGIN_M / 111_320.0;
    let mid_lat = (min_lat + max_lat) / 2.0;
    let d_lon =
        RAIL_CORRIDOR_MARGIN_M / (111_320.0 * (mid_lat * std::f64::consts::PI / 180.0).cos());
    let (min_lat, max_lat) = (min_lat - d_lat, max_lat + d_lat);
    let (min_lon, max_lon) = (min_lon - d_lon, max_lon + d_lon);
    let poly = format!(
        "POLYGON(({min_lon} {min_lat},{max_lon} {min_lat},{max_lon} {max_lat},\
         {min_lon} {max_lat},{min_lon} {min_lat}))"
    );

    // ⚠ `feature_type = 'railway'`, the mirror's BUCKET. `subtype` carries the
    // OSM value (rail, subway, station, …); filtering on subtype here would
    // drop the ways `isRailSubtype` is meant to judge.
    let line_rows = sqlx::query(
        "SELECT name, subtype, ST_AsText(geom) AS wkt FROM osm_lines \
         WHERE feature_type = 'railway' \
           AND MBRIntersects(geom, ST_GeomFromText(?, 4326)) LIMIT ?",
    )
    .bind(&poly)
    .bind(RAIL_CORRIDOR_LINE_LIMIT)
    .fetch_all(pool)
    .await
    .context("querying the rail corridor")?;

    let mut lines: Vec<serde_json::Value> = Vec::with_capacity(line_rows.len());
    for r in &line_rows {
        let wkt: String = r.try_get("wkt")?;
        let coords = parse_linestring_wkt(&wkt);
        if coords.len() < 2 {
            continue;
        }
        lines.push(serde_json::json!({
            "name": r.try_get::<Option<String>, _>("name")?,
            "subtype": r.try_get::<Option<String>, _>("subtype")?,
            "coords": coords,
        }));
    }

    let station_rows = sqlx::query(
        "SELECT name, subtype, ST_AsText(geom) AS wkt FROM osm_points \
         WHERE feature_type = 'railway' \
           AND subtype IN ('station','halt','stop','subway_entrance','tram_stop') \
           AND MBRIntersects(geom, ST_GeomFromText(?, 4326))",
    )
    .bind(&poly)
    .fetch_all(pool)
    .await
    .context("querying rail stations")?;

    let mut stations: Vec<serde_json::Value> = Vec::with_capacity(station_rows.len());
    for r in &station_rows {
        let wkt: String = r.try_get("wkt")?;
        let Some((lat, lon)) = parse_point_wkt(&wkt) else {
            continue;
        };
        stations.push(serde_json::json!({
            "name": r.try_get::<Option<String>, _>("name")?,
            "subtype": r.try_get::<Option<String>, _>("subtype")?,
            "latBits": backend::fold_payload::bits(lat),
            "lonBits": backend::fold_payload::bits(lon),
        }));
    }

    for on_line in [false, true] {
        if let Some(path) =
            backend::lean::rail_snap(key, start_ts, end_ts, &lines, &stations, fixes, on_line)?
        {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

/// `LINESTRING(lon lat, …)` → `[[latBits, lonBits], …]`.
///
/// ⚠ WKT IS `lon lat`, THE OTHER WAY ROUND. Getting it backwards puts every
/// rail way in the wrong hemisphere, where the graph builds fine and the snap
/// simply never finds a route — a silent empty answer rather than an error.
pub(crate) fn parse_linestring_wkt(wkt: &str) -> Vec<serde_json::Value> {
    let Some(inner) = wkt
        .trim()
        .strip_prefix("LINESTRING(")
        .and_then(|s| s.strip_suffix(')'))
    else {
        return Vec::new();
    };
    inner
        .split(',')
        .filter_map(|pair| {
            let mut it = pair.split_whitespace();
            let lon: f64 = it.next()?.parse().ok()?;
            let lat: f64 = it.next()?.parse().ok()?;
            Some(serde_json::json!([
                backend::fold_payload::bits(lat),
                backend::fold_payload::bits(lon)
            ]))
        })
        .collect()
}

/// `POINT(lon lat)` → `(lat, lon)`. Same axis-order warning as above.
pub(crate) fn parse_point_wkt(wkt: &str) -> Option<(f64, f64)> {
    let inner = wkt
        .trim()
        .strip_prefix("POINT(")
        .and_then(|s| s.strip_suffix(')'))?;
    let mut it = inner.split_whitespace();
    let lon: f64 = it.next()?.parse().ok()?;
    let lat: f64 = it.next()?.parse().ok()?;
    Some((lat, lon))
}

/// Margin (m) around a train run's fixes when reading its rail corridor — wide
/// enough that the line and BOTH stations fall inside the box even where the
/// fixes scatter off the track. The TypeScript's `RAIL_CORRIDOR_MARGIN_M`.
pub(crate) const RAIL_CORRIDOR_MARGIN_M: f64 = 1500.0;
/// The TypeScript's `LIMIT 12000`.
pub(crate) const RAIL_CORRIDOR_LINE_LIMIT: i64 = 12000;
/// The TypeScript's `DEFAULT_WINDOW_DAYS`.
pub(crate) const RAIL_DEFAULT_WINDOW_DAYS: i64 = 21;

/// Rebuild `presence_log` from `decoded_days` over a bounded window.
///
/// Tier 2 of #982 — the first CronJob logic to leave node. The rule is
/// `Verified.PresenceLog.computeRow`; everything here is the IO around it.
///
/// ⚠ AN UPSERT, not the DELETE+INSERT its TypeScript header claims. The code
/// there does `onDuplicateKeyUpdate` and always did; the comment is wrong and
/// mirroring the comment instead of the code would drop rows outside the
/// window on every run.
///
/// ⚠ Rows are processed in the order the query returns them, and each day's
/// segments in the order they were stored. The rollup's tie-break keeps the
/// place seen FIRST, so re-ordering either changes which place a day is
/// attributed to.
pub(crate) async fn refresh_presence_log(pool: &sqlx::MySqlPool, lookback: i64) -> Result<()> {
    use sqlx::Row as _;

    backend::schema::migrate(pool).await?;

    // The TypeScript builds this from `Date.now()` and slices the ISO string, so
    // the cutoff is a UTC civil date regardless of anyone's zone.
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(lookback))
        .format("%Y-%m-%d")
        .to_string();
    eprintln!("refresh-presence-log: lookback={lookback}d (cutoff={cutoff})");

    let days = sqlx::query("SELECT user_id, date, segments_json FROM decoded_days WHERE date >= ?")
        .bind(&cutoff)
        .fetch_all(pool)
        .await
        .context("reading decoded_days")?;
    eprintln!(
        "refresh-presence-log: {} decoded day(s) in window",
        days.len()
    );

    let mut tz_by_user: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let (mut inserted, mut skipped) = (0u32, 0u32);

    for row in days {
        let user_id: String = row.try_get("user_id").context("decoded_days.user_id")?;
        // ⚠ `date` is a DATE column; read it as a string the same way the rest
        // of this binary does rather than through chrono, so the value written
        // back is the value read.
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

        // ⚠ Bad JSON is SKIPPED with a warning, not an abort — one corrupt day
        // must not stop the other 89. The TypeScript does the same.
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

pub(crate) async fn refresh_rail_stops(dry_run: bool) -> Result<()> {
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    backend::schema::migrate(&pool).await?;

    let Some(plan) = mirror_plan(&pool).await? else {
        pool.close().await;
        return Ok(());
    };

    // ⚠ BEFORE THE FETCH AND BEFORE THE COVERAGE REFUSAL, deliberately. Retiring a
    // key the plan can no longer emit needs the PLAN and nothing else: such a key
    // can never be refreshed by any future run, whatever tonight's coverage turns
    // out to be. Measured 2026-09-12, this is not theoretical — it sat inside the
    // merge, the run came back at 8/18 tiles (44%), `may_rebuild` refused BELOW
    // the 50%% floor and bailed, and the retirement never executed. It cannot
    // wait behind a successful refresh, because the nights it is most needed are
    // the nights there isn't one (#1153).
    //
    // Its own transaction, because it is its own decision — nothing here depends
    // on what the mirrors are about to say.
    if !dry_run {
        retire_unplannable(&pool, &plan, "rail").await?;
    }

    let client = reqwest::Client::new();
    let h = mirror_fetch(&client, "rail", &plan.tiles).await?;
    // ⚠ `existing` MUST be the real row count. It was a literal `0` here, and
    // `coverageRefusal` returns `none` when `existing == 0` — deliberately, so
    // an all-failed FIRST run against a cold cache still proceeds. Passing 0
    // unconditionally made this arm permanently look like that first run, so
    // #1134's coverage floor could never fire on it: measured 2026-09-06,
    // rail-stops merged at 8/18 tiles (44%, under the 50% floor) and the
    // CronJob reported success. Bus has always counted its rows; the two now
    // agree.
    let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM rail_stops_cache")
        .fetch_one(&pool)
        .await
        .context("counting rail_stops_cache")?;
    let verdict = backend::lean::may_rebuild(
        "rail",
        h.routes.len(),
        h.failures,
        plan.tiles.len(),
        existing,
    )?;
    eprintln!(
        "refresh-rail-stops: {} relations, {}",
        h.routes.len(),
        mirror_coverage_line(h.succeeded.len(), plan.tiles.len())
    );
    if !verdict.may_write {
        pool.close().await;
        // ⚠ SAY LEAN'S SENTENCE, not a guessed one. Hardcoding "all N tiles
        // failed" covers only one refusal; since #1134 it can also refuse for
        // COVERAGE, where that wording is untrue and sends the reader after an
        // outage that
        // did not happen. The bus arm already did this; the two now agree.
        anyhow::bail!(
            "{} — leaving rail_stops_cache untouched",
            verdict
                .refusal
                .unwrap_or_else(|| format!("all {} tiles failed", plan.tiles.len()))
        );
    }

    // ⚠ THE DRY RUN STOPS HERE, AFTER the refusal and BEFORE the transaction — so
    // it exercises the fetch, the extraction and the decision, which is
    // everything a real run decides. Placing it earlier would make it a test of
    // the argument parser.
    if dry_run {
        let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM rail_stops_cache")
            .fetch_one(&pool)
            .await
            .unwrap_or(-1);
        eprintln!(
            "DRY RUN — rail_stops_cache holds {existing} relation(s); this run would {} with {} relation(s)",
            if verdict.full_rebuild {
                "rebuild it in full".to_string()
            } else {
                format!(
                    "replace {} of {} tiles",
                    h.succeeded.len(),
                    plan.tiles.len()
                )
            },
            h.routes.len()
        );
        pool.close().await;
        return Ok(());
    }

    let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM rail_stops_cache")
        .fetch_one(&pool)
        .await
        .unwrap_or(-1);
    let mut tx = pool
        .begin()
        .await
        .context("opening the rebuild transaction")?;
    if verdict.full_rebuild {
        // A complete run is authoritative for the whole bbox: anything absent is
        // absent from OSM. This is also what retires the `tile_key IS NULL` rows
        // written before the column existed.
        sqlx::query("DELETE FROM rail_stops_cache")
            .execute(&mut *tx)
            .await
            .context("clearing rail_stops_cache")?;
    } else {
        // A partial run is authoritative ONLY for the tiles that answered. Every
        // other tile keeps what it had, so the mirror cannot shrink because
        // Overpass 502'd somewhere.
        for key in &h.succeeded {
            sqlx::query("DELETE FROM rail_stops_cache WHERE tile_key = ?")
                .bind(key)
                .execute(&mut *tx)
                .await
                .with_context(|| format!("clearing tile {key}"))?;
        }
    }
    for (tile, r) in h.routes.values() {
        // ⚠ UPSERT, not a plain insert: a relation can survive the delete above
        // under a FAILED tile's key and still be re-fetched from one that
        // answered.
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
    tx.commit().await.context("committing the rebuild")?;
    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM rail_stops_cache")
        .fetch_one(&pool)
        .await
        .unwrap_or(existing);
    if verdict.full_rebuild {
        eprintln!(
            "rail_stops_cache rebuilt in full: {} relations",
            h.routes.len()
        );
    } else {
        eprintln!(
            "rail_stops_cache merged: {}/{} tiles replaced, {} kept their existing rows — {existing} -> {after} relations",
            h.succeeded.len(),
            plan.tiles.len(),
            h.failures
        );
    }
    pool.close().await;
    Ok(())
}

/// Retire the rows no future run can reach: keys the plan can no longer emit.
///
/// ⚠ THE TILE GRID MOVES, which is what makes this necessary. The plan is derived
/// from mined focus places and `tile_key` is the south-west corner to four
/// decimals, so a shifted bbox renames every tile. The merge's per-tile `DELETE`
/// names keys from the CURRENT plan, so rows under the old names are unreachable
/// for ever — as are `tile_key IS NULL` rows from before the column existed.
///
/// Measured on production 2026-09-12: `bus_route_cache` held 318 of 998 rows
/// under such names — 274 pre-column NULLs and 44 under a retired latitude band
/// — and `classification_inputs::bus_route_cache` reads the table with NO
/// filter, so every one reached the bus matcher.
///
/// ⚠ INDEPENDENT OF COVERAGE, which is why the caller runs it before the
/// refusal. A key outside the plan is one no future run can refresh, so retiring
/// it is as correct at 44% coverage as at 100%.
pub(crate) async fn retire_unplannable(
    pool: &sqlx::MySqlPool,
    plan: &backend::lean::MirrorPlan,
    mode: &str,
) -> Result<()> {
    use backend::lean;
    let planned: std::collections::BTreeSet<String> =
        plan.tiles.iter().map(lean::tile_key).collect();
    let mut tx = pool.begin().await.context("opening the retirement")?;

    // ⚠ The table name cannot be bound and the SQL must stay literal for
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
    // ⚠ SAY SO EVEN WHEN IT IS ZERO. A run that retires nothing and a run that
    // never reached the retirement look identical in a log that only speaks up
    // when it acts — and "never reached it" is exactly the bug this placement
    // fixes.
    eprintln!(
        "{mode}: retired {retired} unplannable row(s) across {} planned tile(s)",
        planned.len()
    );
    Ok(())
}

/// Tier 2 of #982 — the node cron is `src/cli/refresh-bus-routes.ts`.
///
/// ⚠ A PARTIAL RUN REPLACES ONLY THE TILES THAT ANSWERED. That is what makes it
/// lossless, and it is why the refusal can be as narrow as "every tile failed".
/// It is also why a 2-of-18 run exits 0 — see #1134.
pub(crate) async fn refresh_bus_routes(dry_run: bool) -> Result<()> {
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    backend::schema::migrate(&pool).await?;

    let Some(plan) = mirror_plan(&pool).await? else {
        pool.close().await;
        return Ok(());
    };

    // ⚠ BEFORE THE FETCH AND BEFORE THE COVERAGE REFUSAL, deliberately. Retiring a
    // key the plan can no longer emit needs the PLAN and nothing else: such a key
    // can never be refreshed by any future run, whatever tonight's coverage turns
    // out to be. Measured 2026-09-12, this is not theoretical — it sat inside the
    // merge, the run came back at 8/18 tiles (44%), `may_rebuild` refused BELOW
    // the 50%% floor and bailed, and the retirement never executed. It cannot
    // wait behind a successful refresh, because the nights it is most needed are
    // the nights there isn't one (#1153).
    //
    // Its own transaction, because it is its own decision — nothing here depends
    // on what the mirrors are about to say.
    if !dry_run {
        retire_unplannable(&pool, &plan, "bus").await?;
    }

    let client = reqwest::Client::new();
    let h = mirror_fetch(&client, "bus", &plan.tiles).await?;

    let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bus_route_cache")
        .fetch_one(&pool)
        .await
        .context("counting bus_route_cache")?;
    let verdict = backend::lean::may_rebuild(
        "bus",
        h.routes.len(),
        h.failures,
        plan.tiles.len(),
        existing,
    )?;
    eprintln!(
        "refresh-bus-routes: {} routes, {}",
        h.routes.len(),
        mirror_coverage_line(h.succeeded.len(), plan.tiles.len())
    );
    if !verdict.may_write {
        pool.close().await;
        anyhow::bail!(
            "{} — leaving bus_route_cache untouched",
            verdict.refusal.unwrap_or_else(|| "refused".into())
        );
    }

    // ⚠ Same placement as the rail arm: after the refusal, before the write.
    if dry_run {
        eprintln!(
            "DRY RUN — bus_route_cache holds {existing} route(s); this run would {} with {} route(s)",
            if verdict.full_rebuild {
                "rebuild it in full".to_string()
            } else {
                format!(
                    "replace {} of {} tiles",
                    h.succeeded.len(),
                    plan.tiles.len()
                )
            },
            h.routes.len()
        );
        pool.close().await;
        return Ok(());
    }

    let mut tx = pool
        .begin()
        .await
        .context("opening the rebuild transaction")?;
    if verdict.full_rebuild {
        // A complete run is authoritative for the whole bbox: anything absent is
        // absent from OSM. This also retires rows written before `tile_key`
        // existed.
        sqlx::query("DELETE FROM bus_route_cache")
            .execute(&mut *tx)
            .await
            .context("clearing bus_route_cache")?;
    } else {
        for key in &h.succeeded {
            sqlx::query("DELETE FROM bus_route_cache WHERE tile_key = ?")
                .bind(key)
                .execute(&mut *tx)
                .await
                .with_context(|| format!("clearing tile {key}"))?;
        }
    }
    for (tile, r) in h.routes.values() {
        // ⚠ UPSERT, not a plain insert: a route can survive the delete above
        // under a FAILED tile's key and still be re-fetched from one that
        // answered.
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
    tx.commit().await.context("committing the rebuild")?;

    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bus_route_cache")
        .fetch_one(&pool)
        .await
        .unwrap_or(existing);
    if verdict.full_rebuild {
        eprintln!("bus_route_cache rebuilt in full: {} routes", h.routes.len());
    } else {
        eprintln!(
            "bus_route_cache merged: {}/{} tiles replaced, {} kept their existing rows — {existing} -> {after} routes",
            h.succeeded.len(),
            plan.tiles.len(),
            h.failures
        );
    }
    pool.close().await;
    Ok(())
}

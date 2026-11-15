//! The fetch queue's drain, running continuously beside the serving pod.
//!
//! The fold records each lookup it has no data for in `osm_fetch_queue`
//! (`fetch_queue`); this drains both halves, Nominatim and Overpass, on demand
//! rather than on a daily cron (the user's call). [`watch`] polls every
//! [`WATCH_INTERVAL`], so a day served with declines is complete on its next
//! view, and queues the ground around fixes arriving since its last tick
//! (`motion_log`), so a travel day is right the first time it is opened.
//!
//! A sidecar of the `health-auth` pod (kubes `dhall/apps/health.dhall`), not the
//! serving process: an Overpass body is ~5 MB of JSON and a fold peaks near
//! 320 MiB under a 512 MiB limit, so they must not share a cgroup. Polite as the
//! old CronJobs were: Nominatim one request a second (`nominatim::MIN_INTERVAL`,
//! slept before each), an Overpass slot asked per box, and a failed key retried
//! on a later tick, never in a loop (`fetch_queue::MAX_ATTEMPTS`).
//! `backend fetch-osm` and `fetch-geocodes` call these same drains.

use std::time::Duration;

use anyhow::{Context, Result};
use sqlx::MySqlPool;

use crate::{fetch_queue, lean, nominatim, osm_mirror, overpass};

/// How often the queue is looked at: set by the view (a served day with
/// declines is cached five minutes), and a poll costs one small `GROUP BY`.
pub const WATCH_INTERVAL: Duration = Duration::from_secs(15);

/// How far back the first tick looks for fixes after a start. A restart happens
/// on every deploy; an hour re-asks the coverage gate for the ground he has
/// just walked, which is memoised and answered from the mirror once covered.
pub const PRECOVER_LOOKBACK_S: i64 = 60 * 60;

/// How far around a new fix (m) the mirror is made ready, so the fold's own
/// 50 m asks for the stay or walk that follows are answered. Far narrower than
/// a box: a highway box covers the next hour of walking too.
pub const PRECOVER_RADIUS_M: f64 = 500.0;

/// Fixes inside one cell this wide are one question: 0.01° is ~1.1 km of
/// latitude, well inside any box the question fetches.
pub const FIX_CELL_DEG: f64 = 0.01;

/// Keys per bucket per tick. One box usually clears many keys, and the Overpass
/// endpoint has two slots; the same bound `backend fetch-osm` defaults to.
pub const OSM_KEYS_PER_TICK: i64 = 40;

/// Geocodes per zoom per tick: at one request per second this is the longest a
/// tick spends on names before it looks at the queue again.
pub const GEOCODE_KEYS_PER_TICK: i64 = 200;

/// The longest one box waits for an Overpass slot, bounded by the view's
/// five-minute window: a box without a slot in two minutes fails and is tried
/// on a later tick.
pub const SLOT_WAIT_CAP_S: u64 = 120;

/// What one geocode drain did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct GeocodeDrain {
    pub fetched: usize,
    /// Answered "nothing is here", and cached as such.
    pub empty: usize,
    pub failed: usize,
}

impl GeocodeDrain {
    #[must_use]
    pub fn is_quiet(&self) -> bool {
        *self == Self::default()
    }
}

/// What one Overpass drain did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct OsmDrain {
    pub fetched: usize,
    pub rows_written: u64,
    /// Keys a box fetched earlier (this run or before) already answered.
    pub covered_already: usize,
    pub failed: usize,
    /// Permanent refusals, retired rather than retried.
    pub refused: usize,
}

impl OsmDrain {
    #[must_use]
    pub fn is_quiet(&self) -> bool {
        *self == Self::default()
    }
}

/// Drain the geocode half of `osm_fetch_queue`.
///
/// ⚠ One request per second is Nominatim's stated policy: exceeding it earns
/// an IP-level ban that takes naming down for everyone behind this address.
///
/// A failure raises `attempts` and the key stays visible; deleting it would only
/// have it re-asked forever. `dry_run` lists without fetching.
pub async fn drain_geocodes(
    pool: &MySqlPool,
    client: &reqwest::Client,
    limit: i64,
    dry_run: bool,
) -> Result<GeocodeDrain> {
    let mut out = GeocodeDrain::default();

    // The zooms come from the queue, not a list here: they are declared in
    // `Verified.Geo.BestPlace` and `Verified.Geo.Enrich`, and a drain knowing
    // only remembered zooms would strand a consumer's keys forever.
    let zooms: Vec<i64> = fetch_queue::census(pool)
        .await?
        .into_iter()
        .filter_map(|(kind, waiting, _)| (waiting > 0).then(|| nominatim::zoom_of(&kind)).flatten())
        .collect();

    for zoom in zooms {
        let kind = nominatim::query_type(zoom);
        let pending = fetch_queue::due(pool, &kind, limit).await?;
        if pending.is_empty() {
            continue;
        }
        tracing::info!("{kind}: {} key(s) to fetch", pending.len());
        if dry_run {
            continue;
        }
        for p in pending {
            // The key is `lat|lon` as rounded by whoever recorded it, parsed not
            // re-rounded, so the answer lands under the key the reader forms.
            let mut parts = p.key.split('|');
            let (Some(lat), Some(lon)) = (
                parts.next().and_then(|v| v.parse::<f64>().ok()),
                parts.next().and_then(|v| v.parse::<f64>().ok()),
            ) else {
                fetch_queue::failed(pool, &kind, &p.key, "unparseable key").await?;
                out.failed += 1;
                continue;
            };
            // Before the request, not after. A sleep after the last fetch of a
            // tick is a second wasted; a sleep skipped before the first fetch of
            // the next tick is a policy breach across two ticks.
            tokio::time::sleep(nominatim::MIN_INTERVAL).await;
            match nominatim::reverse(client, lat, lon, zoom).await {
                Ok(nominatim::Fetched::Answer(answer)) => {
                    if answer.is_none() {
                        out.empty += 1;
                    } else {
                        out.fetched += 1;
                    }
                    // An empty answer is cached. Nominatim knowing of nothing
                    // there is a fact about the world and re-asking it every
                    // tick would spend the budget on settled questions.
                    nominatim::cache_put(pool, zoom, lat, lon, &answer).await?;
                    fetch_queue::done(pool, &kind, &p.key).await?;
                }
                Ok(nominatim::Fetched::Refused(status)) => {
                    out.failed += 1;
                    fetch_queue::failed(pool, &kind, &p.key, &format!("HTTP {status}")).await?;
                }
                Err(e) => {
                    out.failed += 1;
                    fetch_queue::failed(pool, &kind, &p.key, &e.to_string()).await?;
                }
            }
        }
    }
    Ok(out)
}

/// Drain `osm_fetch_queue`'s Overpass half, filling the base mirror with areas
/// the serving path could not answer. After each fetch every key is re-asked
/// `osm_covered`, the serving path's own gate, so dozens of nearby declines
/// collapse into a few requests; a covered key is `done`, not `failed`. `only`
/// limits the run to one kind; `dry_run` lists without fetching.
pub async fn drain_osm(
    pool: &MySqlPool,
    client: &reqwest::Client,
    venue_tags: &[(String, Vec<String>)],
    limit: i64,
    only: Option<&str>,
    dry_run: bool,
) -> Result<OsmDrain> {
    let mut out = OsmDrain::default();
    let vocab = osm_mirror::venue_vocab(venue_tags);

    // The buckets come from the queue, not from a loop over `BUCKETS`: a
    // bucket with nothing waiting must not cost a coverage read.
    let waiting: std::collections::BTreeSet<String> = fetch_queue::census(pool)
        .await?
        .into_iter()
        .filter_map(|(kind, waiting, _)| {
            (waiting > 0 && only.is_none_or(|o| o == kind))
                .then(|| osm_mirror::bucket_of(&kind).map(str::to_string))
                .flatten()
        })
        .collect();

    for bucket in waiting {
        let kind = osm_mirror::queue_kind(&bucket);
        let pending = fetch_queue::due(pool, &kind, limit).await?;
        if pending.is_empty() {
            continue;
        }
        tracing::info!("{kind}: {} key(s) to fetch", pending.len());
        if dry_run {
            continue;
        }
        // Read once per bucket and extended in memory as boxes land, so a key
        // the run has just covered is recognised without a second round trip.
        let bucket_vocab = osm_mirror::vocab_for(&bucket, &vocab);
        let mut boxes = osm_mirror::coverage_rows(pool, &bucket, bucket_vocab).await?;

        for p in pending {
            // A key that does not parse and a question wider than its bucket's
            // cap are retired, not failed: retrying is the invisible loop.
            let Some((lat, lon, radius_m)) = osm_mirror::parse_queue_key(&p.key) else {
                fetch_queue::exhaust(pool, &kind, &p.key, "unparseable key").await?;
                out.failed += 1;
                continue;
            };
            let now_ms = chrono::Utc::now().timestamp_millis();
            // `has_local_data: false`: the serving probe's short-circuit on a
            // sibling bucket's stray rows would stop the drain filling the area.
            if lean::osm_covered(lat, lon, radius_m, &boxes, now_ms, false)? {
                fetch_queue::done(pool, &kind, &p.key).await?;
                out.covered_already += 1;
                continue;
            }
            let half_width_m = match osm_mirror::half_width_for(&bucket, radius_m) {
                Ok(w) => w,
                Err(e) => {
                    fetch_queue::exhaust(pool, &kind, &p.key, &e.to_string()).await?;
                    out.failed += 1;
                    continue;
                }
            };
            let bbox = osm_mirror::fetch_bbox_around(lat, lon, half_width_m);
            let query = osm_mirror::overpass_query(&bucket, &bbox, venue_tags)?;

            overpass::wait_for_slot(client, SLOT_WAIT_CAP_S).await;
            let outcome =
                overpass::fetch_attempt(client, &query, overpass::MIRROR_TIMEOUT_MS, 0).await;
            let body = match outcome {
                overpass::Outcome::Ok(b) => b,
                overpass::Outcome::Permanent { status } => {
                    // Retired, not merely failed. A non-429 4xx is a malformed
                    // query and will be malformed tomorrow too, so spending five
                    // attempts discovering that buys nothing.
                    fetch_queue::exhaust(
                        pool,
                        &kind,
                        &p.key,
                        &format!("HTTP {status} — a permanent refusal, not retried"),
                    )
                    .await?;
                    out.refused += 1;
                    continue;
                }
                overpass::Outcome::AllFailed { errors, .. } => {
                    fetch_queue::failed(pool, &kind, &p.key, &errors.join("; ")).await?;
                    out.failed += 1;
                    continue;
                }
            };

            let features = osm_mirror::features_from_body(&body, venue_tags)?;
            drop(body);
            let written = osm_mirror::upsert_features(pool, &features).await?;
            // After the rows. A coverage row is a promise the area can be
            // answered from the mirror; written first, a crash mid-insert would
            // look like a fetched area with no roads in it.
            osm_mirror::record_coverage(pool, &bucket, &bbox, bucket_vocab).await?;
            boxes.push(lean::CoverageRow {
                min_lat: bbox.min_lat,
                max_lat: bbox.max_lat,
                min_lon: bbox.min_lon,
                max_lon: bbox.max_lon,
                fetched_at: Some(now_ms),
            });
            fetch_queue::done(pool, &kind, &p.key).await?;
            out.fetched += 1;
            out.rows_written += written;
            tracing::info!(
                "  {bucket} {lat:.4},{lon:.4} r={radius_m:.0}m box={half_width_m:.0}m \
                 features={} rows={written}",
                features.len(),
            );
        }
    }
    Ok(out)
}

/// A fix the proxy recorded: `(recorded_at` as Unix seconds`, lat, lon)`.
pub type Fix = (i64, f64, f64);

/// One representative per [`FIX_CELL_DEG`] cell, in first-seen order.
///
/// Pure, so the test can hand it a day of fixes and count the questions.
#[must_use]
pub fn cells_of(fixes: &[Fix]) -> Vec<(f64, f64)> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for &(_, lat, lon) in fixes {
        let cell = (
            (lat / FIX_CELL_DEG).floor() as i64,
            (lon / FIX_CELL_DEG).floor() as i64,
        );
        if seen.insert(cell) {
            out.push((lat, lon));
        }
    }
    out
}

/// Fixes the proxy recorded after `since_s`, oldest first, by `recorded_at`:
/// OwnTracks posts a buffered batch with original timestamps, which a cursor on
/// `ts` would skip.
pub async fn fixes_since(pool: &MySqlPool, since_s: i64) -> Result<Vec<Fix>> {
    use sqlx::Row;
    let rows = sqlx::query(
        "SELECT CAST(UNIX_TIMESTAMP(recorded_at) AS SIGNED) AS at_s, lat, lon \
         FROM motion_log WHERE recorded_at > FROM_UNIXTIME(?) ORDER BY recorded_at",
    )
    .bind(since_s)
    .fetch_all(pool)
    .await
    .context("reading motion_log")?;
    rows.iter()
        .map(|r| {
            Ok((
                r.try_get::<i64, _>("at_s")?,
                r.try_get::<f64, _>("lat")?,
                r.try_get::<f64, _>("lon")?,
            ))
        })
        .collect()
}

/// Queue the ground around every fix after `since_s` for every bucket the
/// coverage gate lacks, returning `(newest recorded_at, questions queued)`. Same
/// queue and key vocabulary as the fold's declines, so [`drain_osm`] fetches
/// them politely in one place. A fix in the same second after the read is
/// missed by the strict `>`; the fold's decline catches it.
pub async fn precover(
    pool: &MySqlPool,
    venue_tags: &[(String, Vec<String>)],
    since_s: i64,
) -> Result<(i64, usize)> {
    let fixes = fixes_since(pool, since_s).await?;
    let Some(&(newest, _, _)) = fixes.last() else {
        return Ok((since_s, 0));
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    let cells = cells_of(&fixes);
    let vocab = osm_mirror::venue_vocab(venue_tags);
    let mut queued = 0usize;
    for bucket in osm_mirror::BUCKETS {
        let boxes =
            osm_mirror::coverage_rows(pool, bucket, osm_mirror::vocab_for(bucket, &vocab)).await?;
        let kind = osm_mirror::queue_kind(bucket);
        for &(lat, lon) in &cells {
            if lean::osm_covered(lat, lon, PRECOVER_RADIUS_M, &boxes, now_ms, false)? {
                continue;
            }
            let key = osm_mirror::queue_key(lat, lon, PRECOVER_RADIUS_M);
            fetch_queue::record(pool, &kind, &key).await;
            queued += 1;
        }
    }
    Ok((newest.max(since_s), queued))
}

/// Run the drain until SIGTERM: every [`WATCH_INTERVAL`], the ground around new
/// fixes, then the Overpass half, then Nominatim. A failed tick is logged and
/// the next runs (the queue holds the work). Quiet when idle, so a failure line
/// is not skimmed past.
pub async fn watch(pool: &MySqlPool, client: &reqwest::Client, interval: Duration) -> Result<()> {
    let venue_tags = lean::venue_tags()?;
    let mut since_s = chrono::Utc::now().timestamp() - PRECOVER_LOOKBACK_S;
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .context("installing the SIGTERM handler")?;
    tracing::info!(
        "fetch-queue watch: every {}s, {}m around new fixes",
        interval.as_secs(),
        PRECOVER_RADIUS_M
    );
    loop {
        tokio::select! {
            _ = term.recv() => {
                tracing::info!("fetch-queue watch: shutting down");
                return Ok(());
            }
            _ = ticker.tick() => {}
        }
        match precover(pool, &venue_tags, since_s).await {
            Ok((newest, queued)) => {
                since_s = newest;
                if queued > 0 {
                    tracing::info!("precover: {queued} question(s) queued around new fixes");
                }
            }
            Err(e) => tracing::error!(error = %format!("{e:#}"), "precover failed"),
        }
        match drain_osm(pool, client, &venue_tags, OSM_KEYS_PER_TICK, None, false).await {
            Ok(d) if d.is_quiet() => {}
            Ok(d) => tracing::info!(
                "osm: fetched {} box(es), {} row(s) · {} already covered · {} failed · {} refused",
                d.fetched,
                d.rows_written,
                d.covered_already,
                d.failed,
                d.refused
            ),
            Err(e) => tracing::error!(error = %format!("{e:#}"), "osm drain failed"),
        }
        match drain_geocodes(pool, client, GEOCODE_KEYS_PER_TICK, false).await {
            Ok(d) if d.is_quiet() => {}
            Ok(d) => tracing::info!(
                "geocodes: fetched {} · {} empty (cached as such) · {} failed",
                d.fetched,
                d.empty,
                d.failed
            ),
            Err(e) => tracing::error!(error = %format!("{e:#}"), "geocode drain failed"),
        }
    }
}

//! The OSM mirror and geocode fetchers: `fetch-osm`, `fetch-geocodes`, and the
//! tile plan behind them.

use super::init_tracing;
use super::session::*;
use anyhow::{Context, Result};
use backend::db;

/// The recent focus places' coordinates, for the region clustering.
///
/// ⚠ `centroid_lat`/`centroid_lon` are DECIMAL, so they must be cast to CHAR and
/// parsed: sqlx refuses them as `f64`, and with a defaulting decode every place
/// read as 0.0 while the check printed OK.
pub(crate) async fn mirror_focus_points(pool: &sqlx::MySqlPool) -> Result<Vec<(f64, f64)>> {
    let cutoff = chrono::Utc::now().timestamp() - MIRROR_RECENT_DAYS * 86_400;
    let rows = sqlx::query(
        "SELECT CAST(centroid_lat AS CHAR) AS lat, CAST(centroid_lon AS CHAR) AS lon \
         FROM focus_places WHERE last_seen_ts >= ?",
    )
    .bind(cutoff)
    .fetch_all(pool)
    .await
    .context("reading recent focus places")?;
    rows.iter()
        .map(|r| {
            use sqlx::Row;
            let lat: String = r.try_get("lat").context("focus_places.centroid_lat")?;
            let lon: String = r.try_get("lon").context("focus_places.centroid_lon")?;
            Ok((
                lat.parse::<f64>()
                    .with_context(|| format!("centroid_lat {lat:?} is not a number"))?,
                lon.parse::<f64>()
                    .with_context(|| format!("centroid_lon {lon:?} is not a number"))?,
            ))
        })
        .collect()
}

/// What one pass over the tiles produced.
pub(crate) struct MirrorHarvest {
    /// Relation id → (tile key, route). Insertion-ordered so a run's log and its
    /// writes read the same way twice.
    pub(crate) routes: std::collections::BTreeMap<i64, (String, backend::lean::ExtractedRoute)>,
    /// The tile keys that answered. Each is authoritative for its own rows.
    pub(crate) succeeded: Vec<String>,
    pub(crate) failures: usize,
}

/// How long to wait between tiles. `overpass-api.de` allows two slots, each
/// held for a query plus a cooldown scaling with its cost (`/api/status`), so
/// 18 back-to-back ~5 MB queries earned refusals and once an IP ban. 5 s is a
/// pace two slots sustain, adding 90 s to a run with a 90-minute deadline.
/// Pacing alone did not fix the cron; asking `wait_for_slot` first did.
/// `kumi.systems` is a separate failure: its status page answers while real
/// queries return 500.
pub(crate) const TILE_PACE_MS: u64 = 5_000;

/// The longest one tile waits for a slot, chosen against the CronJob's 5400 s
/// deadline: 18 tiles × 120 s is 36 minutes, inside it with each fetch on top.
/// A larger cap could let one congested night return nothing.
pub(crate) const SLOT_WAIT_CAP_S: u64 = 120;

/// How long a tile key must go unrefreshed before a run retires its rows. The
/// grid moves with the mined places (a shifted bbox renames every tile), and the
/// per-tile `DELETE` names only current keys. A planned tile is retried every
/// night until it answers, so thirty days of silence means orphaned, not
/// unlucky; a region may also come back when mining restores it.
pub(crate) const ORPHAN_RETIRE_DAYS: i64 = 30;

/// How old a tile's last answer must be before a run fetches it again: stations
/// and routes change a few times a year, so a run fetches about a seventh of the
/// area, and a refused tile is due again the next night.
pub(crate) const REFRESH_DAYS: i64 = 7;

/// How old a tile's last answer must be to count as stale — two missed
/// refreshes, which is what `Verified.Geo.OsmMirrorRefresh` judges the area on.
pub(crate) const STALE_DAYS: i64 = 14;

/// How long ago each tile last answered (s), by key; absent if never. Aged in SQL
/// against `NOW()`, the clock that wrote `refreshed_at`, so the zone cancels.
async fn tile_ages(
    pool: &sqlx::MySqlPool,
    mode: &str,
) -> Result<std::collections::BTreeMap<String, i64>> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT tile_key, TIMESTAMPDIFF(SECOND, refreshed_at, NOW()) \
         FROM osm_mirror_tile WHERE mode = ?",
    )
    .bind(mode)
    .fetch_all(pool)
    .await
    .with_context(|| format!("reading the {mode} mirror's tile ages"))?;
    Ok(rows.into_iter().collect())
}

const DAY_S: i64 = 86_400;

/// The planned tiles a run should fetch: those that never answered, then
/// those last answered more than [`REFRESH_DAYS`] ago, oldest first.
pub(crate) async fn due_tiles(
    pool: &sqlx::MySqlPool,
    mode: &str,
    plan: &backend::lean::MirrorPlan,
) -> Result<Vec<backend::lean::MirrorTile>> {
    let ages = tile_ages(pool, mode).await?;
    let mut due: Vec<(i64, backend::lean::MirrorTile)> = plan
        .tiles
        .iter()
        .map(|t| {
            let age = ages
                .get(&backend::lean::tile_key(t))
                .copied()
                .unwrap_or(i64::MAX);
            (age, t.clone())
        })
        .filter(|(age, _)| *age >= REFRESH_DAYS * DAY_S)
        .collect();
    // Oldest first; a tile that never answered is the most overdue.
    due.sort_by_key(|(age, _)| std::cmp::Reverse(*age));
    Ok(due.into_iter().map(|(_, t)| t).collect())
}

/// How many planned tiles have not answered in [`STALE_DAYS`] days.
pub(crate) async fn stale_tiles(
    pool: &sqlx::MySqlPool,
    mode: &str,
    plan: &backend::lean::MirrorPlan,
) -> Result<usize> {
    let ages = tile_ages(pool, mode).await?;
    Ok(plan
        .tiles
        .iter()
        .filter(|t| {
            ages.get(&backend::lean::tile_key(t))
                .is_none_or(|age| *age >= STALE_DAYS * DAY_S)
        })
        .count())
}

/// Record that these tiles answered, in the transaction that stores their rows.
pub(crate) async fn mark_refreshed(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    mode: &str,
    keys: &[String],
) -> Result<()> {
    for key in keys {
        sqlx::query(
            "INSERT INTO osm_mirror_tile (mode, tile_key, refreshed_at) \
             VALUES (?, ?, NOW()) \
             ON DUPLICATE KEY UPDATE refreshed_at = VALUES(refreshed_at)",
        )
        .bind(mode)
        .bind(key)
        .execute(&mut **tx)
        .await
        .with_context(|| format!("recording tile {key} as refreshed"))?;
    }
    Ok(())
}

/// Fetch every tile and extract what Lean keeps. The dedup rule differs by arm
/// and is Lean's (buses keep the first tile's copy, rail the last).
pub(crate) async fn mirror_fetch(
    client: &reqwest::Client,
    mode: &str,
    tiles: &[backend::lean::MirrorTile],
) -> Result<MirrorHarvest> {
    use backend::lean;
    let mut routes: std::collections::BTreeMap<i64, (String, lean::ExtractedRoute)> =
        std::collections::BTreeMap::new();
    let mut succeeded: Vec<String> = Vec::new();
    let mut failures = 0usize;
    // How often a tile's first attempt was refused, and how often trying again
    // rescued it. Printed so the retry has to justify its cost out of its own
    // numbers rather than out of the argument that introduced it.
    let mut retried = 0usize;
    let mut retries_won = 0usize;
    let mut breaker = lean::BreakerState::new();

    for (i, tile) in tiles.iter().enumerate() {
        // Before the tile, and not after — a trailing sleep would pay the cost
        // on the last tile for no benefit. Skipped on the first, which is never
        // the one that gets refused.
        if i > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(TILE_PACE_MS)).await;
        }
        // Ask rather than pace blind: `/api/status` says when a slot frees, so a
        // spent allowance is waited out instead of refused (and tripping the
        // breaker). Before the first tile too: an earlier run may hold a slot.
        backend::overpass::wait_for_slot(client, SLOT_WAIT_CAP_S).await;
        let key = lean::tile_key(tile);
        let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
        // Fail fast while the breaker is open: the whole point is not to eat
        // the timeout on calls that will not succeed. It still counts as a tile
        // failure.
        breaker = lean::breaker_step(&breaker, "check", now_ms)?;
        if breaker.open {
            eprintln!(
                "  tile {}/{}: circuit breaker is open — skipped",
                i + 1,
                tiles.len()
            );
            failures += 1;
            continue;
        }

        let query = lean::overpass_query(mode, tile)?;
        // A transient refusal is retried once: a skipped tile is a hole in this
        // run's coverage, and a 504 is a timeout, not a verdict. If the nightly
        // tally shows retries that never win, drop this.
        let mut outcome = backend::overpass::fetch_attempt(
            client,
            &query,
            backend::overpass::MIRROR_TIMEOUT_MS,
            0,
        )
        .await;
        // Only if something answered — see `Outcome::may_retry`. `wait_for_slot`
        // cannot gate this: it returns 0 when `/api/status` is itself
        // unreachable, which is exactly the banned case.
        if outcome.may_retry() {
            retried += 1;
            // Ask again before trying again: a refusal is the moment we are
            // least entitled to fire blind.
            backend::overpass::wait_for_slot(client, SLOT_WAIT_CAP_S).await;
            let again = backend::overpass::fetch_attempt(
                client,
                &query,
                backend::overpass::MIRROR_TIMEOUT_MS,
                1,
            )
            .await;
            if matches!(again, backend::overpass::Outcome::Ok(_)) {
                retries_won += 1;
            }
            // The first attempt's errors survive, or a log naming only the
            // retry reads as a one-endpoint outage.
            outcome = match (outcome, again) {
                (
                    backend::overpass::Outcome::AllFailed {
                        errors: mut first, ..
                    },
                    backend::overpass::Outcome::AllFailed {
                        errors: second,
                        answered,
                    },
                ) => {
                    first.extend(second.into_iter().map(|e| format!("retry: {e}")));
                    backend::overpass::Outcome::AllFailed {
                        errors: first,
                        answered,
                    }
                }
                (_, other) => other,
            };
        }
        match outcome {
            backend::overpass::Outcome::Ok(body) => {
                let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
                breaker = lean::breaker_step(&breaker, "success", now_ms)?;
                let found = lean::extract_routes(mode, &body)?;
                let n = found.len();
                for r in found {
                    match mode {
                        // Buses: first tile to yield a relation owns it.
                        "bus" => {
                            routes
                                .entry(r.osm_relation_id)
                                .or_insert_with(|| (key.clone(), r));
                        }
                        // Rail: a bare `set` — the last tile wins.
                        _ => {
                            routes.insert(r.osm_relation_id, (key.clone(), r));
                        }
                    }
                }
                succeeded.push(key);
                eprintln!(
                    "  tile {}/{}: {n} relations ({} unique so far)",
                    i + 1,
                    tiles.len(),
                    routes.len()
                );
            }
            backend::overpass::Outcome::Permanent { status } => {
                // Not counted against the breaker: a permanent 4xx means the
                // query is wrong, and tripping the breaker on it would fail-fast
                // the tiles that would have worked.
                eprintln!(
                    "  tile {}/{}: Overpass {status} — skipped",
                    i + 1,
                    tiles.len()
                );
                failures += 1;
            }
            backend::overpass::Outcome::AllFailed { errors, .. } => {
                let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
                breaker = lean::breaker_step(&breaker, "failure", now_ms)?;
                // Every mirror is named: naming only the last one tried
                // reads as one endpoint being down while both were.
                eprintln!(
                    "  tile {}/{}: {} — skipped",
                    i + 1,
                    tiles.len(),
                    errors.join("; ")
                );
                failures += 1;
            }
        }
    }
    if retried > 0 {
        eprintln!("  retried {retried} refused tile(s); {retries_won} answered on the second try");
    }
    Ok(MirrorHarvest {
        routes,
        succeeded,
        failures,
    })
}

/// Plan the mirror: recent focus places → home metro → tiles.
///
/// `None` means there is nothing to mirror, which is a clean exit.
pub(crate) async fn mirror_plan(
    pool: &sqlx::MySqlPool,
) -> Result<Option<backend::lean::MirrorPlan>> {
    let points = mirror_focus_points(pool).await?;
    if points.is_empty() {
        eprintln!("No recent focus places — nothing to mirror.");
        return Ok(None);
    }
    let plan = backend::lean::mirror_region(
        &points,
        MIRROR_REGION_GAP_KM,
        MIRROR_TILE_DEG,
        MIRROR_MARGIN_M,
    )?;
    let Some(plan) = plan else {
        eprintln!("No recent focus places — nothing to mirror.");
        return Ok(None);
    };
    eprintln!(
        "Recent focus places: {} in {} region(s); mirroring the home region",
        plan.place_count, plan.region_count
    );
    eprintln!(
        "Mirroring across {} tiles of bbox {:.3},{:.3}→{:.3},{:.3}",
        plan.tiles.len(),
        plan.bbox.min_lat,
        plan.bbox.min_lon,
        plan.bbox.max_lat,
        plan.bbox.max_lon
    );
    Ok(Some(plan))
}

/// The fraction of the area refreshed: a route count passes while losing the
/// routes that matter.
pub(crate) fn mirror_coverage_line(succeeded: usize, total: usize) -> String {
    let pct = if total == 0 {
        0.0
    } else {
        100.0 * succeeded as f64 / total as f64
    };
    format!("coverage {succeeded}/{total} tiles ({pct:.0}% of the area)")
}

/// `backend fetch-geocodes`: the Nominatim half of the queue, by hand. The
/// same drain the watch runs (`backend::fetch_drain`); this prints its census
/// and its tally.
pub(crate) async fn fetch_geocodes(dry_run: bool, limit: i64) -> Result<()> {
    init_tracing();
    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    backend::schema::migrate(&pool).await?;
    print_queue_census(&pool).await?;

    let client = reqwest::Client::new();
    let d = backend::fetch_drain::drain_geocodes(&pool, &client, limit, dry_run).await?;
    if dry_run {
        println!("--dry-run: nothing fetched, nothing written");
    } else {
        println!(
            "fetched {} · {} empty (cached as such) · {} failed",
            d.fetched, d.empty, d.failed
        );
    }
    pool.close().await;
    Ok(())
}

/// `backend fetch-osm`: the Overpass half of the queue, by hand. The same
/// drain the watch runs (`backend::fetch_drain`); this prints its census and
/// its tally.
pub(crate) async fn fetch_osm(dry_run: bool, limit: i64, only: Option<&str>) -> Result<()> {
    init_tracing();
    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    backend::schema::migrate(&pool).await?;
    print_queue_census(&pool).await?;

    let client = reqwest::Client::new();
    let venue_tags = backend::lean::venue_tags()?;
    let d =
        backend::fetch_drain::drain_osm(&pool, &client, &venue_tags, limit, only, dry_run).await?;
    if dry_run {
        println!("--dry-run: nothing fetched, nothing written");
    } else {
        println!(
            "fetched {} box(es), {} row(s) · {} key(s) already covered · {} failed · {} refused",
            d.fetched, d.rows_written, d.covered_already, d.failed, d.refused
        );
    }
    pool.close().await;
    Ok(())
}

/// `backend watch-fetch-queue`: the drain (`backend::fetch_drain`) as a process
/// beside the serving pod.
///
/// ⚠ No `migrate()` here: `backend serve` migrates, starting in the same pod at
/// the same moment.
pub(crate) async fn watch_fetch_queue(interval_s: u64) -> Result<()> {
    init_tracing();
    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    // Bounded, as the server's is: a hung mirror must not tie the drain up.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(
            backend::overpass::MIRROR_TIMEOUT_MS,
        ))
        .build()
        .context("building the HTTP client")?;
    let out =
        backend::fetch_drain::watch(&pool, &client, std::time::Duration::from_secs(interval_s))
            .await;
    pool.close().await;
    out
}

/// The queue, by kind, as every by-hand drain prints it first.
async fn print_queue_census(pool: &sqlx::MySqlPool) -> Result<()> {
    for (kind, waiting, exhausted) in backend::fetch_queue::census(pool).await? {
        println!(
            "queue {kind:<20} {waiting:>6} waiting · {exhausted} past {} attempts",
            backend::fetch_queue::MAX_ATTEMPTS
        );
    }
    Ok(())
}

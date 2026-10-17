//! The OSM mirror and geocode fetchers: `fetch-osm`, `fetch-geocodes`, and the
//! tile plan behind them.

use super::init_tracing;
use super::session::*;
use anyhow::{Context, Result};
use backend::db;

/// The recent focus places' coordinates — the input to the region clustering.
///
/// ⚠ `centroid_lat`/`centroid_lon` ARE DECIMAL, so they must be cast to CHAR and
/// parsed. Read as `f64` directly, sqlx fails; paired with a defaulting decode
/// this is the bug that made 117 places decode to centroid 0.0 while the check
/// printed OK.
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
    /// The tile keys that ANSWERED. Each is authoritative for its own rows.
    pub(crate) succeeded: Vec<String>,
    pub(crate) failures: usize,
}

/// How long to wait between tiles, so the mirror stops rate-limiting itself.
///
/// ⚠ THE 429s WERE OURS, NOT THE ENDPOINT'S FAULT (#1153). The mirror issues 18
/// back-to-back queries of ~5 MB each with no pacing; the first few answer in
/// ~1.5 s and then `overpass-api.de` starts refusing. `OVERPASS_CONCURRENCY = 2`
/// cannot help — these are already sequential, and the limit being hit is a
/// RATE, not a concurrency.
///
/// The number comes from the endpoint's own statement of its terms rather than
/// from taste. Measured 2026-08-29:
///
///     GET https://overpass-api.de/api/status
///       Rate limit: 2
///       2 slots available now.
///
/// Two slots, and a slot is held for the query's duration plus a cooldown that
/// scales with its cost. A sequential walk uses one slot at a time, so the
/// budget is spent over TIME, and 5 s is a pace a two-slot allowance can sustain
/// while adding 90 s to an 18-tile run — against a 90-minute deadline.
///
/// ⚠⚠ THIS DOES NOT FIX THE NIGHTLY CRON, AND THE COMMIT THAT ADDED IT SAID IT
/// DID. The 56% -> 83% coverage gain behind this constant was measured from the
/// MAC. `scripts/prod-db.sh` tunnels the DATABASE; the Overpass calls go out
/// over the Mac's own network, so a dry run there never exercises the path the
/// CronJob uses. Measured properly on 2026-08-29, from the pod's host:
///
///     isis -> 162.55.144.139:443   Connection refused, 0.013 s (forced IPv4 too)
///     amun -> overpass-api.de      200 in 0.11 s
///     mac  -> overpass-api.de      200 in 0.25 s
///
/// A RST rather than a timeout, with no local rule naming the address and
/// general egress healthy (github 200 in 0.08 s): `overpass-api.de` was refusing
/// isis (188.165.200.180) at the far end.
///
/// ⚠ **THAT REFUSAL WAS A BAN, AND IT HAS LIFTED — do not read the table above
/// as a standing fact about this host.** #1153 closed it: the burst of eighteen
/// back-to-back queries against a TWO-slot allowance is what earned the block,
/// and once `wait_for_slot` asked `/api/status` first the same cron reached 35
/// of 36 tiles (97%) from isis. So the endpoint WAS rate-limiting us; what was
/// wrong was the axis every earlier fix measured, which is why slowing the job
/// down changed nothing.
///
/// The pacing stays because it is correct behaviour toward a two-slot endpoint
/// and it is what got the Mac from 56% to 83%. It is not what fixed the cron —
/// `wait_for_slot` is.
///
/// ⚠ NOT a fix for `kumi.systems`, which is a different failure and still dead:
/// its `/api/status` answers, and a real query returns 500 in 0.23 s. A status
/// endpoint replying is not an interpreter working, and reading the first as the
/// second is what made this look like one outage
/// ([[feedback_a_degenerate_example_cannot_show_a_convention]]).
pub(crate) const TILE_PACE_MS: u64 = 5_000;

/// The longest one tile will wait for a compute slot.
///
/// ⚠ CHOSEN AGAINST THE RUN'S DEADLINE, not picked round. The CronJob's
/// `activeDeadlineSeconds` is 5400 and a full plan is 18 tiles, so the worst
/// case here is 18 x 120 s = 36 minutes of waiting — comfortably inside it even
/// with every tile's own fetch budget on top. A larger cap would let one
/// congested night eat the deadline and return nothing at all, which is worse
/// than a partial refresh.
pub(crate) const SLOT_WAIT_CAP_S: u64 = 120;

/// How long a tile key must go unrefreshed before a run retires its rows.
///
/// ⚠ THE TILE GRID MOVES, which is what makes this necessary at all. The plan is
/// derived from mined focus places, and `tile_key` is the south-west corner to
/// four decimal places — so a bbox that shifts renames every tile. Rows under
/// the old names become unreachable: the per-tile `DELETE` names keys from the
/// CURRENT plan, so nothing matches them again, and `tile_key IS NULL` (written
/// before the column existed) never matched anything to begin with.
///
/// ⚠ NOT CAUTION FOR ITS OWN SAKE. A key missing from tonight's plan is either a
/// bbox that moved for good or one that will move back when focus-place mining
/// restores a region, and those look identical in the table. A PLANNED tile is
/// attempted nightly; with the mirrors currently answering about 10 of 18, the
/// chance a planned tile goes thirty nights without one successful refresh is
/// roughly `0.44^30` — about one in `10^11`. Thirty days of silence is evidence
/// of orphaning, not of bad luck.
pub(crate) const ORPHAN_RETIRE_DAYS: i64 = 30;

/// Fetch every tile and extract what Lean keeps.
///
/// ⚠ THE DEDUP RULE DIFFERS BY ARM AND IS LEAN'S, NOT THIS FUNCTION'S: buses
/// keep the FIRST tile's copy, rail the LAST. `node(r)` returns a relation's full
/// stop list from any tile it touches, so both copies are complete — but they
/// are different, and unifying them here would be changing behaviour in the
/// shell.
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
    // numbers rather than out of the argument that introduced it (#1153).
    let mut retried = 0usize;
    let mut retries_won = 0usize;
    let mut breaker = lean::BreakerState::new();

    for (i, tile) in tiles.iter().enumerate() {
        // ⚠ BEFORE the tile, and not after — a trailing sleep would pay the cost
        // on the last tile for no benefit. Skipped on the first, which is never
        // the one that gets refused.
        if i > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(TILE_PACE_MS)).await;
        }
        // ⚠ ASK, rather than pace blind. The constant above is a GUESS at what a
        // two-slot allowance sustains; `/api/status` is Overpass telling us. On
        // a healthy run every slot is free and this costs one cheap GET per
        // tile; when they are spent it waits exactly as long as the server said
        // instead of firing into a refusal and spending the breaker on it.
        //
        // Checked before the FIRST tile too, unlike the pace — a slot held by an
        // earlier run is exactly the case that makes tile 1 the one refused.
        backend::overpass::wait_for_slot(client, SLOT_WAIT_CAP_S).await;
        let key = lean::tile_key(tile);
        let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
        // ⚠ Fail fast while the breaker is open — the whole point is not to eat
        // the timeout on calls that will not succeed. It still counts as a tile
        // failure, exactly as `OverpassBreakerOpenError` does in the TypeScript.
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
        // ⚠ A TRANSIENT REFUSAL IS RETRIED ONCE, not surrendered: a skipped
        // tile is a permanent hole in this run's coverage, and coverage is the
        // quantity #1153 is about. A 504 is a timeout, not a verdict.
        //
        // ⚠ WHETHER IT EARNS ITS ~6 s IS NOT YET KNOWN — the tally below is what
        // settles it. If the nightlies print retries that never win, drop this.
        let mut outcome = backend::overpass::fetch_attempt(
            client,
            &query,
            backend::overpass::MIRROR_TIMEOUT_MS,
            0,
        )
        .await;
        // ⚠ ONLY IF SOMETHING ANSWERED — see `Outcome::may_retry`. `wait_for_slot`
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
            // ⚠ THE FIRST ATTEMPT'S ERRORS SURVIVE. Overwriting the outcome
            // wholesale would drop them, which is precisely the defect the
            // `AllFailed { errors }` vector exists to prevent — a log naming
            // only the retry reads as a one-endpoint outage again.
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
                // ⚠ NOT counted against the breaker: a permanent 4xx means the
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
                // ⚠ EVERY mirror is named. The 2026-08-25 dry run printed only
                // `kumi.systems` on all six failed tiles, which reads as one
                // endpoint being down while both were — #1153's misreading,
                // reproduced here before it was fixed.
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

/// ⚠ COVERAGE IS REPORTED BECAUSE A COUNT CANNOT SUBSTITUTE FOR IT. #1134's
/// measured finding is that a route count is uncorrelated with the harm — a run
/// fetching 796 of 995 routes while losing the ones the rider uses passed a
/// count floor. What fraction of the AREA was refreshed is the quantity that is
/// not, and printing it is reporting, not behaviour, so the parity diff against
/// the TypeScript arm still holds.
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
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
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
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
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

/// `backend watch-fetch-queue`: the drain as a process, beside the serving pod
/// (#1889). See `backend::fetch_drain`.
///
/// ⚠ NO `migrate()` here, on purpose: `backend serve` performs it, and this
/// starts in the same pod at the same moment.
pub(crate) async fn watch_fetch_queue(interval_s: u64) -> Result<()> {
    init_tracing();
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
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

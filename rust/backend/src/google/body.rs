//! Reconcile the `body` table's weight against Google. Port of
//! `src/google/body.ts`.
//!
//! # It DELETES, and that is what makes it worth reading carefully
//!
//! Every other fetcher in this crate is an upsert: run it twice and nothing
//! changes. This one removes rows first, because the stale Fitbit values it is
//! replacing are on the SAME primary key `(user_id, date)` only where Google
//! also has a weigh-in — and Fitbit's forward fill has a row for every day,
//! while Google has one for the days somebody actually stood on the scale. An
//! upsert alone would leave the flat line intact between real measurements.
//!
//! So the window `[replaceFrom, ∞)` is cleared and the real values inserted.
//! Rows BEFORE that boundary are older Fitbit history that Google cannot
//! replace, and they are left alone.
//!
//! ⚠ The boundary comes from `Verified.Weight.replaceFrom` and an empty fetch
//! yields `None`, on which this writes NOTHING. A Google outage, a revoked
//! token and a scope change all return zero points; treating that as "replace
//! from the beginning" would delete every weight row there is.

use anyhow::{Context, Result};
use sqlx::MySqlPool;

use super::health;
use super::oauth::{self, GoogleCreds};
use crate::lean::{self, Weigh};

/// What a reconciliation did, or would have done.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct WeightSyncResult {
    /// Weigh-ins Google returned, before dedup.
    pub fetched: usize,
    /// Distinct days after dedup — the rows that get written.
    pub days: usize,
    /// Rows the delete removed. ⚠ Larger than `days` is NORMAL and is the
    /// point: it counts the forward-filled Fitbit rows on days with no real
    /// measurement.
    pub deleted_stale: u64,
    pub upserted: usize,
    pub earliest: Option<String>,
    pub latest: Option<String>,
}

/// Reconcile `body` against a set of weigh-ins.
///
/// `apply = false` reports what it would do and writes nothing — the shape the
/// CLI uses to show a plan before committing to it.
pub async fn sync_google_weight(
    pool: &MySqlPool,
    user_id: &str,
    measurements: &[Weigh],
    apply: bool,
) -> Result<WeightSyncResult> {
    let plan = lean::dedupe_weigh_ins(measurements)?;
    let mut out = WeightSyncResult {
        fetched: measurements.len(),
        days: plan.kept.len(),
        earliest: plan.kept.first().map(|w| w.date.clone()),
        latest: plan.kept.last().map(|w| w.date.clone()),
        ..Default::default()
    };

    let Some(from) = plan.replace_from else {
        // No boundary means no fetch. Say so rather than reporting a quiet
        // success: zero weigh-ins from a feed that should have ~150 is a
        // finding, not a no-op.
        tracing::warn!("[{user_id}] google weight: no weigh-ins returned — nothing written");
        return Ok(out);
    };
    if !apply {
        return Ok(out);
    }

    // ⚠ ONE TRANSACTION. Between the delete and the inserts the window is
    // EMPTY, and a failure there would leave the table with a hole where the
    // stale-but-plausible values used to be — worse than either endpoint,
    // because a gap in weight reads as "did not weigh" rather than as a failed
    // sync. The TypeScript runs these as separate statements on a shared
    // connection and has exactly that exposure.
    let mut tx = pool.begin().await.context("opening the weight tx")?;

    let del = sqlx::query("DELETE FROM body WHERE user_id = ? AND date >= ?")
        .bind(user_id)
        .bind(&from)
        .execute(&mut *tx)
        .await
        .context("clearing the replaced weight window")?;
    out.deleted_stale = del.rows_affected();

    for m in &plan.kept {
        sqlx::query(
            "INSERT INTO body (user_id, date, weight_kg) VALUES (?, ?, ?) \
             ON DUPLICATE KEY UPDATE weight_kg = VALUES(weight_kg)",
        )
        .bind(user_id)
        .bind(&m.date)
        .bind(kilograms(m.grams))
        .execute(&mut *tx)
        .await
        .with_context(|| format!("writing weight for {}", m.date))?;
        out.upserted += 1;
    }

    tx.commit().await.context("committing the weight tx")?;
    Ok(out)
}

/// Grams to the kilograms the column holds.
///
/// ⚠ `weight_kg` is `DECIMAL(5,2)`, so MariaDB rounds to two places on the way
/// in whatever this returns — 67 345 g stores as 67.35 and not 67.345. The
/// division happens here in `f64` to match the TypeScript's `Number(g) / 1000`
/// exactly; both then meet the same column rounding, so the stored values agree.
fn kilograms(grams: i64) -> f64 {
    grams as f64 / 1000.0
}

/// Mint a token, fetch every weigh-in, and reconcile.
pub async fn run_google_weight_sync(
    pool: &MySqlPool,
    http: &reqwest::Client,
    creds: &GoogleCreds,
    user_id: &str,
    apply: bool,
) -> Result<WeightSyncResult> {
    let token = oauth::access_token(http, creds).await?;
    let weight = health::fetch_all_weight(http, &token).await?;
    sync_google_weight(pool, user_id, &weight, apply).await
}

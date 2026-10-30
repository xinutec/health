//! Per-user key/value persistence in the `sync_state` table.
//!
//! The port of the retired TypeScript `sync-state.ts`. The high-water marks and
//! small per-user settings the scheduled work carries between invocations live
//! here (the OwnTracks proxy's, the velocity cache's, the resting heart rate's,
//! the residence zone), so it is the first DB surface any of it needs.
//!
//! # Runtime queries, never the checked macros
//!
//! `sqlx::query(…)` with bind parameters. The `query!` forms would validate
//! these against a live schema at compile time, which is exactly why they are
//! not used — see the note in `Cargo.toml`.
//!
//! # The TS variant that is NOT ported
//!
//! `sync-state.ts` takes an optional `conn` so a read or write can join an
//! outer transaction. That is not reproduced here because nothing in this crate
//! opens a transaction yet, and a parameter with one caller and no test is a
//! guess about a future shape. sqlx spells it by taking `impl Executor`, which
//! is how it should arrive when a transactional caller actually exists.

use anyhow::{Context, Result};
use sqlx::{MySqlPool, Row};

/// Read one key. `None` when the row is absent.
///
/// ⚠ Absent and empty are DIFFERENT and both are preserved. A cursor stored as
/// `""` is not the same as no cursor: the TS read `row?.value ?? null`, so an
/// empty string comes back as an empty string, and a backfill that treats it as
/// "never ran" would restart from the floor date and re-fetch years of data.
pub async fn get(pool: &MySqlPool, user_id: &str, key: &str) -> Result<Option<String>> {
    let row = sqlx::query("SELECT value FROM sync_state WHERE user_id = ? AND key_name = ?")
        .bind(user_id)
        .bind(key)
        .fetch_optional(pool)
        .await
        .with_context(|| format!("reading sync_state {key} for {user_id}"))?;
    row.map(|r| r.try_get::<String, _>("value"))
        .transpose()
        .with_context(|| format!("decoding sync_state {key} for {user_id}"))
}

/// Upsert one key.
///
/// `ON DUPLICATE KEY UPDATE` rather than a read-then-write, matching the TS.
/// Two sync runs overlapping is not supposed to happen, but the statement is
/// the thing that makes it safe rather than a comment saying it does not.
pub async fn set(pool: &MySqlPool, user_id: &str, key: &str, value: &str) -> Result<()> {
    set_with(pool, user_id, key, value).await
}

/// The same upsert against ANY executor, so it can join a caller's transaction.
///
/// ⚠ EXISTS FOR `refresh-focus-places` (#982). It derives `home_tz` from the
/// Home cluster and writes it alongside the `focus_places` rows; through the
/// pool that write would land OUTSIDE the transaction, so a half-failed refresh
/// would leave a residence zone derived from rows that were rolled back. The
/// TypeScript passes its `conn` for exactly this reason.
pub async fn set_with<'e, E>(exec: E, user_id: &str, key: &str, value: &str) -> Result<()>
where
    E: sqlx::Executor<'e, Database = sqlx::MySql>,
{
    sqlx::query(
        "INSERT INTO sync_state (user_id, key_name, value) VALUES (?, ?, ?) \
         ON DUPLICATE KEY UPDATE value = VALUES(value)",
    )
    .bind(user_id)
    .bind(key)
    .bind(value)
    .execute(exec)
    .await
    .with_context(|| format!("writing sync_state {key} for {user_id}"))?;
    Ok(())
}

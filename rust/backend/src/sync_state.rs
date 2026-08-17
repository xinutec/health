//! Per-user key/value persistence in the `sync_state` table.
//!
//! The port of `src/db/sync-state.ts`. This is where every backfill cursor
//! lives, so it is the first DB surface any scheduled work needs: "how far did
//! the last run get" is the only state a sync job carries between invocations.
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
/// `""` is not the same as no cursor: the TS reads `row?.value ?? null`, so an
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
    sqlx::query(
        "INSERT INTO sync_state (user_id, key_name, value) VALUES (?, ?, ?) \
         ON DUPLICATE KEY UPDATE value = VALUES(value)",
    )
    .bind(user_id)
    .bind(key)
    .bind(value)
    .execute(pool)
    .await
    .with_context(|| format!("writing sync_state {key} for {user_id}"))?;
    Ok(())
}

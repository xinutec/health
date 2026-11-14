//! Per-user key/value persistence in `sync_state`: high-water marks and small
//! settings the scheduled work carries (the OwnTracks proxy's, the velocity
//! cache's, resting heart rate's, the residence zone). Runtime `sqlx::query`,
//! not the checked macros (see `Cargo.toml`).

use anyhow::{Context, Result};
use sqlx::{MySqlPool, Row};

/// The zone a user's days are bounded in when they have not set one.
pub const DEFAULT_HOME_TZ: &str = "Europe/London";

/// The zone a user's days are bounded in: their `home_tz`, else
/// [`DEFAULT_HOME_TZ`]. One default, so a served day and a decoded day of a
/// user with no zone have the same bounds.
pub async fn home_tz(pool: &MySqlPool, user_id: &str) -> Result<String> {
    Ok(get(pool, user_id, "home_tz")
        .await?
        .unwrap_or_else(|| DEFAULT_HOME_TZ.into()))
}

/// Read one key; `None` when absent. ⚠ An empty string comes back as one: a
/// backfill reading `""` as "never ran" would re-fetch years.
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

/// Upsert one key with `ON DUPLICATE KEY UPDATE`, safe even if two runs overlap.
pub async fn set(pool: &MySqlPool, user_id: &str, key: &str, value: &str) -> Result<()> {
    set_with(pool, user_id, key, value).await
}

/// The same upsert against any executor, so `refresh-focus-places` can write
/// `home_tz` inside the transaction of the rows it derives from.
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

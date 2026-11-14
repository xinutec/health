//! The MariaDB connection pool (sqlx, as the sibling repos). It connects eagerly
//! at startup, so a bad credential fails there, not in the next CronJob.

use anyhow::{Context, Result};
use sqlx::MySqlPool;
use sqlx::mysql::MySqlPoolOptions;

/// Sized for the sync job's fan-out and a server that folds one day at a time
/// (`fold_slot`).
const MAX_CONNECTIONS: u32 = 8;

pub async fn connect(database_url: &str) -> Result<MySqlPool> {
    let pool = MySqlPoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        // Pin every session to UTC, as `life`'s pool does: columns written by
        // the DB clock come back session-local, and health stores DATETIME, so
        // the session zone alone decides what `NOW()` means.
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET time_zone = '+00:00'")
                    .execute(conn)
                    .await?;
                Ok(())
            })
        })
        .connect(database_url)
        .await
        // ⚠ The URL carries the password, so it must not go in the error. sqlx's
        // own connect errors do not include it; this context line must not
        // reintroduce it, because a CronJob's stderr is not a secret store.
        .context("connecting to MariaDB")?;
    Ok(pool)
}

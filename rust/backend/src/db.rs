//! The MariaDB connection pool.
//!
//! sqlx, matching the six sibling repos (#982), and proven in this repo first
//! by `rust/day-shell/src/mirror.rs` against the live OSM mirror.
//!
//! # What is different from `mirror.rs`, and why
//!
//! `mirror.rs` builds its pool with `connect_lazy_with` from SYNCHRONOUS code
//! and has to `runtime().enter()` first, because an sqlx pool spawns a
//! maintenance task on construction and panics without a Tokio context. That
//! shape exists because the fold reaches it through a Lean callback with no
//! `await` to hand an answer back through.
//!
//! Nothing here has that constraint: the backend is async from `main` down. So
//! this connects eagerly and `await`s, which also means a bad credential or an
//! unreachable host fails AT STARTUP with a clear error, rather than at the
//! first query in whatever CronJob invocation happens to run next.

use anyhow::{Context, Result};
use sqlx::MySqlPool;
use sqlx::mysql::MySqlPoolOptions;

/// Enough for the sync job's fan-out without being a second opinion about the
/// server's needs. The TypeScript pool is 20, sized for `velocity.ts`'s
/// `Promise.all` segment enrichment — a request-path concern that has not moved
/// here yet. Sizing this at 20 now would be copying a number away from the
/// measurement that justified it; it rises when the request path arrives and
/// has its own reason to.
const MAX_CONNECTIONS: u32 = 8;

pub async fn connect(database_url: &str) -> Result<MySqlPool> {
    let pool = MySqlPoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        // ⚠ Pin every session to UTC, the same as `life`'s pool does.
        //
        // Columns written by the DB clock (`NOW()`, `DEFAULT CURRENT_TIMESTAMP`)
        // come back as naive local-to-the-session values. Without this the code
        // is correct only while the container happens to run UTC — true today
        // and not a thing to depend on, because the failure is silent and shows
        // up as biometrics landing in the wrong hour rather than as an error.
        //
        // health stores DATETIME rather than TIMESTAMP, so the server does no
        // conversion of its own and the session zone is the only thing deciding
        // what `NOW()` means.
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
        // ⚠ The URL carries the password, so it must NOT go in the error. sqlx's
        // own connect errors do not include it; this context line must not
        // reintroduce it, because a CronJob's stderr is not a secret store.
        .context("connecting to MariaDB")?;
    Ok(pool)
}

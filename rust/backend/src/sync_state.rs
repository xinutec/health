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

/// Where a backfill walk's cursor and completion flag live.
///
/// ⚠ THIS EXISTS SO THE WALK CAN BE TESTED, and the reason is a bug that got
/// through. The walk's only durable effect is four calls through here, but they
/// went straight to a `MySqlPool`, so a test could reach the streak FOLD and
/// never the LOOP that applies it. That is precisely where the three-way
/// [`crate::backfill::StreakFold`] had been collapsed into two: every test
/// passed, and a failed day still cleared the streak.
///
/// Boxed futures rather than `async fn` in a trait because the walk holds this
/// through `dyn` — the same shape `DayStream` already uses for its fetchers.
pub trait CursorStore: Send + Sync {
    fn get<'a>(&'a self, user_id: &'a str, key: &'a str) -> StoreFut<'a, Option<String>>;
    fn set<'a>(&'a self, user_id: &'a str, key: &'a str, value: &'a str) -> StoreFut<'a, ()>;
}

pub type StoreFut<'a, T> =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<T>> + Send + 'a>>;

impl CursorStore for MySqlPool {
    fn get<'a>(&'a self, user_id: &'a str, key: &'a str) -> StoreFut<'a, Option<String>> {
        Box::pin(get(self, user_id, key))
    }
    fn set<'a>(&'a self, user_id: &'a str, key: &'a str, value: &'a str) -> StoreFut<'a, ()> {
        Box::pin(set(self, user_id, key, value))
    }
}

/// An in-memory [`CursorStore`] that also RECORDS every write in order.
///
/// The order is the point. A walk that ends in the right state having taken the
/// wrong path — completing a stream before its streak was reached, say — is
/// indistinguishable from a correct one if you only compare the final rows.
#[derive(Default)]
pub struct MemoryStore {
    rows: std::sync::Mutex<std::collections::HashMap<(String, String), String>>,
    pub writes: std::sync::Mutex<Vec<(String, String)>>,
}

impl MemoryStore {
    pub fn with(pairs: &[(&str, &str)]) -> Self {
        let s = Self::default();
        {
            let mut rows = s.rows.lock().unwrap();
            for (k, v) in pairs {
                rows.insert(("u".to_string(), k.to_string()), v.to_string());
            }
        }
        s
    }

    /// Every (key, value) written, in the order the walk wrote them.
    pub fn trace(&self) -> Vec<(String, String)> {
        self.writes.lock().unwrap().clone()
    }

    pub fn value(&self, key: &str) -> Option<String> {
        self.rows
            .lock()
            .unwrap()
            .get(&("u".to_string(), key.to_string()))
            .cloned()
    }
}

impl CursorStore for MemoryStore {
    fn get<'a>(&'a self, user_id: &'a str, key: &'a str) -> StoreFut<'a, Option<String>> {
        let v = self
            .rows
            .lock()
            .unwrap()
            .get(&(user_id.to_string(), key.to_string()))
            .cloned();
        Box::pin(async move { Ok(v) })
    }
    fn set<'a>(&'a self, user_id: &'a str, key: &'a str, value: &'a str) -> StoreFut<'a, ()> {
        self.rows
            .lock()
            .unwrap()
            .insert((user_id.to_string(), key.to_string()), value.to_string());
        self.writes
            .lock()
            .unwrap()
            .push((key.to_string(), value.to_string()));
        Box::pin(async move { Ok(()) })
    }
}

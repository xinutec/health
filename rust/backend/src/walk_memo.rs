//! A walk's drawn result, remembered across folds.
//!
//! Drawing walks is most of a fold, and every page load redrew the day's walks.
//! Lean keys each result by a hash of everything the drawing reads
//! (`WalkAnnotate.walkMemoKey`), asks here first (`memo.walkGet`) and hands
//! over what it drew (`memo.walkPut`). This side adds the code version, a hash
//! of the `verified_cli` binary.
//!
//! A remembered line cannot be stale: the code and the data (fixes, roads,
//! buildings, by content) are in the key, and `WalkAnnotate.drawWalk` takes
//! exactly the arguments `walkMemoKey` hashes. `tests/suite/walk_memo.rs`
//! checks that a remembered day equals the drawn one.
//!
//! A deploy empties the memo; `routes::velocity::warm_recent` refolds in the
//! background. Drawing walks in parallel could make this module unnecessary;
//! nothing else depends on it.
//!
//! Only the serving process keeps anything ([`init`]); elsewhere every walk is
//! drawn. The asks are answered in the worker loop and never recorded among the
//! fold's asks.

use std::sync::OnceLock;

use anyhow::{Context, Result};
use serde_json::Value;
use sha2::Digest as _;
use sqlx::MySqlPool;

use crate::lean::Ask;

/// Where remembered walks live: the database for the server, a map for the
/// test that holds a remembered walk to the drawn one.
enum Store {
    Db {
        pool: MySqlPool,
        handle: tokio::runtime::Handle,
        version: String,
    },
}

static STORE: OnceLock<Store> = OnceLock::new();

thread_local! {
    /// The test's store: this thread's alone, so a fold another test runs in
    /// the same process neither reads it nor moves its counters.
    static MEM: std::cell::RefCell<Option<std::collections::HashMap<String, String>>> =
        const { std::cell::RefCell::new(None) };
    static MEM_STATS: std::cell::Cell<MemStats> = const { std::cell::Cell::new(MemStats {
        served: 0,
        missed: 0,
        puts: 0,
    }) };
}

/// What the in-memory store has been asked (gets served, gets missed, puts), so
/// a test can prove the second replay read it without timing.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct MemStats {
    pub served: u64,
    pub missed: u64,
    pub puts: u64,
}

/// This thread's in-memory counters so far, and reset them.
pub fn take_mem_stats() -> MemStats {
    MEM_STATS.with(|s| s.take())
}

fn count(f: impl FnOnce(&mut MemStats)) {
    MEM_STATS.with(|s| {
        let mut v = s.get();
        f(&mut v);
        s.set(v);
    });
}

/// A store in memory, for the folds this thread runs. For tests only: nothing
/// outlives the thread, and no code version is needed because the code cannot
/// change.
pub fn init_in_memory() {
    MEM.with(|m| *m.borrow_mut() = Some(Default::default()));
}

/// Turn the store on for this process: hash the Lean binary, clear rows of any
/// other version, and keep the pool and the runtime to answer from.
pub async fn init(pool: &MySqlPool) -> Result<()> {
    let path = crate::lean_worker::verified_cli_path()?;
    let bytes = tokio::fs::read(path)
        .await
        .with_context(|| format!("reading {} to version the walk memo", path.display()))?;
    let digest = sha2::Sha256::digest(&bytes);
    let version: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
    let cleared = sqlx::query("DELETE FROM walk_memo WHERE code_version <> ?")
        .bind(&version)
        .execute(pool)
        .await
        .context("clearing walk_memo rows of other code versions")?
        .rows_affected();
    tracing::info!(%version, cleared, "walk memo on");
    let _ = STORE.set(Store::Db {
        pool: pool.clone(),
        handle: tokio::runtime::Handle::current(),
        version,
    });
    Ok(())
}

/// Run one database call to completion from whatever thread asks. On A
/// thread of its own: the worker's loop may sit inside the runtime or on a
/// blocking thread, and `block_on` from the former panics.
fn block<T: Send>(
    handle: &tokio::runtime::Handle,
    f: impl std::future::Future<Output = T> + Send,
) -> T {
    std::thread::scope(|sc| {
        sc.spawn(|| handle.block_on(f))
            .join()
            .expect("walk memo thread")
    })
}

/// Answer a `memo.*` ask: the stored result for `memo.walkGet`, nothing for
/// `memo.walkPut` (whose key is `hash|value`) once it is stored.
pub fn answer(ask: &Ask) -> Option<Value> {
    if let Some(hit) = MEM.with(|m| m.borrow_mut().as_mut().map(|map| answer_mem(ask, map))) {
        return hit;
    }
    match STORE.get()? {
        Store::Db {
            pool,
            handle,
            version,
        } => answer_db(ask, pool, handle, version),
    }
}

fn answer_mem(ask: &Ask, map: &mut std::collections::HashMap<String, String>) -> Option<Value> {
    match ask.what.as_str() {
        "memo.walkGet" => {
            let hit = map.get(&ask.key).and_then(|t| serde_json::from_str(t).ok());
            count(|s| {
                if hit.is_some() {
                    s.served += 1
                } else {
                    s.missed += 1
                }
            });
            hit
        }
        "memo.walkPut" => {
            if let Some((key, value)) = ask.key.split_once('|') {
                map.entry(key.to_string())
                    .or_insert_with(|| value.to_string());
            }
            count(|s| s.puts += 1);
            None
        }
        _ => None,
    }
}

fn answer_db(
    ask: &Ask,
    pool: &MySqlPool,
    handle: &tokio::runtime::Handle,
    version: &str,
) -> Option<Value> {
    match ask.what.as_str() {
        "memo.walkGet" => {
            let row: Result<Option<String>, sqlx::Error> = block(
                handle,
                sqlx::query_scalar(
                    "SELECT value FROM walk_memo WHERE code_version = ? AND memo_key = ?",
                )
                .bind(version)
                .bind(&ask.key)
                .fetch_optional(pool),
            );
            match row {
                Ok(Some(text)) => serde_json::from_str(&text).ok(),
                Ok(None) => None,
                Err(e) => {
                    tracing::warn!(error = %e, "walk memo read failed; drawing the walk");
                    None
                }
            }
        }
        "memo.walkPut" => {
            if let Some((key, value)) = ask.key.split_once('|') {
                let done = block(
                    handle,
                    sqlx::query(
                        "INSERT IGNORE INTO walk_memo (code_version, memo_key, value) VALUES (?, ?, ?)",
                    )
                    .bind(version)
                    .bind(key)
                    .bind(value)
                    .execute(pool),
                );
                if let Err(e) = done {
                    tracing::warn!(error = %e, "walk memo write failed");
                }
            }
            None
        }
        _ => None,
    }
}

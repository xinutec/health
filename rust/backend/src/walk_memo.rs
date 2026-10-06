//! A walk's drawn result, remembered across folds (#1921).
//!
//! Drawing a walk — the matcher, the building corrector, the reconstruction —
//! was most of a fold, and a page load drew every walk of the day again: the
//! morning's walks on every evening load. Lean keys each walk's result by a
//! hash of everything its drawing reads (`WalkAnnotate.walkMemoKey`) and asks
//! here first (`memo.walkGet`); a walk it drew it hands over (`memo.walkPut`).
//! This side adds the code version — a hash of the `verified_cli` binary — so
//! a new build never reads an old build's lines.
//!
//! # Why a remembered line cannot be a stale one
//!
//! * The code is in the key. A change to anything that draws a walk changes
//!   the `verified_cli` binary, so an old build's rows are never read, and a
//!   start clears them.
//! * The data is in the key: the walk's fixes and the roads and buildings
//!   answered for it, by content. A changed map changes the key.
//! * The key cannot miss an input. `WalkAnnotate.drawWalk` takes exactly the
//!   arguments `walkMemoKey` hashes, so the drawing has no way to read anything
//!   the key leaves out; a new input has to become an argument of both.
//!
//! `tests/suite/walk_memo.rs` replays three days twice and requires the day
//! with remembered walks to be the day that drew them.
//!
//! # The alternative, for when it is worth more than this
//!
//! A deploy changes the code version and empties the memo, and the first fold
//! after it draws every walk again — `routes::velocity::warm_recent` does that
//! fold in the background so a person does not. The other way to the same
//! speed is a drawing fast enough to need no memory at all: the walks of a day
//! are independent and could be drawn in parallel, a day then costing its
//! longest walk rather than their sum (roughly 2–3× on 2026-10-04); and the
//! drawing itself has room left (#1921: the matcher's two graph builds, the
//! corrector's whole-network walk graph). If that lands, this module and its
//! table can go — nothing else depends on them.
//!
//! ⚠ ONLY THE SERVING PROCESS KEEPS ANYTHING. [`init`] is called where the
//! server starts; everywhere else (gates, captures, the CLI) the store is unset,
//! every `memo.walkGet` answers nothing and every walk is drawn, which is what a
//! test of the drawing has to do. The asks are answered in the worker's loop and
//! never recorded among the fold's asks, so no count, capture or fetch queue
//! sees them.

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
    Mem(std::sync::Mutex<std::collections::HashMap<String, String>>),
}

static STORE: OnceLock<Store> = OnceLock::new();

/// What the in-memory store has been asked, for the test that proves the
/// second replay READ it: `memo.walkGet`s served, `memo.walkGet`s missed,
/// `memo.walkPut`s. A clock cannot say that — once drawing is fast, "four
/// times faster when remembered" is noise (#1921).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct MemStats {
    pub served: u64,
    pub missed: u64,
    pub puts: u64,
}

static MEM_STATS: std::sync::Mutex<MemStats> = std::sync::Mutex::new(MemStats {
    served: 0,
    missed: 0,
    puts: 0,
});

/// The in-memory store's counters so far, and reset them.
pub fn take_mem_stats() -> MemStats {
    let mut s = MEM_STATS.lock().expect("walk memo stats");
    std::mem::take(&mut *s)
}

fn count(f: impl FnOnce(&mut MemStats)) {
    if let Ok(mut s) = MEM_STATS.lock() {
        f(&mut s);
    }
}

/// A store in memory, for this process. For tests only: nothing outlives the
/// process, and no code version is needed because the code cannot change.
pub fn init_in_memory() {
    let _ = STORE.set(Store::Mem(Default::default()));
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

/// Run one database call to completion from whatever thread asks. ⚠ ON A
/// THREAD OF ITS OWN: the worker's loop may sit inside the runtime or on a
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
    match STORE.get()? {
        Store::Mem(map) => {
            let mut map = map.lock().ok()?;
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
        Store::Db {
            pool,
            handle,
            version,
        } => answer_db(ask, pool, handle, version),
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

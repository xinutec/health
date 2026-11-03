//! How much of a re-decode an incremental one could reuse: the first minute
//! whose observation row changed since the day's previous decode, and which
//! day-wide inputs moved (any of them means nothing is reusable). Measured and
//! logged only; nothing decodes from it yet
//! (docs/proposals/2026-11-incremental-today.md, step 1).
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde_json::Value;

/// The request's inputs that are not per-minute rows: a change in any of them
/// reaches every minute.
pub const DAY_WIDE: [&str; 9] = [
    "edges",
    "nodes",
    "places",
    "placeNearLine",
    "railStopRelations",
    "continuity",
    "flags",
    "tz",
    "maxD",
];

/// The day-wide inputs that differ between two decode requests.
pub fn day_wide_moved(prev: &Value, next: &Value) -> Vec<&'static str> {
    DAY_WIDE
        .into_iter()
        .filter(|k| prev.get(k) != next.get(k))
        .collect()
}

/// The first minute whose observation row differs, `None` when none does.
pub fn row_frontier(prev: &Value, next: &Value) -> Result<Option<u64>> {
    let req = serde_json::json!({
        "mode": "obsfrontier",
        "prev": prev.get("observation").context("prev has no observation")?,
        "next": next.get("observation").context("next has no observation")?,
    });
    let reply: Value = serde_json::from_str(&crate::lean::serve(&req.to_string())?)
        .context("obsfrontier answer is not JSON")?;
    if let Some(e) = reply.get("error") {
        anyhow::bail!("obsfrontier: {e}");
    }
    Ok(reply["frontier"].as_u64())
}

/// Where a day's previous request is kept.
pub fn prev_path(dir: &Path, user_id: &str, date: &str) -> PathBuf {
    dir.join(format!("{user_id}-{date}.json"))
}

/// The line to log for `next` against the day's previous request in `dir`, and
/// `next` kept as the previous one.
pub fn note(dir: &Path, user_id: &str, date: &str, next: &Value) -> Result<String> {
    let path = prev_path(dir, user_id, date);
    let line = match std::fs::read(&path) {
        Err(_) => "no previous decode".to_string(),
        Ok(bytes) => {
            let prev: Value = serde_json::from_slice(&bytes).context("the previous request")?;
            let moved = day_wide_moved(&prev, next);
            if moved.is_empty() {
                match row_frontier(&prev, next)? {
                    Some(m) => format!("minute {m} of 1440"),
                    None => "nothing changed".to_string(),
                }
            } else {
                format!("minute 0 (day-wide: {})", moved.join(", "))
            }
        }
    };
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    std::fs::write(&path, serde_json::to_vec(next)?)
        .with_context(|| format!("writing {}", path.display()))?;
    // The user's earlier days go: the watch keeps 90 days current, and only
    // the days still growing are worth a frontier.
    let prefix = format!("{user_id}-");
    for entry in std::fs::read_dir(dir)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(d) = name
            .strip_prefix(&prefix)
            .and_then(|r| r.strip_suffix(".json"))
            && d < date
        {
            std::fs::remove_file(entry.path())?;
        }
    }
    Ok(line)
}

//! How much of a re-decode an incremental one could reuse: the first minute
//! whose observation row changed since the day's previous decode, and which
//! day-wide inputs moved (any of them means nothing is reusable)
//! (docs/proposals/2026-11-incremental-today.md, step 1). A request identical
//! to the previous one, under the same code, decodes to the stored result.
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde_json::{Value, json};

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

/// A request against the day's previous one.
#[derive(Debug, PartialEq, Eq)]
pub enum Frontier {
    NoPrevious,
    CodeChanged,
    Unchanged,
    /// The first minute whose observation row differs.
    Minute(u64),
    /// The day-wide inputs that moved.
    DayWide(Vec<&'static str>),
}

impl std::fmt::Display for Frontier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoPrevious => write!(f, "no previous decode"),
            Self::CodeChanged => write!(f, "the code changed"),
            Self::Unchanged => write!(f, "nothing changed"),
            Self::Minute(m) => write!(f, "minute {m} of 1440"),
            Self::DayWide(moved) => write!(f, "minute 0 (day-wide: {})", moved.join(", ")),
        }
    }
}

/// The day-wide inputs that differ between two decode requests.
pub fn day_wide_moved(prev: &Value, next: &Value) -> Vec<&'static str> {
    DAY_WIDE
        .into_iter()
        .filter(|k| prev.get(k) != next.get(k))
        .collect()
}

/// The first minute whose observation row differs, `None` when none does.
pub fn row_frontier(prev: &Value, next: &Value) -> Result<Option<u64>> {
    let req = json!({
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

/// `next` against the day's previous request in `dir`, kept there under `code`.
pub fn compare(
    dir: &Path,
    user_id: &str,
    date: &str,
    code: &str,
    next: &Value,
) -> Result<Frontier> {
    let Ok(bytes) = std::fs::read(prev_path(dir, user_id, date)) else {
        return Ok(Frontier::NoPrevious);
    };
    let kept: Value = serde_json::from_slice(&bytes).context("the previous request")?;
    if kept["code"].as_str() != Some(code) {
        return Ok(Frontier::CodeChanged);
    }
    let prev = &kept["request"];
    let moved = day_wide_moved(prev, next);
    if !moved.is_empty() {
        return Ok(Frontier::DayWide(moved));
    }
    Ok(match row_frontier(prev, next)? {
        Some(m) => Frontier::Minute(m),
        None => Frontier::Unchanged,
    })
}

/// Keep `next` as the day's previous request under `code` — only once its
/// decode is written, so an unchanged request always has a stored result.
pub fn keep(dir: &Path, user_id: &str, date: &str, code: &str, next: &Value) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let path = prev_path(dir, user_id, date);
    std::fs::write(
        &path,
        serde_json::to_vec(&json!({ "code": code, "request": next }))?,
    )
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
    Ok(())
}

//! Reverse geocoding through Nominatim, and its cache. A captured day cannot
//! answer `reverseGeocode` from this ([`crate::rowset_answerer`] declines them).
//!
//! `osm_cache` is keyed `(query_type, lat_rounded DECIMAL(7,4), lon_rounded
//! DECIMAL(7,4))` under `nominatim_z18` / `nominatim_z16`. A rounding off by one
//! unit misses quietly and re-fetches.
//!
//! ⚠ The stored keys round halves toward +∞ (`floor(x + 0.5)`); `f64::round`
//! rounds away from zero and differs on every negative half, which is every
//! London longitude. [`round_coord`] uses the stored rule, as
//! `Verified.Geo.Enrich.cityGrid` does.
//!
//! Nominatim allows one request per second per source, on pain of an IP ban.
//! [`MIN_INTERVAL`] is that floor; a batch driver must honour it.

use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sqlx::{MySqlPool, Row};

/// Nominatim's reverse endpoint.
pub const REVERSE_URL: &str = "https://nominatim.openstreetmap.org/reverse";

/// The policy floor between two requests: one per second, absolute.
pub const MIN_INTERVAL: Duration = Duration::from_secs(1);

/// How long a failed fetch suppresses a retry, as `withCache`'s negative
/// sentinel did. Long enough to survive a rate-limit recovery.
pub const NEGATIVE_TTL: Duration = Duration::from_secs(5 * 60);

/// Rounded to 4 decimals (~11 m), as `osm_cache` is declared, by
/// `floor(x + 0.5)` (see the module header).
#[must_use]
pub fn round_coord(n: f64) -> f64 {
    (n * 10000.0 + 0.5).floor() / 10000.0
}

/// The `query_type` a zoom is cached under (`nominatim_z18`, `nominatim_z16`),
/// also the [`crate::fetch_queue`] `kind`, so the drain fills the fold's cache.
#[must_use]
pub fn query_type(zoom: i64) -> String {
    format!("nominatim_z{zoom}")
}

/// The zoom back out of a [`query_type`], so a drain learns zooms from the
/// queue. They are declared in `Verified.Geo.BestPlace` and `Enrich`.
#[must_use]
pub fn zoom_of(query_type: &str) -> Option<i64> {
    query_type.strip_prefix("nominatim_z")?.parse().ok()
}

/// The `fetch_key` a queued geocode is recorded under, rounded by the cache's
/// rule: nearby fixes share one fetch and the answer lands where the fold looks.
/// [`round_coord`] is idempotent, so re-rounding a parsed key is safe.
#[must_use]
pub fn queue_key(lat: f64, lon: f64) -> String {
    format!("{}|{}", round_coord(lat), round_coord(lon))
}

/// One Nominatim answer, in the wire names `osmTrace.reverseGeocode` and
/// golden fixtures use: `displayName` from `display_name`, `category` from
/// `class`, else `category`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Geocode {
    #[serde(rename = "displayName")]
    pub display_name: String,
    /// Nominatim's `type` — `residential`, `hospital`, `pedestrian`, …
    #[serde(rename = "type")]
    pub kind: String,
    /// Nominatim's `class`.
    pub category: String,
    pub address: serde_json::Map<String, serde_json::Value>,
}

/// Nominatim's own reply, before narrowing.
#[derive(Debug, Deserialize)]
struct Reply {
    display_name: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    class: Option<String>,
    category: Option<String>,
    address: Option<serde_json::Map<String, serde_json::Value>>,
}

/// Narrow one Nominatim reply. `None` (no `display_name`) is a valid answer,
/// cached: Nominatim knows nothing there, unlike a failed request.
#[must_use]
pub fn narrow(body: &str) -> Option<Geocode> {
    let r: Reply = serde_json::from_str(body).ok()?;
    let display_name = r.display_name?;
    Some(Geocode {
        display_name,
        kind: r.kind.unwrap_or_default(),
        // `class` first: Nominatim sends `class`, and reading `category`
        // first would take an absent field and record the wrong vocabulary.
        category: r.class.or(r.category).unwrap_or_default(),
        address: r.address.unwrap_or_default(),
    })
}

/// What a cache row holds: an answer (possibly the valid `null`), or a
/// suppressed failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cached {
    /// A fetched answer. `None` is Nominatim saying nothing is there.
    Answer(Option<Geocode>),
    /// A failure recorded at this epoch-millisecond, with the status that caused
    /// it. Suppresses a re-fetch for [`NEGATIVE_TTL`].
    Failed { status: u16, at_ms: i64 },
}

/// The negative sentinel `withCache` wrote: `{_err, _at}`.
#[derive(Debug, Deserialize)]
struct NegSentinel {
    _err: u16,
    _at: i64,
}

/// Read one cached geocode: `None` is no row, `Cached::Answer(None)` a row
/// saying nothing is there. The coordinate binds as a 4-decimal string: sqlx
/// binds `f64` as a double, which mismatches `DECIMAL(7,4)` on real rows.
pub async fn cache_get(pool: &MySqlPool, zoom: i64, lat: f64, lon: f64) -> Result<Option<Cached>> {
    let row = sqlx::query(
        "SELECT result FROM osm_cache \
         WHERE query_type = ? AND lat_rounded = ? AND lon_rounded = ?",
    )
    .bind(query_type(zoom))
    .bind(format!("{:.4}", round_coord(lat)))
    .bind(format!("{:.4}", round_coord(lon)))
    .fetch_optional(pool)
    .await
    .context("reading osm_cache")?;
    let Some(row) = row else { return Ok(None) };
    let text: String = row.try_get("result").context("osm_cache.result")?;
    if let Ok(neg) = serde_json::from_str::<NegSentinel>(&text) {
        return Ok(Some(Cached::Failed {
            status: neg._err,
            at_ms: neg._at,
        }));
    }
    // `null` parses to `Answer(None)`, a cached "nothing here". Anything else
    // that is not a geocode is corrupt and errors, rather than becoming a
    // permanent silent blank.
    let answer: Option<Geocode> = serde_json::from_str(&text)
        .with_context(|| format!("osm_cache holds an unreadable {} row", query_type(zoom)))?;
    Ok(Some(Cached::Answer(answer)))
}

/// Write one answer, replacing whatever was there.
pub async fn cache_put(
    pool: &MySqlPool,
    zoom: i64,
    lat: f64,
    lon: f64,
    answer: &Option<Geocode>,
) -> Result<()> {
    let json = serde_json::to_string(answer).context("encoding a geocode")?;
    sqlx::query(
        "INSERT INTO osm_cache (query_type, lat_rounded, lon_rounded, result) \
         VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE result = VALUES(result)",
    )
    .bind(query_type(zoom))
    .bind(format!("{:.4}", round_coord(lat)))
    .bind(format!("{:.4}", round_coord(lon)))
    .bind(json)
    .execute(pool)
    .await
    .context("writing osm_cache")?;
    Ok(())
}

/// The outcome of one live request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fetched {
    /// Nominatim answered. `None` means it knows of nothing there.
    Answer(Option<Geocode>),
    /// Nominatim refused. Not cached as an answer — see [`Cached::Failed`].
    Refused(u16),
}

/// Ask Nominatim once. Does not rate-limit itself — see [`MIN_INTERVAL`].
pub async fn reverse(client: &reqwest::Client, lat: f64, lon: f64, zoom: i64) -> Result<Fetched> {
    let res = client
        .get(REVERSE_URL)
        .query(&[
            ("lat", lat.to_string()),
            ("lon", lon.to_string()),
            ("format", "json".into()),
            ("zoom", zoom.to_string()),
        ])
        .header("User-Agent", crate::overpass::USER_AGENT)
        .send()
        .await
        .context("asking Nominatim")?;
    let status = res.status();
    if !status.is_success() {
        return Ok(Fetched::Refused(status.as_u16()));
    }
    let body = res.text().await.context("reading Nominatim's reply")?;
    Ok(Fetched::Answer(narrow(&body)))
}

//! Reverse geocoding through Nominatim, and the cache the TypeScript left behind
//! (#1076).
//!
//! The port of `src/geo/osm.ts`'s `reverseGeocode` and its `withCache` wrapper.
//! Production has never made this call since the TypeScript went (#975), which
//! is why a captured day cannot answer the `reverseGeocode` keys every golden
//! day holds — see [`crate::rowset_answerer`], which declines them on purpose.
//!
//! # The cache table already exists, and reproducing its key EXACTLY is the point
//!
//! `osm_cache` is keyed `(query_type, lat_rounded DECIMAL(7,4), lon_rounded
//! DECIMAL(7,4))`. It holds whatever the TypeScript fetched, under
//! `nominatim_z18` / `nominatim_z16`. A rounding that disagrees with the
//! TypeScript's by one unit in the last place does not fail — it MISSES, quietly,
//! and re-fetches something already paid for.
//!
//! ⚠ **`Math.round` and `f64::round` disagree on exactly the coordinates this
//! sees.** JS rounds a half toward +∞; Rust rounds a half away from zero. On a
//! London longitude — negative, always — `Math.round(-1836.5)` is `-1836` and
//! `(-1836.5f64).round()` is `-1837`. [`round_coord`] spells the JS form, the
//! same way `Verified.Geo.Enrich.cityGrid` already does for the city grid.
//!
//! # Rate limit
//!
//! Nominatim's usage policy is an absolute one request per second from one
//! source, and exceeding it earns an IP-level ban — the same terms
//! [`crate::overpass`] records for Overpass. [`MIN_INTERVAL`] is that floor;
//! whoever drives a batch is responsible for honouring it.

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

/// `Math.round(n * 10000) / 10000` — 4 decimals, ~11 m, the precision
/// `osm_cache` is declared at.
///
/// ⚠ `floor(x + 0.5)`, NOT `f64::round`. See the module header: the two differ
/// on a negative half, and every longitude here is negative.
#[must_use]
pub fn round_coord(n: f64) -> f64 {
    (n * 10000.0 + 0.5).floor() / 10000.0
}

/// The `query_type` a zoom is cached under: `nominatim_z18`, `nominatim_z16`.
///
/// ⚠ Also the `kind` of an [`crate::fetch_queue`] row, on purpose — the drain
/// writes straight back into the cache the fold reads, and two vocabularies for
/// one thing is how a queue fills with entries nothing consumes.
#[must_use]
pub fn query_type(zoom: i64) -> String {
    format!("nominatim_z{zoom}")
}

/// The zoom back out of a [`query_type`], for a drain that learns which zooms
/// were asked from the queue rather than from a list it carries.
///
/// ⚠ The zooms are declared in `Verified.Geo.BestPlace` and
/// `Verified.Geo.Enrich`. Restating them here would be a second source of truth
/// for a number the fold owns.
#[must_use]
pub fn zoom_of(query_type: &str) -> Option<i64> {
    query_type.strip_prefix("nominatim_z")?.parse().ok()
}

/// The `fetch_key` a queued geocode is recorded under.
///
/// ⚠ ROUNDED, so two fixes 3 m apart queue ONE fetch rather than two against a
/// service that allows one request per second. And rounded with the SAME rule
/// the cache is keyed by, so the answer the drain writes lands where the fold
/// looks — [`round_coord`] is idempotent, which is what makes parsing this key
/// and re-rounding it safe.
#[must_use]
pub fn queue_key(lat: f64, lon: f64) -> String {
    format!("{}|{}", round_coord(lat), round_coord(lon))
}

/// One Nominatim answer, in the shape the fold's `osmTrace.reverseGeocode`
/// section carries and `Verified.Geo.BestPlace` reads.
///
/// ⚠ The field names are the TypeScript's, not Nominatim's: `displayName` from
/// `display_name`, and `category` from **`class`** falling back to `category`.
/// A golden fixture is written in these names, so they are wire format.
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

/// Narrow one Nominatim reply.
///
/// `None` is a VALID answer and is cached as one: Nominatim replying without a
/// `display_name` means it knows of nothing there, which is different from the
/// request having failed.
#[must_use]
pub fn narrow(body: &str) -> Option<Geocode> {
    let r: Reply = serde_json::from_str(body).ok()?;
    let display_name = r.display_name?;
    Some(Geocode {
        display_name,
        kind: r.kind.unwrap_or_default(),
        // ⚠ `class` first. The TypeScript reads `data.class ?? data.category`,
        // and Nominatim sends `class`; reading `category` first would take an
        // absent field and record the wrong vocabulary.
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

/// Read one cached geocode. The outer `None` is "no row"; `Cached::Answer(None)`
/// is a row saying nothing is there. Those are three states and all three matter.
///
/// ⚠ The coordinate is bound as a 4-decimal STRING rather than an `f64`. The
/// column is `DECIMAL(7,4)`, and sqlx's MySQL `f64` binding goes out as a double
/// — which is the family of mismatch that fails only on real rows
/// (`reference_sqlx_mysql_type_traps`). A decimal string compares exactly.
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
    // `null` parses to `Answer(None)` — the TypeScript cached exactly that.
    //
    // ⚠ A row that is NEITHER the sentinel nor a geocode is CORRUPT, and must
    // not read as "nothing is there". That default would turn a damaged cache
    // into a permanent, silent blank at one coordinate — the shape #1501 is
    // about one layer down, where an empty answer and an unmeasured one are
    // indistinguishable.
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

/// Ask Nominatim once. Does NOT rate-limit itself — see [`MIN_INTERVAL`].
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

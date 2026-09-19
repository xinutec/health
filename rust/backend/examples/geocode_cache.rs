//! What is in `osm_cache`, the TypeScript's Nominatim cache? (#1076)
//!
//! ⚠ WHY: #1076 is written as "build a client and a cache table". The table
//! already exists — `osm_cache`, keyed `(query_type, lat_rounded, lon_rounded)`
//! with a LONGTEXT result — and nothing in Rust reads it. Before designing a
//! second one, this says what the first one holds: which query types, how many
//! rows, how old, and which fields a cached result carries.
//!
//! A warm cache changes the shape of the port. If the answers the fold needs
//! are already here, the Nominatim call is a MISS path rather than the primary
//! one, and the question "where does the call run" gets much cheaper.
//!
//! ⚠ PRINTS NO COORDINATES AND NO PLACE NAMES. Health's repositories are
//! public and a cached geocode is a real place he stood (#860): the output is
//! query types, counts, timestamps and FIELD NAMES only.
//!
//! ```text
//! scripts/prod-db.sh cargo run --release --example geocode_cache
//! ```

use anyhow::{Context, Result};
use backend::{config::Config, db};
use sqlx::Row;

#[tokio::main]
async fn main() -> Result<()> {
    let cfg = Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url()).await.context("connecting")?;

    let rows = sqlx::query(
        "SELECT query_type, COUNT(*) AS n, \
            CAST(MIN(cached_at) AS CHAR) AS oldest, \
            CAST(MAX(cached_at) AS CHAR) AS newest \
         FROM osm_cache GROUP BY query_type ORDER BY n DESC",
    )
    .fetch_all(&pool)
    .await
    .context("reading osm_cache")?;

    println!("osm_cache by query_type");
    for r in &rows {
        let ty: String = r.try_get("query_type")?;
        let n: i64 = r.try_get("n")?;
        let oldest: String = r.try_get("oldest").unwrap_or_default();
        let newest: String = r.try_get("newest").unwrap_or_default();
        println!("  {ty:<24} {n:>8}   {oldest} -> {newest}");
    }
    if rows.is_empty() {
        println!("  (empty)");
    }

    // One sample per type, reported as SHAPE only — the field names a cached
    // result carries, never its values.
    for r in &rows {
        let ty: String = r.try_get("query_type")?;
        let sample: Option<String> =
            sqlx::query_scalar("SELECT result FROM osm_cache WHERE query_type = ? LIMIT 1")
                .bind(&ty)
                .fetch_optional(&pool)
                .await?;
        let Some(sample) = sample else { continue };
        let shape = match serde_json::from_str::<serde_json::Value>(&sample) {
            Ok(serde_json::Value::Object(o)) => {
                let mut ks: Vec<String> = o
                    .iter()
                    .map(|(k, v)| match v {
                        serde_json::Value::Object(inner) => {
                            let mut sub: Vec<&str> = inner.keys().map(String::as_str).collect();
                            sub.sort_unstable();
                            format!("{k}{{{}}}", sub.join(","))
                        }
                        serde_json::Value::Array(a) => format!("{k}[{}]", a.len()),
                        _ => k.clone(),
                    })
                    .collect();
                ks.sort();
                ks.join(" ")
            }
            Ok(serde_json::Value::Array(a)) => format!("<array of {}>", a.len()),
            Ok(other) => format!("<scalar {other}>"),
            Err(e) => format!("<unparseable: {e}>"),
        };
        println!("\n{ty} fields:\n  {shape}");
    }

    pool.close().await;
    Ok(())
}

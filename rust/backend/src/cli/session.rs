//! Session credentials by hand: `mint-session` (WRITES a credential) and `drop-
//! session`.

use anyhow::{Context, Result};
use backend::{config::Config, db};

/// Mint a session and print its cookie value, for end-to-end verification.
///
/// ⚠ THIS CREATES REAL CREDENTIALS. It exists because the only honest way to
/// compare the Rust backend against the TypeScript one is to send the SAME
/// cookie to both — they share the sessions table, so a session minted here is
/// accepted by either. Nothing else in the port can check an authenticated
/// response body.
///
/// ⚠ Pair every call with `drop-session`. A session left behind is a working
/// credential for the named user with the full TTL ahead of it, and nothing
/// distinguishes it from one the user created by logging in.
pub(crate) async fn mint_session(user: &str) -> Result<()> {
    let cfg = Config::from_env().context("reading configuration")?;
    let secret = cfg
        .session_secret
        .as_deref()
        .context("SESSION_SECRET is not set; a session cannot be signed")?;
    let pool = db::connect(&cfg.db.url()).await?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let signed = backend::auth::session::create(&pool, secret, user, "smoke", now_ms).await?;
    pool.close().await;
    println!("{signed}");
    eprintln!("⚠ minted a REAL session for {user} — run `backend drop-session` when done");
    Ok(())
}

/// Destroy a session minted above.
pub(crate) async fn drop_session(cookie: &str) -> Result<()> {
    let cfg = Config::from_env().context("reading configuration")?;
    let secret = cfg
        .session_secret
        .as_deref()
        .context("SESSION_SECRET is not set")?;
    let pool = db::connect(&cfg.db.url()).await?;
    let gone = backend::auth::session::destroy(&pool, secret, cookie).await?;
    pool.close().await;
    // ⚠ Reported rather than assumed: a "destroyed" that removed no row means
    // the credential is still live somewhere.
    eprintln!("session removed: {gone}");
    if !gone {
        anyhow::bail!("no session row matched that cookie — it may still be valid");
    }
    Ok(())
}

/// Only mirror around focus places seen this recently — drops stale travel
/// history so the mirror tracks where the user lives NOW.
pub(crate) const MIRROR_RECENT_DAYS: i64 = 120;
/// Two focus places are the same metropolitan region within this. Comfortably
/// larger than a city's diameter, far smaller than the gap between cities.
pub(crate) const MIRROR_REGION_GAP_KM: f64 = 80.0;
/// ≈ 3.5 km. Proven size: a single whole-bbox `relation[route=bus]` over greater
/// London matches ~700 routes and pulls every member node of each, which timed
/// out on first run (#255).
pub(crate) const MIRROR_TILE_DEG: f64 = 0.05;
/// The margin `bboxFromFixes` adds around the home region.
pub(crate) const MIRROR_MARGIN_M: f64 = 1500.0;

//! Runtime configuration, read from the environment at startup.
//!
//! The Rust backend is a DROP-IN for the TypeScript one, so it reads the
//! variables `src/config.ts` reads and the k8s manifests already set —
//! `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME`, and the
//! Fitbit client pair. `rust/day-shell/src/mirror.rs` reads the same DB set.
//!
//! It deliberately does NOT adopt `life`'s single `DATABASE_URL`, which is the
//! house shape elsewhere: adopting it would mean changing the Deployment and
//! the CronJobs in the same change that introduces a new binary, so a failure
//! could be either. The URL is composed here instead, from the parts the
//! cluster already supplies.
//!
//! # Every required variable is REFUSED when absent, never defaulted
//!
//! This is the whole value of the layer and the one thing it must not get
//! wrong. A config that defaults a missing password to `""` starts a process
//! that fails later, at a connection, with an error about credentials rather
//! than about configuration — and in a CronJob nobody is watching. So the
//! required set errors by NAME, and the optional set is `Option`, and there is
//! no third category that silently becomes an empty string.

use anyhow::{Context, Result};

/// What the sync job needs. Mirrors `loadSyncConfig` in `src/config.ts` — the
/// entrypoint this replaces first — rather than the fuller `loadConfig` the
/// HTTP server uses. The server's own fields (session secret, service tokens,
/// allowed Owntracks tokens) arrive with the server, not before it.
#[derive(Clone, Debug)]
pub struct Config {
    pub db: DbConfig,
    pub fitbit: FitbitConfig,
    /// Base URL of the Nextcloud instance, no trailing slash.
    ///
    /// OPTIONAL, and the option is load-bearing rather than lenience: the TS
    /// `loadSyncConfig` types this `.nullable()` and passes `null` when
    /// `NC_BASE_URL` is unset, which is how a sync run with no PhoneTrack
    /// source is spelled. Defaulting it to the production URL would make an
    /// unconfigured job quietly reach for the real Nextcloud.
    pub nextcloud_base_url: Option<String>,
    /// The HMAC key behind every session cookie.
    ///
    /// ⚠ OPTIONAL HERE, REQUIRED BY THE SERVER. `sync` has no cookies and must
    /// keep starting without one — a CronJob that refuses to run because the
    /// web tier's secret is absent is an outage caused by an unrelated
    /// dependency. `serve` demands it at startup instead, so the failure lands
    /// on the process that actually needs it.
    ///
    /// ⚠ NO DEFAULT, ever. A defaulted signing key is a key everyone knows, and
    /// the failure is silent: cookies verify, sessions work, and anyone can mint
    /// one. The TypeScript enforces `min(16)` on it; that check moves here when
    /// the server does.
    pub session_secret: Option<String>,
}

#[derive(Clone, Debug)]
pub struct DbConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub database: String,
}

#[derive(Clone, Debug)]
pub struct FitbitConfig {
    pub client_id: String,
    pub client_secret: String,
}

impl DbConfig {
    /// A `mysql://` URL for sqlx.
    ///
    /// ⚠ Percent-encodes the password. A MariaDB password is an arbitrary byte
    /// string and the ones in this cluster are generated, so `@`, `/`, `?` and
    /// `#` all occur — every one of which terminates a URL component early and
    /// would silently produce a DIFFERENT host, database or credential rather
    /// than a parse error. `mirror.rs` sidesteps this by using
    /// `MySqlConnectOptions` and never composing a URL; this composes one
    /// because the pool is built from a URL, so it has to encode.
    pub fn url(&self) -> String {
        format!(
            "mysql://{}:{}@{}:{}/{}",
            encode(&self.user),
            encode(&self.password),
            self.host,
            self.port,
            self.database
        )
    }
}

/// Percent-encode everything outside the RFC 3986 unreserved set.
///
/// Deliberately conservative — encoding a character that did not need it is
/// harmless, and the set of characters that DO need it in a userinfo component
/// is easy to get subtly wrong in the permissive direction.
fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// A required variable: absent is an error naming it.
fn required(key: &str) -> Result<String> {
    std::env::var(key).with_context(|| format!("missing required env var {key}"))
}

/// An optional variable with a default.
///
/// ⚠ An EMPTY value is treated as absent. `DB_HOST=""` in a manifest is a
/// mistake rather than a request for an empty hostname, and sqlx would take it
/// and fail at connect time with a message about the network.
fn with_default(key: &str, default: &str) -> String {
    match std::env::var(key) {
        Ok(v) if !v.is_empty() => v,
        _ => default.to_string(),
    }
}

/// An optional variable with no default. Empty reads as absent, as above.
fn optional(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(v) if !v.is_empty() => Some(v),
        _ => None,
    }
}

impl Config {
    /// Read the environment. Fails with the name of the first missing variable.
    /// A config with no environment behind it, for tests that need the SHAPE
    /// rather than the values.
    ///
    /// ⚠ Every credential is empty and the database points nowhere. That is the
    /// point: a test using this cannot accidentally reach a real service, and a
    /// test that needs one has to say so by building its own.
    #[doc(hidden)]
    pub fn for_test() -> Self {
        Config {
            db: DbConfig {
                host: "127.0.0.1".into(),
                port: 1,
                user: String::new(),
                password: String::new(),
                database: "nowhere".into(),
            },
            fitbit: FitbitConfig {
                client_id: String::new(),
                client_secret: String::new(),
            },
            nextcloud_base_url: None,
            session_secret: None,
        }
    }

    pub fn from_env() -> Result<Self> {
        let port_raw = with_default("DB_PORT", "3306");
        // ⚠ PARSED, not `unwrap_or(3306)`. `mirror.rs` falls back to the
        // default on an unparseable value, which is right for an optional
        // read-only mirror that may not be configured at all; it is wrong here.
        // `DB_PORT=3306 ` or `DB_PORT=three` would silently connect somewhere
        // other than where the manifest says, and the manifest would keep
        // claiming otherwise.
        let port: u16 = port_raw
            .parse()
            .with_context(|| format!("DB_PORT is not a port number: {port_raw:?}"))?;

        Ok(Config {
            db: DbConfig {
                host: with_default("DB_HOST", "health-db"),
                port,
                user: required("DB_USER")?,
                password: required("DB_PASSWORD")?,
                database: with_default("DB_NAME", "health"),
            },
            fitbit: FitbitConfig {
                client_id: required("FITBIT_CLIENT_ID")?,
                client_secret: required("FITBIT_CLIENT_SECRET")?,
            },
            nextcloud_base_url: optional("NC_BASE_URL"),
            session_secret: optional("SESSION_SECRET"),
        })
    }
}

//! Runtime configuration from the environment the k8s manifests set: `DB_HOST`,
//! `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` (composed into a URL here,
//! rather than `life`'s single `DATABASE_URL`, so the manifests stay as they are).
//!
//! Every required variable is refused by name when absent, never defaulted: a
//! password defaulted to `""` fails later, at a connection, with an error about
//! credentials, in a CronJob nobody watches. Optional settings are `Option`.

use anyhow::{Context, Result};

/// The backend's settings, read once from the environment.
#[derive(Clone, Debug)]
pub struct Config {
    pub db: DbConfig,
    /// Base URL of the Nextcloud instance, no trailing slash. Optional on
    /// purpose: unset `NC_BASE_URL` is a sync run with no PhoneTrack source, and a
    /// default would make an unconfigured job reach for the real Nextcloud.
    pub nextcloud_base_url: Option<String>,
    /// Shared secrets for `/internal/*`, consumed by the coach app.
    ///
    /// ⚠ empty disables the internal API entirely, and that is the default. A
    /// list that fell back to "allow" when unset would expose another user's
    /// mined places to anyone who could reach the port.
    pub service_tokens: Vec<String>,
    /// PhoneTrack session tokens the owntracks proxy will forward; unset forwards
    /// nothing. Rejecting before upstream protects Nextcloud's brute-force
    /// counters and this process's state maps.
    pub owntracks_tokens: Vec<String>,
    /// Where the dashboard is served from, for share URLs. Defaulted, since the
    /// serving pod does not set `PUBLIC_BASE_URL` and every share link uses it.
    pub public_base_url: String,
    /// The HMAC key behind every session cookie. Optional here (the `sync`
    /// CronJob has no cookies and must start without it); `serve` demands it.
    ///
    /// ⚠ No default, ever. A defaulted signing key is a key everyone knows, and
    /// the failure is silent: cookies verify, sessions work, and anyone can mint
    /// one.
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

/// The Nextcloud base URL the focus cron uses: the default host, set or not.
/// `Config::nextcloud_base_url` is `None` in production, so reading it here
/// would fetch nothing and look like a user with no location history.
pub fn focus_nc_base_url() -> String {
    std::env::var("NC_BASE_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| FOCUS_DEFAULT_NC_BASE_URL.to_string())
}

/// The focus cron's default Nextcloud host.
pub const FOCUS_DEFAULT_NC_BASE_URL: &str = "https://dash.xinutec.org";

impl DbConfig {
    /// The database settings alone, for a command touching nothing else: a
    /// command demanding a setting it never uses fails on an unrelated deployment
    /// detail, possibly after its work is done.
    pub fn from_env() -> Result<Self> {
        let port_raw = with_default("DB_PORT", "3306");
        // Parsed, not `unwrap_or(3306)`: `DB_PORT=three` must not silently
        // connect somewhere other than the manifest says.
        let port: u16 = port_raw
            .parse()
            .with_context(|| format!("DB_PORT is not a port number: {port_raw:?}"))?;
        Ok(DbConfig {
            host: with_default("DB_HOST", "health-db"),
            port,
            user: required("DB_USER")?,
            password: required("DB_PASSWORD")?,
            database: with_default("DB_NAME", "health"),
        })
    }

    /// A `mysql://` URL for sqlx, with the password percent-encoded: generated
    /// passwords contain `@`, `/`, `?` and `#`, each of which would silently
    /// change the host, database or credential rather than fail to parse.
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

/// Percent-encode everything outside the RFC 3986 unreserved set: encoding too
/// much is harmless, too little silently wrong.
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

/// An optional variable with a default; an empty value counts as absent
/// (`DB_HOST=""` is a manifest mistake, not a hostname).
fn with_default(key: &str, default: &str) -> String {
    match std::env::var(key) {
        Ok(v) if !v.is_empty() => v,
        _ => default.to_string(),
    }
}

/// A comma-separated secret list; absent or empty is no tokens ("this surface
/// is off"). Blank entries are dropped, or a stray comma would allow an empty
/// token.
fn token_list(key: &str) -> Vec<String> {
    std::env::var(key)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

/// An optional variable with no default. Empty reads as absent, as above.
fn optional(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(v) if !v.is_empty() => Some(v),
        _ => None,
    }
}

impl Config {
    /// A config with no environment behind it, for tests needing the shape: every
    /// credential is empty and the database points nowhere, so a test cannot
    /// reach a real service by accident.
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
            nextcloud_base_url: None,
            service_tokens: Vec::new(),
            owntracks_tokens: Vec::new(),
            public_base_url: "https://health.xinutec.org".to_string(),
            session_secret: None,
        }
    }

    /// Read every setting from the environment. Every command reads this one:
    /// a credential only one path used is not here, so a CronJob that sets
    /// `DB_*` and `NC_*` alone builds the same `Config` the server does.
    pub fn from_env() -> Result<Self> {
        Ok(Config {
            db: DbConfig::from_env()?,
            nextcloud_base_url: optional("NC_BASE_URL"),
            service_tokens: token_list("SERVICE_TOKEN"),
            owntracks_tokens: token_list("OWNTRACKS_ALLOWED_TOKENS"),
            public_base_url: with_default("PUBLIC_BASE_URL", "https://health.xinutec.org"),
            session_secret: optional("SESSION_SECRET"),
        })
    }
}

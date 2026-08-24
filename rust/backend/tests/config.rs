//! The config layer REFUSES rather than defaults (#982).
//!
//! This is the whole value of the layer, and the failure it guards against is
//! silent by construction. A config that turns a missing `DB_PASSWORD` into
//! `""` starts a process that dies later at a connection, reporting a
//! credential problem rather than a configuration one — inside a CronJob where
//! nobody is watching the stderr.
//!
//! ⚠ ONE `#[test]` FUNCTION, DELIBERATELY, and it is not laziness.
//! `std::env::set_var` mutates process-global state, and Rust runs a test
//! binary's tests on MANY THREADS by default. Cargo gives each file under
//! `tests/` its own binary but does not serialise the tests inside one, so two
//! `#[test]`s arranging different environments would race — and the resulting
//! flake would look like a config bug rather than a test bug. Splitting these
//! needs `--test-threads=1`, which is a flag a future runner can drop without
//! anything failing until it flakes.
//!
//! So: one function, sections in order, each asserting with a message naming
//! the case. `clear_all` runs before each section so none of them can pass on a
//! leftover from the one above.

use backend::config::Config;

/// # Safety
/// Called only from the single `#[test]` below, which nothing runs alongside.
unsafe fn set_all() {
    unsafe {
        std::env::set_var("DB_HOST", "db.example");
        std::env::set_var("DB_PORT", "3307");
        std::env::set_var("DB_USER", "syncer");
        std::env::set_var("DB_PASSWORD", "pw");
        std::env::set_var("DB_NAME", "healthdb");
        std::env::set_var("FITBIT_CLIENT_ID", "cid");
        std::env::set_var("FITBIT_CLIENT_SECRET", "csecret");
    }
}

/// # Safety
/// As `set_all`.
unsafe fn clear_all() {
    unsafe {
        for k in [
            "DB_HOST",
            "DB_PORT",
            "DB_USER",
            "DB_PASSWORD",
            "DB_NAME",
            "FITBIT_CLIENT_ID",
            "FITBIT_CLIENT_SECRET",
            "NC_BASE_URL",
        ] {
            std::env::remove_var(k);
        }
    }
}

/// Arrange the full valid environment from scratch.
///
/// # Safety
/// As `set_all`.
unsafe fn fresh() {
    unsafe {
        clear_all();
        set_all();
    }
}

#[test]
fn the_config_layer_refuses_rather_than_defaults() {
    // ---- a complete environment parses -------------------------------------
    unsafe { fresh() };
    let c = Config::from_env().expect("a complete environment must parse");
    assert_eq!(c.db.host, "db.example");
    assert_eq!(c.db.port, 3307);
    assert_eq!(c.db.user, "syncer");
    assert_eq!(c.db.database, "healthdb");
    assert_eq!(c.fitbit.client_id, "cid");
    assert_eq!(c.fitbit.client_secret, "csecret");
    assert_eq!(
        c.nextcloud_base_url, None,
        "NC_BASE_URL is optional and unset here"
    );

    // ---- the optional set has defaults -------------------------------------
    unsafe { fresh() };
    unsafe {
        std::env::remove_var("DB_HOST");
        std::env::remove_var("DB_PORT");
        std::env::remove_var("DB_NAME");
    }
    let c = Config::from_env().expect("the optional set has defaults");
    assert_eq!(c.db.host, "health-db", "DB_HOST default");
    assert_eq!(c.db.port, 3306, "DB_PORT default");
    assert_eq!(c.db.database, "health", "DB_NAME default");

    // ---- ⚠ THE POINT OF THE FILE -------------------------------------------
    // Each required variable, when absent, is an error that NAMES it. Not a
    // default, and not a generic failure an operator has to guess at.
    for key in [
        "DB_USER",
        "DB_PASSWORD",
        "FITBIT_CLIENT_ID",
        "FITBIT_CLIENT_SECRET",
    ] {
        unsafe { fresh() };
        unsafe { std::env::remove_var(key) };
        match Config::from_env() {
            Ok(_) => panic!("{key} is required, but from_env succeeded without it"),
            Err(e) => {
                let msg = format!("{e:#}");
                assert!(
                    msg.contains(key),
                    "the error for a missing {key} must NAME it, so an operator reading \
                     a CronJob log knows which variable to set. Got: {msg}"
                );
            }
        }
    }

    // ---- an empty value is a mistake, not a request ------------------------
    // sqlx would accept `DB_HOST=""` and fail later with a message about the
    // network rather than about the manifest.
    unsafe { fresh() };
    unsafe {
        std::env::set_var("DB_HOST", "");
        std::env::set_var("NC_BASE_URL", "");
    }
    let c = Config::from_env().expect("empty optionals fall back to their defaults");
    assert_eq!(c.db.host, "health-db", "empty DB_HOST reads as absent");
    assert_eq!(
        c.nextcloud_base_url, None,
        "empty NC_BASE_URL reads as absent"
    );

    // ---- ⚠ an unparseable port is an ERROR, not the default ----------------
    // `mirror.rs` falls back here and is right to — it is an optional read-only
    // mirror. This is the primary database: `DB_PORT=three` must not silently
    // connect to 3306 while the manifest claims otherwise.
    unsafe { fresh() };
    unsafe { std::env::set_var("DB_PORT", "three") };
    match Config::from_env() {
        Ok(c) => panic!(
            "a non-numeric DB_PORT must be refused, got port {}",
            c.db.port
        ),
        Err(e) => {
            let msg = format!("{e:#}");
            assert!(
                msg.contains("DB_PORT"),
                "the error must name DB_PORT: {msg}"
            );
        }
    }

    // ---- ⚠ credentials cannot move the host --------------------------------
    // A generated password contains `@`, `/`, `?` or `#` often enough that this
    // is not hypothetical, and each of them terminates a URL component early.
    // Unencoded, `p@ss` would compose a URL pointing at a DIFFERENT HOST — a
    // connection somewhere else, not a parse error.
    unsafe { fresh() };
    unsafe {
        std::env::set_var("DB_USER", "user@name");
        std::env::set_var("DB_PASSWORD", "p@ss/w?rd#1");
    }
    let url = Config::from_env().unwrap().db.url();
    assert_eq!(
        url, "mysql://user%40name:p%40ss%2Fw%3Frd%231@db.example:3307/healthdb",
        "credentials must be percent-encoded"
    );
    assert!(
        url.ends_with("@db.example:3307/healthdb"),
        "credentials must not be able to move the host: {url}"
    );

    // ---- an explicit Nextcloud URL survives --------------------------------
    unsafe { fresh() };
    unsafe { std::env::set_var("NC_BASE_URL", "https://dash.example") };
    let c = Config::from_env().unwrap();
    assert_eq!(
        c.nextcloud_base_url.as_deref(),
        Some("https://dash.example")
    );

    // ---- a DB-only command must not require the Fitbit credentials ---------
    //
    // ⚠ The batch CronJobs set DB_* and nothing else. `refresh-presence-log`
    // used `Config::from_env`, which requires FITBIT_CLIENT_ID, and died in
    // production with "missing required env var FITBIT_CLIENT_ID" — AFTER
    // `decode-day` had spent twelve minutes decoding seven days, because the
    // config was read at the start of the step rather than the start of the job
    // (#982 Tier 2, 2026-08-24).
    //
    // A command should ask for what it USES. This pins that `DbConfig::from_env`
    // does, so the next DB-only subcommand cannot quietly reintroduce the
    // requirement.
    unsafe { clear_all() };
    unsafe {
        std::env::set_var("DB_USER", "syncer");
        std::env::set_var("DB_PASSWORD", "s3cret");
    }
    let d = backend::config::DbConfig::from_env()
        .expect("a database-only command must not need the Fitbit credentials");
    assert_eq!(d.user, "syncer", "DB_USER");
    assert_eq!(d.host, "health-db", "DB_HOST defaults");
    assert_eq!(d.port, 3306, "DB_PORT defaults");
    assert_eq!(d.database, "health", "DB_NAME defaults");
    // And the full config, with the same environment, must still REFUSE — the
    // point is that the two ask for different things, not that either is lax.
    assert!(
        Config::from_env().is_err(),
        "the full config must still require the Fitbit credentials"
    );

    // ---- the FOCUS cron's env is DB_* + NC_*, and that must be enough ------
    //
    // ⚠ THIS IS THE SECOND TIME. `refresh-presence-log` died on
    // FITBIT_CLIENT_ID (above); on 2026-08-24 `refresh-focus-places` did the
    // same thing in production, because it was written to call
    // `Config::from_env` on the reasoning that it "needs Nextcloud too". It
    // does not: the NC credentials come from the DATABASE, and the only extra
    // it wants is a base URL.
    //
    // The test above could not catch that — it pins the config LAYER, not which
    // config a subcommand reaches for. This pins the focus cron's actual
    // requirement: its pod sets DB_* and NC_CLIENT_ID/NC_CLIENT_SECRET, no
    // FITBIT_* and no NC_BASE_URL, and everything the command reads at startup
    // must resolve under exactly that.
    unsafe { clear_all() };
    unsafe {
        std::env::set_var("DB_USER", "syncer");
        std::env::set_var("DB_PASSWORD", "s3cret");
        std::env::set_var("NC_CLIENT_ID", "ncid");
        std::env::set_var("NC_CLIENT_SECRET", "ncsecret");
    }
    backend::config::DbConfig::from_env()
        .expect("the focus cron's env must satisfy the config it actually uses");
    // ⚠ NC_BASE_URL is UNSET in production (#1037). The focus cron must still
    // reach the real Nextcloud, because its TypeScript defaults rather than
    // nullifying. A `None` here would mean fetching nothing and reporting
    // success.
    assert_eq!(
        backend::config::focus_nc_base_url(),
        backend::config::FOCUS_DEFAULT_NC_BASE_URL,
        "with NC_BASE_URL unset the focus cron must fall back to its own default"
    );
    unsafe { std::env::set_var("NC_BASE_URL", "https://nc.example") };
    assert_eq!(
        backend::config::focus_nc_base_url(),
        "https://nc.example",
        "an explicit NC_BASE_URL still wins"
    );
    // An EMPTY value is the same silence as absent — a k8s env var set from a
    // missing secret key arrives as "".
    unsafe { std::env::set_var("NC_BASE_URL", "") };
    assert_eq!(
        backend::config::focus_nc_base_url(),
        backend::config::FOCUS_DEFAULT_NC_BASE_URL,
        "an empty NC_BASE_URL is absence, not a value"
    );

    // ---- but a DB-only command still refuses a missing password ------------
    unsafe { clear_all() };
    unsafe { std::env::set_var("DB_USER", "syncer") };
    assert!(
        backend::config::DbConfig::from_env().is_err(),
        "DB_PASSWORD is required, not defaulted to empty"
    );

    unsafe { clear_all() };
}

//! `backend sync` without Fitbit (#260).
//!
//! The Fitbit Web API ends 2026-10-30. The Google streams must not depend on
//! it: until 2026-10-01 the run listed users from the Fitbit `tokens` table
//! FIRST and returned early when it was empty, Google included.

use backend::fitbit::run::{Passes, run};
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};

/// A pool nothing answers: lazy, so the first QUERY is what fails.
fn dead_pool() -> sqlx::MySqlPool {
    MySqlPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_millis(200))
        .connect_lazy_with(
            MySqlConnectOptions::new()
                .host("127.0.0.1")
                .port(1)
                .database("nowhere"),
        )
}

/// With no Fitbit credentials the run never asks for Fitbit users, so a dead
/// database cannot fail it there. Before the fix this query came first and
/// failed ("listing users with Fitbit tokens").
#[tokio::test]
async fn without_fitbit_credentials_the_run_never_reads_the_fitbit_tokens() {
    let lookup = |_: f64, _: f64| None;
    let r = run(
        &dead_pool(),
        &reqwest::Client::new(),
        None,
        None,
        &lookup,
        Passes::Forward,
    )
    .await;
    assert!(r.is_ok(), "{r:?}");
}

/// The control: WITH credentials the same dead database does fail the run, at
/// the Fitbit user list — so the test above passes because the query was
/// skipped, not because nothing could fail.
#[tokio::test]
async fn with_fitbit_credentials_the_run_reads_the_fitbit_tokens() {
    let lookup = |_: f64, _: f64| None;
    let fb = backend::config::FitbitConfig {
        client_id: "id".into(),
        client_secret: "secret".into(),
    };
    let r = run(
        &dead_pool(),
        &reqwest::Client::new(),
        Some(&fb),
        None,
        &lookup,
        Passes::Forward,
    )
    .await;
    let e = format!(
        "{:#}",
        r.expect_err("the dead database must fail the Fitbit user list")
    );
    assert!(e.contains("listing users with Fitbit tokens"), "{e}");
}

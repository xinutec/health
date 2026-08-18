//! The backfill WALK, driven end to end against a fake store (#982).
//!
//! `tests/backfill.rs` covers the streak fold. That is not the same thing, and
//! the difference is not academic: the fold was correct as a function and WRONG
//! where the loop applied it, because the loop collapsed three outcomes into
//! two. Every test passed. Only a test that runs the loop itself can see that.
//!
//! So these assert the TRACE — every `sync_state` write, in order — rather than
//! the final state. A walk that ends in the right place having taken the wrong
//! path is indistinguishable from a correct one if you only compare the last
//! row, and "completed the stream two days early" is exactly that shape.
//!
//! ⚠ ONE `#[tokio::test]`, DELIBERATELY, for the reason `tests/lean_ffi.rs`
//! gives: the walk asks Lean for every step, and `lean::init()` starts a
//! runtime that several tests racing on it would flake over. The scenarios run
//! in sequence below.

use std::sync::Mutex;

use backend::backfill::DayResult;
use backend::fitbit::backfill_runner::{DayStream, run_intraday_backfill};
use backend::fitbit::client::RateLimitState;
use backend::lean;
use backend::sync_state::MemoryStore;

/// A fetcher that answers from a script and records what it was asked.
struct Script {
    answers: Mutex<Vec<DayResult>>,
    asked: Mutex<Vec<String>>,
}

impl Script {
    fn new(answers: Vec<DayResult>) -> Self {
        Self {
            answers: Mutex::new(answers),
            asked: Mutex::new(Vec::new()),
        }
    }
    fn take(&self, date: &str) -> DayResult {
        self.asked.lock().unwrap().push(date.to_string());
        let mut a = self.answers.lock().unwrap();
        if a.is_empty() {
            DayResult::Ok { points: 0 }
        } else {
            a.remove(0)
        }
    }
}

fn stream<'a>(script: &'a Script, max_empty: i64) -> DayStream<'a> {
    DayStream {
        name: "hr_intraday".to_string(),
        max_empty_days: max_empty,
        fetch: Box::new(move |date: String| Box::pin(async move { Ok(script.take(&date)) })),
        skip_if: None,
    }
}

async fn walk(store: &MemoryStore, script: &Script, budget: i64, max_empty: i64) {
    let rate = RateLimitState::with_budget(budget);
    run_intraday_backfill(&rate, store, "u", &stream(script, max_empty), "2026-01-01")
        .await
        .expect("the walk itself must not error");
}

/// ⚠ THE REGRESSION, AT LOOP LEVEL. Thirteen empty days, then a day that
/// FAILS, then one more empty day.
///
/// Correct: the failure says nothing, so the fourteenth empty day is the
/// fourteenth, and the stream completes on it. The collapsed version reset the
/// streak to zero at the failure and would walk on past it — completing far
/// later, or never on a stream that fails periodically.
async fn a_failure_between_empty_days_does_not_restart_the_count() {
    let store = MemoryStore::with(&[("backfill_hr_intraday_cursor", "2026-01-01")]);
    let mut answers: Vec<DayResult> = (0..13).map(|_| DayResult::Ok { points: 0 }).collect();
    answers.push(DayResult::Failed);
    answers.push(DayResult::Ok { points: 0 });
    let script = Script::new(answers);

    walk(&store, &script, 150, 14).await;

    let trace = store.trace();
    let completes: Vec<_> = trace
        .iter()
        .filter(|(k, _)| k.ends_with("_complete"))
        .collect();
    assert_eq!(
        completes,
        vec![&(
            "backfill_hr_intraday_complete".to_string(),
            "true".to_string()
        )],
        "the stream completes exactly once"
    );

    // 15 days were fetched: 13 empty, 1 failed, 1 empty. The failed one is the
    // 14th fetch but NOT the 14th empty, which is the whole point.
    assert_eq!(script.asked.lock().unwrap().len(), 15);
    assert_eq!(
        store.value("backfill_hr_intraday_cursor").unwrap(),
        "2025-12-17"
    );
}

/// Data resets the streak, and the walk keeps going.
async fn a_day_with_data_clears_the_streak() {
    let store = MemoryStore::with(&[("backfill_hr_intraday_cursor", "2026-01-01")]);
    let mut answers: Vec<DayResult> = (0..3).map(|_| DayResult::Ok { points: 0 }).collect();
    answers.push(DayResult::Ok { points: 42 });
    let script = Script::new(answers);

    walk(&store, &script, 150, 4).await;

    // 3 empty, then data (streak -> 0), then 4 more empty from the default
    // answer: 8 fetches before the streak reaches 4.
    assert_eq!(script.asked.lock().unwrap().len(), 8);
    assert_eq!(
        store.value("backfill_hr_intraday_complete").unwrap(),
        "true"
    );
}

/// ⚠ A SPENT BUDGET WRITES NOTHING DURABLE. `pause` must leave the cursor where
/// it is and must NOT mark the stream complete — a stream that stops because
/// this run ran out of calls has said nothing about its history.
async fn a_spent_budget_pauses_without_completing() {
    let store = MemoryStore::with(&[("backfill_hr_intraday_cursor", "2026-01-01")]);
    let script = Script::new(vec![]);

    walk(&store, &script, 15, 14).await;

    assert!(script.asked.lock().unwrap().is_empty(), "no day is fetched");
    assert!(store.trace().is_empty(), "and nothing at all is written");
    assert_eq!(store.value("backfill_hr_intraday_complete"), None);
}

/// A stream already marked complete is not walked, and writes nothing.
async fn a_complete_stream_is_left_alone() {
    let store = MemoryStore::with(&[
        ("backfill_hr_intraday_cursor", "2023-04-01"),
        ("backfill_hr_intraday_complete", "true"),
    ]);
    let script = Script::new(vec![]);

    walk(&store, &script, 150, 14).await;

    assert!(script.asked.lock().unwrap().is_empty());
    assert!(store.trace().is_empty());
}

/// ⚠ THE FOSSIL CURSOR, WHICH PRODUCTION ACTUALLY HOLDS (#1043). A cursor that
/// does not name a day stops the stream rather than being walked from — the
/// guard against compounding a bad value into a worse one.
async fn a_cursor_that_is_not_a_date_stops_the_stream() {
    let store = MemoryStore::with(&[("backfill_hr_intraday_cursor", "-000031-08")]);
    let script = Script::new(vec![]);

    walk(&store, &script, 150, 14).await;

    assert!(
        script.asked.lock().unwrap().is_empty(),
        "nothing is fetched from a bad cursor"
    );
    assert_eq!(
        store.trace(),
        vec![(
            "backfill_hr_intraday_complete".to_string(),
            "true".to_string()
        )],
        "it completes, and the cursor is left as evidence rather than overwritten"
    );
}

/// The walk stops at the floor, and says so.
async fn reaching_the_floor_completes_the_stream() {
    let store = MemoryStore::with(&[("backfill_hr_intraday_cursor", "2010-01-03")]);
    let script = Script::new(vec![DayResult::Ok { points: 5 }]);

    walk(&store, &script, 150, 14).await;

    // 2010-01-02 is fetchable; the day before it is the floor, so the walk ends.
    assert_eq!(
        *script.asked.lock().unwrap(),
        vec!["2010-01-02".to_string()]
    );
    assert_eq!(
        store.trace(),
        vec![
            (
                "backfill_hr_intraday_cursor".to_string(),
                "2010-01-02".to_string()
            ),
            (
                "backfill_hr_intraday_complete".to_string(),
                "true".to_string()
            ),
        ]
    );
}

#[tokio::test]
async fn the_walk() {
    lean::init().expect("the Lean runtime must start");
    a_failure_between_empty_days_does_not_restart_the_count().await;
    a_day_with_data_clears_the_streak().await;
    a_spent_budget_pauses_without_completing().await;
    a_complete_stream_is_left_alone().await;
    a_cursor_that_is_not_a_date_stops_the_stream().await;
    reaching_the_floor_completes_the_stream().await;
}

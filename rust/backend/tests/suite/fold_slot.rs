//! The fold slot: one day folds at a time per process (#1071).

use backend::routes::velocity::{fold_slot, fold_slot_free};

/// The slot is the process's, and other tests fold days: "free" is only
/// observable while this test holds it, and its return by taking it again.
#[tokio::test]
async fn there_is_exactly_one_fold_slot() {
    let held = fold_slot().await;
    assert!(!fold_slot_free(), "a fold in flight takes the only slot");
    drop(held);
    let again = tokio::time::timeout(std::time::Duration::from_secs(60), fold_slot())
        .await
        .expect("the slot returns when the fold ends");
    drop(again);
}

#[tokio::test]
async fn a_second_fold_waits_for_the_first() {
    let first = fold_slot().await;
    let second = tokio::spawn(async { drop(fold_slot().await) });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(
        !second.is_finished(),
        "the second fold is still queued behind the first"
    );
    drop(first);
    tokio::time::timeout(std::time::Duration::from_secs(5), second)
        .await
        .expect("the queued fold ran once the slot freed")
        .expect("the queued fold did not panic");
}

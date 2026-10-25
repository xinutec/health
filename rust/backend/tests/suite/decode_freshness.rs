//! `decode_freshness`: the horizon a day's inputs reach, and the queue key.
use backend::decode_freshness::{horizon, parse_key, queue_key};

#[test]
fn the_horizon_is_the_laggard() {
    // Today: the watch synced an hour ago, so the steps stop there.
    assert_eq!(horizon(10_000, Some(5_000), 6_000), 5_000);
    // A past day the watch has synced beyond: its end.
    assert_eq!(horizon(10_000, Some(20_000), 30_000), 10_000);
    // No sync on record: the fixes, complete to now.
    assert_eq!(horizon(10_000, None, 6_000), 6_000);
}

#[test]
fn a_key_round_trips() {
    assert_eq!(
        parse_key(&queue_key("u", "2026-10-25")),
        Some(("u".into(), "2026-10-25".into()))
    );
    assert_eq!(parse_key("no-separator"), None);
}

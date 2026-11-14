//! `lean::focus_places`, the `focus` mode as the weekly focus-places cron calls
//! it (`refresh_focus_places_one`); the decode lives in `lean.rs` so this test
//! reaches it.
//!
//! Synthetic points: no tracked test carries real places, and a cluster built
//! at a chosen spot with a chosen dwell has a known expected outcome. One
//! `#[test]`: `lean::init()` starts a runtime that parallel tests would race on.

/// A day of dwell at one invented spot: `n` fixes a minute apart, jittered by
/// about a metre so it is a cluster rather than a repeated identical point.
fn dwell(start_ts: i64, lat: f64, lon: f64, n: i64) -> Vec<(i64, f64, f64, Option<f64>)> {
    (0..n)
        .map(|i| {
            let j = f64::from(i32::try_from(i % 5).unwrap_or(0)) * 0.000_01;
            (start_ts + i * 60, lat + j, lon - j, Some(8.0))
        })
        .collect()
}

#[test]
fn focus_places_mines_a_dwell_and_keeps_its_reply_self_consistent() {
    backend::lean::init().expect("the Lean runtime must start");

    // Two well-separated invented spots, ~11 km apart, each sat at for four
    // hours on two different days. Separated so nothing here depends on the
    // clustering radius, which is not what this test is pinning.
    let day = 86_400;
    let mut points = Vec::new();
    for d in 0..2 {
        points.extend(dwell(1_000_000 + d * day, 0.0, 0.0, 240));
        points.extend(dwell(1_000_000 + d * day + 40_000, 0.1, 0.1, 240));
    }

    let mined = backend::lean::focus_places(&points, &[], &[])
        .expect("a well-formed point history must not error");

    assert!(
        !mined.mined.is_empty(),
        "two spots sat at for four hours on two days must mine at least one place"
    );

    // One assignment per mined cluster, or the cron pairs a cluster with the
    // wrong row. `focus_places` already bails otherwise; restated for readers.
    assert_eq!(
        mined.assignments.len(),
        mined.mined.len(),
        "one identity assignment per mined cluster"
    );

    // Nothing existed before, so nothing can be a continuation of it and
    // nothing can have gone away. This is what makes the run above a cold mine
    // rather than a re-mine, and it is the arm the cron takes on a new user.
    assert!(
        mined.assignments.iter().all(Option::is_none),
        "with no `old` rows there is nothing to continue: {:?}",
        mined.assignments
    );
    assert!(
        mined.deleted.is_empty(),
        "with no `old` rows there is nothing to delete: {:?}",
        mined.deleted
    );

    // Every mined cluster carries the geometry the caller reads off it. The
    // caller does `.context("cluster has no lat")?` on exactly these, so a
    // reply without them is a crash in the cron rather than a bad name.
    for c in &mined.mined {
        for field in ["lat", "lon"] {
            let v = c
                .get(field)
                .unwrap_or_else(|| panic!("cluster has no {field}: {c}"));
            let bits = v
                .as_str()
                .unwrap_or_else(|| panic!("{field} crosses as a bit-pattern STRING, got {v}"));
            bits.parse::<u64>()
                .unwrap_or_else(|e| panic!("{field} is not a bit pattern: {bits:?} ({e})"));
        }
    }

    // ── The empty history is a well-defined mining of nothing, not an error ──
    // The cron reaches this on a user with no points yet, and an `Err` there
    // would fail the whole weekly run rather than skip one account.
    let empty = backend::lean::focus_places(&[], &[], &[])
        .expect("an empty history is a normal answer, never an error");
    assert!(empty.mined.is_empty(), "nothing in, nothing mined");
    assert!(empty.assignments.is_empty());
    assert!(empty.deleted.is_empty());
}

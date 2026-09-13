//! `/api/status` parsing — the slot protocol Overpass publishes and this
//! codebase ignored until #1153.
//!
//! ⚠ THE BODIES HERE ARE REAL. The first is what `overpass-api.de` returned to
//! isis on 2026-09-13 at 10:21:15Z, pasted unedited apart from the client id.
//! The exhausted shapes are the documented ones. A hand-invented status page
//! would test the parser against this file's author rather than against the
//! server — and the whole defect was a belief about the server that nobody had
//! read back.

use backend::overpass::{Slots, parse_status};

/// The healthy case, verbatim.
#[test]
fn two_slots_free_is_no_wait() {
    let body = "Connected as: 3712168559\n\
                Current time: 2026-09-13T10:21:15Z\n\
                Announced endpoint: lambert.openstreetmap.de/\n\
                Rate limit: 2\n\
                2 slots available now.\n\
                Currently running queries (pid, space limit, time limit, start time):\n";
    assert_eq!(
        parse_status(body),
        Some(Slots {
            limit: 2,
            available: 2,
            next_in_s: None
        })
    );
}

/// ⚠ THE REASON THE LIMIT IS CARRIED AT ALL. Two is the number the refresh was
/// violating eighteen times a night; a parser that dropped it would leave the
/// operator's log unable to say what the ceiling was.
#[test]
fn the_rate_limit_is_read_not_assumed() {
    let body = "Rate limit: 6\n6 slots available now.\n";
    assert_eq!(parse_status(body).unwrap().limit, 6);
}

/// Exhausted: no count line, one or more announced release times.
#[test]
fn no_slots_waits_for_the_soonest() {
    let body = "Connected as: 3712168559\n\
                Current time: 2026-09-13T10:21:15Z\n\
                Rate limit: 2\n\
                Slot available after: 2026-09-13T10:25:00Z, in 42 seconds.\n\
                Slot available after: 2026-09-13T10:26:00Z, in 102 seconds.\n";
    assert_eq!(
        parse_status(body),
        Some(Slots {
            limit: 2,
            available: 0,
            next_in_s: Some(42)
        })
    );
}

/// ⚠ `0 slots available now.` CAN APPEAR ALONGSIDE the release lines, and the
/// zero must not read as "no information".
#[test]
fn an_explicit_zero_still_takes_the_wait() {
    let body = "Rate limit: 2\n\
                0 slots available now.\n\
                Slot available after: 2026-09-13T10:25:00Z, in 7 seconds.\n";
    let s = parse_status(body).unwrap();
    assert_eq!(s.available, 0);
    assert_eq!(s.next_in_s, Some(7));
}

/// Singular, because one free slot is spelled without the `s`.
#[test]
fn one_slot_is_singular_and_still_free() {
    let s = parse_status("Rate limit: 2\n1 slot available now.\n").unwrap();
    assert_eq!(s.available, 1);
    assert_eq!(s.next_in_s, None, "a free slot is not a wait");
}

/// ⚠ A CHANGED STATUS PAGE MUST NOT STOP THE REFRESH. `None` means "no opinion",
/// and the caller proceeds — the breaker and the deadline are what protect the
/// run. Returning a wait here would let an unrelated HTML error page halt a
/// nightly job.
#[test]
fn something_that_is_not_a_status_page_has_no_opinion() {
    assert_eq!(
        parse_status("<html><body>502 Bad Gateway</body></html>"),
        None
    );
    assert_eq!(parse_status(""), None);
}

/// ⚠ THE SECONDS COME FROM `in N seconds`, NEVER from the timestamp. This body
/// quotes a moment in 2019; a parser subtracting it from the local clock would
/// compute a wait of years out of an answer that says seven seconds.
#[test]
fn a_stale_timestamp_does_not_become_the_wait() {
    let body = "Current time: 2019-01-01T00:00:00Z\n\
                Rate limit: 2\n\
                Slot available after: 2019-01-01T00:00:07Z, in 7 seconds.\n";
    assert_eq!(parse_status(body).unwrap().next_in_s, Some(7));
}

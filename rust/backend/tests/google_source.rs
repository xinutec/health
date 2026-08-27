//! The per-stream ownership roster (#260).

use backend::google::source::{Owner, STREAMS, at_risk, fitbit_still_owns};

/// ⚠ EXACTLY ONE OWNER PER STREAM. The biometric tables are
/// `ON DUPLICATE KEY UPDATE`, so two writers means the last job to run wins and
/// the value flips with scheduling. That reads as instrument noise, not as a
/// source conflict, and is very hard to trace back.
#[test]
fn no_stream_is_listed_twice() {
    let mut seen = std::collections::HashSet::new();
    for s in STREAMS {
        assert!(seen.insert(s.name), "{} is listed more than once", s.name);
    }
}

/// ⚠ A stream Google does NOT own must still be fetched from Fitbit — including
/// the Health Connect ones, whose reader does not exist yet. "Not Fitbit's job
/// any more" and "nobody's job yet" are different, and conflating them switches
/// a stream off while the old API still works.
#[test]
fn health_connect_streams_are_still_fetched_from_fitbit() {
    for s in STREAMS.iter().filter(|s| s.owner == Owner::HealthConnect) {
        assert!(
            fitbit_still_owns(s.name),
            "{} would stop being fetched before its replacement exists",
            s.name
        );
    }
}

/// Only a proven Google stream is dropped from the Fitbit run.
#[test]
fn google_owned_streams_are_dropped_from_fitbit() {
    for s in STREAMS.iter().filter(|s| s.owner == Owner::Google) {
        assert!(!fitbit_still_owns(s.name), "{} is fetched twice", s.name);
    }
}

/// ⚠ An unlisted stream defaults to Fitbit, never to silence. A new table added
/// without a roster entry must keep being fetched, not vanish.
#[test]
fn an_unknown_stream_defaults_to_fitbit() {
    assert!(fitbit_still_owns("a_table_nobody_has_classified_yet"));
}

/// Every entry says WHY, because the verdict alone cannot be re-judged later:
/// "Google returns nothing" and "we have not written the client" are the same
/// owner today and different decisions tomorrow.
#[test]
fn every_stream_records_its_evidence() {
    for s in STREAMS {
        assert!(s.why.len() > 30, "{} has no real reason recorded", s.name);
    }
}

/// The at-risk list is what the September shutdown actually costs.
#[test]
fn at_risk_is_everything_google_does_not_own() {
    let risky = at_risk();
    assert!(risky.iter().any(|s| s.name == "sleep"));
    assert!(risky.iter().any(|s| s.name == "steps_intraday"));
    assert!(!risky.iter().any(|s| s.name == "body"));
}

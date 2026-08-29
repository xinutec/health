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

/// ⚠ THE FLIP AND THE WRITER ARE INSEPARABLE. `Owner::Google` makes
/// `fitbit::run` skip a stream; if nothing in `google::sync` writes it, the
/// stream stops dead — silently, from what reads as a one-line config change.
#[test]
fn every_google_owned_stream_has_a_writer() {
    use backend::google::source::has_writer;
    for s in STREAMS.iter().filter(|s| s.owner == Owner::Google) {
        assert!(
            has_writer(s.name),
            "{} is owned by Google but nothing writes it — flipping it stops the stream",
            s.name
        );
    }
}

/// And the converse: a writer with no Google-owned stream is dead code that
/// will be read as coverage.
#[test]
fn no_writer_without_an_owned_stream() {
    use backend::google::source::HAS_WRITER;
    for w in HAS_WRITER {
        assert!(
            STREAMS
                .iter()
                .any(|s| s.name == *w && s.owner == Owner::Google),
            "{w} has a writer but is not owned by Google"
        );
    }
}

/// ⚠ A COMPUTED STREAM IS STILL ONE STREAM. `skin_temperature` is written from
/// two Google fields subtracted, which is a different shape from every other
/// writer — and exactly the kind of special case that gets flipped in the
/// roster while the writer is still a TODO.
#[test]
fn skin_temperature_is_google_owned_and_written() {
    use backend::google::source::has_writer;
    let s = STREAMS
        .iter()
        .find(|s| s.name == "skin_temperature")
        .expect("skin_temperature is in the roster");
    assert_eq!(s.owner, Owner::Google);
    assert!(has_writer("skin_temperature"));
}

/// ⚠ THE DAILY AND INTRADAY STREAMS OF ONE SENSOR ARE SEPARATE ENTRIES, and
/// only the daily ones have Google writers. `hrv_daily` moved while
/// `hrv_intraday` cannot: Google's `heart-rate-variability` carries only RMSSD,
/// and our table also has `coverage`, `hf` and `lf`. Gating both on a shared
/// prefix would strand three columns with no source.
#[test]
fn the_intraday_siblings_did_not_move_with_their_daily_streams() {
    for name in ["hrv_intraday", "heart_rate_intraday"] {
        assert!(
            fitbit_still_owns(name),
            "{name} has no Google writer — flipping it would strand its columns"
        );
    }
}

/// ⚠ `daily_activity` STAYS ON FITBIT while a Google writer also exists — the
/// one deliberate exception to the roster's model, because its columns need
/// different owners. `minutes_sedentary` and `active_score` have no Google
/// source at all, so flipping the owner would stop them while Fitbit still
/// works. The two writers are separated by a DATE, not by the roster.
#[test]
fn daily_activity_stays_on_fitbit_despite_having_a_google_writer() {
    let s = STREAMS
        .iter()
        .find(|s| s.name == "daily_activity")
        .expect("daily_activity is in the roster");
    assert_eq!(s.owner, Owner::Fitbit);
    assert!(fitbit_still_owns("daily_activity"));
}

/// ⚠ AND THE CUTOVER MUST NOT PREDATE THE FITBIT SHUTDOWN. The whole safety of
/// two writers on one table rests on their date ranges not overlapping; a
/// cutover earlier than the shutdown puts both on the same days, where the last
/// job to run wins and step counts flip with scheduling.
#[test]
fn the_cutover_is_not_before_the_fitbit_shutdown() {
    assert!(backend::google::sync::DAILY_ACTIVITY_CUTOVER >= "2026-09-01");
}

/// ⚠ THE ASSERTION ABOVE IS ABOUT A STRING, NOT ABOUT BEHAVIOUR. It cannot fail
/// on the day the writer is supposed to start, because it does not run the
/// writer's decision. Until 2026-09-01 `sync_daily_activity` logs "before the
/// cutover, nothing to write" on every run, so the branch that WRITES has never
/// executed in production or in a test — the guard has only ever been observed
/// refusing. These drive it.
mod the_cutover_opens_exactly_once {
    use backend::google::sync::cutover_window;
    use chrono::NaiveDate;

    fn on(y: i32, m: u32, d: u32) -> Option<(NaiveDate, NaiveDate)> {
        cutover_window(NaiveDate::from_ymd_opt(y, m, d).expect("a real date"))
            .expect("the cutover constant parses")
    }

    /// The day before. `end` is TOMORROW — 2026-09-01 — which EQUALS `start`,
    /// and a half-open window of zero width must be refused rather than fetched.
    /// This is the ordering that can fail; a test only on 09-02 would pass with
    /// the comparison written either way.
    #[test]
    fn closed_on_the_day_before() {
        assert_eq!(on(2026, 8, 31), None);
    }

    /// ⚠ THE DAY IT MUST START. If this is `None` the migration silently does
    /// nothing on the day it was scheduled for, and `daily_activity` keeps
    /// whatever Fitbit last left — which looks identical to a healthy table
    /// until someone reads the dates.
    #[test]
    fn open_on_the_cutover_day_itself() {
        let (start, end) = on(2026, 9, 1).expect("the writer owns 2026-09-01");
        assert_eq!(start, NaiveDate::from_ymd_opt(2026, 9, 1).unwrap());
        assert_eq!(end, NaiveDate::from_ymd_opt(2026, 9, 2).unwrap());
    }

    /// And it does not narrow to a trailing window later: every day since the
    /// cutover stays in range, which is what makes a run that was skipped —
    /// a failed Job, a suspended cron — recoverable by the next one.
    #[test]
    fn still_reaches_back_to_the_cutover_months_later() {
        let (start, end) = on(2026, 12, 25).expect("the writer owns 2026-12-25");
        assert_eq!(start, NaiveDate::from_ymd_opt(2026, 9, 1).unwrap());
        assert_eq!(end, NaiveDate::from_ymd_opt(2026, 12, 26).unwrap());
    }
}

/// The `list` walk has no date window, so its days are filtered by a
/// LEXICOGRAPHIC compare against the cutover string. That is sound only while
/// every date reaching it is zero-padded, so this pins the PRODUCER as well as
/// the predicate — the failure it guards against is silent: `2026-9-1` sorts
/// before `2026-09-01` and the day is dropped with no error anywhere.
mod the_string_filter_is_sound_because_the_producer_pads {
    use backend::google::health::day_of_list_point;
    use backend::google::sync::owned_by_google;

    #[test]
    fn the_cutover_day_is_ours_and_the_day_before_is_not() {
        assert!(owned_by_google("2026-09-01"));
        assert!(owned_by_google("2026-09-02"));
        assert!(!owned_by_google("2026-08-31"));
        assert!(!owned_by_google("2023-04-15"));
    }

    /// ⚠ SINGLE-DIGIT MONTH AND DAY, which is exactly where padding decides the
    /// answer. September the 1st parsed out of the API's integer fields must
    /// come back as `2026-09-01`, not `2026-9-1` — the second sorts below the
    /// cutover and would drop the migration's first day without a trace.
    #[test]
    fn a_single_digit_date_comes_back_padded_and_passes_the_filter() {
        let pt = serde_json::json!({
            "civilStartTime": { "date": { "year": 2026, "month": 9, "day": 1 } },
            "dailyRestingHeartRate": { "beatsPerMinute": 58 },
        });
        let day = day_of_list_point(&pt, "/dailyRestingHeartRate/beatsPerMinute")
            .expect("a resting-heart-rate point parses");
        assert_eq!(day.date, "2026-09-01");
        assert!(
            owned_by_google(&day.date),
            "the migration's first day must survive the filter"
        );
    }
}

/// ⚠ THE TWO WRITERS MUST PARTITION THE TABLE, and before 2026-08-29 they did
/// not: `google_streams` (run.rs:101) wrote five columns and
/// `sync::activity::sync_activity` (run.rs:199) then assigned all twelve, in the
/// same job, seconds later. Nothing errored and no row was lost — Fitbit's
/// numbers are real — so the migration would have read as verified for weeks
/// while its write path never once survived to the table.
///
/// A partition has exactly two ways to break and both are silent, which is why
/// they are pinned here rather than left to the SQL:
///
///   * a column in NEITHER list is written by nobody past the cutover, and goes
///     NULL for ever without an error;
///   * a column in BOTH is assigned by both writers again, and the last job to
///     run wins — the overlap the cutover exists to prevent.
mod the_two_writers_partition_daily_activity {
    use backend::fitbit::sync::activity::FITBIT_ONLY_COLUMNS;
    use backend::google::sync::GOOGLE_OWNED_COLUMNS;

    /// Every data column of `daily_activity` — the schema's, minus the
    /// `(user_id, date)` key. Written out so a column ADDED to the table and to
    /// neither writer fails here rather than being discovered as a NULL.
    const EVERY_DATA_COLUMN: &[&str] = &[
        "steps",
        "calories_total",
        "calories_active",
        "distance_km",
        "floors",
        "elevation_m",
        "minutes_sedentary",
        "minutes_lightly_active",
        "minutes_fairly_active",
        "minutes_very_active",
        "active_score",
        "resting_heart_rate",
    ];

    #[test]
    fn no_column_is_claimed_by_both() {
        let both: Vec<_> = GOOGLE_OWNED_COLUMNS
            .iter()
            .filter(|c| FITBIT_ONLY_COLUMNS.contains(c))
            .collect();
        assert!(
            both.is_empty(),
            "these columns are assigned by BOTH writers, so the last job to run wins: {both:?}"
        );
    }

    #[test]
    fn no_column_is_left_to_nobody() {
        let orphaned: Vec<_> = EVERY_DATA_COLUMN
            .iter()
            .filter(|c| !GOOGLE_OWNED_COLUMNS.contains(c) && !FITBIT_ONLY_COLUMNS.contains(c))
            .collect();
        assert!(
            orphaned.is_empty(),
            "no writer owns these past the cutover — they go NULL silently: {orphaned:?}"
        );
    }

    /// And neither list names a column the table does not have, which is how a
    /// RENAME turns into a writer that quietly stops writing.
    #[test]
    fn neither_writer_claims_a_column_that_does_not_exist() {
        for c in GOOGLE_OWNED_COLUMNS.iter().chain(FITBIT_ONLY_COLUMNS) {
            assert!(
                EVERY_DATA_COLUMN.contains(c),
                "{c} is claimed by a writer but is not a column of daily_activity"
            );
        }
    }
}

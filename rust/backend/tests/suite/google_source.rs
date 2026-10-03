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
    // Every once-at-risk stream flipped on 2026-09-02; what September still
    // costs is daily_activity's two Fitbit-only columns (minutes_sedentary,
    // active_score), which no flip can save — the roster keeps that visible.
    assert!(risky.iter().any(|s| s.name == "daily_activity"));
    assert!(!risky.iter().any(|s| s.name == "body"));
    assert!(!risky.iter().any(|s| s.name == "steps_intraday"));
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

// ⚠ NO PER-STREAM PINS HERE. A test naming one stream as Fitbit-owned has to be
// deleted the day that stream moves, writer first. The generic pairing tests
// below (`every_google_owner_has_a_writer` and its converse) assert the
// invariant such a pin would be standing in for.

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
/// writer's decision. Before the cutover `sync_daily_activity` logs "before the
/// cutover, nothing to write" on every run, so the branch that WRITES never
/// executes in production or in a test — the guard is only ever observed
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

/// One step minute served under two offsets — the watch's zone changed mid-day
/// (London → Paris, 2026-09-30) — is ONE minute, at its instant.
mod step_minutes {
    use backend::google::sync::merge_step_points;
    use serde_json::json;

    fn point(device: &str, start: &str, offset: &str, count: i64) -> serde_json::Value {
        json!({
            "dataSource": {"platform": "FITBIT", "device": {"displayName": device}},
            "steps": {"count": count, "interval": {"startTime": start, "startUtcOffset": offset}}
        })
    }

    #[test]
    fn a_minute_served_under_two_offsets_is_one_minute_at_its_instant() {
        let (m, skipped) = merge_step_points(&[
            point("Pixel Watch", "2026-09-30T13:50:00Z", "3600s", 90),
            point("Pixel Watch", "2026-09-30T13:50:00Z", "7200s", 98),
        ]);
        assert_eq!(skipped, 0);
        assert_eq!(m.len(), 1);
        let (wall, steps) = &m["2026-09-30 13:50:00"];
        assert_eq!((wall.as_str(), *steps), ("2026-09-30 15:50:00", 98));
    }

    #[test]
    fn the_watch_wins_a_minute_the_phone_also_counted() {
        let (m, _) = merge_step_points(&[
            point("MobileTrack", "2026-09-30T13:50:00Z", "7200s", 40),
            point("Pixel Watch", "2026-09-30T13:50:00Z", "7200s", 30),
            point("MobileTrack", "2026-09-30T13:51:00Z", "7200s", 12),
        ]);
        assert_eq!(m["2026-09-30 13:50:00"].1, 30);
        assert_eq!(m["2026-09-30 13:51:00"].1, 12);
    }

    /// The archive keeps the minutes whose WALL CLOCK falls in `[from, until)`,
    /// the clock the stored series is keyed by, so it meets Fitbit's history at
    /// exactly the stored first minute whatever the offsets around it. The fetch
    /// is a day wider either side; those minutes are dropped here.
    #[test]
    fn the_archive_keeps_minutes_by_wall_clock_date() {
        use backend::google::sync::archive_minutes;
        use chrono::NaiveDate;
        let (m, _) = merge_step_points(&[
            // 23:30 UTC on the 12th is 00:30 on the 13th in Amsterdam: outside.
            point("Inspire 3", "2024-01-12T23:30:00Z", "3600s", 7),
            point("Inspire 3", "2024-01-12T22:59:00Z", "3600s", 5),
            // The day before `from`, by wall clock: outside.
            point("Inspire 3", "2023-04-14T21:59:00Z", "7200s", 9),
            point("Inspire 3", "2023-04-14T22:00:00Z", "7200s", 4),
            // Zero minutes are never written.
            point("Inspire 3", "2023-06-01T10:00:00Z", "7200s", 0),
        ]);
        let d = |s| NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        let kept: Vec<_> = archive_minutes(&m, d("2023-04-15"), d("2024-01-13"))
            .into_iter()
            .map(|(_, wall, steps)| (wall, steps))
            .collect();
        assert_eq!(
            kept,
            vec![
                ("2023-04-15 00:00:00".to_string(), 4),
                ("2024-01-12 23:59:00".to_string(), 5),
            ]
        );
    }
}

/// `users.pairedDevices`, in the shape measured 2026-10-01 (ids invented).
mod paired_devices {
    use backend::google::sync::{BatteryReading, battery_readings};
    use serde_json::json;

    #[test]
    fn the_watch_reads_and_the_phone_without_a_level_does_not() {
        let reply = json!({"pairedDevices": [
            {"name": "users/1/pairedDevices/111", "deviceType": "TRACKER",
             "batteryStatus": "Medium", "batteryLevel": 66,
             "lastSyncTime": "2026-10-01T10:25:49Z", "deviceVersion": "Inspire 3"},
            {"name": "users/1/pairedDevices/222", "deviceType": "TRACKER",
             "batteryStatus": "Empty", "lastSyncTime": "2026-10-01T10:10:49Z",
             "deviceVersion": "MobileTrack"}
        ]});
        assert_eq!(
            battery_readings(&reply),
            [BatteryReading {
                device_id: "111".into(),
                device_version: Some("Inspire 3".into()),
                battery_level: 66,
                last_sync_utc: "2026-10-01 10:25:49".into(),
            }]
        );
    }

    #[test]
    fn no_devices_is_no_readings() {
        assert!(battery_readings(&json!({})).is_empty());
    }
}

/// Blood-oxygen samples (#1886): one per instant, filed under the wall clock
/// Google serves beside it.
mod spo2_samples {
    use backend::google::sync::spo2_samples;
    use serde_json::json;

    fn sample(instant: &str, hour: i64, offset: &str, pct: serde_json::Value) -> serde_json::Value {
        json!({"oxygenSaturation": {"sampleTime": {
            "physicalTime": instant, "utcOffset": offset,
            "civilTime": {"date": {"year": 2026, "month": 10, "day": 2},
                          "time": {"hours": hour, "minutes": 46, "seconds": 33}}},
            "percentage": pct}})
    }

    #[test]
    fn one_reading_per_instant_under_its_wall_clock() {
        let (m, skipped) = spo2_samples(&[
            sample("2026-10-02T09:46:33Z", 11, "7200s", json!(96.5)),
            // The same instant served again under another offset: one reading.
            sample("2026-10-02T09:46:33Z", 10, "3600s", json!(96.5)),
            // Unreadable: no percentage.
            json!({"oxygenSaturation": {"sampleTime": {"physicalTime": "2026-10-02T09:47:33Z"}}}),
        ]);
        assert_eq!(skipped, 1);
        assert_eq!(m.len(), 1);
        let (wall, pct) = &m["2026-10-02 09:46:33"];
        assert_eq!(wall.as_str(), "2026-10-02 11:46:33");
        assert!((pct - 96.5).abs() < 1e-9);
    }
}

/// Recorded workouts (#1886): one row per Google point, the summary typed and
/// the whole point kept.
mod exercise_sessions {
    use backend::google::exercise::parse_exercise;
    use serde_json::json;

    fn walk() -> serde_json::Value {
        json!({
            "name": "users/1/dataTypes/exercise/dataPoints/4093039881136750928",
            "dataSource": {"platform": "FITBIT", "device": {"displayName": "Inspire 3"}},
            "exercise": {
                "interval": {"startTime": "2026-10-02T11:35:37.761Z", "startUtcOffset": "7200s",
                             "endTime": "2026-10-02T12:34:37.129Z", "endUtcOffset": "7200s"},
                "exerciseType": "WALKING", "displayName": "Walk",
                "metricsSummary": {"distanceMillimeters": 1337692, "steps": "1413",
                                   "caloriesKcal": 98.5, "averageHeartRateBeatsPerMinute": "97"},
                "exerciseMetadata": {"hasGps": true},
                "activeDuration": "3539.368s",
                "updateTime": "2026-10-02T12:35:29.862017Z"
            }
        })
    }

    #[test]
    fn a_workout_reads_with_both_clocks_and_its_summary() {
        let w = parse_exercise(&walk()).expect("a readable workout");
        assert_eq!(w.point_id, "4093039881136750928");
        assert_eq!(
            (w.platform.as_deref(), w.source.as_deref()),
            (Some("FITBIT"), Some("Inspire 3"))
        );
        assert_eq!(w.exercise_type.as_deref(), Some("WALKING"));
        assert_eq!(
            (w.start_utc.as_str(), w.start_ts.as_str()),
            ("2026-10-02 11:35:37", "2026-10-02 13:35:37")
        );
        assert_eq!(
            (w.end_utc.as_str(), w.end_ts.as_str()),
            ("2026-10-02 12:34:37", "2026-10-02 14:34:37")
        );
        assert_eq!(w.active_s, Some(3539));
        assert_eq!(w.steps, Some(1413));
        assert!((w.distance_m.unwrap() - 1337.692).abs() < 1e-9);
        assert_eq!(w.avg_hr, Some(97.0));
        assert_eq!(w.has_gps, Some(true));
        // The whole point is kept, not only what has a column.
        let raw: serde_json::Value = serde_json::from_str(&w.raw).unwrap();
        assert_eq!(raw, walk());
    }

    #[test]
    fn an_app_workout_names_its_app_and_a_point_without_times_is_refused() {
        let mut p = walk();
        p["dataSource"] = json!({"platform": "HEALTH_CONNECT", "device": {},
                                 "application": {"packageName": "com.google.android.apps.fitness"}});
        assert_eq!(
            parse_exercise(&p).unwrap().source.as_deref(),
            Some("com.google.android.apps.fitness")
        );
        p["exercise"]["interval"] = json!({});
        assert!(parse_exercise(&p).is_none());
    }
}

/// The raw archive (#1886): every remaining type as `google_points` rows, the
/// time normalised into columns and the rest of the payload kept.
mod google_points {
    use backend::google::archive::parse_point;
    use serde_json::json;

    #[test]
    fn an_interval_point_keeps_both_ends_its_offsets_and_its_payload() {
        let p = json!({"dataSource": {"platform": "FITBIT", "device": {"displayName": "Inspire 3"}},
            "activityLevel": {"interval": {"startTime": "2026-10-02T13:30:00Z", "startUtcOffset": "7200s",
                                           "endTime": "2026-10-02T13:31:00Z", "endUtcOffset": "7200s"},
                              "activityLevelType": "VERY_ACTIVE"}});
        let r = parse_point(&p, "activityLevel").expect("readable");
        assert_eq!(r.start_utc, "2026-10-02 13:30:00.000");
        assert_eq!(r.end_utc.as_deref(), Some("2026-10-02 13:31:00.000"));
        assert_eq!(r.start_ts.as_deref(), Some("2026-10-02 15:30:00.000"));
        assert_eq!((r.start_offset_s, r.end_offset_s), (Some(7200), Some(7200)));
        assert_eq!(r.source, "FITBIT|Inspire 3");
        assert_eq!(r.payload, json!({"activityLevelType": "VERY_ACTIVE"}));
    }

    #[test]
    fn a_sample_point_has_no_end_and_milliseconds_survive() {
        let p = json!({"dataSource": {"platform": "HEALTH_CONNECT", "device": {},
                                      "application": {"packageName": "com.example.app"}},
            "respiratoryRateSleepSummary": {"sampleTime": {"physicalTime": "2026-10-02T08:59:00.250Z",
                                                            "utcOffset": "7200s"},
                                            "fullSleepStats": {"breathsPerMinute": 17.2}}});
        let r = parse_point(&p, "respiratoryRateSleepSummary").expect("readable");
        assert_eq!(r.start_utc, "2026-10-02 08:59:00.250");
        assert_eq!(r.end_utc, None);
        assert_eq!(r.start_ts.as_deref(), Some("2026-10-02 10:59:00.250"));
        assert_eq!(r.source, "HEALTH_CONNECT|com.example.app");
        assert_eq!(
            r.payload,
            json!({"fullSleepStats": {"breathsPerMinute": 17.2}})
        );
    }

    /// Mid-2024 Google serves up to three activity-level points for ONE minute
    /// from one watch, often with different levels, and nothing in them tells
    /// them apart. All are kept: each gets a sequence number within its
    /// (start, source), ordered by payload so a re-fetch numbers them the same.
    #[test]
    fn points_sharing_a_start_and_source_are_numbered_by_payload() {
        use backend::google::archive::number_points;
        let p = |level: &str| {
            json!({"dataSource": {"platform": "FITBIT", "device": {"displayName": "Inspire 3"}},
            "activityLevel": {"interval": {"startTime": "2024-07-10T10:00:00Z", "startUtcOffset": "3600s",
                                           "endTime": "2024-07-10T10:01:00Z", "endUtcOffset": "3600s"},
                              "activityLevelType": level}})
        };
        let rows: Vec<_> = ["SEDENTARY", "LIGHTLY_ACTIVE", "SEDENTARY"]
            .iter()
            .map(|l| parse_point(&p(l), "activityLevel").unwrap())
            .collect();
        let mut reversed = rows.clone();
        reversed.reverse();
        let seqs = |rs: Vec<backend::google::archive::PointRow>| -> Vec<(i32, String)> {
            let mut v: Vec<_> = number_points(rs)
                .into_iter()
                .map(|(r, n)| {
                    (
                        n,
                        r.payload["activityLevelType"].as_str().unwrap().to_string(),
                    )
                })
                .collect();
            v.sort();
            v
        };
        let want = vec![
            (0, "LIGHTLY_ACTIVE".to_string()),
            (1, "SEDENTARY".to_string()),
            (2, "SEDENTARY".to_string()),
        ];
        assert_eq!(seqs(rows), want);
        // The serving order does not move a number.
        assert_eq!(seqs(reversed), want);
    }

    #[test]
    fn an_interval_without_offsets_has_no_wall_clock_and_no_time_is_refused() {
        let p = json!({"dataSource": {"platform": "FITBIT", "device": {"displayName": "Inspire 3"}},
            "swimLengthsData": {"interval": {"startTime": "2026-10-02T13:28:45Z", "endTime": "2026-10-02T13:29:05Z"},
                                "strokeCount": "20"}});
        let r = parse_point(&p, "swimLengthsData").expect("readable");
        assert_eq!((r.start_ts, r.start_offset_s), (None, None));
        assert_eq!(r.payload, json!({"strokeCount": "20"}));
        assert!(
            parse_point(
                &json!({"swimLengthsData": {"strokeCount": "1"}}),
                "swimLengthsData"
            )
            .is_none()
        );
    }
}

/// Active minutes per day from Google's `active-minutes` rollup (#260): the
/// replacement for Fitbit's lightly/fairly/very active columns, which the
/// summary card's "active minutes" reads. Measured 2026-10-02 against 1,253
/// Fitbit days: moderate + vigorous equals fairly + very on EVERY day.
mod active_minutes {
    use backend::google::health::active_minutes_of_rollup_point;
    use serde_json::json;

    #[test]
    fn the_three_levels_of_a_day_and_a_missing_level_is_zero() {
        let p = json!({"civilStartTime": {"date": {"year": 2026, "month": 9, "day": 2}},
            "activeMinutes": {"activeMinutesRollupByActivityLevel": [
                {"activityLevel": "LIGHT", "activeMinutesSum": "144"},
                {"activityLevel": "VIGOROUS", "activeMinutesSum": "48"}]}});
        let d = active_minutes_of_rollup_point(&p).expect("a day");
        assert_eq!(d.date, "2026-09-02");
        assert_eq!((d.light, d.moderate, d.vigorous), (144.0, 0.0, 48.0));
    }

    #[test]
    fn a_point_without_a_breakdown_is_no_reading() {
        let p = json!({"civilStartTime": {"date": {"year": 2026, "month": 9, "day": 2}},
            "activeMinutes": {}});
        assert!(active_minutes_of_rollup_point(&p).is_none());
    }
}

mod exercise_routes {
    use backend::google::routes::{export_url, positions, trackpoints};

    const TCX: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities><Activity Sport="Running"><Id>2025-03-01T08:00:00Z</Id>
    <Lap StartTime="2025-03-01T08:00:00Z"><Track>
      <Trackpoint><Time>2025-03-01T08:00:00Z</Time><Position><LatitudeDegrees>51.5</LatitudeDegrees><LongitudeDegrees>-0.1</LongitudeDegrees></Position><AltitudeMeters>12</AltitudeMeters></Trackpoint>
      <Trackpoint><Time>2025-03-01T08:00:01Z</Time><HeartRateBpm><Value>120</Value></HeartRateBpm></Trackpoint>
      <Trackpoint attr="x"><Time>2025-03-01T08:00:02Z</Time><Position><LatitudeDegrees>51.5001</LatitudeDegrees><LongitudeDegrees>-0.1001</LongitudeDegrees></Position></Trackpoint>
    </Track></Lap>
  </Activity></Activities>
</TrainingCenterDatabase>"#;

    /// Three trackpoints, two of them with a fix: the one recorded under cover
    /// counts as a trackpoint and not as a position.
    #[test]
    fn counts_trackpoints_and_positions_separately() {
        assert_eq!(trackpoints(TCX), 3);
        assert_eq!(positions(TCX), 2);
    }

    #[test]
    fn an_empty_document_has_none() {
        assert_eq!(trackpoints(""), 0);
        assert_eq!(positions(""), 0);
    }

    /// The export is a custom method on the session's point, and `alt=media`
    /// is what makes it the document rather than a JSON wrapper.
    #[test]
    fn the_export_url_names_the_point_and_asks_for_media() {
        let u = export_url("4093039881136750928");
        assert!(
            u.ends_with(
                "/dataTypes/exercise/dataPoints/4093039881136750928:exportExerciseTcx?alt=media"
            ),
            "{u}"
        );
        assert!(
            u.starts_with("https://health.googleapis.com/v4/users/me/"),
            "{u}"
        );
    }
}

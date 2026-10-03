//! `backend`'s command line (`backend::argv`).
//!
//! The listing is clap's, rendered from the same enum the dispatch matches on,
//! so the drift the old hand-kept table suffered (19 of 29 listed) cannot recur.
//! What is left to pin is that every subcommand says what it does, and that the
//! argv production actually runs still parses to what it meant.

use backend::argv::{Cli, Command};
use clap::{CommandFactory, Parser};

fn parse(argv: &[&str]) -> Result<Command, clap::Error> {
    Cli::try_parse_from(std::iter::once("backend").chain(argv.iter().copied())).map(|c| c.command)
}

#[test]
fn the_definition_is_well_formed() {
    Cli::command().debug_assert();
}

/// A subcommand with no line in `--help` is undocumented, not just thin.
#[test]
fn every_subcommand_says_what_it_does() {
    for sub in Cli::command().get_subcommands() {
        let about = sub.get_about().map(|a| a.to_string()).unwrap_or_default();
        assert!(
            !about.trim().is_empty(),
            "{} has no description",
            sub.get_name()
        );
    }
}

/// Every argv the cluster runs (the CronJobs and `health-auth`, read from the
/// live namespace on 2026-09-30), parsed to what it meant before clap.
#[test]
fn every_production_argv_parses_as_it_did() {
    assert!(matches!(parse(&["serve"]), Ok(Command::Serve)));
    assert!(matches!(
        parse(&["sync"]),
        Ok(Command::Sync {
            forward_only: false
        })
    ));
    assert!(matches!(parse(&["freshness"]), Ok(Command::Freshness)));
    assert!(matches!(
        parse(&["refresh-bus-routes"]),
        Ok(Command::RefreshBusRoutes { dry_run: false })
    ));
    assert!(matches!(
        parse(&["refresh-rail-stops"]),
        Ok(Command::RefreshRailStops { dry_run: false })
    ));
    assert!(matches!(
        parse(&["refresh-rail-routes"]),
        Ok(Command::RefreshRailRoutes { window_days: None })
    ));
    assert!(matches!(
        parse(&["refresh-presence-log", "90"]),
        Ok(Command::RefreshPresenceLog { lookback_days: 90 })
    ));
    assert!(matches!(
        parse(&["fetch-geocodes", "--limit", "200"]),
        Ok(Command::FetchGeocodes {
            dry_run: false,
            limit: 200
        })
    ));
    assert!(matches!(
        parse(&["google-sync-exercise-routes", "--limit", "3"]),
        Ok(Command::GoogleSyncExerciseRoutes { limit: Some(3) })
    ));
    assert!(matches!(
        parse(&["watch-fetch-queue"]),
        Ok(Command::WatchFetchQueue { interval_s: 15 })
    ));
    match parse(&["refresh-focus-places"]) {
        Ok(Command::RefreshFocusPlaces {
            user: None,
            lookback_days: None,
            dry: false,
            ..
        }) => {}
        other => panic!("refresh-focus-places: {other:?}"),
    }
    match parse(&["decode-day", "someone", "7"]) {
        Ok(Command::DecodeDay {
            user: Some(u),
            when: Some(w),
            dry_run: false,
        }) => {
            assert_eq!((u.as_str(), w.as_str()), ("someone", "7"));
        }
        other => panic!("decode-day: {other:?}"),
    }
    match parse(&["velocity-many", "someone", "2026-09-21", "2026-09-12"]) {
        Ok(Command::VelocityMany { user, dates }) => {
            assert_eq!(user, "someone");
            assert_eq!(dates, ["2026-09-21", "2026-09-12"]);
        }
        other => panic!("velocity-many: {other:?}"),
    }
}

/// The by-hand forms whose shape was irregular before clap.
#[test]
fn the_irregular_forms_keep_their_meaning() {
    match parse(&["hr-trend", "--averages", "2026-06-01", "2026-07-01"]) {
        Ok(Command::HrTrend {
            json: false,
            since: None,
            averages: Some(a),
        }) => {
            assert_eq!(a, ["2026-06-01", "2026-07-01"]);
        }
        other => panic!("hr-trend --averages: {other:?}"),
    }
    assert!(matches!(
        parse(&["hr-trend", "2026-06-10", "--json"]),
        Ok(Command::HrTrend {
            json: true,
            since: Some(_),
            averages: None
        })
    ));
    assert!(matches!(
        parse(&["velocity", "u", "2026-09-30", "--no-walk-match"]),
        Ok(Command::Velocity {
            no_walk_match: true,
            ..
        })
    ));
    assert!(matches!(
        parse(&["day-mirror", "u", "2026-09-30"]),
        Ok(Command::DayMirror(_))
    ));
    assert!(matches!(
        parse(&["decode-bench", "--runs", "3", "2026-05-12"]),
        Ok(Command::DecodeBench { runs: 3, .. })
    ));
}

/// A typo is refused, never ignored: `sync`'s one flag decides whether durable
/// backfill state is written, and the hand parser's reason for existing was
/// that a misspelling must not fall through to the full run.
#[test]
fn what_it_cannot_parse_it_refuses() {
    assert!(parse(&["sync", "--forwrd-only"]).is_err());
    assert!(parse(&["refresh-presence-log", "0"]).is_err());
    assert!(
        parse(&["refresh-focus-places", "--dry"]).is_err(),
        "sinks need a user"
    );
    assert!(parse(&["google-backfill-sleep", "7", "--allow-shrink"]).is_err());
    assert!(parse(&["hr-trend", "--json", "--averages", "a", "b"]).is_err());
    assert!(
        parse(&["velocity-many", "someone"]).is_err(),
        "at least one date"
    );
    assert!(parse(&["no-such-command"]).is_err());
}

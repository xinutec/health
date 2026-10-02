//! `backend`'s command line, declared once with clap.
//!
//! The list of subcommands, their arguments and their one-line descriptions ARE
//! this enum: `backend --help` renders it, so the listing cannot drift from the
//! dispatch the way the hand-kept table did (19 of 29 before it was tested).
//!
//! It lives in the library, not beside `main`, so the suite can parse the exact
//! argv production runs (`tests/suite/usage.rs`).
//!
//! ⚠ A PARSE ERROR EXITS 64, not clap's 2: 64 (`EX_USAGE`) is what every
//! subcommand exited with before, and a cron reading exit codes should not see
//! the meaning change under it. See [`parse`].

use clap::{Args, Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(
    name = "backend",
    about = "The health backend: the server, the sync and the tools"
)]
#[command(arg_required_else_help = true)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

/// `<user> <date> [display-tz]`, shared by the one-day subcommands.
#[derive(Debug, Args)]
pub struct UserDay {
    pub user: String,
    /// YYYY-MM-DD
    pub date: String,
    /// IANA zone the day is displayed in
    pub display_tz: Option<String>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// read the config and prove it against the real database; READ-ONLY
    Check,
    /// the HTTP server — health-auth runs this
    Serve,
    /// Fitbit + Google ingestion for every linked user
    Sync {
        /// the forward pass alone; touches NO backfill state, safe beside the cron
        #[arg(long)]
        forward_only: bool,
    },
    /// has each stream actually arrived? exits non-zero naming the stale ones
    Freshness,
    /// rows and date span per biometric table
    Coverage,
    /// resting HR / HRV / breathing rate by day, or two window means (#1733)
    HrTrend {
        #[arg(long, conflicts_with = "averages")]
        json: bool,
        /// YYYY-MM-DD
        #[arg(conflicts_with = "averages")]
        since: Option<String>,
        /// two window means, split at BOUNDARY
        #[arg(long, num_args = 2, value_names = ["FROM", "BOUNDARY"])]
        averages: Option<Vec<String>>,
    },
    /// the full HRV + resting-HR history as CSV (#1733)
    HrvHistory,
    /// which daily_activity columns hold data (#260)
    ColumnFill,
    /// the shape of heart_rate_zones (#1223)
    ZonesCensus,
    /// id gaps in focus_places — were places mass-deleted? (#1140)
    FocusAudit,
    /// every venue-prior snapshot and the current blob, as the serving path resolves them (#1845)
    VenuePriorSnapshots { user: String, out_dir: String },
    /// which timezones are stored, and could inference change them? (#1037)
    TzCensus,
    /// field NAMES and leaf types from Google Health; never values
    GoogleProbe,
    /// Google against the stored rows, per stream
    GoogleCompare,
    /// Google heart-rate samples against heart_rate_intraday (#260)
    GoogleCompareIntraday {
        #[arg(default_value_t = 7)]
        days: i64,
    },
    /// re-fetch a wide sleep window through the routine writer (#1491)
    GoogleBackfillSleep {
        days: i64,
        #[arg(long)]
        write: bool,
        /// also write a session shorter than the one it replaces
        #[arg(long, requires = "write")]
        allow_shrink: bool,
    },
    /// re-fetch step minutes through the routine writer, storing each instant
    GoogleBackfillSteps {
        /// first day archived, by wall clock (YYYY-MM-DD)
        #[arg(long, value_parser = parse_date)]
        from: chrono::NaiveDate,
        /// first day NOT archived, by wall clock (YYYY-MM-DD)
        #[arg(long, value_parser = parse_date)]
        until: chrono::NaiveDate,
        #[arg(long)]
        write: bool,
    },
    /// archive Google's types with no table of their own into google_points (#1886)
    GoogleArchivePoints {
        /// first day archived (YYYY-MM-DD, UTC)
        #[arg(long, value_parser = parse_date)]
        from: chrono::NaiveDate,
        /// first day NOT archived (YYYY-MM-DD, UTC)
        #[arg(long, value_parser = parse_date)]
        until: chrono::NaiveDate,
        /// one type (e.g. sedentary-period); every archived type when absent
        #[arg(long = "type")]
        data_type: Option<String>,
        #[arg(long)]
        write: bool,
    },
    /// write every recorded workout Google holds (#1886)
    GoogleSyncExercise,
    /// archive every SpO2 reading Google holds over a UTC date range (#1886)
    GoogleArchiveSpo2 {
        /// first day archived (YYYY-MM-DD, UTC)
        #[arg(long, value_parser = parse_date)]
        from: chrono::NaiveDate,
        /// first day NOT archived (YYYY-MM-DD, UTC)
        #[arg(long, value_parser = parse_date)]
        until: chrono::NaiveDate,
        #[arg(long)]
        write: bool,
    },
    /// Google sleep sessions against sleep + sleep_stages (#260)
    GoogleCompareSleep {
        #[arg(default_value_t = 7)]
        days: i64,
    },
    /// Google HRV samples against hrv_intraday.rmssd (#260)
    GoogleCompareHrv {
        #[arg(default_value_t = 7)]
        days: i64,
    },
    /// Google zone bounds + interval sums against heart_rate_zones (#260)
    GoogleCompareZones {
        #[arg(default_value_t = 7)]
        days: i64,
    },
    /// Google step intervals against steps_intraday: width + sources (#260)
    GoogleCompareSteps {
        #[arg(default_value_t = 7)]
        days: i64,
    },
    /// compare stored rows against a date
    RowsCheck {
        user: String,
        since: String,
        date: String,
    },
    /// the OwnTracks proxy's decisions, the durable copy of its log line; READ-ONLY
    OwntracksLog {
        user: String,
        #[arg(default_value_t = 200)]
        limit: i64,
    },
    /// the classification inputs for one day
    Inputs(UserDay),
    /// recompute the velocity fold
    Velocity {
        #[command(flatten)]
        day: UserDay,
        #[arg(long)]
        no_walk_match: bool,
    },
    /// the pipeline head over a fixture
    Head { fixture: String },
    /// the day fold over a fixture
    Day { fixture: String },
    /// the day fold against live data
    DayLive(UserDay),
    /// the day fold against the OSM mirror
    DayMirror(UserDay),
    /// write a golden fixture for one day from the live mirror (#1660)
    CaptureDay {
        user: String,
        date: String,
        out: String,
        display_tz: Option<String>,
    },
    /// time the HSMM decoder per frozen day, model build excluded (#1714)
    DecodeBench {
        #[arg(long, default_value_t = 5)]
        runs: usize,
        days: Vec<String>,
    },
    /// the OSM mirror against a fixture
    MirrorCheck { fixture: String },
    /// the locations answer for one day
    LocationsCheck { user: String, date: String },
    /// the HSMM decode; the nightly cron
    DecodeDay {
        user: Option<String>,
        /// a day count back from today, or one YYYY-MM-DD
        #[arg(requires = "user")]
        when: Option<String>,
        #[arg(long)]
        dry_run: bool,
    },
    /// rebuild presence_log
    RefreshPresenceLog {
        #[arg(default_value_t = 30, value_parser = clap::value_parser!(i64).range(1..))]
        lookback_days: i64,
    },
    /// re-mine focus_places from PhoneTrack
    RefreshFocusPlaces {
        user: Option<String>,
        #[arg(requires = "user", value_parser = clap::value_parser!(i64).range(1..))]
        lookback_days: Option<i64>,
        #[arg(long, requires = "user")]
        hard_out: Option<String>,
        #[arg(long, requires = "user")]
        soft_out: Option<String>,
        #[arg(long, requires = "user")]
        dry: bool,
        /// mine as of the end of this YYYY-MM-DD
        #[arg(long, value_parser = parse_date)]
        as_of: Option<chrono::NaiveDate>,
    },
    /// fill the rail route cache
    RefreshRailRoutes {
        #[arg(value_parser = clap::value_parser!(i64).range(1..))]
        window_days: Option<i64>,
    },
    /// mirror rail relations from Overpass
    RefreshRailStops {
        #[arg(long)]
        dry_run: bool,
    },
    /// mirror bus routes from Overpass
    RefreshBusRoutes {
        #[arg(long)]
        dry_run: bool,
    },
    /// fetch the reverse geocodes the fold could not answer
    FetchGeocodes {
        #[arg(long)]
        dry_run: bool,
        #[arg(long, default_value_t = 200)]
        limit: i64,
    },
    /// fold several days in ONE process — the arena's high-water (#1071)
    VelocityMany {
        user: String,
        #[arg(required = true)]
        dates: Vec<String>,
    },
    /// fill the OSM mirror where the fold found no coverage
    FetchOsm {
        #[arg(long)]
        dry_run: bool,
        #[arg(long, default_value_t = 40)]
        limit: i64,
        /// only this queue kind (`osm_railway`, …); every kind when absent
        #[arg(long)]
        kind: Option<String>,
    },
    /// issue a session cookie
    MintSession { user: String },
    /// revoke a session cookie
    DropSession { cookie: String },
}

fn parse_date(s: &str) -> Result<chrono::NaiveDate, String> {
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|e| format!("{s:?}: {e}"))
}

/// The process's argv parsed as `T` — or the process exits: 0 for `--help`, 64
/// for anything it cannot parse (a missing subcommand included, as before).
///
/// Shared by the examples, several of which exit 2 to mean "the golden corpus
/// is not on this machine, skip loudly"; clap's own 2 would read as that.
pub fn parse_or_exit<T: Parser>() -> T {
    T::try_parse().unwrap_or_else(|e| {
        use clap::error::ErrorKind;
        let code = match e.kind() {
            ErrorKind::DisplayHelp | ErrorKind::DisplayVersion => 0,
            _ => 64,
        };
        // `print` routes help to stdout and errors to stderr.
        let _ = e.print();
        std::process::exit(code)
    })
}

/// `backend`'s argv; see [`parse_or_exit`].
pub fn parse() -> Cli {
    parse_or_exit()
}

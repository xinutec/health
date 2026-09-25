//! The Rust backend skeleton (#982).
//!
//! # What this is, and what it is NOT
//!
//! Pippijn, 2026-08-17: *"We want no TS backend. Logic should be in Lean. A bit
//! of IO glue needs to be in Rust."* This crate is the IO glue — configuration,
//! a connection pool, the cursor store, and the entrypoint that ties them
//! together. **Nothing here decides anything.** If a module in this crate grows
//! a rule about what a day means or when a segment is a walk, that rule belongs
//! in Lean and its presence here is the bug.
//!
//! # ⚠ THE PLAN THIS HEADER USED TO DESCRIBE HAS COMPLETED
//!
//! ⚠ KEEP THE SECTIONS BELOW IN THE PRESENT TENSE. Written as plans they
//! outlive the plan and tell a reader the opposite of what is live.
//!
//! Where it stands:
//!
//!   * the TS↔Lean per-tenant A/B retired with the TypeScript backend (#975,
//!     2026-08-26). `state.rs` still names `setVerifiedCoreOverride`; that
//!     symbol exists nowhere but in prose.
//!   * this crate serves `/api` — see `routes/`, which answers `/api/me`,
//!     `/api/locations` and the biometric tables. `dist/server.js` is gone.
//!   * the ingestion IS Rust, and the Fitbit→Google cutover it was written for
//!     landed and was verified in prod on 2026-09-01 (#260).
//!
//! The paragraph below is kept because the RULE it states outlived the plan.
//!
//! # The Lean/Rust line, drawn by example
//!
//! Pippijn, 2026-08-17: *"anything that can be in Lean should be in Lean."*
//! `src/share/token.ts` is the worked example and the shape to copy. Four
//! functions; the split is not 50/50 and was not a judgement call:
//!
//!   * `generateShareToken` reads the CSPRNG → **Rust**. There is nothing to
//!     prove about `randomBytes(32)` beyond that it was asked for 32 bytes, and
//!     a Lean model of it would be fiction.
//!   * `buildShareUrl`, `shareableDateRange`, `clampShareDaysBack` are total
//!     functions of their arguments → **Lean** (`Verified/Share.lean`), on top
//!     of `Verified/Civil.lean`.
//!
//! The test to apply at each module: *does this decide anything, or does it
//! only move bytes?* Deciding goes to Lean even when it is three lines, because
//! three lines is exactly the size at which a wrong clamp survives review.

pub mod auth;
pub mod backfill;
pub mod classification_inputs;
pub mod config;
pub mod db;
pub mod decode_fixture;
pub mod error;
pub mod fetch_queue;
pub mod fitbit;
pub mod fold;
pub mod fold_payload;
pub mod freshness;
pub mod google;
pub mod head;
pub mod lean;
pub mod lean_worker;
pub mod location_cache;
pub mod mirror_source;
pub mod nextcloud;
pub mod nominatim;
pub mod osm_mirror;
pub mod osm_trace;
pub mod overpass;
pub mod routes;
pub mod row_json;
pub mod rows_check;
pub mod rowset_answerer;
pub mod rowset_capture;
pub mod schema;
pub mod state;
pub mod sync_state;
pub mod timezone;
pub mod velocity_cache;

/// Every subcommand `backend`'s `main` dispatches, with its arguments and one line of what
/// it does.
///
/// ⚠ THE LIST IS THE DOCUMENTATION AND IT IS TESTED. `usage_lists_every_subcommand`
/// compares this against the match arms in `main.rs`'s source, so adding a
/// subcommand without a line here fails the gate. Before that test the printed
/// list had 19 of 29 — a hand-maintained list rots, and this one had.
pub const SUBCOMMANDS: &[(&str, &str, &str)] = &[
    (
        "check",
        "",
        "read the config and prove it against the real database; READ-ONLY",
    ),
    ("serve", "", "the HTTP server — health-auth runs this"),
    (
        "sync",
        "[--forward-only]",
        "Fitbit + Google ingestion for every linked user",
    ),
    (
        "freshness",
        "",
        "has each stream actually arrived? exits non-zero naming the stale ones",
    ),
    ("coverage", "", "rows and date span per biometric table"),
    (
        "hr-trend",
        "[--json] [SINCE] | --averages <FROM> <BOUNDARY>",
        "resting HR / HRV / breathing rate by day, or two window means (#1733)",
    ),
    (
        "hrv-history",
        "",
        "the full HRV + resting-HR history as CSV (#1733)",
    ),
    (
        "column-fill",
        "",
        "which daily_activity columns hold data (#260)",
    ),
    ("zones-census", "", "the shape of heart_rate_zones (#1223)"),
    (
        "focus-audit",
        "",
        "id gaps in focus_places — were places mass-deleted? (#1140)",
    ),
    (
        "tz-census",
        "",
        "which timezones are stored, and could inference change them? (#1037)",
    ),
    (
        "google-probe",
        "",
        "field NAMES and leaf types from Google Health; never values",
    ),
    (
        "google-compare",
        "",
        "Google against the stored rows, per stream",
    ),
    (
        "google-compare-intraday",
        "[days]",
        "Google heart-rate samples against heart_rate_intraday (#260)",
    ),
    (
        "google-backfill-sleep",
        "<days> [--write]",
        "re-fetch a wide sleep window through the routine writer (#1491)",
    ),
    (
        "google-compare-sleep",
        "[days]",
        "Google sleep sessions against sleep + sleep_stages (#260)",
    ),
    (
        "google-compare-hrv",
        "[days]",
        "Google HRV samples against hrv_intraday.rmssd (#260)",
    ),
    (
        "google-compare-zones",
        "[days]",
        "Google zone bounds + interval sums against heart_rate_zones (#260)",
    ),
    (
        "google-compare-steps",
        "[days]",
        "Google step intervals against steps_intraday: width + sources (#260)",
    ),
    (
        "rows-check",
        "<user> <since> <date>",
        "compare stored rows against a date",
    ),
    (
        "owntracks-log",
        "<user> [limit]",
        "the OwnTracks proxy's decisions, the durable copy of its log line; READ-ONLY",
    ),
    (
        "inputs",
        "<user> <date> [tz]",
        "the classification inputs for one day",
    ),
    (
        "velocity",
        "<user> <date> [tz]",
        "recompute the velocity fold",
    ),
    ("head", "<fixture.json>", "the pipeline head over a fixture"),
    ("day", "<fixture.json>", "the day fold over a fixture"),
    (
        "day-live",
        "<user> <date> [tz]",
        "the day fold against live data",
    ),
    (
        "day-mirror",
        "<user> <date> [tz]",
        "the day fold against the OSM mirror",
    ),
    (
        "capture-day",
        "<user> <date> <out.json> [tz]",
        "write a golden fixture for one day from the live mirror (#1660)",
    ),
    (
        "decode-bench",
        "[--runs N] [DAY…]",
        "time the HSMM decoder per frozen day, model build excluded (#1714)",
    ),
    (
        "mirror-check",
        "<fixture.json>",
        "the OSM mirror against a fixture",
    ),
    (
        "locations-check",
        "<user> <date>",
        "the locations answer for one day",
    ),
    (
        "decode-day",
        "[user] [days|date] [--dry-run]",
        "the HSMM decode; the nightly cron",
    ),
    ("refresh-presence-log", "[days]", "rebuild presence_log"),
    (
        "refresh-focus-places",
        "[user] [days]",
        "re-mine focus_places from PhoneTrack",
    ),
    ("refresh-rail-routes", "[days]", "fill the rail route cache"),
    (
        "refresh-rail-stops",
        "[--dry-run]",
        "mirror rail relations from Overpass",
    ),
    (
        "refresh-bus-routes",
        "[--dry-run]",
        "mirror bus routes from Overpass",
    ),
    (
        "fetch-geocodes",
        "[--dry-run] [--limit N]",
        "fetch the reverse geocodes the fold could not answer",
    ),
    (
        "velocity-many",
        "<user> <date>...",
        "fold several days in ONE process — the arena's high-water (#1071)",
    ),
    (
        "fetch-osm",
        "[--dry-run] [--limit N]",
        "fill the OSM mirror where the fold found no coverage",
    ),
    ("mint-session", "<user>", "issue a session cookie"),
    ("drop-session", "<cookie>", "revoke a session cookie"),
];

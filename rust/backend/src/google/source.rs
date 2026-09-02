//! Which API owns each biometric stream, and why (#260).
//!
//! # Why this is a table and not a set of call sites
//!
//! The Fitbit Web API is decommissioned in September 2026; Google Health carries
//! most of the same data and NOT all of it. The migration is therefore per
//! stream and staged, which means that for a while the honest answer to "where
//! does resting heart rate come from?" is different from the answer for sleep.
//!
//! Spread across call sites that becomes unanswerable — a reader has to find
//! every `if` to reconstruct it, and a stream quietly served by neither, or by
//! both, looks exactly like one served correctly. Here it is one list, and the
//! compiler makes `fitbit::run` consult it.
//!
//! ⚠ **A STREAM MUST HAVE EXACTLY ONE OWNER.** Two writers on one table is not
//! redundancy: the tables are `ON DUPLICATE KEY UPDATE`, so the last run wins
//! and the value flips with whichever job fired most recently. That reads as
//! instrument noise and is nearly impossible to trace back to a source conflict.

/// Where a stream's rows come from today.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Owner {
    /// Google Health carries it and we have proven so against the live account.
    Google,
    /// Still the Fitbit Web API. ⚠ Every one of these stops in September 2026.
    Fitbit,
    /// Google does not carry it at all. Needs Health Connect on the phone,
    /// which is native Android work and not this task's port.
    HealthConnect,
}

/// One biometric stream and its current owner.
///
/// ⚠ THE `why` IS NOT DECORATION. A future reader deciding whether a stream can
/// move needs the measurement, not the verdict — "Google returns 200 with no
/// dataPoints" and "we have not written the client yet" are the same `Fitbit`
/// today and completely different tomorrow.
pub struct Stream {
    pub name: &'static str,
    pub owner: Owner,
    pub why: &'static str,
}

/// The roster. Measured 2026-08-27 against the live Google account and prod.
pub const STREAMS: &[Stream] = &[
    Stream {
        name: "body",
        owner: Owner::Google,
        why: "live since 2026-06-19; the scale reaches Google, not Fitbit",
    },
    Stream {
        name: "hrv_daily",
        owner: Owner::Google,
        why: "BOTH columns measured against daily-heart-rate-variability: daily_rmssd 1195/1195 and \
              deep_rmssd 1196/1196, EXACT. ⚠ Two pointers on ONE type — the deep figure is a field \
              of the daily type, not a per-stage sibling (that sibling is HTTP 400, unsupported)",
    },
    Stream {
        name: "spo2_daily",
        owner: Owner::Google,
        why: "ALL THREE columns: averagePercentage/lowerBound/upperBound, 1162 of 1174 days each, \
              p50 p90 p99 all 0.000. ⚠ The 12 exceptions are CONSECUTIVE (2024-04-15..26) — an \
              episode, not the different-statistic mismatch this was once blocked on. \
              lowerBound/upperBound measured as real extremes, NOT a mean±stddev interval",
    },
    Stream {
        name: "breathing_rate",
        owner: Owner::Google,
        why: "full_sleep_rate 1186/1186 EXACT against daily-respiratory-rate; the three stage \
              columns GAIN 1197 days each, having held 0 rows since Fitbit never returned them",
    },
    Stream {
        name: "skin_temperature",
        owner: Owner::Google,
        why: "COMPUTED, not a field: nightlyTemperatureCelsius MINUS baselineTemperatureCelsius, \
              1194/1194 nights, worst 0.050 °C. ⚠ The field whose NAME matches \
              (relativeNightlyStddev30dCelsius) is the WORST of three candidates at p50 0.599. \
              The 0.050 residual is our own 0.1 °C quantisation, so this gains precision",
    },
    Stream {
        name: "heart_rate_intraday",
        owner: Owner::Google,
        why: "google-compare-intraday over 7 days (2026-09-02): 259,082 of 259,082 shared seconds \
              IDENTICAL, |Δbpm| p99 0.00 — google's heart-rate IS the Fitbit stream re-served, \
              sample for sample. The instrument is not blind: it reported 10 rows and 1 minute \
              only-in-ours at the window edge",
    },
    Stream {
        name: "hrv_intraday",
        owner: Owner::Google,
        why: "google-compare-hrv over 7 days (2026-09-02): 848/848 shared civil timestamps \
              within our 0.001 ms step, worst |delta| 0.000. rmssd ONLY: coverage/hf/lf have \
              no Google source, are stored-and-never-read, and NULL forward by decision (#260)",
    },
    Stream {
        name: "heart_rate_zones",
        owner: Owner::Google,
        why: "google-compare-zones over 7 days (2026-09-02): 32/32 (date,zone) rows shared, \
              bounds 32/32 EXACT, minutes 29/32 within 1 (the 3 are the in-progress day, where \
              ours still holds Fitbit's whole-day filler). ⚠ Google RENAMED the zones — \
              LIGHT/MODERATE/VIGOROUS/PEAK, mapped by intensity order and verified by bounds. \
              `calories` has no source and NULLs forward (#260); junk dates are #1223",
    },
    Stream {
        name: "daily_activity",
        owner: Owner::Fitbit,
        why: "⚠ THE ONE TABLE WHOSE COLUMNS NEED DIFFERENT OWNERS, so this stays Fitbit and \
              google::sync::sync_daily_activity gates itself on a DATE instead. Fitbit is the only \
              source there has ever been for minutes_sedentary and active_score; flipping would stop \
              them while they still work. Measured: distance 1193/1226, calories_total 968/1246, \
              steps 587/1229 with google LOWER on 570 (history NOT rewritten, by decision), \
              calories_active 111 days of 1246. floors and elevation_m are 0 rows in BOTH",
    },
    Stream {
        name: "sleep",
        owner: Owner::Google,
        why: "google-compare-sleep over 7 days (2026-09-02): start/end/duration/deep/rem/main \
              EXACT on all shared nights; asleep/awake/light/efficiency differ ~25 min/night \
              because Google's summary matches ITS OWN stage series where Fitbit's does not \
              even match Fitbit's — accepted as the better statistic, discontinuity noted in \
              #260. ⚠ The earlier 'list returns 200 with NO dataPoints' was probe_one's \
              pageSize=1, a request shape session types answer EMPTY; pageSize=25 serves \
              full sessions",
    },
    Stream {
        name: "steps_intraday",
        owner: Owner::Google,
        why: "the 'list on steps is empty' verdict was probe_one's pageSize=1 (a request session \
              and interval types answer EMPTY); a real page serves per-interval counts, 60s-aligned \
              from the watch. Writer is WATCH-FIRST per minute, phone fallback — measured \
              2026-09-02: 1282/1297 stored minutes identical, sums within 0.5%, the 15 misses all \
              in device-transition windows. GAINS phone-only minutes a watchless window lost",
    },
];

/// True when the Fitbit sync should still fetch this stream.
///
/// ⚠ `HealthConnect` streams answer TRUE. Google does not carry them and the
/// phone-side reader does not exist, so Fitbit is the only source there is —
/// right up until September, when they stop. Treating "not Fitbit's job any
/// more" and "nobody's job yet" as the same thing would switch them off early
/// and lose data while the old API still worked.
pub fn fitbit_still_owns(name: &str) -> bool {
    STREAMS
        .iter()
        .find(|s| s.name == name)
        .is_none_or(|s| s.owner != Owner::Google)
}

/// The streams that stop when the Web API is decommissioned and have nowhere
/// else to go yet.
pub fn at_risk() -> Vec<&'static Stream> {
    STREAMS
        .iter()
        .filter(|s| s.owner != Owner::Google)
        .collect()
}

/// The streams something in `google::sync` actually writes.
///
/// ⚠ **THIS EXISTS BECAUSE `Owner::Google` MAKES `fitbit::run` SKIP A STREAM.**
/// Flipping an owner without a writer does not fall back — it stops the stream
/// dead, silently, and looks like a one-line config change. The test pairing
/// this with `STREAMS` is what makes the two inseparable.
///
/// ⚠ Not derived from `STREAMS`. A list generated from the thing it checks
/// agrees with it by construction and proves nothing; this is written by hand
/// and the test compares them.
pub const HAS_WRITER: &[&str] = &[
    "body",
    "breathing_rate",
    "heart_rate_intraday",
    "heart_rate_zones",
    "hrv_daily",
    "hrv_intraday",
    "skin_temperature",
    "sleep",
    "spo2_daily",
    "steps_intraday",
];

/// True when `google::sync` (or `google::body`) writes this stream.
pub fn has_writer(name: &str) -> bool {
    HAS_WRITER.contains(&name)
}

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
        owner: Owner::Fitbit,
        why: "google has daily-heart-rate-variability, 1196 points against our 1196 — client not written yet",
    },
    Stream {
        name: "spo2_daily",
        owner: Owner::Fitbit,
        why: "google has daily-oxygen-saturation, 1176 against our 1175 — client not written yet",
    },
    Stream {
        name: "breathing_rate",
        owner: Owner::Fitbit,
        why: "google has daily-respiratory-rate, 1186 against our 1186 — client not written yet",
    },
    Stream {
        name: "skin_temperature",
        owner: Owner::Fitbit,
        why: "google has daily-sleep-temperature-derivations, 1197 against our 1193 — client not written yet",
    },
    Stream {
        name: "heart_rate_intraday",
        owner: Owner::Fitbit,
        why: "google has heart-rate as intraday samples with physicalTime — client not written yet",
    },
    Stream {
        name: "hrv_intraday",
        owner: Owner::Fitbit,
        why: "google has heart-rate-variability as RMSSD samples — client not written yet",
    },
    Stream {
        name: "heart_rate_zones",
        owner: Owner::Fitbit,
        why: "google has daily-heart-rate-zones — client not written yet; see #1223, our table also holds junk dates",
    },
    Stream {
        name: "daily_activity",
        owner: Owner::Fitbit,
        why: "google has steps/distance/active-minutes/total-calories via dailyRollUp — client not written yet. \
              ⚠ floors and elevation are absent from BOTH; the device never recorded them",
    },
    Stream {
        name: "sleep",
        owner: Owner::HealthConnect,
        why: "google's `list` is the supported action for sleep and returns 200 with NO dataPoints. \
              Health Connect has it (00:21-10:08, 9h47m, written by com.fitbit.FitbitMobile)",
    },
    Stream {
        name: "steps_intraday",
        owner: Owner::HealthConnect,
        why: "google's `list` on steps is empty; dailyRollUp gives one countSum per DAY, which cannot \
              feed a per-minute series. Health Connect has the minutes",
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

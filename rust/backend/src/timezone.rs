//! Wall-clock ↔ UTC conversion for Fitbit timestamps.
//!
//! Port of the two functions in `src/geo/timezone.ts` that every stream parser
//! depends on. See `docs/design/timezone.md` for the three-tier storage
//! contract this serves.
//!
//! # Fitbit sends a wall clock with no offset
//!
//! `2026-08-17 14:30:00` and nothing else. What instant that names depends on
//! where the watch was, which is why the tz rides alongside and why `ts_utc` is
//! null when the tz is unknown — a guess stored in a UTC column is worse than
//! an absent value, because nothing downstream can tell it was a guess.
//!
//! # How the TypeScript does it, and why the port does not copy that
//!
//! It has no tz database, so it round-trips through `Intl`: pretend the
//! components are UTC, render that instant in the target zone, measure how far
//! the rendering diverged, and subtract. Ingenious and correct for the common
//! case, but it silently picks ONE answer at a DST boundary without saying
//! which, because the divergence it measures is whatever `Intl` rendered.
//!
//! `chrono-tz` has the real zone data, so this asks the question directly and
//! the two ambiguous cases become visible rather than implicit:
//!
//!   * SPRING FORWARD — the wall clock never happened. 01:30 on a night the
//!     clocks jump 01:00 → 02:00 names no instant at all.
//!   * FALL BACK — the wall clock happened TWICE, an hour apart.
//!
//! ⚠ The choices below match what the TypeScript's round-trip produces, so the
//! port does not silently re-time existing rows. They are written down because
//! "whatever `Intl` did" is not a specification, and the next person to touch
//! this needs to know a decision was made.

use anyhow::{Context, Result};
use chrono::{DateTime, Datelike, NaiveDateTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;

/// Parse Fitbit's wall-clock form: `YYYY-MM-DD HH:MM:SS`, or the same with `T`.
///
/// Trailing content is IGNORED, matching the TypeScript, whose regex is
/// unanchored — a value carrying a `.000Z` suffix parses to the same wall clock
/// rather than failing. Copied deliberately: rows written by the older path
/// carry that shape.
pub fn parse_wall_clock(s: &str) -> Option<NaiveDateTime> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let head = &s[..19];
    let normalised = if b[10] == b'T' {
        format!("{} {}", &head[..10], &head[11..])
    } else if b[10] == b' ' {
        head.to_string()
    } else {
        return None;
    };
    NaiveDateTime::parse_from_str(&normalised, "%Y-%m-%d %H:%M:%S").ok()
}

/// A wall clock in `tz` as a Unix timestamp in seconds.
///
/// `None` when the string does not parse or the zone is unknown.
///
/// At a DST boundary BOTH cases take the POST-transition offset, because that
/// is what the TypeScript's `Intl` round-trip produces and re-timing existing
/// rows is not the port's to do:
///
///   * ambiguous (fall back) → the LATER instant. `2026-10-25 01:30` in London
///     is 01:30 UTC (GMT), not 00:30 UTC (BST).
///   * nonexistent (spring forward) → read on the offset in force AFTER the
///     jump. `2026-03-29 01:30` is 00:30 UTC.
///
/// ⚠ MEASURED AGAINST THE PRODUCTION TYPESCRIPT, NOT DERIVED. The first version
/// of this function guessed the other way on both — earlier-instant for
/// ambiguous, pre-transition for the gap — which is the defensible reading and
/// disagrees with what is in the database. Running `wallClockToUtcString` over
/// the two 2026 London transitions is what settled it.
///
/// ⚠ THE GAP IS NOT MONOTONIC, in TypeScript or here: `01:00` maps to `00:00`
/// UTC while the preceding `00:45` maps to `00:45`. That is a real property of
/// the post-transition reading and it is not repaired, because it cannot arise
/// from a device: the watch's own clock jumps too, so no Fitbit sample ever
/// carries a wall clock inside the gap. A row that did would be corrupt on
/// arrival, and inventing a monotonic answer for it would hide that.
pub fn wall_clock_to_unix(s: &str, tz: &str) -> Option<i64> {
    let naive = parse_wall_clock(s)?;
    let zone: Tz = tz.parse().ok()?;
    match zone.from_local_datetime(&naive) {
        chrono::offset::LocalResult::Single(dt) => Some(dt.timestamp()),
        chrono::offset::LocalResult::Ambiguous(_earlier, later) => Some(later.timestamp()),
        chrono::offset::LocalResult::None => {
            // In the gap. An hour LATER is always a real instant on the
            // post-transition offset, so resolve there and step back — this
            // terminates rather than searching.
            let after = naive + chrono::TimeDelta::hours(1);
            let dt = zone.from_local_datetime(&after).single()?;
            Some(dt.timestamp() - 3600)
        }
    }
}

/// A wall clock plus its tz, as a UTC `YYYY-MM-DD HH:MM:SS` for storage.
///
/// `None` when the tz is absent — no inference signal at write time — or when
/// the wall clock is malformed. Storing a guess in a column declared to hold
/// UTC is the failure this returns `None` to avoid.
pub fn wall_clock_to_utc_string(wall_clock: &str, tz: Option<&str>) -> Option<String> {
    let tz = tz?;
    let unix = wall_clock_to_unix(wall_clock, tz)?;
    let dt = chrono::DateTime::from_timestamp(unix, 0)?;
    Some(dt.format("%Y-%m-%d %H:%M:%S").to_string())
}

/// The half-open UTC instant range `[start_utc, end_utc)` a civil date covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DayBounds {
    pub start_utc: i64,
    pub end_utc: i64,
}

/// The UTC bounds of a civil date in a zone.
///
/// The calendar arithmetic could be Lean's — `Verified.Civil` has it — but the
/// ZONE cannot: that file's own header says "nothing here needs a `Float`, a
/// timezone database, or a clock", and a tz database is data about what
/// governments did, not a rule a proof constrains. Same split as the Fitbit tz
/// decision already uses.
///
/// # ⚠ A TRANSLITERATION, REPRODUCING TWO DEFECTS ON PURPOSE
///
/// Unlike [`wall_clock_to_unix`] above — which asks `chrono-tz` directly and
/// merely MATCHES the TypeScript's observed answers — this copies the
/// TypeScript's method, because its method is where its answers come from:
///
///   * **The day is always 86400 seconds.** `end_utc` is `start_utc + 86400`,
///     not the next local midnight, so a spring-forward day runs an hour past
///     it and an autumn day stops an hour short.
///   * **The offset is read from the HOUR FIELD ALONE**, so a half-hour zone
///     truncates: Asia/Kolkata (+05:30) is applied as +05:00 and
///     America/St_Johns (−03:30) as −04:00.
///
/// Both are wrong and both are kept, because the 35-day golden corpus is the
/// only oracle for the pipeline this feeds and a port that deliberately differs
/// cannot be checked against it. Every corpus day is Europe/London, where the
/// offset is a whole number of hours and the truncation cannot be seen — so
/// "correct" and "faithful" agree there, and the divergence would only appear
/// for a user this backend has never had. Fixing it is a deliberate change that
/// re-blesses the corpus, not a tidy-up.
pub fn date_bounds_utc(date: &str, tz: Option<&str>) -> Result<DayBounds> {
    let day = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .with_context(|| format!("{date} is not a YYYY-MM-DD date"))?;
    let midnight: DateTime<Utc> =
        Utc.from_utc_datetime(&day.and_hms_opt(0, 0, 0).expect("midnight is a valid time"));
    let start_utc = midnight.timestamp();

    let Some(tz) = tz.filter(|t| !t.is_empty()) else {
        // No zone: the boundaries are UTC midnight, the loader's own fallback.
        return Ok(DayBounds {
            start_utc,
            end_utc: start_utc + 86_400,
        });
    };

    let zone: Tz = tz
        .parse()
        .with_context(|| format!("{tz} is not a known timezone"))?;
    let local = midnight.with_timezone(&zone);

    // ⚠ `hour()` and `day()` ONLY. This is the truncation, and it is the
    // TypeScript's `formatToParts` reading exactly these two fields. Replacing
    // it with `local.offset()` changes the answer for zones the corpus cannot
    // see, which is a re-blessing rather than a refactor.
    let local_hour = i64::from(local.hour());
    let local_day = i64::from(local.day());
    let date_day = i64::from(day.day());

    let offset_seconds = if local_day == date_day {
        local_hour * 3600
    } else if local_day > date_day || (date_day > 27 && local_day == 1) {
        // So far east the local clock already rolled over. The `> 27` arm is
        // how a month boundary is told from a genuinely smaller day number.
        (local_hour + 24) * 3600
    } else {
        (local_hour - 24) * 3600
    };

    let start_utc = start_utc - offset_seconds;
    Ok(DayBounds {
        start_utc,
        end_utc: start_utc + 86_400,
    })
}

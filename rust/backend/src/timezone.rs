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

/// The local hour of an instant in a zone, `0..=23`.
///
/// Port of `localHourOf` in `src/geo/venue-prior.ts`. ⚠ The TypeScript maps an
/// hour of 24 to 0 because some `Intl` locales render midnight that way; that
/// cannot arise from `chrono`, so there is no branch for it here and the result
/// is the same.
pub fn local_hour_of(ts_unix: i64, tz: &str) -> Result<u32> {
    let zone: Tz = tz
        .parse()
        .with_context(|| format!("{tz} is not a known timezone"))?;
    let dt = chrono::DateTime::from_timestamp(ts_unix, 0)
        .with_context(|| format!("{ts_unix} is not a representable instant"))?;
    Ok(dt.with_timezone(&zone).hour())
}

/// The civil date at an instant, in a zone — `YYYY-MM-DD`.
///
/// The tzdata half of `isLiveDay` (`src/routes/velocity-cache.ts`), which the
/// TypeScript gets from `Intl.DateTimeFormat("en-CA", { timeZone })`. The
/// DECISION that follows — is this the day in progress, and how long may its
/// result be reused — is `Verified.VelocityCache`; this only answers what day it
/// is where the viewer is.
///
/// ⚠ An absent zone is UTC, mirroring the API's own fallback. That is the
/// TypeScript's `tz ?? "UTC"` and not a safe default: at 23:30 in London the UTC
/// date has already rolled over, so a caller that loses the viewer's zone
/// freezes their evening an hour early rather than failing.
pub fn local_date_at(ts_unix: i64, tz: Option<&str>) -> Result<String> {
    let zone: Tz = tz
        .unwrap_or("UTC")
        .parse()
        .with_context(|| format!("{tz:?} is not a known timezone"))?;
    let dt = chrono::DateTime::from_timestamp(ts_unix, 0)
        .with_context(|| format!("{ts_unix} is not a representable instant"))?;
    Ok(dt.with_timezone(&zone).format("%Y-%m-%d").to_string())
}

/// The `[hourLocal, dayOfWeekLocal]` pair for every minute of a local day.
///
/// The tzdata half of `buildObservationTensor`. The tensor asks "what hour is it
/// where the user is" 1440 times, and the answer is not pure — so the shell
/// resolves the whole table once and the decoder reads it by index, exactly as
/// `local_stay_samples` does for opening hours.
///
/// ⚠ SUNDAY IS 0 HERE. `local_stay_samples` is Monday-based because the
/// opening-hours table is; the observation tensor's `dayOfWeekLocal` follows
/// JavaScript's `Date`, where Sunday is 0. The two live in one file and disagree
/// on purpose — a shared helper would have to pick one and silently shift the
/// other by a day.
///
/// ⚠ THE TABLE IS RESOLVED PER MINUTE, NOT DERIVED FROM `start_utc`. A DST
/// transition inside the day repeats or skips an hour, so `(m / 60) % 24` is
/// wrong on exactly the two days a year the decoder is hardest to debug.
pub fn local_ctx_table(start_utc: i64, tz: &str) -> Result<Vec<[u32; 2]>> {
    let zone: Tz = tz
        .parse()
        .with_context(|| format!("{tz} is not a known timezone"))?;
    (0..MINUTES_PER_DAY)
        .map(|m| {
            let ts = start_utc + i64::from(m) * 60;
            let dt = chrono::DateTime::from_timestamp(ts, 0)
                .with_context(|| format!("{ts} is not a representable instant"))?
                .with_timezone(&zone);
            Ok([dt.hour(), dt.weekday().num_days_from_sunday()])
        })
        .collect()
}

/// Minutes in a day, as the observation tensor counts them. ⚠ A FIXED 1440 even
/// across a DST transition: the tensor is indexed by minute-of-day, and a 23- or
/// 25-hour civil day still occupies exactly one row per index. `Verified.Hsmm.
/// Observation.MINUTES_PER_DAY` is the twin, and `parseObservationInput` refuses
/// a table of any other length.
pub const MINUTES_PER_DAY: u32 = 1440;

/// The stay's minutes as `(dayIdx, minuteOfDay)` in the venue's local zone —
/// every minute of `[start, end)`, or the single instant at `start` for a
/// zero-length window.
///
/// Port of `localStaySamples` in `src/geo/opening-hours.ts`, which exists for
/// exactly the reason this does: `Verified.Geo.OpeningHours` decides
/// open-versus-closed, but instant → local `(weekday, minute)` is tzdata, so
/// the shell resolves the pairs and puts them on the wire.
///
/// ⚠ `dayIdx` is MONDAY-BASED (`Mon = 0 … Sun = 6`), matching the
/// TypeScript's `WEEKDAY_IDX`. `chrono`'s `num_days_from_sunday` is not it, and
/// getting this wrong shifts every opening-hours judgement by one day without
/// changing the shape of anything.
///
/// ⚠ ONE ENTRY PER MINUTE. An eight-hour stay is 480 pairs, and a day's worth
/// of stays is why this table dominates the request. The TypeScript steps by 60
/// seconds from `start` rather than snapping to minute boundaries, so a stay
/// beginning at 09:00:30 samples :30 of each minute — kept, because the pairs
/// it produces are what the scorer was measured against.
pub fn local_stay_samples(start_unix: i64, end_unix: i64, tz: &str) -> Result<Vec<(u32, u32)>> {
    let zone: Tz = tz
        .parse()
        .with_context(|| format!("{tz} is not a known timezone"))?;

    let at = |ts: i64| -> Result<(u32, u32)> {
        let dt = chrono::DateTime::from_timestamp(ts, 0)
            .with_context(|| format!("{ts} is not a representable instant"))?
            .with_timezone(&zone);
        // Monday-based, as `WEEKDAY_IDX` is.
        let day_idx = dt.weekday().num_days_from_monday();
        Ok((day_idx, dt.hour() * 60 + dt.minute()))
    };

    if end_unix <= start_unix {
        return Ok(vec![at(start_unix)?]);
    }
    let mut out = Vec::with_capacity(((end_unix - start_unix) / 60 + 1) as usize);
    let mut t = start_unix;
    while t < end_unix {
        out.push(at(t)?);
        t += 60;
    }
    Ok(out)
}

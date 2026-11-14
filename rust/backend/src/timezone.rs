//! Wall clocks, zones and day bounds: the tzdata half of every local-time rule.
//!
//! A stored wall clock names an instant only with its zone, so `ts_utc` is null
//! when the zone is unknown: a guess in a UTC column cannot be told from a fact.
//! The DST choices below keep existing rows' instants stable.

use anyhow::{Context, Result};
use chrono::{Datelike, NaiveDateTime, NaiveTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;

/// Parse a wall clock, `YYYY-MM-DD HH:MM:SS` or with `T`. Trailing content
/// (a stored `.000Z`) is ignored.
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

/// A wall clock in `tz` as a Unix timestamp; `None` if either does not parse.
///
/// At a DST change both cases take the post-transition offset, as the stored
/// rows do: an ambiguous (autumn) `01:30` in London is 01:30 UTC, and a
/// nonexistent (spring) `01:30` is 00:30 UTC. The gap is therefore not
/// monotonic; no device sample falls inside it, since the watch's clock jumps too.
pub fn wall_clock_to_unix(s: &str, tz: &str) -> Option<i64> {
    let naive = parse_wall_clock(s)?;
    let zone: Tz = tz.parse().ok()?;
    match zone.from_local_datetime(&naive) {
        chrono::offset::LocalResult::Single(dt) => Some(dt.timestamp()),
        chrono::offset::LocalResult::Ambiguous(_earlier, later) => Some(later.timestamp()),
        chrono::offset::LocalResult::None => {
            // In the gap. An hour later is always a real instant on the
            // post-transition offset, so resolve there and step back — this
            // terminates rather than searching.
            let after = naive + chrono::TimeDelta::hours(1);
            let dt = zone.from_local_datetime(&after).single()?;
            Some(dt.timestamp() - 3600)
        }
    }
}

/// A wall clock plus its zone as a UTC `YYYY-MM-DD HH:MM:SS` for storage;
/// `None` without a zone rather than a guess.
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

/// The UTC bounds of a civil date in a zone: its local midnight to the next.
/// A DST day is 23 or 25 hours; no zone means UTC. The zone is tzdata, so this
/// stays in Rust while the calendar rules are `Verified.Civil`'s.
pub fn date_bounds_utc(date: &str, tz: Option<&str>) -> Result<DayBounds> {
    let day = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .with_context(|| format!("{date} is not a YYYY-MM-DD date"))?;
    let next = day
        .succ_opt()
        .with_context(|| format!("{date} has no next day"))?;

    let Some(tz) = tz.filter(|t| !t.is_empty()) else {
        let start_utc = Utc
            .from_utc_datetime(&day.and_time(NaiveTime::MIN))
            .timestamp();
        return Ok(DayBounds {
            start_utc,
            end_utc: start_utc + 86_400,
        });
    };

    let zone: Tz = tz
        .parse()
        .with_context(|| format!("{tz} is not a known timezone"))?;
    Ok(DayBounds {
        start_utc: first_instant_of(day, zone)?,
        end_utc: first_instant_of(next, zone)?,
    })
}

/// The first instant whose local date is `day`: local midnight, or the jump
/// where midnight falls in a spring-forward gap (America/Santiago).
fn first_instant_of(day: chrono::NaiveDate, zone: Tz) -> Result<i64> {
    let midnight = day.and_time(NaiveTime::MIN);
    (0..24 * 60)
        .find_map(|m| {
            zone.from_local_datetime(&(midnight + chrono::TimeDelta::minutes(m)))
                .earliest()
        })
        .map(|dt| dt.timestamp())
        .with_context(|| format!("{day} has no wall clock in {zone}"))
}

/// The local hour of an instant in a zone, `0..=23`.
///
/// `localHourOf`: the venue-local hour of an instant.
pub fn local_hour_of(ts_unix: i64, tz: &str) -> Result<u32> {
    let zone: Tz = tz
        .parse()
        .with_context(|| format!("{tz} is not a known timezone"))?;
    let dt = chrono::DateTime::from_timestamp(ts_unix, 0)
        .with_context(|| format!("{ts_unix} is not a representable instant"))?;
    Ok(dt.with_timezone(&zone).hour())
}

/// The civil date at an instant in a zone, `YYYY-MM-DD`; the tzdata half of
/// `Verified.VelocityCache`'s liveness rule. No zone is UTC, which in a London
/// evening is already tomorrow.
pub fn local_date_at(ts_unix: i64, tz: Option<&str>) -> Result<String> {
    let zone: Tz = tz
        .unwrap_or("UTC")
        .parse()
        .with_context(|| format!("{tz:?} is not a known timezone"))?;
    let dt = chrono::DateTime::from_timestamp(ts_unix, 0)
        .with_context(|| format!("{ts_unix} is not a representable instant"))?;
    Ok(dt.with_timezone(&zone).format("%Y-%m-%d").to_string())
}

/// `[hourLocal, dayOfWeek]` for every minute of `[start_utc, end_utc)`, the
/// observation tensor's local-time table (1380 or 1500 rows on a DST day).
/// Resolved per minute, since `(m / 60) % 24` is wrong across a DST change.
/// Sunday is 0 here, Monday in `local_stay_samples`: each matches its consumer.
pub fn local_ctx_table(start_utc: i64, end_utc: i64, tz: &str) -> Result<Vec<[u32; 2]>> {
    let zone: Tz = tz
        .parse()
        .with_context(|| format!("{tz} is not a known timezone"))?;
    (start_utc..end_utc)
        .step_by(60)
        .map(|ts| {
            let dt = chrono::DateTime::from_timestamp(ts, 0)
                .with_context(|| format!("{ts} is not a representable instant"))?
                .with_timezone(&zone);
            Ok([dt.hour(), dt.weekday().num_days_from_sunday()])
        })
        .collect()
}

/// A stay's minutes as `(dayIdx, minuteOfDay)` in the venue's zone, for
/// `Verified.Geo.OpeningHours`: every minute of `[start, end)`, or the one
/// instant at `start` for a zero-length stay. `dayIdx` is Monday-based
/// (`num_days_from_sunday` would shift every judgement a day). Steps 60 s from
/// `start`, not from minute boundaries, as the scorer was fitted.
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

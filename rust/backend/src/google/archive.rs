//! The raw archive: every Google type we hold no table for, into `google_points`
//! (#1886).
//!
//! Fitbit's Web API ends on 2026-10-30, and with it the only other copy of this
//! history. Measured 2026-10-02: activity-level 1.12M points, distance 402k,
//! active-zone-minutes 43k, swim-lengths 32k, sedentary-period 19k,
//! respiratory-rate-sleep-summary 1.4k, nutrition-log 2 — back to 2023 (2022
//! for nutrition).
//!
//! ⚠ LOSSLESS, NOT TYPED. The time is normalised into columns (both instants to
//! the millisecond, both offsets, the wall clock) and the rest of the type's
//! object is kept whole as `payload`. A reader that needs a typed table derives
//! it; nothing Google serves is dropped on the way in.

use anyhow::{Context, Result};
use sqlx::MySqlPool;

/// The archived types: `(data type, its object's key, the filter field an
/// incremental read uses)`. An empty field is a type the API refuses to filter
/// (nutrition-log, 400), read whole every time.
pub const ARCHIVE_TYPES: [(&str, &str, &str); 7] = [
    ("sedentary-period", "sedentaryPeriod", "interval.start_time"),
    ("activity-level", "activityLevel", "interval.start_time"),
    (
        "active-zone-minutes",
        "activeZoneMinutes",
        "interval.start_time",
    ),
    ("distance", "distance", "interval.start_time"),
    (
        "swim-lengths-data",
        "swimLengthsData",
        "interval.start_time",
    ),
    (
        "respiratory-rate-sleep-summary",
        "respiratoryRateSleepSummary",
        "sample_time.physical_time",
    ),
    ("nutrition-log", "nutritionLog", ""),
];

/// One `google_points` row.
#[derive(Debug, Clone, PartialEq)]
pub struct PointRow {
    /// `YYYY-MM-DD HH:MM:SS.mmm`, UTC.
    pub start_utc: String,
    pub end_utc: Option<String>,
    /// The wall clock at the start, when Google serves the offset.
    pub start_ts: Option<String>,
    pub start_offset_s: Option<i64>,
    pub end_offset_s: Option<i64>,
    /// `platform|device` or `platform|app package`.
    pub source: String,
    /// The type's object without its `interval` / `sampleTime`.
    pub payload: serde_json::Value,
}

fn instant(s: &str) -> Option<chrono::NaiveDateTime> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.naive_utc())
}

fn offset_s(s: Option<&str>) -> Option<i64> {
    s?.strip_suffix('s')?.parse().ok()
}

const MS: &str = "%Y-%m-%d %H:%M:%S%.3f";

/// Read one point of a type whose object sits under `key`. `None` when it has
/// no readable start: a point with no time is nothing to file.
#[must_use]
pub fn parse_point(pt: &serde_json::Value, key: &str) -> Option<PointRow> {
    let obj = pt.get(key)?.as_object()?;
    let s = |p: &str| pt.pointer(p).and_then(serde_json::Value::as_str);
    let (start, end, so, eo) = if let Some(iv) = obj.get("interval") {
        let g = |k: &str| iv.get(k).and_then(serde_json::Value::as_str);
        (
            instant(g("startTime")?)?,
            g("endTime").and_then(instant),
            offset_s(g("startUtcOffset")),
            offset_s(g("endUtcOffset")),
        )
    } else {
        let st = obj.get("sampleTime")?;
        let g = |k: &str| st.get(k).and_then(serde_json::Value::as_str);
        (
            instant(g("physicalTime")?)?,
            None,
            offset_s(g("utcOffset")),
            None,
        )
    };
    let mut payload = obj.clone();
    payload.remove("interval");
    payload.remove("sampleTime");
    Some(PointRow {
        start_utc: start.format(MS).to_string(),
        end_utc: end.map(|e| e.format(MS).to_string()),
        start_ts: so.map(|o| {
            (start + chrono::Duration::seconds(o))
                .format(MS)
                .to_string()
        }),
        start_offset_s: so,
        end_offset_s: eo,
        source: format!(
            "{}|{}",
            s("/dataSource/platform").unwrap_or("-"),
            s("/dataSource/device/displayName")
                .or_else(|| s("/dataSource/application/packageName"))
                .unwrap_or("-")
        ),
        payload: serde_json::Value::Object(payload),
    })
}

/// Number the points that share a `(start, source)`: 0, 1, … in payload order.
///
/// ⚠ NOT SERVING ORDER. Mid-2024 Google serves up to three activity-level points
/// for one minute from one watch, often with different levels, with nothing in
/// them to tell them apart (measured 2026-10-02: 4,613 such minutes in July
/// 2024 alone). Keeping all of them needs a key part; ordering by payload makes
/// a re-fetch number them the same, so `INSERT IGNORE` stays idempotent.
#[must_use]
pub fn number_points(mut rows: Vec<PointRow>) -> Vec<(PointRow, i32)> {
    rows.sort_by(|a, b| {
        (&a.start_utc, &a.source, a.payload.to_string()).cmp(&(
            &b.start_utc,
            &b.source,
            b.payload.to_string(),
        ))
    });
    let mut out: Vec<(PointRow, i32)> = Vec::with_capacity(rows.len());
    for r in rows {
        let seq = match out.last() {
            Some((p, n)) if p.start_utc == r.start_utc && p.source == r.source => n + 1,
            _ => 0,
        };
        out.push((r, seq));
    }
    out
}

/// Rows per INSERT; the prod tunnel makes every statement a round trip.
const BATCH_ROWS: usize = 1000;

/// How long one archive fetch spans: a month of per-minute activity level is
/// ~30k points, a few pages, and a failed window costs a month.
const WINDOW_DAYS: i64 = 31;

/// Archive one type into `google_points`.
///
/// `archive` is `(from, until)` by UTC date, read a month at a time. Without
/// it, the routine sync: from a day before the type's newest stored start, or a
/// week back when none is stored. A type with no filter field is read whole.
///
/// ⚠ HOLES ONLY (`INSERT IGNORE` on user, type, start, source, seq — see
/// `number_points`): a stored point
/// keeps its row. The returned pair is `(fetched, written)`; a fetched point
/// that wrote nothing was already stored, or collided on the key — the log
/// says how many, rather than hiding it.
pub async fn archive_points(
    pool: &MySqlPool,
    http: &reqwest::Client,
    access_token: &str,
    user_id: &str,
    data_type: &str,
    archive: Option<(chrono::NaiveDate, chrono::NaiveDate)>,
) -> Result<(usize, u64)> {
    let Some(&(_, key, field)) = ARCHIVE_TYPES.iter().find(|t| t.0 == data_type) else {
        anyhow::bail!("{data_type} is not an archived type");
    };
    let snake = data_type.replace('-', "_");
    let windows: Vec<Option<(String, Option<String>)>> = if field.is_empty() {
        vec![None]
    } else if let Some((from, until)) = archive {
        anyhow::ensure!(
            from < until,
            "an archive range must not be empty ({from} → {until})"
        );
        let mut out = Vec::new();
        let mut a = from;
        while a < until {
            let b = (a + chrono::Duration::days(WINDOW_DAYS)).min(until);
            out.push(Some((
                format!("{a}T00:00:00Z"),
                Some(format!("{b}T00:00:00Z")),
            )));
            a = b;
        }
        out
    } else {
        let high: Option<String> = sqlx::query_scalar(
            "SELECT CAST(MAX(start_utc) AS CHAR) FROM google_points \
             WHERE user_id = ? AND data_type = ?",
        )
        .bind(user_id)
        .bind(data_type)
        .fetch_one(pool)
        .await
        .with_context(|| format!("reading the {data_type} high-water mark"))?;
        let since = match &high {
            Some(ts) => {
                chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%d %H:%M:%S%.f")
                    .with_context(|| format!("unreadable {data_type} high-water mark {ts:?}"))?
                    - chrono::Duration::days(1)
            }
            None => (chrono::Utc::now() - chrono::Duration::days(7)).naive_utc(),
        };
        vec![Some((since.format("%Y-%m-%dT%H:%M:%SZ").to_string(), None))]
    };

    let (mut fetched, mut written, mut unreadable) = (0usize, 0u64, 0usize);
    for w in &windows {
        let points = match w {
            None => crate::google::health::fetch_all_points(http, access_token, data_type).await,
            Some((since, before)) => {
                let f = format!("{snake}.{field}");
                let filter = match before {
                    Some(b) => format!("{f} >= \"{since}\" AND {f} < \"{b}\""),
                    None => format!("{f} >= \"{since}\""),
                };
                crate::google::health::fetch_points_filtered(http, access_token, data_type, &filter)
                    .await
            }
        }
        .with_context(|| format!("fetching {data_type}"))?;
        let rows = number_points(points.iter().filter_map(|p| parse_point(p, key)).collect());
        fetched += points.len();
        unreadable += points.len() - rows.len();
        let mut tx = pool
            .begin()
            .await
            .context("opening the google_points transaction")?;
        for batch in rows.chunks(BATCH_ROWS) {
            let mut qb: sqlx::QueryBuilder<sqlx::MySql> = sqlx::QueryBuilder::new(
                "INSERT IGNORE INTO google_points (user_id, data_type, start_utc, end_utc, \
                 start_ts, start_offset_s, end_offset_s, source, seq, payload) ",
            );
            qb.push_values(batch, |mut row, (r, seq)| {
                row.push_bind(user_id)
                    .push_bind(data_type)
                    .push_bind(&r.start_utc)
                    .push_bind(&r.end_utc)
                    .push_bind(&r.start_ts)
                    .push_bind(r.start_offset_s)
                    .push_bind(r.end_offset_s)
                    .push_bind(&r.source)
                    .push_bind(seq)
                    .push_bind(r.payload.to_string());
            });
            written += qb
                .build()
                .execute(&mut *tx)
                .await
                .with_context(|| format!("writing a batch of {data_type}"))?
                .rows_affected();
        }
        tx.commit().await.context("committing google_points")?;
        if let (Some(_), Some((since, _))) = (archive, w) {
            tracing::info!(
                "[{user_id}] google archive {data_type} {since}: {} point(s)",
                rows.len()
            );
        }
    }
    tracing::info!(
        "[{user_id}] google_points {data_type}: {written} new of {fetched} fetched, {unreadable} unreadable"
    );
    Ok((fetched, written))
}

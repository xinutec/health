//! Google Health API v4 — the weight feed. Port of `src/google/health.ts`.
//!
//! Unified data model: `GET /v4/users/me/dataTypes/{type}/dataPoints`, paged.

use anyhow::{Context, Result, anyhow};
use serde::Deserialize;
use std::collections::BTreeMap;

use crate::lean::Weigh;

const BASE: &str = "https://health.googleapis.com/v4";

/// Pages requested at a time. Google's maximum; the whole history is ~150
/// weigh-ins, so this is one page in practice and the loop is for correctness
/// rather than for volume.
const PAGE_SIZE: u32 = 1000;

/// A bound on the page walk.
///
/// ⚠ NOT expected to be reached — it exists because a `nextPageToken` that
/// never changes is an infinite loop against a paid API, and the failure mode
/// of "hangs until the job deadline kills it" is much worse to diagnose than a
/// refusal that names the cause.
const MAX_PAGES: u32 = 100;

#[derive(Debug, Deserialize)]
struct CivilDate {
    year: i64,
    month: u32,
    day: u32,
}

#[derive(Debug, Deserialize)]
struct CivilTime {
    date: Option<CivilDate>,
}

#[derive(Debug, Deserialize)]
struct SampleTime {
    #[serde(rename = "physicalTime")]
    physical_time: Option<String>,
    #[serde(rename = "civilTime")]
    civil_time: Option<CivilTime>,
}

#[derive(Debug, Deserialize)]
struct WeightPoint {
    /// ⚠ Google sends this as a NUMBER or a STRING depending on magnitude —
    /// the JSON mapping for int64 quotes large values. `serde_json::Value` and
    /// an explicit coercion, because a plain `i64` silently fails to decode the
    /// quoted form and the point is then dropped as malformed.
    #[serde(rename = "weightGrams")]
    weight_grams: Option<serde_json::Value>,
    #[serde(rename = "sampleTime")]
    sample_time: Option<SampleTime>,
}

#[derive(Debug, Deserialize)]
struct DataPoint {
    weight: Option<WeightPoint>,
}

#[derive(Debug, Deserialize)]
struct ListResponse {
    #[serde(rename = "dataPoints")]
    data_points: Option<Vec<DataPoint>>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
}

fn grams(v: &serde_json::Value) -> Option<i64> {
    match v {
        serde_json::Value::Number(n) => n.as_i64(),
        serde_json::Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

/// Map one page's data points, skipping those that cannot name a day or a mass.
///
/// ⚠ A point missing either field is DROPPED rather than refused, matching the
/// TypeScript's `continue`. That is safe only because the dedup downstream keys
/// on the civil date: a point with no date cannot place itself, so keeping it
/// would mean inventing one. It is NOT safe to extend this to other fields —
/// dropping a point can move the replace boundary and strand stale rows.
pub fn parse_page(body: &str) -> Result<(Vec<Weigh>, Option<String>)> {
    let page: ListResponse = serde_json::from_str(body).context("decoding a google weight page")?;
    let mut out = Vec::new();
    for p in page.data_points.unwrap_or_default() {
        let Some(w) = p.weight else { continue };
        let Some(g) = w.weight_grams.as_ref().and_then(grams) else {
            continue;
        };
        let Some(date) = w
            .sample_time
            .as_ref()
            .and_then(|s| s.civil_time.as_ref())
            .and_then(|c| c.date.as_ref())
        else {
            continue;
        };
        out.push(Weigh {
            // The same `YYYY-MM-DD` the TypeScript builds by padding. Not routed
            // through `Verified.Civil.formatDate`: these three integers are
            // Google's own civil date, already split, so there is no arithmetic
            // to get wrong — only zero-padding.
            date: format!("{:04}-{:02}-{:02}", date.year, date.month, date.day),
            grams: g,
            ts: w
                .sample_time
                .as_ref()
                .and_then(|s| s.physical_time.clone())
                .unwrap_or_default(),
        });
    }
    Ok((out, page.next_page_token.filter(|t| !t.is_empty())))
}

/// Every weigh-in for the authenticated user, following pagination.
pub async fn fetch_all_weight(http: &reqwest::Client, access_token: &str) -> Result<Vec<Weigh>> {
    let mut out = Vec::new();
    let mut page_token: Option<String> = None;
    let mut pages = 0u32;

    loop {
        let mut url = reqwest::Url::parse(&format!("{BASE}/users/me/dataTypes/weight/dataPoints"))
            .context("building the weight URL")?;
        url.query_pairs_mut()
            .append_pair("pageSize", &PAGE_SIZE.to_string());
        if let Some(t) = &page_token {
            url.query_pairs_mut().append_pair("pageToken", t);
        }

        let res = http
            .get(url)
            .bearer_auth(access_token)
            .send()
            .await
            .context("GET google health weight")?;
        let status = res.status();
        let body = res.text().await.context("body of the weight page")?;
        if !status.is_success() {
            return Err(anyhow!(
                "health weight {}: {}",
                status.as_u16(),
                body.chars().take(400).collect::<String>()
            ));
        }

        let (mut points, next) = parse_page(&body)?;
        out.append(&mut points);

        pages += 1;
        match next {
            None => break,
            // ⚠ A token identical to the one just used is a server-side loop,
            // not more data. Caught explicitly so it reads as what it is.
            Some(t) if Some(&t) == page_token.as_ref() => {
                return Err(anyhow!("google weight paging repeated its page token"));
            }
            Some(_) if pages >= MAX_PAGES => {
                return Err(anyhow!(
                    "google weight paging exceeded {MAX_PAGES} pages ({} points so far)",
                    out.len()
                ));
            }
            Some(t) => page_token = Some(t),
        }
    }
    Ok(out)
}

/// A civil day and one aggregated number for it.
///
/// ⚠ The rollup carries `civilStartTime`/`civilEndTime`, not a `date`. The day
/// is the START — an `end` of the following midnight is the exclusive bound, so
/// keying on it would file every value one day late.
#[derive(Debug, Clone, PartialEq)]
pub struct DailyValue {
    /// `YYYY-MM-DD`, from `civilStartTime`.
    pub date: String,
    /// The type's own summed field, as a JSON number — `steps.countSum`,
    /// `distance.millimetersSum`, `totalCalories.kcalSum`. Kept as `f64`
    /// because the units differ per type and the caller knows which it asked
    /// for; narrowing here would need a table this layer has no reason to hold.
    pub value: f64,
}

/// The per-type ceiling on `windowSizeDays * pageSize`.
///
/// ⚠ NOT A PAGE SIZE. Google bounds the DURATION a page implies, so a pageSize
/// of 100 with the default one-day window asks for 100 days and is refused —
/// reported as `INVALID_ROLLUP_QUERY_DURATION` against `range`, which is
/// blameless. Measured 2026-08-27: 90 for steps/distance/floors/altitude,
/// 14 for active-minutes and total-calories.
///
/// 14 is every type's floor, so one width is always legal. A caller wanting a
/// longer span asks for more windows, not a bigger page.
const ROLLUP_MAX_DAYS: i64 = 14;

/// One rollup point mapped to a civil day and its summed value, or `None`.
///
/// Split out of the fetch so the part that can file data on the WRONG DAY is
/// testable without the live API.
pub fn day_of_rollup_point(pt: &serde_json::Value, sum_field: &str) -> Option<DailyValue> {
    let date = pt.get("civilStartTime")?.get("date")?;
    let y = date.get("year")?.as_i64()?;
    let m = date.get("month")?.as_i64()?;
    let d = date.get("day")?.as_i64()?;
    // ⚠ An absent sum is DROPPED, never defaulted. Zero steps is a real reading;
    // a missing one is not, and writing 0 turns a gap into a claim.
    //
    // ⚠ `numeric`, not `as_f64` — the rollup sums are the source for most of
    // `daily_activity`, and a quoted one would drop the whole stream exactly as
    // it did for resting heart rate.
    let value = numeric(pt.pointer(sum_field)?)?;
    Some(DailyValue {
        date: format!("{y:04}-{m:02}-{d:02}"),
        value,
    })
}

/// Read `[start, end)` of one rollup type, in legal-width chunks.
///
/// ⚠ HALF-OPEN, matching the API: "the inclusive start" and "the exclusive
/// end". A caller passing the same date twice gets nothing, not one day.
pub async fn fetch_daily_rollup(
    http: &reqwest::Client,
    access_token: &str,
    data_type: &str,
    start: chrono::NaiveDate,
    end: chrono::NaiveDate,
    sum_field: &str,
) -> Result<Vec<DailyValue>> {
    use chrono::Datelike as _;

    if start >= end {
        return Ok(Vec::new());
    }
    let civil = |d: chrono::NaiveDate| serde_json::json!({ "date": { "year": d.year(), "month": d.month(), "day": d.day() } });

    let mut out = Vec::new();
    let mut chunk_start = start;
    while chunk_start < end {
        let chunk_end = std::cmp::min(chunk_start + chrono::Duration::days(ROLLUP_MAX_DAYS), end);
        let span = (chunk_end - chunk_start).num_days();
        let body = serde_json::json!({
            "range": { "start": civil(chunk_start), "end": civil(chunk_end) },
            // One page per chunk: the chunk is already sized to the cap.
            "pageSize": span,
        });

        let url = format!("{BASE}/users/me/dataTypes/{data_type}/dataPoints:dailyRollUp");
        let res = http
            .post(&url)
            .bearer_auth(access_token)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("POST dailyRollUp {data_type}"))?;
        let status = res.status();
        let text = res
            .text()
            .await
            .with_context(|| format!("body of the {data_type} rollup"))?;
        if !status.is_success() {
            return Err(anyhow!(
                "{data_type} rollup {} over {chunk_start}..{chunk_end}: {}",
                status.as_u16(),
                text.chars().take(400).collect::<String>()
            ));
        }

        let page: serde_json::Value = serde_json::from_str(&text)
            .with_context(|| format!("decoding the {data_type} rollup"))?;
        // ⚠ `rollupDataPoints`, NOT `dataPoints` — a different key from `list`,
        // and reading the wrong one reports every type as empty.
        for pt in page
            .get("rollupDataPoints")
            .and_then(|p| p.as_array())
            .map(|v| v.as_slice())
            .unwrap_or_default()
        {
            if let Some(v) = day_of_rollup_point(pt, sum_field) {
                out.push(v);
            }
        }
        chunk_start = chunk_end;
    }
    Ok(out)
}

/// Every point of a one-per-day type, as `(civil date, value)`.
///
/// ⚠ USES `list`, NOT `dailyRollUp`. The daily aggregates ARE sample types
/// here — `daily-respiratory-rate` and friends answer `list` and REFUSE
/// `dailyRollUp` ("the following actions are supported: list, reconcile"). The
/// two shapes are not interchangeable and picking the wrong one returns 400 or,
/// worse, 200 and nothing.
///
/// ⚠ The list is ordered NEWEST FIRST with no ascending sort, so this walks
/// every page to see the whole series. That is a few pages for a daily
/// aggregate and must never be pointed at an intraday type.
pub async fn fetch_daily_series(
    http: &reqwest::Client,
    access_token: &str,
    data_type: &str,
    value_pointer: &str,
) -> Result<Vec<DailyValue>> {
    Ok(fetch_all_points(http, access_token, data_type)
        .await?
        .iter()
        .filter_map(|pt| day_of_list_point(pt, value_pointer))
        .collect())
}

/// Every `list` point of a data type, paged, as raw JSON.
///
/// The paging is identical for every `list` type; only what you do with a point
/// differs. {@link fetch_daily_series} is the one-value-per-day reading of this;
/// the intraday and sleep writers need the whole point, because a sleep record
/// carries stages and awakenings and a heart-rate point carries a timestamp to
/// the second.
///
/// ⚠ `list` IS NEWEST FIRST and there is no ascending sort, so a caller that
/// wants chronological order must sort. Nothing here does it, because the
/// writers key on a primary key and do not care.
pub async fn fetch_all_points(
    http: &reqwest::Client,
    access_token: &str,
    data_type: &str,
) -> Result<Vec<serde_json::Value>> {
    fetch_points(http, access_token, data_type, None).await
}

/// {@link fetch_all_points}, bounded by an AIP-160 `filter` expression.
///
/// # ⚠ AN INTRADAY TYPE CANNOT BE WALKED WITHOUT ONE
///
/// `heart-rate` carries ~34,000 points a day and the list is newest-first with
/// no ascending sort, so the unbounded walk hits `MAX_PAGES` years short of the
/// oldest point — it cannot ever finish, only fail. The filter is how the API
/// bounds a walk by time. The fields are the PROTO names, snake_case, NOT the
/// camelCase the JSON payload spells them with:
///
///   heart_rate.sample_time.physical_time >= "2026-08-25T00:00:00Z"
///     AND heart_rate.sample_time.physical_time < "2026-09-01T00:00:00Z"
///
/// Only `>=` and `<` are documented, and the field family follows the type's
/// shape: `sample_time` for sample types, `interval.start_time` for interval
/// types, `interval.end_time` for sleep sessions.
pub async fn fetch_points_filtered(
    http: &reqwest::Client,
    access_token: &str,
    data_type: &str,
    filter: &str,
) -> Result<Vec<serde_json::Value>> {
    fetch_points(http, access_token, data_type, Some(filter)).await
}

async fn fetch_points(
    http: &reqwest::Client,
    access_token: &str,
    data_type: &str,
    filter: Option<&str>,
) -> Result<Vec<serde_json::Value>> {
    let mut out = Vec::new();
    let mut page_token: Option<String> = None;
    let mut pages = 0u32;

    loop {
        let mut url =
            reqwest::Url::parse(&format!("{BASE}/users/me/dataTypes/{data_type}/dataPoints"))
                .with_context(|| format!("building the {data_type} URL"))?;
        // ⚠ 10,000 — the documented maximum — WHEN FILTERED, because filtered
        // means intraday and 1,000 per page turns one week of heart-rate into
        // 24 round trips. Unfiltered stays at 1,000: that path is the daily
        // aggregates, one page either way, and it is the page size every prod
        // comparison to date ran under.
        url.query_pairs_mut()
            .append_pair("pageSize", if filter.is_some() { "10000" } else { "1000" });
        if let Some(f) = filter {
            url.query_pairs_mut().append_pair("filter", f);
        }
        if let Some(t) = &page_token {
            url.query_pairs_mut().append_pair("pageToken", t);
        }

        let res = http
            .get(url)
            .bearer_auth(access_token)
            .send()
            .await
            .with_context(|| format!("GET {data_type}"))?;
        let status = res.status();
        let body = res
            .text()
            .await
            .with_context(|| format!("body of a {data_type} page"))?;
        if !status.is_success() {
            return Err(anyhow!(
                "{data_type} {}: {}",
                status.as_u16(),
                body.chars().take(400).collect::<String>()
            ));
        }
        let page: serde_json::Value =
            serde_json::from_str(&body).with_context(|| format!("decoding a {data_type} page"))?;

        for pt in page
            .get("dataPoints")
            .and_then(|p| p.as_array())
            .map(|v| v.as_slice())
            .unwrap_or_default()
        {
            out.push(pt.clone());
        }

        pages += 1;
        match page.get("nextPageToken").and_then(|t| t.as_str()) {
            Some(t) if !t.is_empty() => {
                // ⚠ Same guards as the weight walk: a token that never changes
                // is a server-side loop, not more data.
                if Some(t) == page_token.as_deref() {
                    return Err(anyhow!("{data_type} paging repeated its page token"));
                }
                if pages >= MAX_PAGES {
                    return Err(anyhow!(
                        "{data_type} paging exceeded {MAX_PAGES} pages ({} points so far)",
                        out.len()
                    ));
                }
                page_token = Some(t.to_string());
            }
            _ => break,
        }
    }
    Ok(out)
}

/// One `list` point mapped to its civil day and a value at `value_pointer`.
///
/// ⚠ The date lives under the TYPE's own key — `dailyRespiratoryRate.date`,
/// `dailyOxygenSaturation.date` — so it is found by SHAPE (an object carrying
/// year/month/day) rather than by a path table of guesses.
/// A Google `civilTime` object as a MariaDB `DATETIME` string.
///
/// ⚠ `seconds` is OPTIONAL — the heart-rate samples carry it, the daily types
/// do not, and a missing one means zero rather than an unreadable point.
pub fn civil_datetime(v: Option<&serde_json::Value>) -> Option<String> {
    let v = v?;
    let d = v.get("date")?;
    let t = v.get("time")?;
    Some(format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        d.get("year")?.as_i64()?,
        d.get("month")?.as_i64()?,
        d.get("day")?.as_i64()?,
        t.get("hours").and_then(|x| x.as_i64()).unwrap_or(0),
        t.get("minutes").and_then(|x| x.as_i64()).unwrap_or(0),
        t.get("seconds").and_then(|x| x.as_i64()).unwrap_or(0),
    ))
}

/// An RFC-3339 instant as a UTC `DATETIME` string.
///
/// ⚠ Parsed, not string-sliced. Google's `physicalTime` is a true instant and
/// may carry any offset; taking the first 19 characters would store a local
/// clock in the UTC column on any point that is not already `Z`.
pub fn rfc3339_to_utc_datetime(s: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.naive_utc().format("%Y-%m-%d %H:%M:%S").to_string())
}

/// A UTC `DATETIME` string as the RFC-3339 instant a `filter` expression wants.
///
/// The inverse of {@link rfc3339_to_utc_datetime}, for turning a stored
/// high-water mark (`MAX(ts_utc)`) back into a `physical_time >= "…"` bound.
/// Parsed, not string-spliced, so a malformed readout is a `None` rather than a
/// filter the API rejects at run time.
pub fn utc_datetime_to_rfc3339(s: &str) -> Option<String> {
    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

/// A physical instant plus its protobuf-Duration offset (`"3600s"`) as the
/// LOCAL wall-clock `DATETIME` string.
///
/// # Why this exists at all
///
/// Sleep sessions and step intervals carry NO civil fields — unlike the sample
/// types, whose `sampleTime.civilTime` is served ready-made. The wall clock the
/// tables key on has to be derived, and physical + utcOffset is the derivation
/// Google itself intends (the offset is served beside every timestamp).
///
/// ⚠ Both halves parsed, neither spliced: an offset like `"-3600s"` must move
/// the clock BACK, and a truncation-based reading would quietly keep UTC.
pub fn wall_clock_from_physical(physical: &str, offset: &str) -> Option<String> {
    let secs: i64 = offset.strip_suffix('s')?.parse().ok()?;
    chrono::DateTime::parse_from_rfc3339(physical)
        .ok()
        .map(|dt| {
            (dt.naive_utc() + chrono::Duration::seconds(secs))
                .format("%Y-%m-%d %H:%M:%S")
                .to_string()
        })
}

/// One stage entry of a parsed sleep session.
pub struct GoogleSleepStage {
    /// Local wall clock, the `sleep_stages.ts` key.
    pub ts: String,
    /// The physical instant, for `ts_utc`.
    pub ts_utc: String,
    /// Fitbit's level vocabulary — `deep`/`light`/`rem`/`wake` for a STAGES
    /// session — so the rows land beside the Fitbit-written ones unchanged.
    pub stage: String,
    pub duration_seconds: i64,
}

/// One Google sleep session, in the shape the `sleep` table wants.
pub struct GoogleSleepSession {
    /// Parsed from the dataPoint `name`'s last path segment. It is
    /// Fitbit-logId-SIZED (18-19 digits) but equality with Fitbit's ids is
    /// UNVERIFIED — nothing may depend on it. The `(user_id, start_time,
    /// is_main_sleep)` unique key is what merges a night written by both.
    pub log_id: i64,
    /// The civil date the sleep ENDED — Fitbit's `dateOfSleep` convention.
    pub date: String,
    pub start_time: String,
    pub end_time: String,
    pub start_time_utc: String,
    pub end_time_utc: String,
    pub duration_ms: i64,
    /// Derived: `minutesAsleep / minutesInSleepPeriod`, rounded to a percent.
    /// Whether that IS Fitbit's statistic is the comparison's question, not an
    /// assumption of this parser.
    pub efficiency: i64,
    pub minutes_asleep: i64,
    pub minutes_awake: i64,
    pub minutes_deep: Option<i64>,
    pub minutes_light: Option<i64>,
    pub minutes_rem: Option<i64>,
    pub minutes_wake: Option<i64>,
    pub is_main_sleep: bool,
    pub stages: Vec<GoogleSleepStage>,
}

/// Google's stage vocabulary as Fitbit's level strings.
///
/// ⚠ CONDITIONAL ON THE SESSION TYPE. For a `STAGES` session `AWAKE` is
/// Fitbit's `wake`; a `CLASSIC` session's levels (`ASLEEP`/`RESTLESS`/`AWAKE`)
/// lowercase as themselves, where `awake` is correct. Collapsing the two would
/// write `wake` rows into a classic night that Fitbit spelled `awake`.
fn stage_level(session_type: &str, google_type: &str) -> String {
    if session_type == "STAGES" && google_type == "AWAKE" {
        return "wake".to_string();
    }
    google_type.to_ascii_lowercase()
}

/// A `sleep` dataPoint as the row set to write, or `None` with the reason
/// counted by the caller.
///
/// ⚠ Every summary minute is a QUOTED number — `numeric`, never `as_i64`.
pub fn parse_sleep_point(pt: &serde_json::Value) -> Option<GoogleSleepSession> {
    let sl = pt.get("sleep")?;
    let log_id: i64 = pt
        .get("name")
        .and_then(|v| v.as_str())
        .and_then(|n| n.rsplit('/').next())
        .and_then(|id| id.parse().ok())?;
    let iv = sl.get("interval")?;
    let (start_p, start_off) = (
        iv.get("startTime")?.as_str()?,
        iv.get("startUtcOffset")?.as_str()?,
    );
    let (end_p, end_off) = (
        iv.get("endTime")?.as_str()?,
        iv.get("endUtcOffset")?.as_str()?,
    );
    let start_time = wall_clock_from_physical(start_p, start_off)?;
    let end_time = wall_clock_from_physical(end_p, end_off)?;
    let start_time_utc = rfc3339_to_utc_datetime(start_p)?;
    let end_time_utc = rfc3339_to_utc_datetime(end_p)?;
    let duration_ms = (chrono::DateTime::parse_from_rfc3339(end_p).ok()?
        - chrono::DateTime::parse_from_rfc3339(start_p).ok()?)
    .num_milliseconds();

    let summary = sl.get("summary")?;
    let mins = |k: &str| summary.get(k).and_then(numeric).map(|v| v.round() as i64);
    let minutes_asleep = mins("minutesAsleep")?;
    let minutes_awake = mins("minutesAwake")?;
    let in_period = mins("minutesInSleepPeriod")?;
    // Integer percent, like Fitbit stores. A zero-length period cannot divide;
    // 0 is the honest readout for a record that slept no minutes of none.
    let efficiency = if in_period > 0 {
        ((minutes_asleep as f64 / in_period as f64) * 100.0).round() as i64
    } else {
        0
    };

    let session_type = sl.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let mut by_stage: BTreeMap<String, i64> = BTreeMap::new();
    for e in summary
        .get("stagesSummary")
        .and_then(|v| v.as_array())
        .map(|v| v.as_slice())
        .unwrap_or_default()
    {
        if let (Some(t), Some(m)) = (
            e.get("type").and_then(|v| v.as_str()),
            e.get("minutes").and_then(numeric),
        ) {
            by_stage.insert(stage_level(session_type, t), m.round() as i64);
        }
    }

    let stages = sl
        .get("stages")
        .and_then(|v| v.as_array())
        .map(|v| v.as_slice())
        .unwrap_or_default()
        .iter()
        .filter_map(|e| {
            let (sp, so) = (
                e.get("startTime")?.as_str()?,
                e.get("startUtcOffset")?.as_str()?,
            );
            let ep = e.get("endTime")?.as_str()?;
            let dur = (chrono::DateTime::parse_from_rfc3339(ep).ok()?
                - chrono::DateTime::parse_from_rfc3339(sp).ok()?)
            .num_seconds();
            Some(GoogleSleepStage {
                ts: wall_clock_from_physical(sp, so)?,
                ts_utc: rfc3339_to_utc_datetime(sp)?,
                stage: stage_level(session_type, e.get("type")?.as_str()?),
                duration_seconds: dur,
            })
        })
        .collect();

    Some(GoogleSleepSession {
        log_id,
        // The END's civil date — `end_time` is `YYYY-MM-DD HH:MM:SS`.
        date: end_time[..10].to_string(),
        start_time,
        end_time,
        start_time_utc,
        end_time_utc,
        duration_ms,
        efficiency,
        minutes_asleep,
        minutes_awake,
        minutes_deep: by_stage.get("deep").copied(),
        minutes_light: by_stage.get("light").copied(),
        minutes_rem: by_stage.get("rem").copied(),
        minutes_wake: by_stage.get("wake").copied(),
        is_main_sleep: sl
            .pointer("/metadata/mainSleep")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        stages,
    })
}

/// A JSON number, whether or not Google quoted it.
///
/// ⚠ **A QUOTED NUMBER IS NOT AN ABSENT ONE.** `as_f64()` returns `None` on a
/// string, so a field Google serialises as `"62"` is dropped exactly like a
/// missing one — and a whole stream of them reports as zero days, which reads as
/// "Google does not carry this". Measured 2026-08-28:
/// `dailyRestingHeartRate.beatsPerMinute` is a STRING, and 1258 real points were
/// being discarded silently while `google-compare` printed `google 0 days`.
///
/// ⚠ This is NOT a permissive fallback. A string that does not parse still
/// yields `None`, because a value we cannot read is not a value we may guess.
/// The types differ per FIELD, not per stream, so this cannot be decided once at
/// the call site.
pub fn numeric(v: &serde_json::Value) -> Option<f64> {
    match v {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

pub fn day_of_list_point(pt: &serde_json::Value, value_pointer: &str) -> Option<DailyValue> {
    fn find_ymd(v: &serde_json::Value) -> Option<(i64, i64, i64)> {
        match v {
            serde_json::Value::Object(m) => {
                if let (Some(y), Some(mo), Some(d)) = (m.get("year"), m.get("month"), m.get("day"))
                    && let (Some(y), Some(mo), Some(d)) = (y.as_i64(), mo.as_i64(), d.as_i64())
                {
                    return Some((y, mo, d));
                }
                m.values().find_map(find_ymd)
            }
            serde_json::Value::Array(a) => a.iter().find_map(find_ymd),
            _ => None,
        }
    }
    let (y, m, d) = find_ymd(pt)?;
    // ⚠ Absent is dropped, never defaulted — a missing reading is not a zero one.
    let value = numeric(pt.pointer(value_pointer)?)?;
    Some(DailyValue {
        date: format!("{y:04}-{m:02}-{d:02}"),
        value,
    })
}

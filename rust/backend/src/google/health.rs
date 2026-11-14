//! Google Health API v4 — the client every Google stream reads through: paged
//! `dataPoints` walks, filtered walks, the daily roll-up and the typed fetchers.
//! Unified data model: `GET /v4/users/me/dataTypes/{type}/dataPoints`, paged.

use anyhow::{Context, Result, anyhow};
use serde::Deserialize;
use std::collections::BTreeMap;

use crate::lean::Weigh;

pub(crate) const BASE: &str = "https://health.googleapis.com/v4";

/// Page size for the weight walk: Google's maximum, so the weigh-in history is
/// one page and the loop is for correctness.
const PAGE_SIZE: u32 = 1000;

/// A bound on the page walk: a `nextPageToken` that never changes would loop
/// against a paid API, and a refusal naming the cause beats a hang.
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
    /// A number or a quoted string depending on magnitude (int64's JSON
    /// mapping), so `Value` plus coercion: a plain `i64` drops the quoted form.
    #[serde(rename = "weightGrams")]
    weight_grams: Option<serde_json::Value>,
    #[serde(rename = "sampleTime")]
    sample_time: Option<SampleTime>,
}

#[derive(Debug, Deserialize)]
struct BodyFatPoint {
    percentage: Option<f64>,
    #[serde(rename = "sampleTime")]
    sample_time: Option<SampleTime>,
}

#[derive(Debug, Deserialize)]
struct DataPoint {
    weight: Option<WeightPoint>,
    #[serde(rename = "bodyFat")]
    body_fat: Option<BodyFatPoint>,
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

/// Map one page's data points, dropping those without a day or a mass: the
/// dedup keys on the civil date, so a dateless point cannot be placed. Do not
/// extend the dropping to other fields, which could move the replace boundary.
pub fn parse_page(body: &str) -> Result<(Vec<Weigh>, Option<String>)> {
    let page: ListResponse = serde_json::from_str(body).context("decoding a google weight page")?;
    let mut out = Vec::new();
    for p in page.data_points.unwrap_or_default() {
        let Some(w) = p.weight else { continue };
        let Some(g) = w.weight_grams.as_ref().and_then(grams) else {
            continue;
        };
        if let Some(r) = reading(w.sample_time.as_ref(), g) {
            out.push(r);
        }
    }
    Ok((out, page.next_page_token.filter(|t| !t.is_empty())))
}

/// [`parse_page`] for `body-fat`. Each reading is a [`Weigh`] whose `grams`
/// holds the percentage in thousandths (18.3 % → 18 300), so the same
/// latest-per-day rule picks the day's value; [`body_fat_pct`] turns it back.
pub fn parse_body_fat_page(body: &str) -> Result<(Vec<Weigh>, Option<String>)> {
    let page: ListResponse =
        serde_json::from_str(body).context("decoding a google body-fat page")?;
    let mut out = Vec::new();
    for p in page.data_points.unwrap_or_default() {
        let Some(f) = p.body_fat else { continue };
        let Some(pct) = f.percentage.filter(|v| v.is_finite()) else {
            continue;
        };
        if let Some(r) = reading(f.sample_time.as_ref(), (pct * 1000.0).round() as i64) {
            out.push(r);
        }
    }
    Ok((out, page.next_page_token.filter(|t| !t.is_empty())))
}

/// A body-fat reading's percentage, from [`parse_body_fat_page`]'s encoding.
pub fn body_fat_pct(r: &Weigh) -> f64 {
    r.grams as f64 / 1000.0
}

/// One dated reading, or `None` when the point cannot name its civil day.
fn reading(sample_time: Option<&SampleTime>, value: i64) -> Option<Weigh> {
    let date = sample_time?.civil_time.as_ref()?.date.as_ref()?;
    Some(Weigh {
        // Zero-padded `YYYY-MM-DD` of Google's own civil date: no arithmetic,
        // so not via `Verified.Civil.formatDate`.
        date: format!("{:04}-{:02}-{:02}", date.year, date.month, date.day),
        grams: value,
        ts: sample_time
            .and_then(|s| s.physical_time.clone())
            .unwrap_or_default(),
    })
}

/// Every weigh-in for the authenticated user, following pagination.
pub async fn fetch_all_weight(http: &reqwest::Client, access_token: &str) -> Result<Vec<Weigh>> {
    fetch_all_readings(http, access_token, "weight", parse_page).await
}

/// Every body-fat reading (the Hume scale's, via Health Connect), following
/// pagination. See [`parse_body_fat_page`] for the encoding.
pub async fn fetch_all_body_fat(http: &reqwest::Client, access_token: &str) -> Result<Vec<Weigh>> {
    fetch_all_readings(http, access_token, "body-fat", parse_body_fat_page).await
}

type PageParser = fn(&str) -> Result<(Vec<Weigh>, Option<String>)>;

async fn fetch_all_readings(
    http: &reqwest::Client,
    access_token: &str,
    data_type: &str,
    parse: PageParser,
) -> Result<Vec<Weigh>> {
    let mut out = Vec::new();
    let mut page_token: Option<String> = None;
    let mut pages = 0u32;

    loop {
        let mut url =
            reqwest::Url::parse(&format!("{BASE}/users/me/dataTypes/{data_type}/dataPoints"))
                .context("building the readings URL")?;
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
            .with_context(|| format!("GET google health {data_type}"))?;
        let status = res.status();
        let body = res
            .text()
            .await
            .with_context(|| format!("body of the {data_type} page"))?;
        if !status.is_success() {
            return Err(anyhow!(
                "health {data_type} {}: {}",
                status.as_u16(),
                body.chars().take(400).collect::<String>()
            ));
        }

        let (mut points, next) = parse(&body)?;
        out.append(&mut points);

        pages += 1;
        match next {
            None => break,
            // A token identical to the one just used is a server-side loop,
            // not more data. Caught explicitly so it reads as what it is.
            Some(t) if Some(&t) == page_token.as_ref() => {
                return Err(anyhow!("google {data_type} paging repeated its page token"));
            }
            Some(_) if pages >= MAX_PAGES => {
                return Err(anyhow!(
                    "google {data_type} paging exceeded {MAX_PAGES} pages ({} points so far)",
                    out.len()
                ));
            }
            Some(t) => page_token = Some(t),
        }
    }
    Ok(out)
}

/// A civil day and one aggregated number. The day is `civilStartTime`; the end
/// is the exclusive next midnight, and keying on it would file a day late.
#[derive(Debug, Clone, PartialEq)]
pub struct DailyValue {
    /// `YYYY-MM-DD`, from `civilStartTime`.
    pub date: String,
    /// The type's summed field (`steps.countSum`, `distance.millimetersSum`,
    /// …), as `f64`: units differ per type and the caller knows which it asked.
    pub value: f64,
}

/// The per-type ceiling on `windowSizeDays * pageSize` (90 days for steps,
/// distance, floors and altitude, 14 for active-minutes and total-calories),
/// which Google reports against the blameless `range`. 14 is legal for every
/// type; a longer span takes more windows.
const ROLLUP_MAX_DAYS: i64 = 14;

/// One rollup point as a civil day and its sum, or `None`; separate from the
/// fetch so filing a day is testable without the API.
pub fn day_of_rollup_point(pt: &serde_json::Value, sum_field: &str) -> Option<DailyValue> {
    let date = pt.get("civilStartTime")?.get("date")?;
    let y = date.get("year")?.as_i64()?;
    let m = date.get("month")?.as_i64()?;
    let d = date.get("day")?.as_i64()?;
    // An absent sum is dropped, never defaulted: zero steps is a reading, a gap
    // is not. `numeric`, not `as_f64`: a quoted sum would drop the stream.
    let value = numeric(pt.pointer(sum_field)?)?;
    Some(DailyValue {
        date: format!("{y:04}-{m:02}-{d:02}"),
        value,
    })
}

/// One day of the `active-minutes` rollup: minutes at each level.
#[derive(Debug, Clone, PartialEq)]
pub struct ActiveMinutesDay {
    pub date: String,
    pub light: f64,
    pub moderate: f64,
    pub vigorous: f64,
}

/// Read one `active-minutes` rollup point. A level absent from the day's
/// breakdown is zero minutes at it; a point with no breakdown is no reading.
pub fn active_minutes_of_rollup_point(pt: &serde_json::Value) -> Option<ActiveMinutesDay> {
    let date = pt.get("civilStartTime")?.get("date")?;
    let (y, m, d) = (
        date.get("year")?.as_i64()?,
        date.get("month")?.as_i64()?,
        date.get("day")?.as_i64()?,
    );
    let levels = pt
        .pointer("/activeMinutes/activeMinutesRollupByActivityLevel")?
        .as_array()?;
    let at = |name: &str| {
        levels
            .iter()
            .find(|l| l.get("activityLevel").and_then(|v| v.as_str()) == Some(name))
            .and_then(|l| l.get("activeMinutesSum"))
            .and_then(numeric)
            .unwrap_or(0.0)
    };
    Some(ActiveMinutesDay {
        date: format!("{y:04}-{m:02}-{d:02}"),
        light: at("LIGHT"),
        moderate: at("MODERATE"),
        vigorous: at("VIGOROUS"),
    })
}

/// Read `[start, end)` of one rollup type in legal-width chunks, half-open as
/// the API is, so the same date twice gets nothing.
pub async fn fetch_daily_rollup(
    http: &reqwest::Client,
    access_token: &str,
    data_type: &str,
    start: chrono::NaiveDate,
    end: chrono::NaiveDate,
    sum_field: &str,
) -> Result<Vec<DailyValue>> {
    Ok(
        fetch_daily_rollup_points(http, access_token, data_type, start, end)
            .await?
            .iter()
            .filter_map(|pt| day_of_rollup_point(pt, sum_field))
            .collect(),
    )
}

/// The rollup points of `[start, end)`, whole: for a type whose day carries more
/// than one sum (`active-minutes`, one per level).
pub async fn fetch_daily_rollup_points(
    http: &reqwest::Client,
    access_token: &str,
    data_type: &str,
    start: chrono::NaiveDate,
    end: chrono::NaiveDate,
) -> Result<Vec<serde_json::Value>> {
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
        // `rollupDataPoints`, not `dataPoints` — a different key from `list`,
        // and reading the wrong one reports every type as empty.
        for pt in page
            .get("rollupDataPoints")
            .and_then(|p| p.as_array())
            .map(|v| v.as_slice())
            .unwrap_or_default()
        {
            out.push(pt.clone());
        }
        chunk_start = chunk_end;
    }
    Ok(out)
}

/// Every point of a one-per-day type, as `(civil date, value)`. Uses `list`:
/// the daily aggregates refuse `dailyRollUp`, and the wrong action returns 400
/// or 200 with nothing. Walks every newest-first page, so never point it at an
/// intraday type.
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

/// Every `list` point of a data type, paged, as raw JSON, for writers that need
/// the whole point. Newest first and unsorted; the writers key on a primary key
/// and do not care.
pub async fn fetch_all_points(
    http: &reqwest::Client,
    access_token: &str,
    data_type: &str,
) -> Result<Vec<serde_json::Value>> {
    fetch_points(http, access_token, data_type, None).await
}

/// {@link fetch_all_points} bounded by an AIP-160 `filter`, which an intraday
/// type needs: ~34,000 points a day newest-first would hit `MAX_PAGES` long
/// before the oldest. The fields are the snake_case proto names:
///
///   heart_rate.sample_time.physical_time >= "…Z"
///     AND heart_rate.sample_time.physical_time < "…Z"
///
/// Only `>=` and `<` are documented; the field is `sample_time` for sample
/// types, `interval.start_time` for intervals, `interval.end_time` for sleep.
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
        // 10,000 (the documented maximum) when filtered, which means intraday;
        // unfiltered stays at 1,000 for the daily aggregates.
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
                // Same guards as the weight walk: a token that never changes
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

/// A Google `civilTime` object as a MariaDB `DATETIME` string. `seconds` is
/// optional (the daily types omit it), and missing means zero.
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

/// An RFC-3339 instant as a UTC `DATETIME` string, parsed rather than sliced:
/// `physicalTime` may carry any offset.
pub fn rfc3339_to_utc_datetime(s: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.naive_utc().format("%Y-%m-%d %H:%M:%S").to_string())
}

/// A UTC `DATETIME` string as the RFC-3339 instant a `filter` wants, for turning
/// a stored `MAX(ts_utc)` into a bound. Parsed, so a bad readout is `None`.
pub fn utc_datetime_to_rfc3339(s: &str) -> Option<String> {
    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

/// A physical instant plus its protobuf-Duration offset (`"3600s"`) as the local
/// wall-clock `DATETIME`. Sleep sessions and step intervals carry no civil
/// fields, and physical + utcOffset is Google's intended derivation. Both parsed,
/// so `"-3600s"` moves the clock back.
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
    /// Fitbit's level vocabulary — `deep`/`light`/`rem`/`wake` for a stages
    /// session — so the rows land beside the Fitbit-written ones unchanged.
    pub stage: String,
    pub duration_seconds: i64,
}

/// One Google sleep session, in the shape the `sleep` table wants.
pub struct GoogleSleepSession {
    /// From the dataPoint `name`'s last segment. Nothing may depend on it
    /// equalling Fitbit's ids; the `(user_id, start_time, is_main_sleep)` key
    /// merges a night from either source.
    pub log_id: i64,
    /// The civil date the sleep ended. Some Fitbit rows date a night by its
    /// start; `date` overwrites on duplicate, so the last writer decides.
    pub date: String,
    pub start_time: String,
    pub end_time: String,
    pub start_time_utc: String,
    pub end_time_utc: String,
    pub duration_ms: i64,
    /// Derived: `minutesAsleep / minutesInSleepPeriod`, rounded to a percent.
    /// Whether that is Fitbit's statistic is the comparison's question, not an
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

/// Google's stage vocabulary as the stored level strings, by session type: a
/// `STAGES` session's `AWAKE` is `wake`, while a `CLASSIC` session's levels
/// lowercase as themselves (`awake`).
fn stage_level(session_type: &str, google_type: &str) -> String {
    if session_type == "STAGES" && google_type == "AWAKE" {
        return "wake".to_string();
    }
    google_type.to_ascii_lowercase()
}

/// A `sleep` dataPoint as the rows to write, or `None` (the caller counts why).
/// Summary minutes are quoted numbers: `numeric`, never `as_i64`.
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
        // The end's civil date — `end_time` is `YYYY-MM-DD HH:MM:SS`.
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
/// ⚠ A quoted number is not an absent one: `as_f64()` drops `"62"`, and a stream
/// of them reports as zero days. Not a permissive fallback: an unparseable
/// string is still `None`. Types differ per field, so this is per value.
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
    // Absent is dropped, never defaulted — a missing reading is not a zero one.
    let value = numeric(pt.pointer(value_pointer)?)?;
    Some(DailyValue {
        date: format!("{y:04}-{m:02}-{d:02}"),
        value,
    })
}

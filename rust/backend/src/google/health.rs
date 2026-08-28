//! Google Health API v4 — the weight feed. Port of `src/google/health.ts`.
//!
//! Unified data model: `GET /v4/users/me/dataTypes/{type}/dataPoints`, paged.

use anyhow::{Context, Result, anyhow};
use serde::Deserialize;

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
    let value = pt.pointer(sum_field)?.as_f64()?;
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
    let mut out = Vec::new();
    let mut page_token: Option<String> = None;
    let mut pages = 0u32;

    loop {
        let mut url =
            reqwest::Url::parse(&format!("{BASE}/users/me/dataTypes/{data_type}/dataPoints"))
                .with_context(|| format!("building the {data_type} URL"))?;
        url.query_pairs_mut().append_pair("pageSize", "1000");
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
            if let Some(v) = day_of_list_point(pt, value_pointer) {
                out.push(v);
            }
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
    let value = pt.pointer(value_pointer)?.as_f64()?;
    Some(DailyValue {
        date: format!("{y:04}-{m:02}-{d:02}"),
        value,
    })
}

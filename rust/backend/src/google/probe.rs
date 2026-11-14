//! What does Google Health actually serve for this account?
//!
//! Measures each stream rather than assuming it from the one that works
//! (weight reaches Google by a phone-side path, which says nothing about the
//! watch's data).
//!
//! # ⚠ Field names only — never a value
//!
//! It prints a data point's shape (`weightGrams`, `sampleTime`), never its
//! contents: the output lands in a Kubernetes log, which is no place for heart
//! rates or coordinates. Read-only throughout.

use anyhow::{Context, Result};
use std::collections::BTreeSet;

use super::oauth::GoogleCreds;

const BASE: &str = "https://health.googleapis.com/v4";

/// Points per page when walking a daily series to its end: the documented
/// maximum, so a daily aggregate fits one page and the loop is for correctness.
const DEPTH_PAGE_SIZE: u32 = 10_000;

/// A bound on the page walk: a `nextPageToken` that never changes would loop
/// against a paid API, and a readout that stops and says so beats a hang.
const DEPTH_MAX_PAGES: u32 = 100;

/// The types cheap enough to walk to the end, one point per day each. The
/// intraday `heart-rate` and `heart-rate-variability` are absent: newest-first
/// with no ascending sort, their depth needs the `filter` parameter.
const DAILY_TYPES: &[&str] = &[
    "weight",
    "daily-resting-heart-rate",
    "daily-heart-rate-variability",
    "daily-oxygen-saturation",
    "daily-respiratory-rate",
    "daily-sleep-temperature-derivations",
    // Not one per day: it runs past the page bound, which is reported, so a
    // type that breaks the assumption says so rather than being dropped.
    "daily-heart-rate-zones",
    // A weigh-in's sibling: how much body-fat history is there to backfill?
    "body-fat",
];

/// The Google type for every biometric stream, plus aggregates that might stand
/// in for one. Kebab-case (`heart-rate`), from the v4 reference: a single-word
/// type like `weight` cannot show the convention, and snake_case 404s on every
/// probe. A 404 means "not under this name"; discovery is the authority.
const CANDIDATES: &[&str] = &[
    // The stream that already works — the control. If this 404s, the probe
    // itself is broken and nothing below can be read.
    "weight",
    // Heart rate: intraday samples and the daily zones.
    "heart-rate",
    "daily-heart-rate-zones",
    "time-in-heart-rate-zone",
    "daily-resting-heart-rate",
    // Steps.
    "steps",
    // Sleep: sessions with stages.
    "sleep",
    // HRV: samples, and the nightly figure.
    "heart-rate-variability",
    // Carries both `hrv_daily` columns (the daily average and the deep-sleep
    // RMSSD). There is no per-stage sibling: the analogue of
    // `respiratory-rate-sleep-summary` answers 400 "not supported".
    "daily-heart-rate-variability",
    // Daily: SpO2, breathing rate, temperature.
    "oxygen-saturation",
    "daily-oxygen-saturation",
    "daily-respiratory-rate",
    "respiratory-rate-sleep-summary",
    "daily-sleep-temperature-derivations",
    "core-body-temperature",
    // Activity: the fields the daily row carries.
    "distance",
    "floors",
    "altitude",
    "active-zone-minutes",
    "active-minutes",
    "total-calories",
    "active-energy-burned",
    // The scale's other readings (Hume → Health Connect → Google). Google has
    // no type for muscle, bone, water or BMR — these two are all there is.
    "body-fat",
    "height",
];

/// The sorted key paths of one JSON value — the testable face of [`shape`].
pub fn shape_of(v: &serde_json::Value) -> Vec<String> {
    let mut out = BTreeSet::new();
    shape(v, "", &mut out);
    out.into_iter().collect()
}

/// The keys of one JSON object as `a.b` paths; arrays report their first
/// element's shape. Values never appear.
/// The type of a scalar, never its value. A quoted number reports as `string`,
/// which is the difference between a field being read and being dropped.
pub fn json_kind(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Bool(_) => "bool",
        serde_json::Value::Null => "null",
        serde_json::Value::Object(_) => "object",
        serde_json::Value::Array(_) => "array",
    }
}

pub(crate) fn shape(v: &serde_json::Value, prefix: &str, out: &mut BTreeSet<String>) {
    match v {
        serde_json::Value::Object(m) => {
            for (k, sub) in m {
                let path = if prefix.is_empty() {
                    k.clone()
                } else {
                    format!("{prefix}.{k}")
                };
                match sub {
                    serde_json::Value::Object(_) | serde_json::Value::Array(_) => {
                        shape(sub, &path, out)
                    }
                    // The type, not the value: `as_f64()` returns `None` on a
                    // quoted number, so a type-confused field reads as absent
                    // and a stream with data reports as empty.
                    _ => {
                        out.insert(format!("{path}: {}", json_kind(sub)));
                    }
                }
            }
        }
        serde_json::Value::Array(a) => match a.first() {
            Some(first) => shape(first, &format!("{prefix}[]"), out),
            None => {
                out.insert(format!("{prefix}[] (empty)"));
            }
        },
        _ => {
            out.insert(format!("{prefix}: {}", json_kind(v)));
        }
    }
}

/// The date carried by a data point, as `YYYY-MM-DD`. Each type nests it under
/// its own key, so this looks for the shape (an object with year/month/day)
/// rather than a path.
pub fn date_of(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Object(m) => {
            if let (Some(y), Some(mo), Some(d)) = (
                m.get("year").and_then(serde_json::Value::as_i64),
                m.get("month").and_then(serde_json::Value::as_i64),
                m.get("day").and_then(serde_json::Value::as_i64),
            ) {
                return Some(format!("{y:04}-{mo:02}-{d:02}"));
            }
            m.values().find_map(date_of)
        }
        serde_json::Value::Array(a) => a.iter().find_map(date_of),
        _ => None,
    }
}

/// Page one type to exhaustion, reporting how far back it goes. Only for daily
/// types: the list is newest first with no ascending sort.
async fn depth_one(http: &reqwest::Client, token: &str, ty: &str) -> String {
    let mut page_token: Option<String> = None;
    let mut total = 0usize;
    let mut newest: Option<String> = None;
    let mut oldest: Option<String> = None;

    let mut hit_bound = true;
    for _ in 0..DEPTH_MAX_PAGES {
        let mut url =
            format!("{BASE}/users/me/dataTypes/{ty}/dataPoints?pageSize={DEPTH_PAGE_SIZE}");
        if let Some(t) = &page_token {
            url.push_str(&format!("&pageToken={t}"));
        }
        let res = match http.get(&url).bearer_auth(token).send().await {
            Ok(r) => r,
            Err(e) => return format!("{ty:36} TRANSPORT ERROR after {total} points: {e}"),
        };
        let status = res.status().as_u16();
        let body = match res.text().await {
            Ok(b) => b,
            Err(e) => return format!("{ty:36} HTTP {status}, body failed to read: {e}"),
        };
        if status != 200 {
            return format!("{ty:36} HTTP {status} after {total} points");
        }
        let page: serde_json::Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(e) => return format!("{ty:36} page {total} did not parse: {e}"),
        };
        let points = match page.get("dataPoints").and_then(|p| p.as_array()) {
            None => {
                hit_bound = false;
                break;
            }
            Some(ps) if ps.is_empty() => {
                hit_bound = false;
                break;
            }
            Some(ps) => ps.clone(),
        };
        for pt in &points {
            total += 1;
            if let Some(d) = date_of(pt) {
                if newest.is_none() {
                    newest = Some(d.clone());
                }
                oldest = Some(d);
            }
        }
        match page.get("nextPageToken").and_then(|t| t.as_str()) {
            Some(t) if !t.is_empty() => page_token = Some(t.to_string()),
            _ => {
                hit_bound = false;
                break;
            }
        }
    }

    // Say so when the walk was cut short: a partial total beside a date reads
    // as a complete series.
    let note = if hit_bound {
        format!(
            "  ⚠ STOPPED AT THE {DEPTH_MAX_PAGES}-PAGE BOUND — partial, and the \
             oldest date below is only the oldest SEEN. Not a one-per-day type."
        )
    } else {
        String::new()
    };
    let dates = match (&oldest, &newest) {
        (Some(o), Some(n)) => format!("{o} → {n}"),
        _ => "[no date found in any point]".to_string(),
    };
    format!("{ty:36} {total:6} points   {dates}{note}")
}

/// Google's error with its `details`, the half that says what to do. Shared by
/// every caller, since a copy keeping only `message` dropped the field names.
fn error_detail(body: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(body) {
        Err(e) => {
            let head: String = body.chars().take(160).collect();
            format!("[body is not JSON: {e}] {head}")
        }
        Ok(v) => match v.get("error") {
            None => format!("[JSON with no `error` field] {v}"),
            Some(err) => {
                let msg = match err.get("message").and_then(|m| m.as_str()) {
                    Some(m) => m.to_string(),
                    None => "[no `message` field]".to_string(),
                };
                match err.get("details") {
                    Some(d) => format!("{msg} | details: {d}"),
                    None => format!("{msg} | [no `details` field]"),
                }
            }
        },
    }
}

/// One line of readout for one candidate type.
async fn probe_one(http: &reqwest::Client, token: &str, ty: &str) -> String {
    // Not pageSize=1: session and interval types answer it with 200 and no
    // dataPoints, indistinguishable from "no data". Probe as a consumer asks.
    let url = format!("{BASE}/users/me/dataTypes/{ty}/dataPoints?pageSize=25");
    let res = match http.get(&url).bearer_auth(token).send().await {
        Ok(r) => r,
        Err(e) => return format!("{ty:24} TRANSPORT ERROR  {e}"),
    };
    let status = res.status().as_u16();
    // A body that failed to read is not an empty body: defaulting to "" would
    // report "200, 0 points" for a failed transfer.
    let body = match res.text().await {
        Ok(b) => b,
        Err(e) => return format!("{ty:24} HTTP {status} but the body failed to read: {e}"),
    };

    if status != 200 {
        // Print the whole `details` array: for a 403 it names the missing
        // scope, the next action. A non-JSON body (Google answers some errors
        // with HTML) and a JSON body without details are different diagnoses,
        // so every branch is named.
        let detail = error_detail(&body);
        return format!("{ty:24} HTTP {status}  {}", detail.replace('\n', " "));
    }

    let parsed: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => return format!("{ty:24} HTTP 200 but undecodable: {e}"),
    };

    let points = parsed.get("dataPoints").and_then(|p| p.as_array());
    match points {
        None => format!("{ty:24} HTTP 200, NO dataPoints field — type exists, no data"),
        Some(ps) if ps.is_empty() => format!("{ty:24} HTTP 200, 0 points — type exists, no data"),
        Some(ps) => {
            let mut fields = BTreeSet::new();
            shape(&ps[0], "", &mut fields);
            let more = if parsed.get("nextPageToken").is_some() {
                " (paged)"
            } else {
                ""
            };
            format!(
                "{ty:24} HTTP 200, HAS DATA{more}  fields: {}",
                fields.into_iter().collect::<Vec<_>>().join(", ")
            )
        }
    }
}

/// Types whose `list` answered 200 with nothing, or refused `list` outright.
/// `floors` and `total-calories` refuse `list`; `steps` and `sleep` accept it
/// and return nothing. If the rollup has data for those too, an interval type
/// answers `list` with silence, and a "no data" from `list` alone is wrong.
const ROLLUP_SUSPECTS: &[&str] = &[
    "steps",
    "sleep",
    "distance",
    "altitude",
    "active-minutes",
    "oxygen-saturation",
    "core-body-temperature",
    // The two that named `dailyRollup` themselves — the controls. If these come
    // back empty too, the request shape is wrong and nothing else here is
    // readable.
    "floors",
    "total-calories",
];

/// One `dailyRollUp` over a recent 14-day, midnight-aligned window. 14 days is
/// the reference's cap for several types, so one width for all keeps a refusal
/// meaning "no data" rather than "window too wide".
async fn rollup_one(
    http: &reqwest::Client,
    token: &str,
    ty: &str,
    start: (i32, u32, u32),
    end: (i32, u32, u32),
) -> String {
    let url = format!("{BASE}/users/me/dataTypes/{ty}/dataPoints:dailyRollUp");
    // `start`/`end`, each a CivilDateTime: `startTime`/`endTime` ISO strings
    // are refused by every type (`400 Unknown name "startTime"`). `time`
    // defaults to midnight, which a one-day window wants.
    let civil = |(y, m, d): (i32, u32, u32)| serde_json::json!({ "date": { "year": y, "month": m, "day": d } });
    let body = serde_json::json!({
        "range": { "start": civil(start), "end": civil(end) },
        // `pageSize` is bounded by the duration it implies (window × pageSize
        // ≤ 90 days for steps, 14 for active-minutes and total-calories), and an
        // excess is blamed on the range field. 14 fits every type and the window.
        "pageSize": 14
    });
    let res = match http.post(&url).bearer_auth(token).json(&body).send().await {
        Ok(r) => r,
        Err(e) => return format!("{ty:24} TRANSPORT ERROR  {e}"),
    };
    let status = res.status().as_u16();
    let text = match res.text().await {
        Ok(t) => t,
        Err(e) => return format!("{ty:24} HTTP {status} but the body failed to read: {e}"),
    };
    let parsed: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            let head: String = text.chars().take(160).collect();
            return format!("{ty:24} HTTP {status}, body is not JSON: {e} — {head}");
        }
    };
    if status != 200 {
        return format!(
            "{ty:24} HTTP {status}  {}",
            error_detail(&text).replace('\n', " ")
        );
    }
    // `rollupDataPoints`, not `dataPoints`. A different key from `list`, and
    // reading the wrong one would report every type as empty.
    match parsed.get("rollupDataPoints").and_then(|p| p.as_array()) {
        None => format!("{ty:24} HTTP 200, NO rollupDataPoints field — empty over the window"),
        Some(ps) if ps.is_empty() => format!("{ty:24} HTTP 200, 0 points over the window"),
        Some(ps) => {
            let mut fields = BTreeSet::new();
            shape(&ps[0], "", &mut fields);
            format!(
                "{ty:24} HTTP 200, {} point(s)  fields: {}",
                ps.len(),
                fields.into_iter().collect::<Vec<_>>().join(", ")
            )
        }
    }
}

/// Probe Google Health for every biometric stream and print a readout. A 404
/// is an answer, not an error, so it does not stop the run.
pub async fn run() -> Result<()> {
    let Some(creds) = GoogleCreds::from_env() else {
        anyhow::bail!("GH_CLIENT_ID, GH_CLIENT_SECRET and GH_REFRESH_TOKEN must all be set");
    };
    let http = reqwest::Client::new();
    let token = super::oauth::access_token(&http, &creds)
        .await
        .context("minting a Google access token")?;
    println!("access token: ok\n");

    // Ask the API what it has, rather than trusting the guess list below.
    println!("== discovery: GET /users/me/dataTypes ==");
    match http
        .get(format!("{BASE}/users/me/dataTypes"))
        .bearer_auth(&token)
        .send()
        .await
    {
        Ok(r) => {
            let status = r.status().as_u16();
            match r.text().await {
                Ok(body) => {
                    let head: String = body.chars().take(2000).collect();
                    println!("HTTP {status}\n{head}\n");
                }
                Err(e) => println!("HTTP {status} but the body failed to read: {e}\n"),
            }
        }
        Err(e) => println!("transport error: {e}\n"),
    }

    println!("== per-type probe (field NAMES only, no values) ==");
    println!("⚠ the list is ordered NEWEST FIRST, so these fields come from the most recent point");
    for ty in CANDIDATES {
        println!("{}", probe_one(&http, &token, ty).await);
    }

    // The window is passed in rather than computed here so the two bounds cannot
    // drift apart between calls.
    use chrono::Datelike as _;
    let end_d = chrono::Utc::now().date_naive();
    let start_d = end_d - chrono::Duration::days(14);
    let ymd = |d: chrono::NaiveDate| (d.year(), d.month(), d.day());
    println!();
    println!("== dailyRollUp over {start_d} → {end_d} (14d, the reference's cap) ==");
    println!("⚠ these are the types `list` reported as empty, plus the two that refused `list`");
    for ty in ROLLUP_SUSPECTS {
        println!(
            "{}",
            rollup_one(&http, &token, ty, ymd(start_d), ymd(end_d)).await
        );
    }

    println!();
    println!("== history depth (one-point-per-day types only) ==");
    println!("⚠ a DATE, not a count of days — gaps are not visible here");
    for ty in DAILY_TYPES {
        println!("{}", depth_one(&http, &token, ty).await);
    }
    Ok(())
}

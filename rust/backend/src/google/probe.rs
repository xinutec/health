//! What does Google Health actually serve for THIS account? (#260)
//!
//! # Why this exists as code rather than as a decision
//!
//! The Fitbit Web API dies in Sep 2026 and eight streams have to land
//! somewhere. Weight already comes from Google — but it reaches Google as
//! Hume scale → Health Connect → Google Health, which is a phone-side path
//! that says NOTHING about whether the watch's data travels the same way.
//!
//! Sizing the migration off that one working stream is the mistake this module
//! exists to prevent: "weight works, so the rest is the same client with a
//! different `dataTypes` segment" is a guess wearing the clothes of a measured
//! fact. If Google does not carry HR intraday at ~34,000 points a day, the port
//! is not a port, and the five days before the deadline are better spent
//! knowing that than discovering it.
//!
//! # ⚠ FIELD NAMES ONLY — never a value
//!
//! This prints the SHAPE of a data point (`weightGrams`, `sampleTime`), never
//! its contents. The output lands in a Kubernetes log, and a log is not a place
//! for heart rates, sleep stages or coordinates. Shape is also all the probe is
//! for: the question is whether a stream exists and what fields it carries, and
//! a value cannot answer that any better than its key can.
//!
//! Read-only throughout. No `POST`, no DB handle, nothing to write with.

use anyhow::{Context, Result};
use std::collections::BTreeSet;

use super::oauth::GoogleCreds;

const BASE: &str = "https://health.googleapis.com/v4";

/// The Google counterpart of every stream `fitbit::sync` owns, plus the
/// aggregates that might stand in for one.
///
/// ⚠ **KEBAB-CASE, and that is not cosmetic.** The identifiers are
/// `heart-rate`, not `heart_rate`. This list was first written in snake_case
/// from the shape of the one type we already use — and `weight` is a single
/// word, so the working stream cannot reveal the convention. Every probe would
/// have returned 404 and the readout would have said Google carries none of
/// this, which is the opposite of true. Names are from the v4 reference, not
/// from the shape of `weight`.
///
/// ⚠ A 404 still means "not under this name", NOT "Google does not have it".
/// Discovery is the authority; this list is the fallback.
/// The types cheap enough to walk to the end — one point per day each.
///
/// ⚠ `heart-rate` and `heart-rate-variability` are DELIBERATELY ABSENT. They
/// are intraday (~34,000 points a day for HR), the list has no ascending sort,
/// and reaching the oldest point means paging through all of it. Their depth
/// needs the `filter` parameter, which is a separate piece of work.
/// Points per page when walking a series to its end. The documented maximum is
/// 10,000; a daily aggregate over four years is ~1,500, so this is one page in
/// practice and the loop is for correctness rather than volume.
const DEPTH_PAGE_SIZE: u32 = 10_000;

/// A bound on the page walk. ⚠ NOT expected to be reached — it exists because a
/// `nextPageToken` that never changes is an infinite loop against a paid API,
/// and "hangs until the pod deadline kills it" is far worse to diagnose than a
/// readout that stops and says how far it got.
const DEPTH_MAX_PAGES: u32 = 100;

const DAILY_TYPES: &[&str] = &[
    "weight",
    "daily-resting-heart-rate",
    "daily-heart-rate-variability",
    "daily-oxygen-saturation",
    "daily-respiratory-rate",
    "daily-sleep-temperature-derivations",
    // ⚠ MEASURED NOT ONE-PER-DAY, 2026-08-27: it ran past 500,000 points and
    // hit the page bound, where the five above land at ~1,200. Kept because the
    // bound is now reported out loud, and a type that does not fit the
    // assumption is worth seeing say so rather than being quietly dropped.
    "daily-heart-rate-zones",
];

const CANDIDATES: &[&str] = &[
    // The stream that already works — the control. If this 404s, the probe
    // itself is broken and nothing below can be read.
    "weight",
    // fitbit::sync::heartrate — intraday samples and the daily zones.
    "heart-rate",
    "daily-heart-rate-zones",
    "time-in-heart-rate-zone",
    "daily-resting-heart-rate",
    // fitbit::sync::steps
    "steps",
    // fitbit::sync::sleep — sessions with stages.
    "sleep",
    // fitbit::sync::hrv — samples, and the nightly figure.
    "heart-rate-variability",
    "daily-heart-rate-variability",
    // fitbit::sync::daily — SpO2, breathing rate, temperature.
    "oxygen-saturation",
    "daily-oxygen-saturation",
    "daily-respiratory-rate",
    "respiratory-rate-sleep-summary",
    "daily-sleep-temperature-derivations",
    "core-body-temperature",
    // fitbit::sync::activity — the fields the daily row carries.
    "distance",
    "floors",
    "altitude",
    "active-zone-minutes",
    "active-minutes",
    "total-calories",
    "active-energy-burned",
];

/// The sorted key paths of one JSON value — the testable face of [`shape`].
pub fn shape_of(v: &serde_json::Value) -> Vec<String> {
    let mut out = BTreeSet::new();
    shape(v, "", &mut out);
    out.into_iter().collect()
}

/// The keys of one JSON object, one level deep, as `a.b` paths.
///
/// Nested objects recurse; arrays report their element's shape from the first
/// element only. Values never appear.
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
                    _ => {
                        out.insert(path);
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
            out.insert(prefix.to_string());
        }
    }
}

/// The date carried by a data point, as `YYYY-MM-DD`, wherever it sits.
///
/// Each type nests its date under its own key — `dailyRestingHeartRate.date`,
/// `dailyOxygenSaturation.date` — so this looks for the SHAPE (an object with
/// year/month/day) rather than for a path. A per-type path table would be a
/// list of guesses; the shape is the thing they have in common.
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

/// Page one type to exhaustion, reporting how far back it goes.
///
/// ⚠ ONLY FOR ONE-POINT-PER-DAY TYPES. The list is ordered NEWEST FIRST and
/// there is no ascending sort, so the only way to the oldest point is to walk
/// every page. That is a few pages for a daily aggregate and millions of points
/// for `heart-rate`, which is why the intraday types are not in this list.
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

    // ⚠ SAY SO WHEN THE WALK WAS CUT SHORT. A bounded scan that prints its
    // partial total beside a date reads as a complete series — `daily-heart-rate-zones`
    // reported "500000 points 0657-09-14 → 2026-08-27" on the first run, which
    // is not a finding about the data but a finding about this loop. A silent
    // cap is the failure this whole instrument exists to avoid.
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

/// One line of readout for one candidate type.
async fn probe_one(http: &reqwest::Client, token: &str, ty: &str) -> String {
    let url = format!("{BASE}/users/me/dataTypes/{ty}/dataPoints?pageSize=1");
    let res = match http.get(&url).bearer_auth(token).send().await {
        Ok(r) => r,
        Err(e) => return format!("{ty:24} TRANSPORT ERROR  {e}"),
    };
    let status = res.status().as_u16();
    // ⚠ A BODY THAT FAILED TO READ IS NOT AN EMPTY BODY. Defaulting to "" here
    // would render a mid-transfer failure as "HTTP 200, 0 points — type exists,
    // no data": a confident, wrong answer to the exact question this probe was
    // built to settle.
    let body = match res.text().await {
        Ok(b) => b,
        Err(e) => return format!("{ty:24} HTTP {status} but the body failed to read: {e}"),
    };

    if status != 200 {
        // ⚠ PRINT THE WHOLE `details` ARRAY, not a prefix of the envelope.
        //
        // A 403 here answers "which scope is missing", and that string IS the
        // next action — it is what the re-consent has to ask for. The first
        // version truncated at 120 chars, which spent the budget on the
        // envelope ("Required OAuth scope(s) are missing") and cut the part
        // that names them, leaving a readout that says something is wrong
        // without saying what to do.
        //
        // ⚠ EVERY BRANCH IS NAMED, none defaults to silence. A non-JSON body
        // is a real case here — Google answers some errors with an HTML page —
        // but "the body did not parse" and "the body parsed and carried no
        // details" are different diagnoses, and a readout that renders both as
        // an empty string sends the reader to the wrong problem.
        let detail = match serde_json::from_str::<serde_json::Value>(&body) {
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
        };
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
///
/// ⚠ "200 and empty" and "400, wrong method" are DIFFERENT SYMPTOMS THAT MAY
/// SHARE A CAUSE. `floors` and `total-calories` say plainly that `list` is not
/// their action; `steps` and `sleep` accept `list` and return nothing. If the
/// rollup form has data for the second group too, then an interval type answers
/// `list` with silence rather than a refusal — and every "no data" conclusion
/// drawn from `list` alone was wrong.
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

/// One `dailyRollUp` over a recent window.
///
/// ⚠ 14 DAYS, NOT MORE. The reference caps the range at 14 days for
/// `heart-rate`, `active-minutes`, `total-calories` and
/// `calories-in-heart-rate-zone`. One width for every type keeps a refusal
/// meaning "no data" rather than "your window was too wide for this one".
///
/// ⚠ Midnight-aligned. The range must align with the aggregation window, and
/// `windowSizeDays` defaults to 1.
async fn rollup_one(
    http: &reqwest::Client,
    token: &str,
    ty: &str,
    today: &str,
    start: &str,
) -> String {
    let url = format!("{BASE}/users/me/dataTypes/{ty}/dataPoints:dailyRollUp");
    let body = serde_json::json!({
        "range": { "startTime": format!("{start}T00:00:00Z"), "endTime": format!("{today}T00:00:00Z") },
        "pageSize": 100
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
        let msg = match parsed
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
        {
            Some(m) => m.to_string(),
            None => "[no error.message]".to_string(),
        };
        return format!("{ty:24} HTTP {status}  {msg}");
    }
    // ⚠ `rollupDataPoints`, NOT `dataPoints`. A different key from `list`, and
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

/// Probe Google Health for every stream the Fitbit sync currently owns.
///
/// Prints a readout and returns. ⚠ Deliberately does NOT fail on a 404 — a
/// missing type is the ANSWER, not an error, and exiting non-zero on the first
/// one would hide the twelve behind it.
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
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let start = (chrono::Utc::now() - chrono::Duration::days(14))
        .format("%Y-%m-%d")
        .to_string();
    println!();
    println!("== dailyRollUp over {start} → {today} (14d, the reference's cap) ==");
    println!("⚠ these are the types `list` reported as empty, plus the two that refused `list`");
    for ty in ROLLUP_SUSPECTS {
        println!("{}", rollup_one(&http, &token, ty, &today, &start).await);
    }

    println!();
    println!("== history depth (one-point-per-day types only) ==");
    println!("⚠ a DATE, not a count of days — gaps are not visible here");
    for ty in DAILY_TYPES {
        println!("{}", depth_one(&http, &token, ty).await);
    }
    Ok(())
}

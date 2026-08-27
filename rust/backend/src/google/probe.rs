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

/// One line of readout for one candidate type.
async fn probe_one(http: &reqwest::Client, token: &str, ty: &str) -> String {
    let url = format!("{BASE}/users/me/dataTypes/{ty}/dataPoints?pageSize=1");
    let res = match http.get(&url).bearer_auth(token).send().await {
        Ok(r) => r,
        Err(e) => return format!("{ty:24} TRANSPORT ERROR  {e}"),
    };
    let status = res.status().as_u16();
    let body = res.text().await.unwrap_or_default();

    if status != 200 {
        // The first line of Google's error, which names the reason without the
        // envelope. Truncated: an HTML error page is not a diagnosis.
        let reason: String = body.chars().take(160).collect();
        return format!("{ty:24} HTTP {status}  {}", reason.replace('\n', " "));
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
            let body = r.text().await.unwrap_or_default();
            let head: String = body.chars().take(2000).collect();
            println!("HTTP {status}\n{head}\n");
        }
        Err(e) => println!("transport error: {e}\n"),
    }

    println!("== per-type probe (field NAMES only, no values) ==");
    for ty in CANDIDATES {
        println!("{}", probe_one(&http, &token, ty).await);
    }
    Ok(())
}

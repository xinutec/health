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

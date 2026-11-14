//! PhoneTrack GPS fixes.
//!
//! A Nextcloud user has sessions, sessions have devices, devices have points,
//! and no endpoint spans devices, so a range fetch is one HTTP call per device
//! per chunk.
//!
//! A device whose fetch fails contributes zero points, just like a device that
//! was switched off, so a travel day could read as a day at home. The partial
//! answer is kept (one stale device of two is common), but [`TrackFetch`]
//! carries `failed_devices` out so the caller logs a number.

use anyhow::Context;
use serde::Deserialize;
use sqlx::MySqlPool;

use super::client::NextcloudClient;
use super::credentials::NcError;
use crate::lean;

/// One GPS fix as PhoneTrack stores it. Everything past the position is
/// nullable: an indoor fix has no speed, a desktop client no battery.
#[derive(Debug, Clone, PartialEq)]
pub struct RawTrackPoint {
    /// Unix seconds.
    pub ts: i64,
    pub lat: f64,
    pub lon: f64,
    pub altitude: Option<f64>,
    pub speed: Option<f64>,
    pub accuracy: Option<f64>,
    pub battery: Option<f64>,
}

/// Halve an inclusive window of whole seconds into `[a, mid]` and `[mid + 1,
/// b]`, no gap and no overlap, or `None` when it is one second wide. `hi` is
/// strictly narrower, so the caller's loop terminates.
pub fn split_window(a: i64, b: i64) -> Option<((i64, i64), (i64, i64))> {
    if b <= a {
        return None;
    }
    let mid = a + (b - a) / 2;
    Some(((a, mid), (mid + 1, b)))
}

/// The result of a range fetch: the points, and how much of the walk failed.
#[derive(Debug, Default)]
pub struct TrackFetch {
    /// Ascending by `ts`.
    pub points: Vec<RawTrackPoint>,
    /// Devices whose points call failed and were skipped. Non-zero means
    /// `points` is a subset, and absence in it is not evidence.
    pub failed_devices: usize,
    /// Windows that came back at the cap while one second wide, the one
    /// remaining way to lose points (over 10 000 fixes in a second is a fault,
    /// not a rate). Non-zero means `points` is a subset.
    pub capped_windows: usize,
}

#[derive(Debug, Deserialize)]
struct WireDevice {
    id: i64,
}

/// One PhoneTrack session and the devices that have posted to it.
#[derive(Debug, Deserialize)]
pub struct Session {
    id: i64,
    /// Absent for a session nothing has posted to; `Option`, so "no devices
    /// yet" and "devices omitted" stay distinct. A `BTreeMap` for determinism:
    /// points are concatenated per device and stably sorted by timestamp, and
    /// equal timestamps are real, so device order must not vary between runs.
    #[serde(default)]
    devices: Option<std::collections::BTreeMap<String, WireDevice>>,
}

#[derive(Debug, Deserialize)]
struct WirePoint {
    timestamp: i64,
    lat: f64,
    lon: f64,
    altitude: Option<f64>,
    speed: Option<f64>,
    accuracy: Option<f64>,
    batterylevel: Option<f64>,
}

/// The sessions listing, an object keyed by session token; only the values are
/// kept.
pub fn parse_sessions(body: &str) -> anyhow::Result<Vec<Session>> {
    // `BTreeMap` for the same reason as `Session::devices` — this map's values
    // become `self.sessions`, which the range fetch walks in order.
    let map: std::collections::BTreeMap<String, Session> =
        serde_json::from_str(body).context("decoding the phonetrack sessions listing")?;
    Ok(map.into_values().collect())
}

/// One device's points in PhoneTrack's wire shape. Not sorted: the range fetch
/// sorts once after concatenating devices and chunks.
pub fn parse_points(body: &str) -> anyhow::Result<Vec<RawTrackPoint>> {
    let wire: Vec<WirePoint> =
        serde_json::from_str(body).context("decoding a phonetrack points response")?;
    Ok(wire
        .into_iter()
        .map(|p| RawTrackPoint {
            ts: p.timestamp,
            lat: p.lat,
            lon: p.lon,
            altitude: p.altitude,
            speed: p.speed,
            accuracy: p.accuracy,
            battery: p.batterylevel,
        })
        .collect())
}

/// A client plus the user's session/device list, built once per run: the list
/// costs a credential read and an HTTP call per chunk otherwise.
pub struct PhoneTrack {
    client: NextcloudClient,
    sessions: Vec<Session>,
}

impl PhoneTrack {
    /// Resolve credentials and list the user's sessions.
    pub async fn open(
        http: reqwest::Client,
        pool: &MySqlPool,
        base_url: &str,
        user_id: &str,
    ) -> Result<Self, NcError> {
        let client = NextcloudClient::connect(http, pool, base_url, user_id).await?;
        let body = client
            .get(pool, "/index.php/apps/phonetrack/sessions")
            .await?;
        let sessions = match body {
            // No body is an account with no sessions, not a malformed answer.
            None => Vec::new(),
            Some(b) => parse_sessions(&b).map_err(NcError::Other)?,
        };
        Ok(Self { client, sessions })
    }

    /// How many devices a full range fetch will walk. Zero means the account has
    /// sessions but nothing has ever posted to them.
    pub fn device_count(&self) -> usize {
        self.sessions
            .iter()
            .filter_map(|s| s.devices.as_ref())
            .map(|d| d.len())
            .sum()
    }

    /// Fetch every device's points between two dates, both midnights included.
    /// UTC midnights: the window finds fixes near a wall clock of unknown zone,
    /// so it cannot be bounded in a local one.
    pub async fn fetch_range(
        &self,
        pool: &MySqlPool,
        start_date: &str,
        end_date: &str,
    ) -> Result<TrackFetch, NcError> {
        let min_ts = lean::midnight_utc(start_date).map_err(NcError::Other)?;
        let max_ts = lean::midnight_utc(end_date).map_err(NcError::Other)?;
        self.fetch_window(pool, min_ts, max_ts).await
    }

    /// The same walk bounded by explicit Unix seconds, since not every window is
    /// date-aligned (the day loader's noon cut-offs and battery-tail look-ahead).
    pub async fn fetch_window(
        &self,
        pool: &MySqlPool,
        min_ts: i64,
        max_ts: i64,
    ) -> Result<TrackFetch, NcError> {
        let mut out = TrackFetch::default();
        // Every device at once (they are independent GETs), read back in the
        // listed order so the stable sort sees the same insertion order.
        let devices: Vec<(i64, i64)> = self
            .sessions
            .iter()
            .flat_map(|s| {
                s.devices
                    .iter()
                    .flat_map(move |d| d.values().map(move |dev| (s.id, dev.id)))
            })
            .collect();
        let fetched = futures_util::future::join_all(
            devices
                .iter()
                .map(|(s, d)| self.fetch_device_window(pool, *s, *d, min_ts, max_ts)),
        )
        .await;
        for ((session_id, device_id), got) in devices.iter().zip(fetched) {
            match got {
                // An empty body is an empty device-day, not a failure.
                Ok((points, capped)) => {
                    out.points.extend(points);
                    out.capped_windows += capped;
                }
                // A revoked app password is not a per-device problem: it
                // propagates, so the user sees "relink Nextcloud" once.
                Err(e @ (NcError::ReauthRequired | NcError::NotLinked)) => return Err(e),
                Err(e) => {
                    out.failed_devices += 1;
                    tracing::warn!(
                        "phonetrack: session {session_id}/device {device_id} points fetch failed: {e:#}"
                    );
                }
            }
        }

        out.points.sort_by_key(|p| p.ts);
        Ok(out)
    }

    /// One device's points for `[min_ts, max_ts]`, splitting when the response
    /// comes back at the cap.
    ///
    /// ⚠ PhoneTrack truncates at `maxPoints` and says nothing: a full response
    /// looks like a device that recorded exactly that many. This reads the
    /// symptom (a response at the cap) rather than predicting a capture rate.
    ///
    /// Iterative, since an async fn calling itself needs boxing; it terminates
    /// because every split narrows a window of whole seconds. Returns the count
    /// of capped one-second windows, the only case still losing points.
    async fn fetch_device_window(
        &self,
        pool: &MySqlPool,
        session_id: i64,
        device_id: i64,
        min_ts: i64,
        max_ts: i64,
    ) -> Result<(Vec<RawTrackPoint>, usize), NcError> {
        let mut todo = vec![(min_ts, max_ts)];
        let mut points = Vec::new();
        let mut capped = 0usize;

        while let Some((a, b)) = todo.pop() {
            let path = format!(
                "/index.php/apps/phonetrack/session/{session_id}/device/{device_id}/points\
                 ?minTimestamp={a}&maxTimestamp={b}&maxPoints={MAX_POINTS}"
            );
            let got = match self.client.get(pool, &path).await? {
                None => Vec::new(),
                Some(body) => parse_points(&body).map_err(NcError::Other)?,
            };

            if (got.len() as i64) < MAX_POINTS {
                points.extend(got);
                continue;
            }

            // At the cap. The response may be complete-and-exactly-full or
            // truncated, and nothing distinguishes them — so split and ask
            // again rather than guess which.
            if let Some((lo, hi)) = split_window(a, b) {
                let mid = lo.1;
                todo.push(hi);
                todo.push(lo);
                tracing::debug!(
                    "phonetrack: session {session_id}/device {device_id} \
                     hit the {MAX_POINTS} cap over [{a}, {b}] — splitting at {mid}"
                );
            } else {
                capped += 1;
                points.extend(got);
                tracing::warn!(
                    "phonetrack: session {session_id}/device {device_id} returned \
                     {MAX_POINTS} points for the single second {a} — cannot split \
                     further, so this window is TRUNCATED and its points are a subset"
                );
            }
        }

        Ok((points, capped))
    }
}

/// The per-request point cap. PhoneTrack truncates at it silently, and a 7-day
/// window at one fix a minute is 10 080 points from one device.
const MAX_POINTS: i64 = 10_000;

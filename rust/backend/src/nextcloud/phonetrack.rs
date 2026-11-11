//! PhoneTrack GPS fixes.
//!
//! One Nextcloud user has sessions, each session has devices, and each device
//! has points. There is no endpoint that returns points across devices, so a
//! range fetch is a nested walk: one HTTP call per device per chunk.
//!
//! # What this feeds, and why that raises the stakes on a partial failure
//!
//! These fixes were the evidence the Fitbit wall-clock inference used to decide
//! which zone a row was recorded in — a decision written into `tz` and
//! `ts_utc` columns and never revisited. They are still the day's track.
//!
//! ⚠ **A device whose fetch fails contributes zero points, which is exactly
//! what a device that was switched off contributes.** Returning the survivors
//! alone would make a travel day whose only fixes came from the one device
//! that failed indistinguishable from a day spent at home, and the rows would
//! be stamped with the profile zone, confidently and wrongly.
//!
//! This port does not paper over that by failing the whole fetch, because the
//! partial answer really is better than none for the common case of one stale
//! device on an account with two. What it does instead is stop THROWING AWAY the
//! count: [`TrackFetch`] carries `failed_devices` out, so the caller can say so
//! in a log line that names a number rather than leaving the evidence scattered
//! across per-device warnings nobody correlates.

use anyhow::Context;
use serde::Deserialize;
use sqlx::MySqlPool;

use super::client::NextcloudClient;
use super::credentials::NcError;
use crate::lean;

/// One GPS fix as PhoneTrack stores it.
///
/// Every field past the position is nullable because PhoneTrack takes what the
/// phone offered — an indoor fix has no speed, a desktop client has no battery.
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

/// Halve an inclusive window of whole seconds, or `None` when it is already one
/// second wide.
///
/// ⚠ **THE TWO HALVES COVER THE INPUT EXACTLY — no gap and no overlap.** Both
/// bounds are inclusive, so the split has to be `[a, mid]` and `[mid + 1, b]`. Splitting at `mid` on both
/// sides would re-fetch whatever sits exactly on the boundary, and moving the
/// low end instead would drop it.
///
/// ⚠ **`hi` is strictly narrower than the input**, which is what makes the
/// caller's loop terminate rather than split a two-second window forever.
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
    /// Devices whose points call failed and were skipped.
    ///
    /// ⚠ NOT an error count to be summed and forgotten. A non-zero value means
    /// `points` is a SUBSET of the day, and every consumer that reads absence as
    /// evidence is now reading it wrongly.
    pub failed_devices: usize,
    /// Windows that came back at the cap and could NOT be split any further
    /// because they were already one second wide.
    ///
    /// ⚠ THE ONLY REMAINING WAY TO LOSE POINTS HERE, and it is now counted
    /// instead of invisible. Splitting resolves every ordinary case; this is
    /// over 10 000 fixes inside a single second from one device, which is not a
    /// capture rate but a fault. Non-zero means `points` is a subset.
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
    /// Absent for a session nothing has ever posted to. ⚠ `Option` and not
    /// `#[serde(default)]` into an empty map: "no devices yet" and "devices
    /// omitted from this response" would otherwise both read as zero devices,
    /// and only one of them is a fact about the account.
    ///
    /// ⚠ **`BTreeMap`, and the order is the point.** The range fetch
    /// concatenates points device by device and then sorts by timestamp with a
    /// stable sort, so points sharing a timestamp keep whatever order this walk
    /// produced. A `HashMap` randomises iteration per process, which would make
    /// that order differ between two runs of the same binary on the same day,
    /// and duplicated timestamps are real (95 in one day's 1465 points).
    /// Sorting by device key gives determinism, which is the requirement.
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

/// The sessions listing, which is an object keyed by session token.
///
/// Only the values matter here — the token is the caller's own secret and
/// nothing downstream keys on it.
pub fn parse_sessions(body: &str) -> anyhow::Result<Vec<Session>> {
    // ⚠ `BTreeMap` for the same reason as `Session::devices` — this map's values
    // become `self.sessions`, which the range fetch walks in order.
    let map: std::collections::BTreeMap<String, Session> =
        serde_json::from_str(body).context("decoding the phonetrack sessions listing")?;
    Ok(map.into_values().collect())
}

/// One device's points, in PhoneTrack's wire shape.
///
/// ⚠ NOT sorted here. A single device's points arrive ordered, but the range
/// fetch concatenates several devices and several chunks, so the sort belongs
/// where the concatenation happens or it would be a sort per device that still
/// left the whole unsorted.
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

/// A client plus the user's session/device list, built once and reused.
///
/// The list costs a credential read and an HTTP call. A 180-day tz-inference
/// window is 26 chunks, and paying that per chunk is 26 times the cost for an
/// answer that does not change within a run.
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

    /// Fetch every device's points between two dates, inclusive of both
    /// midnights.
    ///
    /// ⚠ The bounds are UTC midnights from [`lean::midnight_utc`], not local
    /// ones, for a reason worth stating: the window exists to find fixes near a
    /// wall clock whose zone is unknown, so resolving its bounds in a local zone
    /// would need the answer the fetch is being run to produce.
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

    /// The same walk, bounded by explicit Unix seconds.
    ///
    /// ⚠ EXISTS BECAUSE NOT EVERY WINDOW IS DATE-ALIGNED. The day loader asks
    /// for four ranges and only one of them starts at a midnight: the others
    /// are `<date>T12:00:00Z` cut-offs and an 18-hour battery-tail look-ahead
    /// off the LOCAL day end. `fetchTrackPointsRange` takes strings and lets
    /// `new Date(...)` parse either shape; splitting the bound resolution out
    /// here is the same thing said in a type.
    pub async fn fetch_window(
        &self,
        pool: &MySqlPool,
        min_ts: i64,
        max_ts: i64,
    ) -> Result<TrackFetch, NcError> {
        let mut out = TrackFetch::default();
        // ⚠ EVERY DEVICE AT ONCE, in a fixed order. One request per device per
        // window, awaited one after the other, was the day's `load.phonetrack`
        // — 0.5 to 1.2 s on the pod, a round trip at a
        // time. The requests are independent GETs under basic auth, so they go
        // out together; the RESULTS are read back in the order the devices
        // were listed, so the stable sort below sees the same insertion order
        // and fixes at an equal timestamp come out as they always did.
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
                // ⚠ A revoked app password is NOT a per-device problem and
                // must not be swallowed device by device: every other call
                // fails the same way, and the durable answer the user needs
                // ("relink Nextcloud") would be buried under a warning per
                // device. It propagates.
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

    /// One device's points for `[min_ts, max_ts]`, SPLITTING when the response
    /// comes back at the cap.
    ///
    /// ⚠ **PhoneTrack truncates at `maxPoints` and says nothing.** A full
    /// response is shaped exactly like a device that happened to record that
    /// many, so the tail is lost in silence. This reads the SYMPTOM — a
    /// response of exactly the cap — rather than predicting a capture rate, and
    /// so it is right whether or not any device is fast enough today. The
    /// arithmetic that motivated it: a 7-day chunk at one fix per minute is
    /// 10 080 points from a single device, against a 10 000 cap.
    ///
    /// ⚠ **THE HALVES DO NOT OVERLAP.** The bounds are inclusive at both ends,
    /// so `[a, mid]` and `[mid + 1, b]` cover `[a, b]` exactly, with no gap and no repeated fix.
    ///
    /// ⚠ **Iterative, not recursive**, because an async fn that calls itself
    /// needs boxing; the stack here is the recursion made visible. It
    /// terminates: every split strictly narrows a window of whole seconds, and
    /// a window one second wide is not split again.
    ///
    /// The returned count is windows that were AT the cap and one second wide,
    /// which is the only case that still loses points — over 10 000 fixes in a
    /// single second from one device, which is a fault rather than a rate.
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

/// The per-request point cap.
///
/// ⚠ PhoneTrack truncates at this rather than paginating, and there is no field
/// in the response saying it did. The arithmetic is uncomfortably close: a
/// 7-day window at one fix per minute is 10 080 points from a single device,
/// over this cap. Whether real capture rates reach that is not measured, and
/// silent truncation would look like a quiet day rather than a lost tail.
const MAX_POINTS: i64 = 10_000;

//! PhoneTrack GPS fixes. Port of `src/nextcloud/phonetrack.ts`.
//!
//! One Nextcloud user has sessions, each session has devices, and each device
//! has points. There is no endpoint that returns points across devices, so a
//! range fetch is a nested walk: one HTTP call per device per chunk.
//!
//! # What this feeds, and why that raises the stakes on a partial failure
//!
//! These fixes are the evidence [`crate::fitbit::tz_source`] uses to decide
//! which zone a Fitbit wall clock was recorded in. That decision is written into
//! `tz` and `ts_utc` columns and is not revisited.
//!
//! ⚠ **A DEVICE WHOSE FETCH FAILS CONTRIBUTES ZERO POINTS, WHICH IS EXACTLY
//! WHAT A DEVICE THAT WAS SWITCHED OFF CONTRIBUTES.** The TypeScript logs each
//! failure and returns the survivors, so a travel day whose only fixes came from
//! the one device that 500ed is indistinguishable from a day spent at home — and
//! the rows get stamped with the profile zone, confidently and wrongly.
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
/// bounds are inclusive (`Verified.Sync.chunkRange` documents its touching chunk
/// endpoints as a deliberate duplicate, which is what fixes the convention), so
/// the split has to be `[a, mid]` and `[mid + 1, b]`. Splitting at `mid` on both
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
    /// Ascending by `ts`. Chunk boundaries are shared, so duplicates occur —
    /// see `Verified.Sync.chunkRange`.
    pub points: Vec<RawTrackPoint>,
    /// Devices whose points call failed and were skipped.
    ///
    /// ⚠ NOT an error count to be summed and forgotten. A non-zero value means
    /// `points` is a SUBSET of the day, and every consumer that reads absence as
    /// evidence is now reading it wrongly.
    pub failed_devices: usize,
    /// Windows that came back at the cap and could NOT be split any further
    /// because they were already one second wide (#1032).
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
    /// ⚠ **`BTreeMap`, and the ORDER IS THE POINT (#1073).** The range fetch
    /// concatenates points device by device and then sorts by timestamp with a
    /// STABLE sort, so points sharing a timestamp keep whatever order this walk
    /// produced. Rust randomises `HashMap` iteration per process, which made
    /// that order differ between two runs of the same binary on the same day.
    /// Measured 2026-08-22: 2026-08-20 has 95 duplicated timestamps out of 1465
    /// points, so the ties are real — they simply did not cross a device
    /// boundary that day.
    ///
    /// The original task asked for INSERTION order, to match the TypeScript's
    /// `Object.values(session.devices)`. There is no TypeScript to match any
    /// more (#975), and the requirement it was standing in for was only ever
    /// determinism — so this sorts by device key instead of taking a dependency
    /// on `indexmap` to reproduce a dead runtime's iteration order.
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
    // become `self.sessions`, which the range fetch walks in order (#1073).
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
    /// ⚠ The bounds are UTC midnights from [`lean::midnight_utc`], NOT local
    /// ones. That is what the TypeScript's `new Date("YYYY-MM-DD").getTime()`
    /// computed and it is right here for a reason worth stating: the window
    /// exists to find fixes near a wall clock whose zone is UNKNOWN, so
    /// resolving its bounds in a local zone would need the answer the fetch is
    /// being run to produce.
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
        for session in &self.sessions {
            let Some(devices) = &session.devices else {
                continue;
            };
            for device in devices.values() {
                match self
                    .fetch_device_window(pool, session.id, device.id, min_ts, max_ts)
                    .await
                {
                    // An empty body is an empty device-day, not a failure.
                    Ok((points, capped)) => {
                        out.points.extend(points);
                        out.capped_windows += capped;
                    }
                    // ⚠ A revoked app password is NOT a per-device problem and
                    // must not be swallowed device by device: every remaining
                    // call would fail the same way, and the durable answer the
                    // user needs ("relink Nextcloud") would be buried under a
                    // warning per device. It propagates.
                    Err(e @ (NcError::ReauthRequired | NcError::NotLinked)) => return Err(e),
                    Err(e) => {
                        out.failed_devices += 1;
                        tracing::warn!(
                            "phonetrack: session {}/device {} points fetch failed: {e:#}",
                            session.id,
                            device.id
                        );
                    }
                }
            }
        }

        out.points.sort_by_key(|p| p.ts);
        Ok(out)
    }

    /// One device's points for `[min_ts, max_ts]`, SPLITTING when the response
    /// comes back at the cap (#1032).
    ///
    /// ⚠ **PhoneTrack truncates at `maxPoints` and says nothing.** A full
    /// response is shaped exactly like a device that happened to record that
    /// many, so the tail is lost in silence. This reads the SYMPTOM — a
    /// response of exactly the cap — rather than predicting a capture rate, and
    /// so it is right whether or not any device is fast enough today. The
    /// arithmetic that motivated it: a 7-day chunk at one fix per minute is
    /// 10 080 points from a single device, against a 10 000 cap.
    ///
    /// ⚠ **THE HALVES DO NOT OVERLAP, unlike the chunking above.** The bounds
    /// are inclusive at both ends — `Verified.Sync.chunkRange` documents its
    /// touching endpoints as a deliberate duplicate — so `[a, mid]` and
    /// `[mid + 1, b]` cover `[a, b]` exactly, with no gap and no repeated fix.
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

    /// Fetch a span wider than one request, in chunks Lean sizes.
    ///
    /// The chunking is `Verified.Sync.chunkRange`'s: consecutive windows that
    /// share an endpoint, refused outright rather than truncated when the span
    /// would take more requests than the bound allows.
    pub async fn fetch_span(
        &self,
        pool: &MySqlPool,
        start_date: &str,
        end_date: &str,
    ) -> Result<TrackFetch, NcError> {
        let chunks = lean::chunk_range(
            start_date,
            end_date,
            lean::TRACK_CHUNK_DAYS,
            lean::MAX_TRACK_CHUNKS,
        )
        .map_err(NcError::Other)?;

        let mut out = TrackFetch::default();
        for (from, to) in chunks {
            let mut chunk = self.fetch_range(pool, &from, &to).await?;
            out.points.append(&mut chunk.points);
            out.failed_devices += chunk.failed_devices;
            out.capped_windows += chunk.capped_windows;
        }
        // Re-sorted across chunks: each chunk is ordered, the concatenation is
        // not, and `ForwardTzSource` binary-searches this.
        out.points.sort_by_key(|p| p.ts);
        Ok(out)
    }
}

/// The per-request point cap, as the TypeScript sends it.
///
/// ⚠ PhoneTrack truncates at this rather than paginating, and there is no field
/// in the response saying it did. The arithmetic is uncomfortably close: a
/// 7-day chunk ([`lean::TRACK_CHUNK_DAYS`]) at one fix per minute is 10 080
/// points from a SINGLE device, which is over this cap. Whether real capture
/// rates reach that is not measured here, and the silent-truncation shape means
/// exceeding it would look like a quiet day rather than a lost tail. #1032.
const MAX_POINTS: i64 = 10_000;

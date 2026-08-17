//! Sleep logs and their stage series. Port of `src/fitbit/sync/sleep.ts`.
//!
//! # The `logId` precision bug does not come across, and that is the fix
//!
//! Fitbit sleep-log ids are ~7e18, past the 2^53 a JavaScript `Number` holds
//! exactly. `JSON.parse` rounded them, and the same logical id then serialised
//! differently down different mariadb driver paths, leaving `sleep.log_id` and
//! `sleep_stages.sleep_log_id` unequal for one record and breaking the
//! `/api/sleep/stages` join. The TypeScript works around it by textually quoting
//! `"logId":<digits>` before parsing and reviving to `BigInt`, and brands the
//! result so nothing coerces it back.
//!
//! `serde` reads `i64` off the wire, so none of that has anything to port. The
//! branded type, the regex, and the reviver are all absent on purpose.
//!
//! ⚠ THE CANONICAL-ID LOOKUP IS STILL HERE, and it is not the same thing. That
//! one is about DATA AT REST: rows written before the workaround landed still
//! carry rounded ids, and stages inserted under a freshly-read exact id would
//! not join to them. It stays until those rows are repaired, and its comment
//! below says what would let it go.

use anyhow::{Context, Result};
use serde::Deserialize;
use sqlx::MySqlPool;

use super::{TzSource, split_wall_clock};
use crate::fitbit::client::{FitbitClient, FitbitError};
use crate::timezone::wall_clock_to_utc_string;

#[derive(Deserialize)]
struct Minutes {
    minutes: i64,
}

#[derive(Deserialize, Default)]
struct LevelSummary {
    deep: Option<Minutes>,
    light: Option<Minutes>,
    rem: Option<Minutes>,
    wake: Option<Minutes>,
}

#[derive(Deserialize)]
struct StageEntry {
    #[serde(rename = "dateTime")]
    date_time: String,
    level: String,
    seconds: i64,
}

#[derive(Deserialize)]
struct Levels {
    #[serde(default)]
    summary: LevelSummary,
    #[serde(default)]
    data: Vec<StageEntry>,
}

/// Fitbit's wire shape for one sleep log.
///
/// Named `FitbitSleepLog` and not `SleepLog` because the frontend already has a
/// `SleepLog` and it is a DIFFERENT type — the `/api` response shape, with
/// snake_case database columns. dev-lint's wire-mirror check matches by name and
/// reported all 21 fields as drift, which was the right complaint about the
/// wrong thing: two unrelated types cannot share a name and stay checkable. The
/// TypeScript calls this one `FitbitSleepLog` too.
#[derive(Deserialize)]
pub struct FitbitSleepLog {
    /// Read as `i64` straight off the wire. See the module header.
    #[serde(rename = "logId")]
    pub log_id: i64,
    #[serde(rename = "dateOfSleep")]
    pub date_of_sleep: String,
    #[serde(rename = "startTime")]
    pub start_time: String,
    #[serde(rename = "endTime")]
    pub end_time: String,
    pub duration: i64,
    pub efficiency: i64,
    #[serde(rename = "minutesAsleep")]
    pub minutes_asleep: i64,
    #[serde(rename = "minutesAwake")]
    pub minutes_awake: i64,
    #[serde(rename = "isMainSleep")]
    pub is_main_sleep: bool,
    levels: Option<Levels>,
}

#[derive(Deserialize)]
struct SleepResponse {
    sleep: Vec<FitbitSleepLog>,
}

/// One `sleep` row, named rather than positional.
///
/// The TypeScript returns a seventeen-slot tuple. Naming the slots is the whole
/// difference: two of them are `number | null` minutes columns next to each
/// other, and a transposition there is invisible in a tuple literal.
pub struct SleepRow {
    pub log_id: i64,
    pub date: String,
    pub start_time: String,
    pub end_time: String,
    pub duration_ms: i64,
    pub efficiency: i64,
    pub minutes_asleep: i64,
    pub minutes_awake: i64,
    pub minutes_deep: Option<i64>,
    pub minutes_light: Option<i64>,
    pub minutes_rem: Option<i64>,
    pub minutes_wake: Option<i64>,
    pub is_main_sleep: bool,
    pub tz: Option<String>,
    pub start_time_utc: Option<String>,
    pub end_time_utc: Option<String>,
}

/// The pure part: a Fitbit sleep log as the row to write.
///
/// The tz is looked up from `dateOfSleep` plus the time half of `startTime`,
/// and both UTC columns are derived from that ONE zone — a sleep that crosses a
/// DST boundary is stored on the zone it began in, matching the TypeScript.
pub fn parse_sleep_log(log: &FitbitSleepLog, tz_for: TzSource<'_>) -> SleepRow {
    let (_, start_time_only) = split_wall_clock(&log.start_time);
    let tz = tz_for(&log.date_of_sleep, start_time_only);
    let summary = log.levels.as_ref().map(|l| &l.summary);
    let m = |pick: fn(&LevelSummary) -> &Option<Minutes>| -> Option<i64> {
        summary.and_then(|s| pick(s).as_ref()).map(|v| v.minutes)
    };
    SleepRow {
        log_id: log.log_id,
        date: log.date_of_sleep.clone(),
        start_time: log.start_time.clone(),
        end_time: log.end_time.clone(),
        duration_ms: log.duration,
        efficiency: log.efficiency,
        minutes_asleep: log.minutes_asleep,
        minutes_awake: log.minutes_awake,
        minutes_deep: m(|s| &s.deep),
        minutes_light: m(|s| &s.light),
        minutes_rem: m(|s| &s.rem),
        minutes_wake: m(|s| &s.wake),
        is_main_sleep: log.is_main_sleep,
        start_time_utc: wall_clock_to_utc_string(&log.start_time, tz.as_deref()),
        end_time_utc: wall_clock_to_utc_string(&log.end_time, tz.as_deref()),
        tz,
    }
}

/// One `sleep_stages` row.
pub struct StageRow {
    pub sleep_log_id: i64,
    pub ts: String,
    pub stage: String,
    pub duration_seconds: i64,
    pub tz: Option<String>,
    pub ts_utc: Option<String>,
}

/// The pure part: a log's `levels.data` as stage rows.
///
/// The tz is asked per stage and not once per log, because a stage series spans
/// a night and the inference behind it can change inside one.
pub fn parse_sleep_stages(
    log: &FitbitSleepLog,
    sleep_log_id: i64,
    tz_for: TzSource<'_>,
) -> Vec<StageRow> {
    let Some(levels) = log.levels.as_ref() else {
        return Vec::new();
    };
    levels
        .data
        .iter()
        .map(|stage| {
            let (date, time) = split_wall_clock(&stage.date_time);
            let tz = tz_for(date, time);
            StageRow {
                sleep_log_id,
                ts: stage.date_time.clone(),
                stage: stage.level.clone(),
                duration_seconds: stage.seconds,
                ts_utc: wall_clock_to_utc_string(&stage.date_time, tz.as_deref()),
                tz,
            }
        })
        .collect()
}

/// Whether this log has stages to write at all.
pub fn has_stages(log: &FitbitSleepLog) -> bool {
    log.levels.as_ref().is_some_and(|l| !l.data.is_empty())
}

/// `/1.2/user/-/sleep/date/{start}/{end}.json`
pub async fn sync_sleep(
    client: &FitbitClient,
    pool: &MySqlPool,
    access_token: &str,
    user_id: &str,
    start_date: &str,
    end_date: &str,
    tz_for: TzSource<'_>,
) -> Result<usize, FitbitError> {
    let body = client
        .get_json(
            access_token,
            &format!("/1.2/user/-/sleep/date/{start_date}/{end_date}.json"),
        )
        .await?;
    let parsed: SleepResponse = serde_json::from_str(&body).context("parsing sleep response")?;

    for log in &parsed.sleep {
        let r = parse_sleep_log(log, tz_for);
        sqlx::query(
            // `tz` and the two UTC columns COALESCE-preserve so a backfill that
            // later learns the zone can fill a null, while a re-sync with no tz
            // cannot erase one. Everything else overwrites: Fitbit revises a
            // recent night's figures and the newer answer is the right one.
            "INSERT INTO sleep (user_id, log_id, date, start_time, end_time, duration_ms, \
             efficiency, minutes_asleep, minutes_awake, minutes_deep, minutes_light, \
             minutes_rem, minutes_wake, is_main_sleep, tz, start_time_utc, end_time_utc) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON DUPLICATE KEY UPDATE start_time=VALUES(start_time), end_time=VALUES(end_time), \
             duration_ms=VALUES(duration_ms), efficiency=VALUES(efficiency), \
             minutes_asleep=VALUES(minutes_asleep), minutes_awake=VALUES(minutes_awake), \
             minutes_deep=VALUES(minutes_deep), minutes_light=VALUES(minutes_light), \
             minutes_rem=VALUES(minutes_rem), minutes_wake=VALUES(minutes_wake), \
             is_main_sleep=VALUES(is_main_sleep), tz=COALESCE(tz, VALUES(tz)), \
             start_time_utc=COALESCE(start_time_utc, VALUES(start_time_utc)), \
             end_time_utc=COALESCE(end_time_utc, VALUES(end_time_utc))",
        )
        .bind(user_id)
        .bind(r.log_id)
        .bind(&r.date)
        .bind(&r.start_time)
        .bind(&r.end_time)
        .bind(r.duration_ms)
        .bind(r.efficiency)
        .bind(r.minutes_asleep)
        .bind(r.minutes_awake)
        .bind(r.minutes_deep)
        .bind(r.minutes_light)
        .bind(r.minutes_rem)
        .bind(r.minutes_wake)
        .bind(r.is_main_sleep)
        .bind(&r.tz)
        .bind(&r.start_time_utc)
        .bind(&r.end_time_utc)
        .execute(pool)
        .await
        .context("writing sleep")?;

        if !has_stages(log) {
            continue;
        }

        // The stages join on whatever `sleep.log_id` CURRENTLY holds, not on
        // what this response said. The unique index is on
        // (user_id, start_time, is_main_sleep), so an upsert keeps the stored
        // log_id — and a row written before the precision fix holds a ROUNDED
        // id. Inserting stages under the exact id read here would leave them
        // orphaned from that row.
        //
        // This can go once no `sleep` row holds a rounded id. That is a data
        // repair, not a code change, and it is not this port's to do.
        //
        // ⚠ THE READ AND THE REPLACE SHARE ONE TRANSACTION, which the
        // TypeScript's did not. The stage rewrite below is a DELETE followed by
        // INSERTs, and on the pool each of those commits on its own: a failure
        // between them leaves `sleep_stages` durably holding fewer stages than
        // it replaced — and a short stage set reads exactly like a correct one,
        // so nothing downstream can tell. Caught by dev-lint's
        // DL-SQLX-NONATOMIC-REPLACE rather than by reading the port.
        let mut tx = pool.begin().await.context("opening sleep stages tx")?;

        let canonical: Option<i64> = sqlx::query_scalar(
            "SELECT log_id FROM sleep WHERE user_id = ? AND start_time = ? AND is_main_sleep = ? \
             LIMIT 1",
        )
        .bind(user_id)
        .bind(&log.start_time)
        .bind(log.is_main_sleep)
        .fetch_optional(&mut *tx)
        .await
        .context("reading canonical sleep log_id")?;
        let sleep_log_id = canonical.unwrap_or(log.log_id);

        let rows = parse_sleep_stages(log, sleep_log_id, tz_for);

        // Delete then insert, rather than upsert. An upsert can add or update a
        // stage but never REMOVE a stale one, so a botched historical merge
        // could not heal on re-sync. Rewriting the log's stages wholesale means
        // every sync converges on what Fitbit currently says.
        sqlx::query("DELETE FROM sleep_stages WHERE user_id = ? AND sleep_log_id = ?")
            .bind(user_id)
            .bind(sleep_log_id)
            .execute(&mut *tx)
            .await
            .context("clearing sleep_stages")?;

        for s in &rows {
            sqlx::query(
                "INSERT INTO sleep_stages (user_id, sleep_log_id, ts, stage, duration_seconds, \
                 tz, ts_utc) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(user_id)
            .bind(s.sleep_log_id)
            .bind(&s.ts)
            .bind(&s.stage)
            .bind(s.duration_seconds)
            .bind(&s.tz)
            .bind(&s.ts_utc)
            .execute(&mut *tx)
            .await
            .context("writing sleep_stages")?;
        }

        tx.commit().await.context("committing sleep stages")?;
    }

    tracing::info!("[{user_id}] Synced {} sleep logs", parsed.sleep.len());
    Ok(parsed.sleep.len())
}

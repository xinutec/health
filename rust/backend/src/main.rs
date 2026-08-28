//! The backend entrypoint.
//!
//! Three subcommands:
//!
//!   check  — read the config, open the pool, and prove both against the real
//!            database. READ-ONLY, so it is safe to point at production.
//!   sync   — the port of `dist/sync.js`: Fitbit ingestion, forward then
//!            backward, for every linked user. `--forward-only` runs the
//!            forward pass alone and touches NO backfill state, which is the
//!            form that is safe to run beside the live cron.
//!   serve  — the HTTP skeleton. NOT production's server; `src/server.ts` still
//!            owns every real route.
//!
//! ⚠ `sync` NO LONGER EXITS 2. It did, and the reason it did still holds: a
//! `sync` returning 0 having done nothing shows as a healthy scheduled run while
//! data silently stops. That guard is now carried by the code rather than by the
//! stub — the run fails loudly when it cannot read its users or reach Lean, and
//! reports a spent rate budget as the ordinary ending it is.
//!
//! ⚠ IT IS NOT WIRED INTO THE CRONJOB. `health-sync` still runs `dist/sync.js`.
//! Nothing switches over until this has been run by hand against production and
//! its writes compared with the TypeScript's.

use anyhow::{Context, Result};
use backend::fold_converge::Answerer;
use backend::{
    classification_inputs, config::Config, db, fitbit, lean, routes, state::AppState, sync_state,
};

#[tokio::main]
async fn main() -> Result<()> {
    // ⚠ BEFORE ANYTHING ELSE, AND FATAL IF IT FAILS. The rate-limit policy and
    // the backfill cursor arithmetic live in Lean, so a process that could not
    // start the runtime cannot decide anything — and a sync that ran without
    // being able to decide would spend a budget nobody checked and walk a cursor
    // nobody bounded. Refusing to start is the safe failure; limping is not.
    lean::init().context("starting the Lean runtime")?;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or_default();
    let flags = &args[args.len().min(1)..];
    match cmd {
        "check" => check().await,
        "serve" => serve().await,
        "sync" => {
            // ⚠ An UNRECOGNISED flag is refused, never ignored. The one flag
            // here selects whether durable backfill state is written, so a
            // typo silently falling through to the full run is the one outcome
            // this must not have.
            let passes = match flags {
                [] => fitbit::run::Passes::All,
                [f] if f == "--forward-only" => fitbit::run::Passes::Forward,
                _ => {
                    eprintln!("usage: backend sync [--forward-only]");
                    std::process::exit(64);
                }
            };
            sync(passes).await
        }
        "inputs" => {
            // ⚠ The tz is the DISPLAY tz and it is a separate thing from
            // `home_tz`: it bounds the local day, and a fixture captured for a
            // trip abroad carries the zone the day was LIVED in, not the one the
            // profile stores. They coincide for a user at home, which is exactly
            // why passing one for the other would go unnoticed.
            let (user, date, tz) = match flags {
                [user, date] => (user, date, None),
                [user, date, tz] => (user, date, Some(tz.as_str())),
                _ => {
                    eprintln!("usage: backend inputs <user> <date> [display-tz]");
                    std::process::exit(64);
                }
            };
            inputs(user, date, tz).await
        }
        "head" => {
            // Reads a golden fixture rather than the database on purpose: the
            // head's oracle is the frozen `expected.tsArm.capture` sitting in
            // the same file as the `inputs` it was computed from, so the whole
            // chain is checkable with no DB, no network and no Node.
            let [fixture] = flags else {
                eprintln!("usage: backend head <fixture.json>");
                std::process::exit(64);
            };
            head(fixture)
        }
        "day" => {
            let [fixture] = flags else {
                eprintln!("usage: backend day <fixture.json>");
                std::process::exit(64);
            };
            day(fixture)
        }
        "velocity" => {
            let (user, date, tz) = match flags {
                [user, date] => (user, date, None),
                [user, date, tz] => (user, date, Some(tz.as_str())),
                _ => {
                    eprintln!("usage: backend velocity <user> <date> [display-tz]");
                    std::process::exit(64);
                }
            };
            velocity(user, date, tz).await
        }
        "locations-check" => {
            let [user, date] = flags else {
                eprintln!("usage: backend locations-check <user> <date>");
                std::process::exit(64);
            };
            locations_check(user, date).await
        }
        "mint-session" => {
            let [user] = flags else {
                eprintln!("usage: backend mint-session <user>");
                std::process::exit(64);
            };
            mint_session(user).await
        }
        "drop-session" => {
            let [cookie] = flags else {
                eprintln!("usage: backend drop-session <cookie>");
                std::process::exit(64);
            };
            drop_session(cookie).await
        }
        // Tier 2 of #982: the first CronJob logic to move off node. Mirrors
        // `src/cli/refresh-presence-log.ts`.
        "refresh-presence-log" => {
            // ⚠ The CronJob passes `90`; the TypeScript defaults to 30 when the
            // argument is absent, and that default is part of the contract for
            // anyone running it by hand.
            let lookback: i64 = match flags {
                [] => 30,
                [n] => match n.parse::<i64>() {
                    Ok(v) if v > 0 => v,
                    _ => {
                        eprintln!("refresh-presence-log: invalid lookback {n:?}");
                        std::process::exit(2);
                    }
                },
                _ => {
                    eprintln!("usage: backend refresh-presence-log [lookback-days]");
                    std::process::exit(64);
                }
            };
            // ⚠ `DbConfig::from_env`, NOT `Config::from_env`: this touches only
            // the database, and the batch CronJobs do not set the Fitbit
            // credentials the full config requires.
            let dbcfg =
                backend::config::DbConfig::from_env().context("reading database configuration")?;
            let pool = db::connect(&dbcfg.url())
                .await
                .context("connecting to the database")?;
            let r = refresh_presence_log(&pool, lookback).await;
            pool.close().await;
            r
        }
        // `src/cli/refresh-focus-places.ts` — the weekly place miner.
        //
        //   backend refresh-focus-places                 all linked users, 180d
        //   backend refresh-focus-places <user>          one user, 180d
        //   backend refresh-focus-places <user> <days>   one user, explicit
        "refresh-focus-places" => {
            let (user, lookback): (Option<&str>, i64) = match flags {
                [] => (None, FOCUS_DEFAULT_LOOKBACK_DAYS),
                [u] => (Some(u.as_str()), FOCUS_DEFAULT_LOOKBACK_DAYS),
                [u, n] => match n.parse::<i64>() {
                    Ok(v) if v > 0 => (Some(u.as_str()), v),
                    _ => {
                        eprintln!("refresh-focus-places: invalid lookback {n:?}");
                        std::process::exit(2);
                    }
                },
                _ => {
                    eprintln!("usage: backend refresh-focus-places [user] [lookback-days]");
                    std::process::exit(64);
                }
            };
            // ⚠ `DbConfig::from_env`, NOT `Config::from_env`. The full config
            // demands FITBIT_CLIENT_ID and this pod does not set it — the focus
            // CronJob's env is DB_* plus NC_CLIENT_ID/NC_CLIENT_SECRET and
            // nothing else. Using the full config here failed in production on
            // 2026-08-24 with "missing required env var FITBIT_CLIENT_ID",
            // which is the SECOND time that has happened (see the note on
            // `DbConfig::from_env`); the first cost twelve minutes of
            // decode-day's work.
            //
            // The only thing this needs beyond the database is the Nextcloud
            // base URL, and that is one `std::env::var` — the NC credentials
            // are read from the database by `nextcloud::credentials`.
            let dbcfg =
                backend::config::DbConfig::from_env().context("reading database configuration")?;
            let pool = db::connect(&dbcfg.url())
                .await
                .context("connecting to the database")?;
            let r = refresh_focus_places(&pool, user, lookback).await;
            pool.close().await;
            r
        }
        // `src/cli/refresh-rail-routes.ts` — the nightly rail corridor miner.
        "refresh-rail-routes" => {
            let window: i64 = match flags {
                [] => RAIL_DEFAULT_WINDOW_DAYS,
                [n] => match n.parse::<i64>() {
                    Ok(v) if v > 0 => v,
                    _ => {
                        eprintln!("refresh-rail-routes: invalid window {n:?}");
                        std::process::exit(2);
                    }
                },
                _ => {
                    eprintln!("usage: backend refresh-rail-routes [window-days]");
                    std::process::exit(64);
                }
            };
            refresh_rail_routes(window).await
        }
        // `src/cli/decode-day.ts` — the nightly HSMM decoder.
        //
        //   backend decode-day                     all users, last 14 days
        //   backend decode-day <user>              one user, last 14 days
        //   backend decode-day <user> <days>       one user, explicit window
        //   backend decode-day <user> <YYYY-MM-DD> one user, one day
        //   … plus --dry-run anywhere              decode and print, write nothing
        //
        // ⚠ THE DATE IS POSITIONAL, not `--date <ymd>`, which is what this
        // comment claimed until 2026-08-26 — a numeric second argument is a day
        // COUNT and anything else is a date. Nothing enforced the label, so it
        // was wrong in the one place somebody would read before typing.
        //
        // ⚠ `--dry-run` DECODES AND PRINTS, writing nothing. `decoded_days` is
        // keyed `(user_id, date)` and the write is an OVERWRITE, so a run made to
        // check the port would destroy the node row it is being checked against.
        // The two Overpass mirrors grew the same flag for the same reason.
        "decode-day" => {
            let dry_run = flags.iter().any(|f| f == "--dry-run");
            let rest: Vec<&String> = flags.iter().filter(|f| *f != "--dry-run").collect();
            let (user, dates, days): (Option<&str>, Vec<String>, Option<i64>) =
                match rest.as_slice() {
                    [] => (None, Vec::new(), None),
                    [u] => (Some(u.as_str()), Vec::new(), None),
                    [u, d] if d.parse::<i64>().is_ok() => {
                        (Some(u.as_str()), Vec::new(), d.parse::<i64>().ok())
                    }
                    [u, d] => (Some(u.as_str()), vec![(*d).clone()], None),
                    _ => {
                        eprintln!("usage: backend decode-day [user] [days|YYYY-MM-DD] [--dry-run]");
                        std::process::exit(64);
                    }
                };
            decode_day(user, &dates, days, dry_run).await
        }
        // `src/cli/refresh-rail-stops.ts` — the nightly rail-relation mirror.
        //
        //   backend refresh-rail-stops              mirror and rebuild the cache
        //   backend refresh-rail-stops --dry-run    fetch and report, write nothing
        "refresh-rail-stops" => match flags {
            [] => refresh_rail_stops(false).await,
            [f] if f == "--dry-run" => refresh_rail_stops(true).await,
            _ => {
                eprintln!("usage: backend refresh-rail-stops [--dry-run]");
                std::process::exit(64);
            }
        },
        // `src/cli/refresh-bus-routes.ts` — the nightly bus-route mirror.
        "refresh-bus-routes" => match flags {
            [] => refresh_bus_routes(false).await,
            [f] if f == "--dry-run" => refresh_bus_routes(true).await,
            _ => {
                eprintln!("usage: backend refresh-bus-routes [--dry-run]");
                std::process::exit(64);
            }
        },
        "rows-check" => {
            let [user, since, date] = flags else {
                eprintln!("usage: backend rows-check <user> <since-date> <date>");
                std::process::exit(64);
            };
            let cfg = Config::from_env().context("reading configuration")?;
            let pool = db::connect(&cfg.db.url())
                .await
                .context("connecting to the database")?;
            let r = backend::rows_check::run(&pool, user, since, date).await;
            pool.close().await;
            r
        }
        "google-probe" => backend::google::probe::run().await,
        "coverage" => coverage().await,
        "google-compare" => google_compare().await,
        "mirror-check" => {
            let [fixture] = flags else {
                eprintln!("usage: backend mirror-check <fixture.json>");
                std::process::exit(64);
            };
            mirror_check(fixture).await
        }
        sub @ ("day-live" | "day-mirror") => {
            let (user, date, tz) = match flags {
                [user, date] => (user, date, None),
                [user, date, tz] => (user, date, Some(tz.as_str())),
                _ => {
                    eprintln!("usage: backend {sub} <user> <date> [display-tz]");
                    std::process::exit(64);
                }
            };
            day_live(user, date, tz, sub == "day-mirror").await
        }
        "" => {
            eprintln!(
                "usage: backend <check|serve|sync [--forward-only]|inputs <user> <date>|head <fixture.json>|day <fixture.json>|day-live <user> <date>|day-mirror <user> <date>|mirror-check <fixture.json>|google-probe|coverage|google-compare|rows-check <user> <since-date> <date>|velocity <user> <date>>"
            );
            std::process::exit(64);
        }
        other => {
            eprintln!(
                "backend: unknown subcommand {other:?} — expected check, serve, sync, inputs, head, day, day-live, day-mirror, mirror-check, google-probe, coverage, google-compare or velocity"
            );
            std::process::exit(64);
        }
    }
}

/// Does Google agree with Fitbit, day by day? (#260)
///
/// # Why this must run NOW
///
/// The Fitbit Web API is decommissioned in September. Until then BOTH sources
/// answer, and that overlap is the only period in which the Google numbers can
/// be checked against the ones we already trust. Afterwards a discrepancy is
/// permanent and invisible — there is nothing left to compare against.
///
/// ⚠ READ-ONLY. It writes nothing. A cutover that has not been diffed first is
/// a guess, and this is the instrument that makes it not one.
///
/// ⚠ THREE STREAMS ONLY, and deliberately. These are the ones where the
/// QUANTITY is unambiguous — breaths per minute against breaths per minute.
/// `skin_temperature.relative_deviation` against Google's
/// `nightlyTemperatureCelsius` is a deviation against an absolute, and
/// `daily_activity.resting_heart_rate` may be computed over a different window;
/// comparing those without establishing the semantics first would produce a
/// disagreement that means nothing. Add them when someone has checked.
async fn google_compare() -> Result<()> {
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let Some(creds) = backend::google::oauth::GoogleCreds::from_env() else {
        anyhow::bail!("GH_CLIENT_ID, GH_CLIENT_SECRET and GH_REFRESH_TOKEN must all be set");
    };
    let http = reqwest::Client::new();
    let token = backend::google::oauth::access_token(&http, &creds)
        .await
        .context("minting a Google access token")?;

    // (google type, value pointer, our table, our column, tolerance, unit)
    //
    // ⚠ THE TOLERANCE IS NOT A FUDGE FACTOR. Both sides store a float the
    // devices reported; an exact-equality test would fail on the last decimal
    // place and say nothing about whether the migration is safe. These are
    // tight enough that a real disagreement — a different window, a different
    // statistic — cannot hide inside one.
    struct Pair {
        google: &'static str,
        pointer: &'static str,
        table: &'static str,
        column: &'static str,
        tol: f64,
        unit: &'static str,
    }
    const PAIRS: &[Pair] = &[
        Pair {
            google: "daily-respiratory-rate",
            pointer: "/dailyRespiratoryRate/breathsPerMinute",
            table: "breathing_rate",
            column: "full_sleep_rate",
            tol: 0.05,
            unit: "breaths/min",
        },
        Pair {
            google: "daily-oxygen-saturation",
            pointer: "/dailyOxygenSaturation/averagePercentage",
            table: "spo2_daily",
            column: "avg_value",
            tol: 0.05,
            unit: "%",
        },
        Pair {
            google: "daily-heart-rate-variability",
            pointer: "/dailyHeartRateVariability/averageHeartRateVariabilityMilliseconds",
            table: "hrv_daily",
            column: "daily_rmssd",
            tol: 0.05,
            unit: "ms",
        },
    ];

    for p in PAIRS {
        let theirs =
            backend::google::health::fetch_daily_series(&http, &token, p.google, p.pointer).await?;
        let ours = read_daily_column(&pool, p.table, p.column).await?;
        report_pair(p.google, p.table, p.unit, p.tol, &theirs, &ours);
    }
    Ok(())
}

/// Our side of one comparison, as `(date, value)`.
///
/// ⚠ One literal per table, not a `format!`. The crate refuses a dynamically
/// built SQL string and dev-lint refuses even a `const` in a variable — schema
/// checking reads the argument at the call site.
async fn read_daily_column(
    pool: &sqlx::MySqlPool,
    table: &str,
    column: &str,
) -> Result<Vec<(String, f64)>> {
    use sqlx::Row as _;
    let rows = match (table, column) {
        ("breathing_rate", "full_sleep_rate") => {
            sqlx::query("SELECT CAST(date AS CHAR) d, CAST(full_sleep_rate AS CHAR) v FROM breathing_rate WHERE full_sleep_rate IS NOT NULL")
                .fetch_all(pool).await
        }
        ("spo2_daily", "avg_value") => {
            sqlx::query("SELECT CAST(date AS CHAR) d, CAST(avg_value AS CHAR) v FROM spo2_daily WHERE avg_value IS NOT NULL")
                .fetch_all(pool).await
        }
        ("hrv_daily", "daily_rmssd") => {
            sqlx::query("SELECT CAST(date AS CHAR) d, CAST(daily_rmssd AS CHAR) v FROM hrv_daily WHERE daily_rmssd IS NOT NULL")
                .fetch_all(pool).await
        }
        _ => anyhow::bail!("no query wired for {table}.{column}"),
    }
    .with_context(|| format!("reading {table}.{column}"))?;

    let mut out = Vec::new();
    for r in rows {
        let d: String = r.try_get("d").context("date column")?;
        // ⚠ `CAST(... AS CHAR)` ON THE VALUE TOO, not only on the date.
        //
        // These columns are DECIMAL, and sqlx decodes DECIMAL into neither f32
        // nor f64 — a live run answered
        //
        //     Rust type `f32` (as SQL type `FLOAT`) is not compatible with
        //     SQL type `DECIMAL`
        //
        // and an f64/f32 fallback does not help, because the fault is the SQL
        // type rather than its width. ⚠ THIS FAILS ON REAL ROWS ONLY: an empty
        // table decodes fine and the check passes, so a test against a fixture
        // would never have caught it. A string crosses cleanly from every
        // numeric type and this is a readout, not arithmetic.
        let raw: String = r.try_get("v").context("value column")?;
        let v: f64 = raw
            .parse()
            .with_context(|| format!("{table}.{column} value {raw:?} is not a number"))?;
        out.push((d, v));
    }
    Ok(out)
}

/// Print one stream's agreement, and say which side each gap is on.
///
/// ⚠ "Only in Google" and "only in ours" are DIFFERENT FINDINGS and are never
/// merged into one count: the first is data we would gain, the second is data
/// the migration would LOSE. A single "mismatch" number hides the direction,
/// which is the half that decides whether a cutover is safe.
fn report_pair(
    google: &str,
    table: &str,
    unit: &str,
    tol: f64,
    theirs: &[backend::google::health::DailyValue],
    ours: &[(String, f64)],
) {
    use std::collections::HashMap;
    let g: HashMap<&str, f64> = theirs.iter().map(|d| (d.date.as_str(), d.value)).collect();
    let o: HashMap<&str, f64> = ours.iter().map(|(d, v)| (d.as_str(), *v)).collect();

    let (mut agree, mut differ, mut worst, mut worst_day) = (0usize, 0usize, 0.0f64, String::new());
    for (d, gv) in &g {
        if let Some(ov) = o.get(d) {
            let delta = (gv - ov).abs();
            if delta <= tol {
                agree += 1;
            } else {
                differ += 1;
                if delta > worst {
                    worst = delta;
                    worst_day = (*d).to_string();
                }
            }
        }
    }
    let only_google = g.keys().filter(|d| !o.contains_key(*d)).count();
    let only_ours = o.keys().filter(|d| !g.contains_key(*d)).count();

    println!("{google} vs {table}");
    println!("  google {:>5} days   ours {:>5} days", g.len(), o.len());
    println!("  agree within {tol} {unit}: {agree}");
    if differ > 0 {
        println!("  ⚠ DIFFER: {differ}   worst {worst:.3} {unit} on {worst_day}");
    }
    if only_google > 0 {
        println!("  only in google: {only_google}  (data the migration would GAIN)");
    }
    if only_ours > 0 {
        println!("  ⚠ only in ours: {only_ours}  (data the migration would LOSE)");
    }
    println!();
}

/// What span of history does each biometric table actually hold? (#260)
///
/// # Why this exists
///
/// The Google Health migration needs to know which rows have a Google source
/// and which do not. `backend google-probe` measured the far side: the watch
/// series there begin 2023-04-16. This measures THIS side, so the two can be
/// compared instead of one being assumed from the other.
///
/// ⚠ FIVE GOOGLE STREAMS AGREEING ON ONE DATE IS NOT CORROBORATION. It is one
/// observation of one system, and it could as easily be an artefact of how the
/// probe asks as a fact about the data. A backfill sized from it alone would be
/// sized from a single unchecked number.
///
/// ⚠ `CAST(... AS CHAR)`, always. A bare `MIN(date)` decodes as a temporal type
/// and MariaDB's DATE/DATETIME mapping fails on real rows in ways an empty
/// table never shows — the same trap that has bitten DECIMAL and BIGINT
/// UNSIGNED here before. A string crosses cleanly and this is a readout, not
/// arithmetic.
///
/// Read-only: every statement is a SELECT over a fixed table list compiled in.
async fn coverage() -> Result<()> {
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;

    // ⚠ ONE STATIC QUERY, NOT A LOOP OVER A TABLE LIST.
    //
    // Two reasons, and the first is enforced: the crate refuses a dynamically
    // built SQL string (`dynamic SQL strings should be audited for possible
    // injections`), so a `format!`-ed table name will not compile. The second
    // is that the prod tunnel is latency-bound — eleven round trips over it
    // cost far more than eleven arms of one.
    // ⚠ THE LITERAL IS INLINE, not a `const` bound above.
    //
    // Two guards want this and they want slightly different things. The crate
    // refuses a dynamically built SQL string, so a `format!`-ed table name will
    // not compile; dev-lint's DL-SQLX-SCHEMA-TRUTH then refuses even a `const`
    // held in a variable, because schema checking reads the argument at the
    // call site. Inline satisfies both, and one static query is also one round
    // trip — the prod tunnel is latency-bound, so eleven separate reads over it
    // would cost far more than eleven arms of this.
    let rows = sqlx::query(
        "\
         SELECT 'body' AS t, COUNT(*) AS n, CAST(MIN(date) AS CHAR) AS lo, \
          CAST(MAX(date) AS CHAR) AS hi FROM body \
         UNION ALL SELECT 'breathing_rate' AS t, COUNT(*) AS n, CAST(MIN(date) AS CHAR) AS lo, \
          CAST(MAX(date) AS CHAR) AS hi FROM breathing_rate \
         UNION ALL SELECT 'daily_activity' AS t, COUNT(*) AS n, CAST(MIN(date) AS CHAR) AS lo, \
          CAST(MAX(date) AS CHAR) AS hi FROM daily_activity \
         UNION ALL SELECT 'heart_rate_zones' AS t, COUNT(*) AS n, CAST(MIN(date) AS CHAR) AS lo, \
          CAST(MAX(date) AS CHAR) AS hi FROM heart_rate_zones \
         UNION ALL SELECT 'hrv_daily' AS t, COUNT(*) AS n, CAST(MIN(date) AS CHAR) AS lo, \
          CAST(MAX(date) AS CHAR) AS hi FROM hrv_daily \
         UNION ALL SELECT 'skin_temperature' AS t, COUNT(*) AS n, CAST(MIN(date) AS CHAR) AS lo, \
          CAST(MAX(date) AS CHAR) AS hi FROM skin_temperature \
         UNION ALL SELECT 'sleep' AS t, COUNT(*) AS n, CAST(MIN(date) AS CHAR) AS lo, \
          CAST(MAX(date) AS CHAR) AS hi FROM sleep \
         UNION ALL SELECT 'spo2_daily' AS t, COUNT(*) AS n, CAST(MIN(date) AS CHAR) AS lo, \
          CAST(MAX(date) AS CHAR) AS hi FROM spo2_daily \
         UNION ALL SELECT 'heart_rate_intraday' AS t, COUNT(*) AS n, CAST(MIN(ts) AS CHAR) AS lo, \
          CAST(MAX(ts) AS CHAR) AS hi FROM heart_rate_intraday \
         UNION ALL SELECT 'hrv_intraday' AS t, COUNT(*) AS n, CAST(MIN(ts) AS CHAR) AS lo, \
          CAST(MAX(ts) AS CHAR) AS hi FROM hrv_intraday \
         UNION ALL SELECT 'steps_intraday' AS t, COUNT(*) AS n, CAST(MIN(ts) AS CHAR) AS lo, \
          CAST(MAX(ts) AS CHAR) AS hi FROM steps_intraday \
         ",
    )
    .fetch_all(&pool)
    .await
    .context("reading table coverage")?;

    println!("{:<22} {:>10}  earliest → latest", "table", "rows");
    for row in rows {
        use sqlx::Row as _;
        let t: String = row.try_get("t").unwrap_or_else(|_| "?".into());
        let n: i64 = row.try_get("n").unwrap_or(-1);
        let lo: Option<String> = row.try_get("lo").unwrap_or(None);
        let hi: Option<String> = row.try_get("hi").unwrap_or(None);
        match (lo, hi) {
            // ⚠ An empty table is said out loud. A blank span beside a zero
            // count reads as a failed query.
            (None, _) | (_, None) => println!("{t:<22} {n:>10}  (empty)"),
            (Some(lo), Some(hi)) => println!("{t:<22} {n:>10}  {lo} → {hi}"),
        }
    }
    Ok(())
}

/// Print the day's DB inputs as JSON, for diffing against the TypeScript.
///
/// ⚠ THIS IS THE PARITY INSTRUMENT, not a convenience. `backend check` proves
/// each query EXECUTES; it cannot prove the answer is the same one
/// `load-classification-inputs.ts` produces, and those are different claims —
/// a query can run, return rows, and still read the wrong column. The module
/// header says the honest comparison is both arms against one database with the
/// JSON diffed, and this is the half of that which did not exist.
///
/// Compare against a golden fixture's `inputs`, which IS the TypeScript
/// loader's output for that day:
///
///   scripts/prod-db.sh backend inputs pippijn 2026-08-13 > /tmp/rust.json
///   jq -S '{sleepWindows, hsmmDecode}' tests/golden/days/2026-08-13-pippijn.json
///
/// ⚠ ONLY THE PER-DAY FIELDS COMPARE CLEANLY. `busRouteCache`,
/// `railStopsCache`, `railRouteCache`, `knownPlaces` and `venuePriors` are
/// global or re-mined, so a fixture's copy is a snapshot of a moving table and a
/// difference there is drift, not a defect. `sleepWindows` and `hsmmDecode` are
/// fixed history for a past day and are the ones that mean something.
///
/// ⚠ REAL LOCATION DATA on stdout — where the user was and when. Redirect to
/// /tmp, never into the repo: both health repos are public.
async fn inputs(user: &str, date: &str, display_tz: Option<&str>) -> Result<()> {
    let cfg = Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    // The day's UTC bounds, for the window `motion_log` is read over. The tz is
    // the user's stored home zone, exactly as the TypeScript resolves it.
    let home_tz = sync_state::get(&pool, user, "home_tz")
        .await?
        .unwrap_or_else(|| "Europe/Amsterdam".into());
    // Defaults to `home_tz` when not given, which is what a day at home means.
    let display_tz = display_tz.unwrap_or(&home_tz);
    let bounds = backend::timezone::date_bounds_utc(date, Some(display_tz))
        .with_context(|| format!("bounding {date} in {display_tz}"))?;
    // ⚠ The DAY path's base URL has a default; the SYNC path's is an Option.
    // See `DAY_NEXTCLOUD_BASE_URL` — collapsing the two would either break
    // sync's "no PhoneTrack configured" case or blank every timeline.
    let base_url = cfg
        .nextcloud_base_url
        .clone()
        .unwrap_or_else(|| classification_inputs::DAY_NEXTCLOUD_BASE_URL.to_string());
    let out = classification_inputs::load(
        &pool,
        &reqwest::Client::new(),
        &base_url,
        &classification_inputs::DayIdentity {
            user_id: user,
            date,
            display_tz,
        },
        bounds,
        Some(&home_tz),
    )
    .await?;
    pool.close().await;
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}

/// Run one Fitbit ingestion pass over every linked user.
///
/// # ⚠ NOT YET AT PARITY WITH `dist/sync.js` — one thing is missing
///
/// Named here rather than left to be discovered from a diff, because it is a
/// silent absence: the run would look healthy and simply not do it.
///
///   * **`migrate()`**, below.
///
/// The Google Health weight sync USED to be the other entry and now runs — see
/// [`backend::google`]. It is still inert without `GH_*` and `GH_USER_ID`.
///
/// # It does NOT migrate the schema, and the TypeScript's `sync.ts` does
///
/// `dist/sync.js` calls `migrate()` on startup, so whichever of the sync cron
/// and the server started first brought the schema up. This does not, because
/// two processes racing to apply migrations is a worse failure than a missing
/// one, and `health-auth` already migrates on every start. ⚠ That means this
/// binary must not be the FIRST thing to run against a fresh database.
///
/// # The zone lookup is built once
///
/// `tzf-rs` decompresses its polygon set on construction, which is the
/// expensive part; the finder is then queried per fix. Building it per user, or
/// per row, is how a lookup that costs microseconds becomes one that costs
/// hundreds of milliseconds.
async fn sync(passes: fitbit::run::Passes) -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cfg = Config::from_env()?;
    let pool = db::connect(&cfg.db.url()).await?;
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .context("building the HTTP client")?;

    // ⚠ `sync` DOES call Fitbit, so a batch config here is a misconfiguration
    // rather than something to work around.
    let fb = cfg
        .fitbit
        .as_ref()
        .context("sync needs FITBIT_CLIENT_ID and FITBIT_CLIENT_SECRET")?;
    let polygons = fitbit::tz_source::PolygonLookup::new();
    let lookup = |lat: f64, lon: f64| polygons.zone(lat, lon);

    fitbit::run::run(
        &pool,
        &http,
        &fb.client_id,
        &fb.client_secret,
        cfg.nextcloud_base_url.as_deref(),
        &lookup,
        passes,
    )
    .await
}

/// Serve the HTTP surface.
///
/// ⚠ NOT PRODUCTION'S SERVER. `src/server.ts` owns every real route; this binds
/// the skeleton so the config → pool → axum stack is exercised by something
/// other than a unit test. `PORT` defaults to 8081 rather than the TypeScript
/// server's port: the two must be able to run side by side on one host during
/// the port, and defaulting to the same number would make the first accidental
/// double-start look like a crash.
async fn serve() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cfg = Config::from_env()?;
    let pool = db::connect(&cfg.db.url()).await?;
    // ⚠ `AUTH_PORT`, which is what the manifest ALREADY SETS and what
    // `src/config.ts` reads. This used to read `PORT`, which production does not
    // set — so flipping the manifest to this binary would have bound 8081 while
    // the Service and the readiness probe expected 3000, and the rollout would
    // have stalled on a pod that looked healthy from inside (#982).
    //
    // One name, not two with a fallback: a second accepted spelling is how the
    // two arms drift apart again, and the parity harness must run the same
    // environment production does.
    let port: u16 = std::env::var("AUTH_PORT")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.parse()
                .with_context(|| format!("AUTH_PORT is not a port number: {s:?}"))
        })
        .transpose()?
        .unwrap_or(8081);

    // Bounded, for the same reason the pool is: a hung Nextcloud or Fitbit must
    // not tie up a pod.
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;

    // ⚠ BEFORE serving. A pod that answers requests against a schema it has not
    // finished applying returns errors that look like data problems.
    backend::schema::migrate(&pool)
        .await
        .context("applying the schema")?;

    // ⚠ A sweep, because the per-request path only deletes a session when its
    // owner comes back with the cookie. Dormant accounts would otherwise
    // accumulate rows forever, and the table would grow with people who left.
    let sweep_pool = pool.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(6 * 60 * 60));
        loop {
            ticker.tick().await;
            let now_ms = chrono::Utc::now().timestamp_millis();
            match backend::auth::session::cleanup_expired(&sweep_pool, now_ms).await {
                // Silent when there was nothing to do: a line every six hours
                // saying "0" trains a reader to skip the line that says 400.
                Ok(0) => {}
                Ok(n) => tracing::info!(swept = n, "expired session(s) removed"),
                Err(e) => tracing::error!(error = %format!("{e:#}"), "session sweep failed"),
            }
        }
    });

    let app = routes::router(AppState::new(pool, cfg, http));
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .with_context(|| format!("binding port {port}"))?;
    tracing::info!("health backend (rust) listening on {port}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            // SIGTERM is what Kubernetes sends; without this the pod is killed
            // mid-request at the end of the grace period instead of draining.
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("installing SIGTERM handler");
            tokio::select! {
                _ = term.recv() => {}
                _ = tokio::signal::ctrl_c() => {}
            }
            tracing::info!("shutting down");
        })
        .await
        .context("serving")?;
    Ok(())
}

/// Prove the config and the pool against the real database, and read nothing
/// anybody's privacy depends on.
///
/// This is the same shape of evidence `mirror.rs` was landed with: the port was
/// only believable once a query had run against the live server, because
/// nothing in a unit test executes SQL and "it compiles" says nothing about
/// bind order, credentials, or whether the schema is what the code thinks.
///
/// ⚠ It prints COUNTS and never values. `sync_state` holds cursors keyed by
/// user; the row count and the distinct-key count prove the table is reachable
/// and the decode path works without putting anyone's data on a terminal.
async fn check() -> Result<()> {
    let cfg = Config::from_env().context("reading configuration")?;
    let fb = cfg.fitbit.clone().unwrap_or(backend::config::FitbitConfig {
        client_id: "<absent: batch config>".into(),
        client_secret: String::new(),
    });
    println!(
        "config: db {}:{}/{} user={} fitbit_client={} nextcloud={}",
        cfg.db.host,
        cfg.db.port,
        cfg.db.database,
        cfg.db.user,
        // The client ID is not a secret (it ships in the OAuth redirect); the
        // SECRET is never printed, and its presence is reported as a boolean.
        fb.client_id,
        cfg.nextcloud_base_url.as_deref().unwrap_or("<unset>")
    );
    println!(
        "config: fitbit client secret {}",
        if fb.client_secret.is_empty() {
            "EMPTY"
        } else {
            "present"
        }
    );

    let pool = db::connect(&cfg.db.url()).await?;

    // The connection itself.
    let one: i64 = sqlx::query_scalar("SELECT 1")
        .fetch_one(&pool)
        .await
        .context("SELECT 1")?;
    println!("db: SELECT 1 -> {one}");

    // That the session zone pin actually took. Asserting it rather than
    // trusting `after_connect` to have run: a pool option that silently did not
    // apply would leave every DB-clock timestamp off by the server's offset,
    // and nothing else in this binary would notice.
    let tz: String = sqlx::query_scalar("SELECT @@session.time_zone")
        .fetch_one(&pool)
        .await
        .context("reading session time_zone")?;
    println!("db: session time_zone = {tz}");
    if tz != "+00:00" {
        anyhow::bail!(
            "session time_zone is {tz:?}, expected \"+00:00\" — the UTC pin did not apply"
        );
    }

    // The cursor table, which is the first thing any scheduled work reads.
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_state")
        .fetch_one(&pool)
        .await
        .context("counting sync_state")?;
    let keys: i64 = sqlx::query_scalar("SELECT COUNT(DISTINCT key_name) FROM sync_state")
        .fetch_one(&pool)
        .await
        .context("counting sync_state keys")?;
    println!("sync_state: {rows} row(s), {keys} distinct key(s)");

    // The typed read path, through the same function scheduled work will use.
    // A key nobody stores, so the answer is a known `None` and this asserts the
    // ABSENT case decodes rather than the present one — the case a wrong column
    // type would still pass.
    let missing = sync_state::get(&pool, "\u{0}no-such-user", "\u{0}no-such-key").await?;
    if missing.is_some() {
        anyhow::bail!("sync_state::get returned a value for a key that cannot exist");
    }
    println!("sync_state: absent-key read decodes as None");

    // The day-input loaders (#982). Counts, not contents: this runs against
    // PRODUCTION and the rows are real places and real movement.
    //
    // ⚠ The point is that the SQL EXECUTES — column names, bind order, and the
    // decode of every DECIMAL and every nullable. None of that is exercised by
    // compiling, and none of it is exercised by a unit test, because no unit
    // test in this crate runs SQL. It is the same bar `sync_state` above is
    // held to, and for the same reason.
    let user = std::env::var("CHECK_USER").unwrap_or_else(|_| "pippijn".into());
    let places = classification_inputs::known_places(&pool, &user).await?;
    let modes = classification_inputs::mode_biometrics(&pool, &user).await?;
    let rail = classification_inputs::rail_route_cache(&pool).await?;
    let priors = classification_inputs::venue_priors(&pool, &user).await?;
    let len = |v: &serde_json::Value| v.as_array().map_or(0, Vec::len);
    // ⚠ VALUES, NOT JUST COUNTS. `focus_places.centroid_lat` is DECIMAL, which
    // the driver hands back as a STRING — the TypeScript wraps every one in
    // `Number(...)` for exactly that reason. A row count proves the query ran;
    // it does not prove one coordinate decoded, and 117 rows of 0.0 print
    // identically to 117 real ones. This check had that hole when it was written.
    let zero_centroids = places.as_array().map_or(0, |a| {
        a.iter()
            .filter(|p| p["centroidLat"].as_f64() == Some(0.0))
            .count()
    });
    println!(
        "inputs[{user}]: focus_places {} · mode_biometrics {} · rail_route_cache {} · venue_priors {}",
        len(&places),
        len(&modes),
        len(&rail),
        if priors.is_null() {
            "absent"
        } else {
            "present"
        },
    );
    // ⚠ A read that returns NOTHING is not a read that worked. Every one of
    // these is populated in production, so an empty answer means a query that
    // ran against the wrong column or the wrong user and said so quietly.
    if len(&places) == 0 || len(&modes) == 0 || len(&rail) == 0 {
        anyhow::bail!(
            "a day-input loader came back empty for {user} — production has rows in all three,              so this is a query that ran and found nothing, not an empty database"
        );
    }

    if zero_centroids > 0 {
        anyhow::bail!(
            "{zero_centroids} focus place(s) decoded to centroidLat 0.0 — a DECIMAL that did not \
             decode reads as zero, and null island is not where anyone lives"
        );
    }
    println!(
        "inputs[{user}]: centroids decoded non-zero: {}",
        len(&places) - zero_centroids
    );

    // The watch-battery trace (#982). ⚠ Here for the DECODES, which fail only on
    // real rows: `battery_level` is `TINYINT UNSIGNED` and `last_sync_time` is a
    // `DATETIME` that sqlx will not hand back as text.
    //
    // ⚠ The assertion is that levels are NOT ALL ZERO, and that is the whole
    // point of putting it here. The first version of the loader defaulted a
    // failed decode to 0, which draws a watch reporting EMPTY at every sync — a
    // well-formed chart, indistinguishable from a real flat battery, and a row
    // count would have printed OK for it.
    let home_tz = sync_state::get(&pool, &user, "home_tz")
        .await?
        .unwrap_or_else(|| "Europe/Amsterdam".into());
    let latest: Option<(Option<chrono::NaiveDateTime>,)> =
        sqlx::query_as("SELECT MAX(last_sync_time) FROM device_battery_log WHERE user_id = ?")
            .bind(&user)
            .fetch_optional(&pool)
            .await
            .context("reading the newest device_battery_log row")?;
    match latest.and_then(|(t,)| t) {
        None => println!("watch_battery[{user}]: no rows — nothing to decode"),
        Some(newest) => {
            let date = newest.format("%Y-%m-%d").to_string();
            let b = backend::timezone::date_bounds_utc(&date, Some(&home_tz))?;
            let series = backend::fitbit::watch_battery::load(
                &pool,
                &user,
                &home_tz,
                b.start_utc,
                b.end_utc,
            )
            .await?;
            let levels: std::collections::BTreeSet<i64> = series.iter().map(|(_, l)| *l).collect();
            println!(
                "watch_battery[{user}]: {} sample(s) on its newest day, {} distinct level(s)",
                series.len(),
                levels.len()
            );
            // ⚠ An EMPTY series is not a failure: the newest row's own civil day
            // in the home zone may hold only that one reading, and the collapse
            // can leave it. What cannot happen on real data is every level
            // reading zero.
            if !series.is_empty() && levels == std::collections::BTreeSet::from([0]) {
                anyhow::bail!(
                    "every watch-battery level decoded to 0 — an integer that did not decode \
                     reads as zero, and a watch that is empty at every sync is not a watch"
                );
            }
        }
    }

    // ⚠ THE SAME HAZARD ONE COLUMN OVER, and it was live: `hour_profile` is a
    // comma-separated per-mille list, the first port read it as JSON, and all
    // 117 profiles decoded to "absent" while this check printed OK — because
    // the check looked at centroids and nothing else. A place legitimately has
    // no profile before it is mined, so SOME nulls are right and ALL nulls is
    // the shape a format error takes here.
    let profiled = places.as_array().map_or(0, |a| {
        a.iter()
            .filter(|p| p["hourProfile"].as_array().is_some_and(|h| h.len() == 24))
            .count()
    });
    if profiled == 0 {
        anyhow::bail!(
            "not one of {} focus places has a 24-bucket hour profile — production mines them, so \
             this is the stored FORMAT being misread, not an unmined user",
            len(&places)
        );
    }
    println!("inputs[{user}]: hour profiles with 24 buckets: {profiled}");

    // The second tranche (#982). These need a DATE, and picking one by hand
    // would be a check that rots: the corpus moves and a hardcoded day
    // eventually has no decode, at which point the assertions below turn into
    // "production is empty" and get deleted by whoever is unblocking a deploy.
    //
    // So the date is CHOSEN FROM THE DATA — the newest day this user has a
    // current-version decode for. That makes `hsmm_decode` non-null BY
    // CONSTRUCTION, which is the point: a loader that returned null for every
    // day would otherwise be indistinguishable from a day that has no decode.
    let check_date: Option<String> = sqlx::query_scalar(
        "SELECT DATE_FORMAT(MAX(date), '%Y-%m-%d') FROM decoded_days \
         WHERE user_id = ? AND classifier_version = 7",
    )
    .bind(&user)
    .fetch_one(&pool)
    .await
    .context("choosing a check date from decoded_days")?;
    let Some(check_date) = check_date else {
        anyhow::bail!(
            "{user} has no decoded_days row at the current classifier version — either the \
             decode cron has not run, or CLASSIFIER_VERSION has drifted between the TypeScript \
             that writes and the Rust that reads"
        );
    };

    let buses = classification_inputs::bus_route_cache(&pool).await?;
    let rail_stops = classification_inputs::rail_stops_cache(&pool).await?;
    let decode = classification_inputs::hsmm_decode(&pool, &user, &check_date).await?;
    let sleeps = classification_inputs::sleep_windows(&pool, &user, &check_date).await?;
    println!(
        "inputs[{user}] @{check_date}: bus_route_cache {} · rail_stops_cache {} · \
         decoded_days {} segment(s) · sleep_windows {}",
        len(&buses),
        len(&rail_stops),
        len(&decode),
        len(&sleeps),
    );
    if len(&buses) == 0 || len(&rail_stops) == 0 {
        anyhow::bail!(
            "a mirror cache came back empty — both are populated in production, and these two \
             loaders DROP a malformed row silently, so empty is the shape a wrong column name \
             takes here rather than an error"
        );
    }
    if decode.is_null() || len(&decode) == 0 {
        anyhow::bail!(
            "decoded_days({user}, {check_date}) is empty, but the date was chosen BECAUSE it has \
             a row — so this is the version filter or the bind order, not missing data"
        );
    }

    // ⚠ VALUES AGAIN, and the same hazard as the centroids: a BIGINT that fails
    // to decode reads as 0, and 995 routes numbered zero print the same count
    // as 995 real ones.
    let zero_ids = |v: &serde_json::Value| {
        v.as_array().map_or(0, |a| {
            a.iter()
                .filter(|r| r["osmRelationId"].as_f64().unwrap_or(0.0) == 0.0)
                .count()
        })
    };
    if zero_ids(&buses) > 0 || zero_ids(&rail_stops) > 0 {
        anyhow::bail!(
            "{} bus and {} rail relation id(s) decoded to 0 — OSM has no relation 0",
            zero_ids(&buses),
            zero_ids(&rail_stops)
        );
    }

    // Sleep windows are the only loader here that COMPUTES rather than copies:
    // `start_time` is a wall clock and the timestamp comes from a tz conversion.
    // A conversion that silently produced nothing reads as 0 (1970), and an
    // inverted window reads as a plausible-looking pair of numbers, so both are
    // named. A day with no main sleep is legitimate and is not an error.
    for w in sleeps.as_array().into_iter().flatten() {
        let (a, b) = (
            w["startTs"].as_i64().unwrap_or(0),
            w["endTs"].as_i64().unwrap_or(0),
        );
        if a <= 0 || b <= a {
            anyhow::bail!(
                "sleep window [{a}, {b}] for {user} on {check_date} is not a forward interval in \
                 the present — the wall-clock conversion did not run"
            );
        }
    }
    println!(
        "inputs[{user}] @{check_date}: {} sleep window(s), all forward",
        len(&sleeps)
    );

    // The last of the SQL loaders (#982). `biometrics` is the one that COMPUTES
    // — six queries, three of them a wall-clock fallback — so an empty stream
    // is the shape most of its failure modes take.
    let home_tz = sync_state::get(&pool, &user, "home_tz")
        .await?
        .unwrap_or_else(|| "Europe/Amsterdam".into());
    let bounds = backend::timezone::date_bounds_utc(&check_date, Some(&home_tz))
        .with_context(|| format!("bounding {check_date} in {home_tz}"))?;
    let bio = classification_inputs::biometrics(
        &pool,
        &user,
        bounds.start_utc,
        bounds.end_utc,
        Some(&home_tz),
        Some(&home_tz),
    )
    .await?;
    let bracket = classification_inputs::empty_day_bracket(&pool, &user, &check_date).await?;
    println!(
        "inputs[{user}] @{check_date}: hr {} · sleep stages {} · stepped minutes {} · bracket {}",
        len(&bio["hr"]),
        len(&bio["sleep"]),
        len(&bio["steps"]),
        if bracket.is_null() { "none" } else { "present" },
    );
    // ⚠ HR is the one that cannot legitimately be empty on a decoded day: the
    // date was chosen because it HAS an HSMM decode, and the decoder reads
    // these streams. Sleep and steps can be genuinely empty (a watch off the
    // wrist, a day sat still), so they are reported and not enforced.
    if len(&bio["hr"]) == 0 {
        anyhow::bail!(
            "no heart rate for {user} on {check_date}, a day that HAS a decode — the window \
             bounds or the ts_utc filter, not a missing Fitbit"
        );
    }
    // ⚠ A bpm of 0 is what a DECIMAL that did not decode looks like, and
    // `ROUND(AVG(bpm))` returns a DECIMAL. This is the third column in this
    // file to hit that trap.
    let dead_bpm = bio["hr"]
        .as_array()
        .map_or(0, |a| a.iter().filter(|p| p["bpm"] == 0).count());
    if dead_bpm > 0 {
        anyhow::bail!("{dead_bpm} heart-rate minute(s) decoded to 0 bpm — nobody survives that");
    }

    // PhoneTrack — the only input that is not SQL, and the only one this check
    // cannot reach without the network. Run last so a Nextcloud outage does not
    // hide a database problem behind it.
    //
    // ⚠ ZERO FIXES IS NOT PROOF OF A WORKING FETCH. A revoked app password, a
    // wrong base URL and a phone left at home all produce an empty array, and
    // the pipeline reads an empty day as "stationary at the bracketed place".
    // So this asserts fixes exist on a day that HAS a decode — the decoder runs
    // on GPS, so a decoded day had fixes when the TypeScript looked.
    let base_url = cfg
        .nextcloud_base_url
        .clone()
        .unwrap_or_else(|| classification_inputs::DAY_NEXTCLOUD_BASE_URL.to_string());
    let pt = backend::nextcloud::phonetrack::PhoneTrack::open(
        reqwest::Client::new(),
        &pool,
        &base_url,
        &user,
    )
    .await
    .context("opening PhoneTrack")?;
    let fetched = pt
        .fetch_window(&pool, bounds.start_utc, bounds.end_utc)
        .await
        .context("fetching the check day's PhoneTrack fixes")?;
    println!(
        "inputs[{user}] @{check_date}: phonetrack {} fix(es) from {} device(s), {} failed",
        fetched.points.len(),
        pt.device_count(),
        fetched.failed_devices,
    );
    if fetched.points.is_empty() {
        anyhow::bail!(
            "no PhoneTrack fixes for {user} on {check_date}, a day that HAS an HSMM decode — the \
             decoder runs on GPS, so the TypeScript saw fixes here and this arm did not"
        );
    }
    // ⚠ A partial walk is a FAILED check here, not a warning. Unlike the loader
    // — which prefers a partial day to none — this exists to say the path works,
    // and a path that half works is the case it is meant to catch.
    if fetched.failed_devices > 0 {
        anyhow::bail!(
            "{} PhoneTrack device(s) failed — these fixes are a subset, and a gap in them is \
             indistinguishable from a phone that was switched off",
            fetched.failed_devices
        );
    }

    pool.close().await;
    println!("check: OK");
    Ok(())
}

/// Print the capture and battery trace the head computes from a fixture's inputs.
///
/// The parity instrument for #982's second half. `backend check` proves the
/// stages RUN, which is strictly weaker than proving they agree; this prints
/// what a diff can be taken of.
///
/// ⚠ DIFF THE TEXT, NOT THROUGH `jq`. jq parses both sides to doubles, so
/// `25.0 == 25` and it calls a rendering difference clean — which is how three
/// wrong fields survived the loaders' first parity pass. `tests/head_corpus.rs`
/// does this over the whole corpus; this is for looking at one day.
fn head(fixture: &str) -> Result<()> {
    let text = std::fs::read_to_string(fixture).with_context(|| format!("reading {fixture}"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&text).with_context(|| format!("parsing {fixture}"))?;
    let name = std::path::Path::new(fixture)
        .file_stem()
        .and_then(|s| s.to_str())
        .context("the fixture path has no file name")?;
    let (date, user) = name
        .split_once('-')
        .and_then(|_| Some((name.get(..10)?, name.get(11..)?)))
        .with_context(|| format!("{name} is not <YYYY-MM-DD>-<user>"))?;
    let inputs = parsed.get("inputs").context("the fixture has no inputs")?;
    let cap = backend::head::capture(inputs, date, user)?;
    // The battery trace rides alongside rather than inside: the fold's capture
    // shape has no room for it — the TypeScript computes the chart BESIDE the
    // fold, not in it — and `backend day` reads this same struct.
    let battery = backend::head::run(inputs, date)?.battery;
    println!(
        "{}",
        serde_json::json!({ "capture": cap, "battery": battery })
    );
    Ok(())
}

/// Run a whole day from a golden fixture: inputs → head → request → fold.
///
/// The chain end to end with no Node and no database. `head` prints what the
/// fold is asked; this prints what it answers, having walked the converge loop
/// against the fixture's own OSM row set.
///
/// The oracle is `expected.velocity` in the same file. This prints the timeline
/// rather than judging it — `tests/day_corpus.rs` is what compares.
fn day(fixture: &str) -> Result<()> {
    let text = std::fs::read_to_string(fixture).with_context(|| format!("reading {fixture}"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&text).with_context(|| format!("parsing {fixture}"))?;
    let name = std::path::Path::new(fixture)
        .file_stem()
        .and_then(|s| s.to_str())
        .context("the fixture path has no file name")?;
    let (date, user) = name
        .split_once('-')
        .and_then(|_| Some((name.get(..10)?, name.get(11..)?)))
        .with_context(|| format!("{name} is not <YYYY-MM-DD>-<user>"))?;
    let inputs = parsed.get("inputs").context("the fixture has no inputs")?;

    let cap = backend::head::capture(inputs, date, user)?;
    let rows = inputs
        .get("osmRowSet")
        .context("the fixture has no osmRowSet to answer from")?;
    let mut answerer = backend::rowset_answerer::RowSetAnswerer::new(rows)?;
    let r = backend::fold_converge::converge(&cap, inputs, inputs.get("osmTrace"), &mut answerer)?;

    // ⚠ On stderr, so stdout stays a clean timeline to diff. A walk that left
    // keys unanswered produced a timeline from DEFAULTS for them, and that is
    // not the same day — it has to be visible without reading the JSON.
    eprintln!(
        "{date} {user}: {} round(s), {} key(s) answered, {} unanswerable",
        r.rounds,
        r.answered,
        r.unanswerable.len()
    );
    for m in &r.unanswerable {
        eprintln!("  UNANSWERED {}({})", m.what, m.key);
    }
    println!("{}", r.out);
    Ok(())
}

/// Build `/velocity`'s response for one day, from PRODUCTION.
///
/// # ⚠ What this covers, and what it does not
///
/// The route's GATE — auth, the share window, parameter validation — is
/// `tests/velocity_route.rs`, and none of it runs here: this calls the handler's
/// assembly directly with no session. What it covers is the half no test can,
/// because it needs a database and the OSM mirror: that the day actually
/// assembles into a response, with every key the frontend reads present and
/// populated.
///
/// The clip is applied here too, so the printed body is what a request would
/// receive rather than the cached value behind it.
///
/// ⚠ REAL LOCATION DATA on stdout. Redirect to /tmp, never into the repo: both
/// health repos are public.
async fn velocity(user: &str, date: &str, display_tz: Option<&str>) -> Result<()> {
    let cfg = Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let st = backend::state::AppState::new(pool.clone(), cfg, reqwest::Client::new());

    let started = std::time::Instant::now();
    let body = backend::routes::velocity::compute(&st, user, date, display_tz).await?;
    let compute_ms = started.elapsed().as_millis();

    // ⚠ The per-request clip, so this prints what a CALLER sees. Skipping it
    // would print the cached value, which for today is a day asserting a future
    // that has not happened.
    let now_s = chrono::Utc::now().timestamp();
    let states = body
        .get("states")
        .and_then(serde_json::Value::as_array)
        .map(|s| lean::clip_inferred_future(s, now_s))
        .transpose()?
        .unwrap_or_default();
    let clipped = states.len();
    let mut body = body;
    let before = body["states"].as_array().map_or(0, Vec::len);
    body["states"] = serde_json::Value::Array(states);
    pool.close().await;

    // ⚠ COUNTS on stderr, body on stdout. A key that is present but EMPTY is the
    // failure this exists to catch — an assembled response with no points reads
    // as a quiet day rather than as a broken join.
    let len = |k: &str| {
        body.get(k)
            .and_then(serde_json::Value::as_array)
            .map_or(0, Vec::len)
    };
    // ⚠ The TIMING rides on this line too. `fold` dominates, and its cost is
    // round trips — so `mirrorQueries` beside it is what makes the number
    // comparable to an in-cluster run instead of a figure from a laptop over an
    // SSH tunnel (~50x, measured 2026-08-17).
    let t = |k: &str| {
        body.pointer(&format!("/timing/{k}"))
            .cloned()
            .unwrap_or(serde_json::Value::Null)
    };
    eprintln!(
        "velocity[{user}] {date}: {compute_ms} ms — load {} · head {} · fold {} \
         ({} mirror quer(ies), {} round(s), {} key(s)) · watchBattery {}",
        t("load"),
        t("head"),
        t("fold"),
        t("mirrorQueries"),
        t("rounds"),
        t("answered"),
        t("watchBattery"),
    );
    eprintln!(
        "velocity[{user}] {date}: points {} · rawFixes {} · segments {} · \
         states {before}->{clipped} · episodes {} · battery {} · watchBattery {}",
        len("points"),
        len("rawFixes"),
        len("segments"),
        len("episodes"),
        len("battery"),
        len("watchBattery"),
    );
    for k in [
        "points", "rawFixes", "segments", "states", "episodes", "battery",
    ] {
        if body.get(k).is_none() {
            anyhow::bail!("the response has no `{k}` — the frontend reads it");
        }
    }
    println!("{body}");
    Ok(())
}

/// Does the LIVE MIRROR answer a golden day's OSM questions the way its captured
/// row set does?
///
/// # ⚠ Why a count of answered keys is not evidence
///
/// `day-mirror` reports how many keys the mirror answered, and every failure
/// mode this source has produces an ANSWER rather than a decline: a swapped
/// `lat`/`lon` in the box WKT selects rows from the wrong hemisphere, a
/// misspelled `feature_type` selects none, and both come back as "no ways within
/// 50 m" — well-formed, plausible, and wrong. The coverage gate does not catch
/// either, because coverage is about the AREA and these are about the query.
///
/// So this asks both sources the same questions. The fixture's row set was
/// extracted from this same mirror, so agreement is the expected result and a
/// disagreement is either a real defect or the mirror having moved since the
/// capture — which the FIELDS that moved distinguish, not the count.
///
/// Run against production on 2026-08-22, and this is the baseline a future run
/// compares against:
///
///     2026-08-13   136 questions   135 agree   0 declined
///                  nearbyWays: 1 differ (57 -> 58), a row the mirror has gained
///     2026-04-29   120 questions   117 agree   0 declined
///                  nearbyWays: 3 differ, all same-width, all `name`/`subtype`
///
/// ⚠ The older day differs MORE, and no difference anywhere moved `distanceM`.
/// Both facts are what OSM drift looks like and neither is what a defect in this
/// source would look like: a wrong box or a wrong bucket answers EMPTY, and a
/// coordinate read by the wrong path moves every distance derived from it.
///
/// ⚠ REPORTS COUNTS, NEVER CONTENT. The answers carry street and venue names at
/// coordinates the user stood on; both health repos are public, and this runs
/// with a terminal open.
async fn mirror_check(fixture: &str) -> Result<()> {
    /// The tables a row source can answer. `nearbyWays` spells no radius in its
    /// key — the answerer uses the default.
    ///
    /// ⚠ `nearbyLandmarks` BELONGS HERE, and its absence is what let #1054 run.
    /// This check reported 148/148 agreement on 2026-08-22 while the landmark
    /// shaping was answering an EMPTY list for every stay in every day — the
    /// one table that puts a venue name on a timeline was the one table not
    /// compared. A check that omits the thing it is trusted to cover reads as
    /// evidence and is not.
    const TABLES: [&str; 4] = [
        "nearbyWays",
        "nearbyStations",
        "linesAtPoint",
        "nearbyLandmarks",
    ];

    let text = std::fs::read_to_string(fixture).with_context(|| format!("reading {fixture}"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&text).with_context(|| format!("parsing {fixture}"))?;
    let inputs = parsed.get("inputs").context("the fixture has no inputs")?;
    let rows = inputs
        .get("osmRowSet")
        .context("the fixture has no osmRowSet")?;
    let trace = inputs
        .get("osmTrace")
        .context("the fixture has no osmTrace")?;

    // The questions: every coordinate the day actually asked about, spelled the
    // way the fold spells a miss — bit patterns, not decimals.
    let mut asks: Vec<backend::lean::Miss> = Vec::new();
    for table in TABLES {
        let Some(keys) = trace.get(table).and_then(serde_json::Value::as_object) else {
            continue;
        };
        for k in keys.keys() {
            let p: Vec<&str> = k.split('|').collect();
            let (Some(Ok(la)), Some(Ok(lo))) = (
                p.first().map(|s| s.parse::<f64>()),
                p.get(1).map(|s| s.parse::<f64>()),
            ) else {
                continue;
            };
            let key = match p.get(2).and_then(|s| s.parse::<f64>().ok()) {
                Some(r) => format!("{}|{}|{}", la.to_bits(), lo.to_bits(), r.to_bits()),
                None => format!("{}|{}", la.to_bits(), lo.to_bits()),
            };
            asks.push(backend::lean::Miss {
                what: table.to_string(),
                key,
            });
        }
    }
    eprintln!("{} question(s) from the fixture's trace", asks.len());

    // The offline arm: the rows the fixture carries.
    let mut offline = backend::rowset_answerer::RowSetAnswerer::new(rows)?;
    let from_rows: Vec<Option<serde_json::Value>> = asks
        .iter()
        .map(|m| Ok(offline.answer(m)?.map(|(_, v)| v)))
        .collect::<Result<_>>()?;

    // The live arm.
    let cfg = Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .context("the system clock is before the epoch")?
        .as_millis() as i64;
    let questions = asks.clone();
    let from_mirror =
        backend::mirror_source::with_mirror_answerer(pool.clone(), now_ms, move |answerer| {
            questions
                .iter()
                .map(|m| Ok(answerer.answer(m)?.map(|(_, v)| v)))
                .collect::<Result<Vec<_>>>()
        })
        .await?;
    pool.close().await;

    /// Answers are `[lat, lon, rows]` or `[lat, lon, radius, rows]` — the row
    /// list is the last element either way.
    fn rows_of(v: &serde_json::Value) -> &[serde_json::Value] {
        v.as_array()
            .and_then(|a| a.last())
            .and_then(serde_json::Value::as_array)
            .map_or(&[], Vec::as_slice)
    }

    /// WHICH FIELDS moved between two answers of the same width.
    ///
    /// ⚠ The classification is the point, not the count. Two explanations fit a
    /// same-width difference and they call for opposite work:
    ///
    ///   * only `distanceM` — the two arms read the stored coordinate by
    ///     different paths. The capture came through the TypeScript driver's
    ///     TEXT rendering of a `DOUBLE`; this reads `ST_X`/`ST_Y` in the binary
    ///     protocol. A coordinate whose text form does not round-trip differs in
    ///     the last ULP and moves every distance computed from it. That would be
    ///     a defect in THIS port.
    ///   * `name`, `subtype` or `osmId` — OSM itself moved since the capture.
    ///     Nothing to fix; the fixture is a photograph of an older mirror.
    fn moved_fields(want: &serde_json::Value, got: &serde_json::Value) -> Vec<String> {
        let mut fields = std::collections::BTreeSet::new();
        for (w, g) in rows_of(want).iter().zip(rows_of(got)) {
            match (w.as_object(), g.as_object()) {
                (Some(w), Some(g)) => {
                    for k in w.keys().chain(g.keys()) {
                        if w.get(k) != g.get(k) {
                            fields.insert(k.clone());
                        }
                    }
                }
                // `linesAtPoint` answers with bare strings.
                _ if w != g => {
                    fields.insert("<value>".to_string());
                }
                _ => {}
            }
        }
        fields.into_iter().collect()
    }

    let mut agree = 0usize;
    let mut declined = 0usize;
    #[allow(clippy::type_complexity)]
    let mut differ: std::collections::BTreeMap<&str, Vec<(usize, usize, Vec<String>)>> =
        Default::default();
    for ((m, want), got) in asks.iter().zip(&from_rows).zip(&from_mirror) {
        match (want, got) {
            (Some(w), Some(g)) if w == g => agree += 1,
            // ⚠ A decline is NOT a difference to average away. It means the
            // mirror has no coverage row for an area the capture had rows for,
            // which is a finding about the mirror rather than about this port.
            (_, None) => declined += 1,
            (Some(w), Some(g)) => differ.entry(m.what.as_str()).or_default().push((
                rows_of(w).len(),
                rows_of(g).len(),
                moved_fields(w, g),
            )),
            (None, Some(_)) => {
                // The fixture could not answer and the mirror could. Nothing in
                // these three tables should do this; count it as a difference so
                // it cannot pass silently.
                differ.entry(m.what.as_str()).or_default().push((
                    0,
                    1,
                    vec!["<unanswerable offline>".into()],
                ));
            }
        }
    }

    eprintln!("agree: {agree}   mirror declined: {declined}");
    for (table, ds) in &differ {
        // ⚠ COUNTS AND FIELD NAMES, never values: a value here is a street the
        // user walked down.
        let empties = ds.iter().filter(|(_, g, _)| *g == 0).count();
        let widths = ds.iter().filter(|(w, g, _)| w != g).count();
        eprintln!(
            "  {table}: {} differ — {empties} where the MIRROR ANSWERED EMPTY, \
             {widths} with a different row count",
            ds.len()
        );
        for (w, g, fields) in ds.iter().take(12) {
            eprintln!(
                "      ({w} -> {g}) fields that moved: {}",
                fields.join(", ")
            );
        }
    }
    if differ.is_empty() && declined == 0 {
        eprintln!(
            "the live mirror and the captured row set give the same answer to every question"
        );
    }
    Ok(())
}

/// Run a day from the PRODUCTION database, either measuring the OSM gap or
/// answering it from the mirror.
///
/// The offline `day` proves the chain on a fixture, which carries an
/// `osmRowSet` and an `osmTrace` the loader does not produce. Production has
/// neither: `ClassificationInputs.osm` is an ADAPTER there, not data.
///
/// **`day-live`** walks with `RecordOnly`, which answers nothing. The keys it
/// reports are exactly what a live answerer has to supply — a measurement, not
/// a failure; `fold_converge`'s own note calls `RecordOnly` "how a day is
/// MEASURED". ⚠ Its timeline was built from DEFAULTS for every key listed, so
/// it is not a day to judge.
///
/// **`day-mirror`** walks with [`mirror_source::MirrorSource`], which answers
/// what the local OSM mirror covers. What it still reports as unanswerable is
/// the residue: areas nobody has fetched, plus the three tables no row set can
/// answer (`reverseGeocode`, `nearbyLandmarks`, `transitStops` — see
/// `rowset_answerer`'s catch-all).
///
/// ⚠ Its timeline is not a re-bless candidate — the corpus is what the re-bless
/// compares. The mirror source hands Lean every candidate in the box rather than
/// MariaDB's `ORDER BY ST_Distance … LIMIT 50`, which is the point (#413).
///
/// ⚠ HOW FAR IT DIVERGES FROM PRODUCTION IS UNMEASURED. #413 records 0 of 315
/// timeline states differing for the oracle swap alone, so "they disagree by
/// construction" — which this note used to say — is a stronger claim than
/// anything measured.
///
/// ⚠ REAL LOCATION DATA on stdout — where the user was and when. Redirect to
/// /tmp, never into the repo: both health repos are public.
async fn day_live(
    user: &str,
    date: &str,
    display_tz: Option<&str>,
    from_mirror: bool,
) -> Result<()> {
    let cfg = Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    let home_tz = sync_state::get(&pool, user, "home_tz")
        .await?
        .unwrap_or_else(|| "Europe/Amsterdam".into());
    let display_tz = display_tz.unwrap_or(&home_tz);
    let bounds = backend::timezone::date_bounds_utc(date, Some(display_tz))
        .with_context(|| format!("bounding {date} in {display_tz}"))?;
    let base_url = cfg
        .nextcloud_base_url
        .clone()
        .unwrap_or_else(|| classification_inputs::DAY_NEXTCLOUD_BASE_URL.to_string());
    let inputs = classification_inputs::load(
        &pool,
        &reqwest::Client::new(),
        &base_url,
        &classification_inputs::DayIdentity {
            user_id: user,
            date,
            display_tz,
        },
        bounds,
        Some(&home_tz),
    )
    .await?;

    let cap = backend::head::capture(&inputs, date, user)?;
    let segs = cap
        .get("segsRaw")
        .and_then(serde_json::Value::as_array)
        .map_or(0, Vec::len);
    let pts = cap
        .pointer("/obs/points")
        .and_then(serde_json::Value::as_array)
        .map_or(0, Vec::len);
    eprintln!("head: {pts} smoothed point(s), {segs} segment(s)");

    let r = if from_mirror {
        // ⚠ The clock is read HERE and passed down. Lean's coverage rule takes
        // `nowMs` as an argument so the decision does not depend on when it was
        // asked, and a walk whose staleness cutoff moves mid-day would answer
        // two identical questions differently.
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .context("the system clock is before the epoch")?
            .as_millis() as i64;
        backend::mirror_source::converge_from_mirror(
            pool.clone(),
            cap.clone(),
            inputs.clone(),
            now_ms,
        )
        .await?
    } else {
        // No trace: production has no recording to seed the tables from, and
        // passing one would answer questions this measurement exists to count.
        backend::fold_converge::converge(
            &cap,
            &inputs,
            None,
            &mut backend::fold_converge::RecordOnly,
        )?
    };
    pool.close().await;

    let mut by_table: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
    for m in &r.unanswerable {
        *by_table.entry(m.what.as_str()).or_default() += 1;
    }
    eprintln!(
        "fold: {} round(s); {} key(s) answered; {} key(s) a live answerer must supply",
        r.rounds,
        r.answered,
        r.unanswerable.len()
    );
    for (table, n) in &by_table {
        eprintln!("  {table}: {n}");
    }
    // ⚠ `bestPlace` has an EXPECTED decline that is not a gap, and the count
    // alone cannot tell it from one. The fold asks a stay's naming question once
    // before `tzAt` has resolved its zone and again after; the blank spelling is
    // a question asked too early, and answering it with UTC would put a second
    // row on the table for the same stay keyed differently. Splitting it here is
    // what makes "4 unanswered" readable as "4 early asks, none missed".
    let early = r
        .unanswerable
        .iter()
        .filter(|m| m.what == "bestPlace" && m.key.split('|').nth(4).is_none_or(str::is_empty))
        .count();
    if by_table.contains_key("bestPlace") {
        eprintln!("  ...of which bestPlace asked before its timezone resolved: {early}");
    }
    println!("{}", r.out);
    Ok(())
}

/// Rebuild `focus_places` and `venue_type_priors` from PhoneTrack history.
///
/// Tier 2 of #982 — the node cron is `src/cli/refresh-focus-places.ts`, which
/// runs Sundays 04:00. The geometry (stays, clusters, splitting, hour profiles,
/// identity) is `ServeEntry`'s `focus` mode; the amenity vote is
/// `Verified.Geo.FocusMining.mineCluster`; everything here is the IO around
/// them.
///
/// ⚠ NOT ported, deliberately: `--explain`, `--dry-run`'s census listings and
/// `--emit-known-places`. They are ~400 of the TypeScript's 754 lines and are
/// diagnostics for decisions the guards now pin.
///
/// ⚠ `radius_m` is written as the LITERAL 25, on both the INSERT and the
/// UPDATE, because that is what the TypeScript writes and what all 128 prod
/// rows carry. `clusterSpreadM` feeds a console report and nothing else — it is
/// deliberately not ported, and writing a measured spread here would be a
/// behaviour change four call sites can see.
async fn refresh_focus_places(
    pool: &sqlx::MySqlPool,
    only_user: Option<&str>,
    lookback_days: i64,
) -> Result<()> {
    backend::schema::migrate(pool).await?;

    let users: Vec<String> = match only_user {
        Some(u) => vec![u.to_string()],
        None => sqlx::query_scalar("SELECT user_id FROM nc_tokens")
            .fetch_all(pool)
            .await
            .context("listing users with Nextcloud linked")?,
    };
    if users.is_empty() {
        eprintln!("refresh-focus-places: no users with Nextcloud linked");
        return Ok(());
    }

    for user_id in &users {
        if let Err(e) = refresh_focus_places_one(pool, user_id, lookback_days).await {
            // ⚠ One user's failure must not strand the others, and must not
            // read as success either. The TypeScript lets the whole process
            // die here.
            eprintln!("refresh-focus-places: [{user_id}] FAILED: {e:#}");
            return Err(e);
        }
    }
    Ok(())
}

async fn refresh_focus_places_one(
    pool: &sqlx::MySqlPool,
    user_id: &str,
    lookback_days: i64,
) -> Result<()> {
    use sqlx::Row as _;

    // ── 1. the point history ────────────────────────────────────────────────
    // ⚠ `Config::nextcloud_base_url` is None IN PRODUCTION (#1037) — the sync
    // path types it nullable because "no PhoneTrack source" is a real state
    // there. THIS cron does not share that: its TypeScript has its own schema
    // with `.default("https://dash.xinutec.org")`, so it has always fetched
    // against that host whether or not `NC_BASE_URL` was set.
    //
    // Reading the shared config here would make the Rust arm quietly unable to
    // fetch anything in the exact deployment the node cron works in.
    let nc_base_url = backend::config::focus_nc_base_url();
    let ctx = backend::nextcloud::phonetrack::PhoneTrack::open(
        reqwest::Client::new(),
        pool,
        &nc_base_url,
        user_id,
    )
    .await
    .with_context(|| format!("opening PhoneTrack for {user_id}"))?;

    let day = |n: i64| -> String {
        (chrono::Utc::now() - chrono::Duration::days(n))
            .format("%Y-%m-%d")
            .to_string()
    };

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut points: Vec<(i64, f64, f64, Option<f64>)> = Vec::new();
    let mut failed_devices = 0usize;
    let mut offset = lookback_days;
    while offset > 0 {
        let start = day(offset);
        let end = day((offset - FOCUS_FETCH_CHUNK_DAYS).max(0));
        let fetched = ctx
            .fetch_range(pool, &start, &end)
            .await
            .with_context(|| format!("fetching PhoneTrack {start}..{end}"))?;
        failed_devices += fetched.failed_devices;
        for p in fetched.points {
            // The TypeScript's dedup key, verbatim: chunk bounds are shared, so
            // the same fix arrives twice.
            let k = format!("{}/{:.6}/{:.6}", p.ts, p.lat, p.lon);
            if seen.insert(k) {
                points.push((p.ts, p.lat, p.lon, p.accuracy));
            }
        }
        offset -= FOCUS_FETCH_CHUNK_DAYS;
    }
    points.sort_by_key(|p| p.0);

    // ⚠ REFUSE TO WRITE ON A PARTIAL HISTORY (#1140). The write path below ends
    // in `DELETE FROM focus_places`, and a device whose points call failed makes
    // `points` a SUBSET — real places then match nothing, and get deleted. The
    // TypeScript does not check this: it logs a per-device warning and carries
    // on, so one flaky device on one Sunday silently drops rows and the run
    // still reports success.
    //
    // Skipping a week is strictly better: the previous snapshot stands.
    if failed_devices > 0 {
        anyhow::bail!(
            "[{user_id}] {failed_devices} PhoneTrack device(s) failed — refusing to rebuild \
             focus_places from a partial history, the previous snapshot stands (#1140)"
        );
    }
    if points.is_empty() {
        eprintln!("[{user_id}] no PhoneTrack history in last {lookback_days}d, skipping");
        return Ok(());
    }
    eprintln!("[{user_id}] {} points over {lookback_days}d", points.len());

    // ── 2. sleep windows, for `sleepHoursFromFitbit` ────────────────────────
    let sleep_rows = sqlx::query(
        "SELECT start_time, end_time FROM sleep WHERE user_id = ? AND is_main_sleep = 1",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .context("reading sleep windows")?;
    let sleep_windows: Vec<[i64; 2]> = sleep_rows
        .iter()
        .map(|r| {
            let s: chrono::NaiveDateTime = r.try_get("start_time")?;
            let e: chrono::NaiveDateTime = r.try_get("end_time")?;
            Ok([s.and_utc().timestamp(), e.and_utc().timestamp()])
        })
        .collect::<Result<Vec<_>>>()?;
    eprintln!(
        "[{user_id}] {} Fitbit sleep window(s) for mining",
        sleep_windows.len()
    );

    // ── 3. the existing rows, for identity matching ─────────────────────────
    // ⚠ TWO sqlx traps in one row, both of which fail on REAL rows only and
    // neither of which a fixture would show:
    //
    //   * `centroid_lat`/`centroid_lon` are DECIMAL(9,6). sqlx cannot hand back
    //     a MySQL DECIMAL at all without `rust_decimal`, so they are CAST to
    //     CHAR and parsed — the same thing `classification_inputs` does, for
    //     the same reason.
    //   * `id` and `first_seen_ts` are INT UNSIGNED, which is a DISTINCT sqlx
    //     type that decodes as none of the signed forms. Reading `id` as `i64`
    //     failed in production on 2026-08-24 with "Rust type `i64` (as SQL type
    //     `BIGINT`) is not compatible with SQL type `INT UNSIGNED`" — after the
    //     job had already fetched 79,262 points.
    let old_rows = sqlx::query(
        "SELECT id, CAST(centroid_lat AS CHAR) AS centroid_lat, \
         CAST(centroid_lon AS CHAR) AS centroid_lon, first_seen_ts \
         FROM focus_places WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .context("reading focus_places")?;
    let old: Vec<serde_json::Value> = old_rows
        .iter()
        .map(|r| {
            let id: u64 = r.try_get("id")?;
            let lat: f64 = r.try_get::<String, _>("centroid_lat")?.parse()?;
            let lon: f64 = r.try_get::<String, _>("centroid_lon")?.parse()?;
            let fs: u64 = r.try_get("first_seen_ts")?;
            Ok(serde_json::json!([
                id,
                backend::fold_payload::bits(lat),
                backend::fold_payload::bits(lon),
                fs
            ]))
        })
        .collect::<Result<Vec<_>>>()?;

    // ── 4. the geometry, from Lean ──────────────────────────────────────────
    // ⚠ `clusters` is EMPTY on purpose. `focus` mode takes already-built
    // clusters only to exercise `splitCluster` against captured fixtures; the
    // cron mines from points, and `detectFocusPlaces` builds its own.
    let req = serde_json::json!({
        "mode": "focus",
        "points": points.iter().map(|(ts, lat, lon, acc)| serde_json::json!([
            ts,
            backend::fold_payload::bits(*lat),
            backend::fold_payload::bits(*lon),
            match acc { Some(a) => serde_json::json!(backend::fold_payload::bits(*a)),
                        None => serde_json::Value::Null },
        ])).collect::<Vec<_>>(),
        "sleepWindows": sleep_windows,
        "clusters": [],
        "old": old,
    });
    let out = backend::lean::serve(&serde_json::to_string(&req)?)?;
    let focus: serde_json::Value =
        serde_json::from_str(&out).context("focus mode answer is not JSON")?;
    if let Some(e) = focus.get("error") {
        anyhow::bail!("focus mode: {e}");
    }
    // Floats cross from Lean as IEEE-754 bit patterns in decimal strings.
    let bitsf = |v: &serde_json::Value| -> Option<f64> {
        v.as_str()?.parse::<u64>().ok().map(f64::from_bits)
    };
    let mined = focus
        .get("mined")
        .and_then(|v| v.as_array())
        .context("focus mode answer has no `mined`")?;
    let names: std::collections::HashMap<i64, String> = focus
        .get("names")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    let p = p.as_array()?;
                    Some((p.first()?.as_i64()?, p.get(1)?.as_str()?.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    let assignments: Vec<Option<i64>> = focus
        .pointer("/identity/assignments")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().map(serde_json::Value::as_i64).collect())
        .unwrap_or_default();
    let deleted: Vec<i64> = focus
        .pointer("/identity/deleted")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(serde_json::Value::as_i64).collect())
        .unwrap_or_default();
    // ⚠ One assignment per mined cluster, or the write below pairs a cluster
    // with the wrong existing row and moves somebody else's `first_seen_ts`.
    if assignments.len() != mined.len() {
        anyhow::bail!(
            "focus mode returned {} identity assignment(s) for {} cluster(s)",
            assignments.len(),
            mined.len()
        );
    }
    let has_fitbit_sleep = !sleep_windows.is_empty();
    eprintln!(
        "[{user_id}] {} cluster(s), {} to delete",
        mined.len(),
        deleted.len()
    );

    // ── 5. the amenity vote, per cluster ────────────────────────────────────
    // ⚠ TWO PHASES, and the split is forced by the mirror. `MirrorSource` may
    // only be touched from a blocking thread — constructing it on a runtime
    // worker and letting a query reach it ABORTS THE PROCESS — so every OSM
    // lookup has to happen inside `with_mirror_answerer`'s closure, which is
    // `FnOnce + Send + 'static` and cannot await.
    //
    // So: resolve the timezones first (pure CPU, no IO), hand a plain data
    // structure across, and bring the labels back out.
    let zones = backend::fitbit::tz_source::PolygonLookup::new();

    struct PendingStay {
        lat: f64,
        lon: f64,
        start_ts: i64,
        end_ts: i64,
        local_hour: i64,
        duration_sec: i64,
        samples: Vec<(u32, u32)>,
    }
    struct PendingCluster {
        lat: f64,
        lon: f64,
        stays: Vec<PendingStay>,
    }

    let mut pending: Vec<PendingCluster> = Vec::with_capacity(mined.len());
    let mut residential = 0usize;
    for c in mined {
        let clat = c.get("lat").and_then(bitsf).context("cluster has no lat")?;
        let clon = c.get("lon").and_then(bitsf).context("cluster has no lon")?;
        let empty = Vec::new();
        let stays = c.get("stays").and_then(|v| v.as_array()).unwrap_or(&empty);

        // ⚠ GATE 0, THE RESIDENCE GATE. A cluster the user SLEEPS at is not
        // mined at all — `amenity_label` stays null and the runtime falls
        // through to the residential-address lookup. Populating it would be
        // dead data an older code path could mis-pick up.
        //
        // ⚠ Absent from this port until 2026-08-24, and the omission was NOT
        // visible as a shortfall: it made the Rust arm label 88 of 128 clusters
        // where production labels 82. Every one of the six extra was a place
        // with 6-36 sleep hours — hotels, a guest house, a clinic. So the miss
        // wrote WHERE HE SLEPT AND WHAT KIND OF PLACE IT WAS into a column the
        // TypeScript deliberately leaves empty, and it read as better coverage.
        //
        // ⚠ The skip is BEFORE the per-stay loop in the TypeScript, so these
        // stays train NO prior either — that is the 95-vs-77 attributed-stay
        // gap, not a separate bug. An empty `stays` list here reproduces both:
        // `mineCluster` casts no vote and attributes nothing.
        let cluster_sleep_h = if has_fitbit_sleep {
            c.get("sleepFitbitH").and_then(bitsf)
        } else {
            c.get("sleepH").and_then(bitsf)
        }
        .unwrap_or(0.0);
        if cluster_sleep_h >= RESIDENCE_SLEEP_THRESHOLD_H {
            residential += 1;
            pending.push(PendingCluster {
                lat: clat,
                lon: clon,
                stays: Vec::new(),
            });
            continue;
        }

        let mut ps = Vec::with_capacity(stays.len());
        for s in stays {
            let a = s.as_array().context("a stay is not an array")?;
            let start = a
                .first()
                .and_then(serde_json::Value::as_i64)
                .context("stay startTs")?;
            let end = a
                .get(1)
                .and_then(serde_json::Value::as_i64)
                .context("stay endTs")?;
            let slat = a.get(2).and_then(bitsf).context("stay lat")?;
            let slon = a.get(3).and_then(bitsf).context("stay lon")?;
            let dur = a
                .get(5)
                .and_then(serde_json::Value::as_i64)
                .context("stay durationSec")?;
            // ⚠ A stay with no resolvable zone is SKIPPED, not defaulted to
            // UTC. `localHour` and the opening-hours samples are both
            // venue-local, and a wrong clock votes for the wrong venue rather
            // than declining to vote.
            let Some(tz) = zones.zone(slat, slon) else {
                continue;
            };
            ps.push(PendingStay {
                lat: slat,
                lon: slon,
                start_ts: start,
                end_ts: end,
                local_hour: i64::from(backend::timezone::local_hour_of((start + end) / 2, &tz)?),
                duration_sec: dur,
                samples: backend::timezone::local_stay_samples(start, end, &tz)?,
            });
        }
        pending.push(PendingCluster {
            lat: clat,
            lon: clon,
            stays: ps,
        });
    }

    let now_ms = chrono::Utc::now().timestamp_millis();
    let voted = backend::mirror_source::with_mirror_answerer(pool.clone(), now_ms, move |ans| {
        let mut out: Vec<backend::lean::MinedCluster> = Vec::with_capacity(pending.len());
        for c in pending {
            let mut ms: Vec<backend::lean::MineStay> = Vec::with_capacity(c.stays.len());
            for s in c.stays {
                // ⚠ `None` means the MIRROR could not answer, which is NOT
                // "no venues here". This stay then casts no vote, rather than
                // a vote for nothing (#976, and the empty-landmarks day of
                // #1054).
                let Some(shaped) = ans.nearby_landmarks(s.lat, s.lon)? else {
                    continue;
                };
                ms.push(backend::lean::MineStay {
                    start_ts: s.start_ts,
                    end_ts: s.end_ts,
                    local_hour: s.local_hour,
                    duration_sec: s.duration_sec,
                    samples: s.samples,
                    landmarks: shaped,
                });
            }
            let centroid = ans
                .nearby_landmarks(c.lat, c.lon)?
                .unwrap_or_else(|| serde_json::json!([]));
            out.push(backend::lean::mine_cluster(&ms, &centroid)?);
        }
        Ok(out)
    })
    .await?;

    let mut attributed_all: Vec<backend::lean::AttributedStay> = Vec::new();
    let mut labels: Vec<(Option<String>, Option<String>)> = Vec::with_capacity(voted.len());
    let mut mine_ok = 0usize;
    for m in voted {
        if m.amenity_label.is_some() {
            mine_ok += 1;
        }
        attributed_all.extend(m.attributed);
        labels.push((m.amenity_label, m.amenity_kind));
    }
    // ⚠ One label per mined cluster, or the write below pairs a cluster with
    // another cluster's venue.
    if labels.len() != mined.len() {
        anyhow::bail!(
            "mined {} cluster(s) but got {} label(s)",
            mined.len(),
            labels.len()
        );
    }
    eprintln!(
        "[{user_id}] amenity mining: {mine_ok}/{} clusters labelled, {} attributed stay(s), \
         {residential} skipped as residential",
        mined.len(),
        attributed_all.len()
    );

    // ── 6. the priors blob — a full recompute, never incremental ────────────
    let priors = backend::lean::mine_priors(&attributed_all)?;
    sqlx::query(
        "INSERT INTO venue_type_priors (user_id, priors_json, mined_stays) VALUES (?, ?, ?) \
         ON DUPLICATE KEY UPDATE priors_json = VALUES(priors_json), \
                                 mined_stays = VALUES(mined_stays)",
    )
    .bind(user_id)
    .bind(serde_json::to_string(&priors)?)
    .bind(attributed_all.len() as i64)
    .execute(pool)
    .await
    .context("writing venue_type_priors")?;

    // ── 7. the write, in one transaction ────────────────────────────────────
    // ⚠ The DELETE and the upserts must land together. A half-applied refresh
    // leaves rows deleted whose replacements were never written, and the
    // dashboard reads that as places the user stopped going to.
    let mut tx = pool
        .begin()
        .await
        .context("opening the focus_places transaction")?;

    if !deleted.is_empty() {
        // ⚠ `QueryBuilder`, not `format!`: a interpolated SQL string trips the
        // audit lint, and this is the one statement here with a
        // variable-length parameter list.
        let mut qb: sqlx::QueryBuilder<sqlx::MySql> =
            sqlx::QueryBuilder::new("DELETE FROM focus_places WHERE id IN (");
        let mut sep = qb.separated(", ");
        for id in &deleted {
            sep.push_bind(*id);
        }
        qb.push(")");
        qb.build()
            .execute(&mut *tx)
            .await
            .context("deleting stale focus_places")?;
    }

    let mut home_tz: Option<String> = None;
    for (i, c) in mined.iter().enumerate() {
        let id = c
            .get("id")
            .and_then(serde_json::Value::as_i64)
            .context("cluster id")?;
        let clat = c.get("lat").and_then(bitsf).context("cluster lat")?;
        let clon = c.get("lon").and_then(bitsf).context("cluster lon")?;
        let dwell = c
            .get("dwell")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0);
        let unique_days = c
            .get("uniqueDays")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0);
        let detected = c.get("label").and_then(|v| v.as_str()).unwrap_or("other");
        let profile = c.get("profile").and_then(|v| v.as_str()).unwrap_or("");
        // Fitbit-confirmed hours when there are any, else the local-clock
        // 02:00–06:00 heuristic — the TypeScript's choice, on the same test.
        let sleep_h: f64 = if has_fitbit_sleep {
            c.get("sleepFitbitH").and_then(bitsf)
        } else {
            c.get("sleepH").and_then(bitsf)
        }
        .unwrap_or(0.0);
        let empty = Vec::new();
        let stays = c.get("stays").and_then(|v| v.as_array()).unwrap_or(&empty);
        let visit_count = stays.len() as i64;
        let mut ts: Vec<(i64, i64)> = stays
            .iter()
            .filter_map(|s| {
                let a = s.as_array()?;
                Some((a.first()?.as_i64()?, a.get(1)?.as_i64()?))
            })
            .collect();
        ts.sort_unstable();
        let (first_seen, last_seen) = match (ts.first(), ts.last()) {
            (Some(f), Some(l)) => (f.0, l.1),
            _ => continue,
        };
        let display_name = names.get(&id);
        let (amenity_label, amenity_kind) = &labels[i];

        if let Some(old_id) = assignments[i] {
            // ⚠ UPDATE preserves `id` and `first_seen_ts` — the original "first
            // time we observed this place". Rewriting either would break the
            // foreign-key references downstream consumers hold, and would make
            // a re-mine look like a new place.
            sqlx::query(
                "UPDATE focus_places SET centroid_lat = ?, centroid_lon = ?, radius_m = ?, \
                   total_dwell_sec = ?, visit_count = ?, unique_days = ?, last_seen_ts = ?, \
                   detected_label = ?, display_name = ?, sleep_hours = ?, amenity_label = ?, \
                   amenity_kind = ?, hour_profile = ?, refreshed_at = CURRENT_TIMESTAMP \
                 WHERE id = ?",
            )
            .bind(clat)
            .bind(clon)
            .bind(FOCUS_RADIUS_M)
            .bind(dwell)
            .bind(visit_count)
            .bind(unique_days)
            .bind(last_seen)
            .bind(detected)
            .bind(display_name)
            .bind(sleep_h.round() as i64)
            .bind(amenity_label)
            .bind(amenity_kind)
            .bind(profile)
            .bind(old_id)
            .execute(&mut *tx)
            .await
            .with_context(|| format!("updating focus_place {old_id}"))?;
        } else {
            sqlx::query(
                "INSERT INTO focus_places (user_id, centroid_lat, centroid_lon, radius_m, \
                   total_dwell_sec, visit_count, unique_days, first_seen_ts, last_seen_ts, \
                   detected_label, display_name, sleep_hours, amenity_label, amenity_kind, \
                   hour_profile) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(user_id)
            .bind(clat)
            .bind(clon)
            .bind(FOCUS_RADIUS_M)
            .bind(dwell)
            .bind(visit_count)
            .bind(unique_days)
            .bind(first_seen)
            .bind(last_seen)
            .bind(detected)
            .bind(display_name)
            .bind(sleep_h.round() as i64)
            .bind(amenity_label)
            .bind(amenity_kind)
            .bind(profile)
            .execute(&mut *tx)
            .await
            .context("inserting a focus_place")?;
        }

        // The residence zone, for read-time fallback. First Home wins, as in
        // the TypeScript; if no cluster qualifies, the stored value is left
        // alone rather than cleared.
        if home_tz.is_none() && display_name.map(String::as_str) == Some("Home") {
            home_tz = zones.zone(clat, clon);
        }
    }

    if let Some(tz) = &home_tz {
        // ⚠ Inside the transaction, so a half-failed refresh rolls the zone
        // back with the rows it was derived from.
        backend::sync_state::set_with(&mut *tx, user_id, "home_tz", tz)
            .await
            .context("writing home_tz")?;
        eprintln!("[{user_id}] home_tz = {tz}");
    }

    tx.commit().await.context("committing focus_places")?;
    eprintln!("[{user_id}] focus_places refreshed ({} rows)", mined.len());
    Ok(())
}

/// ⚠ The LITERAL the TypeScript writes, and what all 128 prod rows carry. Four
/// call sites read this column and one of them only notices values above 40 m,
/// so writing a measured cluster spread here would be a behaviour change, not a
/// refinement (#789).
const FOCUS_RADIUS_M: i64 = 25;

/// Fitbit-confirmed sleep hours at or above which a cluster is a RESIDENCE and
/// is not mined for a venue name at all. See the gate-0 note at its use.
const RESIDENCE_SLEEP_THRESHOLD_H: f64 = 5.0;
/// The TypeScript's `FETCH_CHUNK_DAYS`. Shared chunk bounds are why the fetch
/// above dedups.
const FOCUS_FETCH_CHUNK_DAYS: i64 = 7;
/// The TypeScript's `DEFAULT_LOOKBACK_DAYS`. ⚠ 180, not the 90 its own header
/// comment claims — the cron passes no argument, so this is what production
/// actually mines.
const FOCUS_DEFAULT_LOOKBACK_DAYS: i64 = 180;

/// Pool each rail route's historic GPS corridor and snap it, filling
/// `rail_route_cache`.
///
/// Tier 2 of #982 — the node cron is `src/cli/refresh-rail-routes.ts`, nightly
/// at 05:00. Two passes, as there: walk the window pooling every train leg's
/// fixes per route key, then snap each pooled cloud once.
///
/// ⚠ THE SNAP IS ENTIRELY LEAN. `Verified.Geo.RailSnap` holds `buildRailGraph`,
/// `edgeWeight`, `bridgeGaps`, `shortestPath` and `nearestVertex` (123 guards),
/// and the `railsnap` serve mode hands it the RAW ways. The TypeScript builds
/// the graph shell-side and asks Lean only for `dijkstraC`; rebuilding it in
/// Rust would put the vertex fusion and the corridor weighting back on this
/// side of the boundary, which is the half that drifts (#1003).
async fn refresh_rail_routes(window_days: i64) -> Result<()> {
    // ⚠ `from_env_batch`, NOT `from_env`: this pod sets DB_* and NC_* and no
    // FITBIT_*, and the day pipeline never touches Fitbit. The strict config
    // here is what failed `refresh-presence-log` and `refresh-focus-places` in
    // production, both times AFTER the job had done real work.
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    backend::schema::migrate(&pool).await?;
    let st = backend::state::AppState::new(pool.clone(), cfg, reqwest::Client::new());

    let users: Vec<String> = sqlx::query_scalar("SELECT user_id FROM nc_tokens")
        .fetch_all(&pool)
        .await
        .context("listing users with Nextcloud linked")?;
    if users.is_empty() {
        eprintln!("refresh-rail-routes: no users with Nextcloud linked");
        pool.close().await;
        return Ok(());
    }

    /// One route's pooled evidence: every train leg's fixes on that key, plus a
    /// representative window. The stored geometry carries no timestamps, so any
    /// instance's window will do for the interpolation.
    struct RouteAcc {
        fixes: Vec<(f64, f64)>,
        start_ts: f64,
        end_ts: f64,
    }
    // ⚠ INSERTION-ORDERED. A `HashMap` here would make the upsert order — and
    // so the log — vary run to run for no reason, and this job's output is read
    // by eye when a route looks wrong.
    let mut by_route: std::collections::BTreeMap<String, RouteAcc> =
        std::collections::BTreeMap::new();
    // ⚠ Counted so an EMPTY result can be told apart from a BROKEN one.
    let (mut days_attempted, mut days_failed) = (0u32, 0u32);

    for user_id in &users {
        let tz = backend::sync_state::get(&pool, user_id, "home_tz")
            .await
            .context("reading home_tz")?
            .unwrap_or_else(|| "Europe/London".into());
        eprintln!("[{user_id}] scanning {window_days}-day window (tz={tz})");

        for offset in 0..=window_days {
            let date = (chrono::Utc::now() - chrono::Duration::days(offset))
                .format("%Y-%m-%d")
                .to_string();
            // ⚠ A day that will not compute is SKIPPED with a warning, not an
            // abort — one bad day must not cost the other twenty. The
            // TypeScript does the same, and the pooled corridor degrades
            // gracefully because it is a union over many days.
            days_attempted += 1;
            let result =
                match backend::routes::velocity::compute(&st, user_id, &date, Some(&tz)).await {
                    Ok(r) => r,
                    Err(e) => {
                        eprintln!("[{user_id} {date}] velocity failed: {e:#}");
                        days_failed += 1;
                        continue;
                    }
                };
            let empty = Vec::new();
            let segments = result
                .get("segments")
                .and_then(serde_json::Value::as_array)
                .unwrap_or(&empty);
            let points = result
                .get("points")
                .and_then(serde_json::Value::as_array)
                .unwrap_or(&empty);

            for seg in segments {
                // `refinedMode ?? mode`, the TypeScript's precedence.
                let mode = seg
                    .get("refinedMode")
                    .and_then(serde_json::Value::as_str)
                    .or_else(|| seg.get("mode").and_then(serde_json::Value::as_str))
                    .unwrap_or("");
                if mode != "train" {
                    continue;
                }
                let Some(way_name) = seg.get("wayName").and_then(serde_json::Value::as_str) else {
                    continue;
                };
                let (Some(s), Some(e)) = (
                    seg.get("startTs").and_then(serde_json::Value::as_f64),
                    seg.get("endTs").and_then(serde_json::Value::as_f64),
                ) else {
                    continue;
                };
                let in_win: Vec<(f64, f64)> = points
                    .iter()
                    .filter(|p| {
                        p.get("ts")
                            .and_then(serde_json::Value::as_f64)
                            .is_some_and(|t| t >= s && t <= e)
                    })
                    .filter_map(|p| Some((p.get("lat")?.as_f64()?, p.get("lon")?.as_f64()?)))
                    .collect();
                if in_win.is_empty() {
                    continue;
                }
                by_route
                    .entry(way_name.to_string())
                    .and_modify(|a| a.fixes.extend_from_slice(&in_win))
                    .or_insert(RouteAcc {
                        fixes: in_win,
                        start_ts: s,
                        end_ts: e,
                    });
            }
        }
    }
    eprintln!(
        "refresh-rail-routes: {} route key(s) pooled from {days_attempted} day(s), {days_failed} failed",
        by_route.len()
    );

    // ⚠ REFUSE rather than report success on nothing. Zero routes is a
    // LEGITIMATE answer — three weeks without a train ride — but it is
    // indistinguishable from every day having failed, and the two need opposite
    // responses. That is #1134's shape (`refresh-bus-routes` reports success
    // after refreshing 2 of 18 tiles), and THIS subcommand reproduced it on its
    // first run: 2026-08-25, all 22 days died with "Read-only file system"
    // (#1106 — the batch pods lack the `/tmp` emptyDir the Deployment has), it
    // pooled 0 routes, upserted 0, and exited SUCCEEDED.
    //
    // The discriminator is the FAILURE count, never the route count.
    if days_failed > 0 && days_failed == days_attempted {
        pool.close().await;
        anyhow::bail!(
            "every one of the {days_attempted} day(s) scanned failed to compute — refusing to \
             report a successful refresh over no evidence (#1134)"
        );
    }
    // A majority failing is not fatal — the corridor is a union over many days —
    // but it must be LOUD: a thin corridor snaps to a WORSE path, not to none.
    if days_failed * 2 > days_attempted {
        eprintln!(
            "⚠ refresh-rail-routes: {days_failed} of {days_attempted} days failed — the pooled \
             corridor is thinner than it should be and any route snapped from it is suspect"
        );
    }

    let mut routes: Vec<(String, serde_json::Value)> = Vec::new();
    for (key, acc) in &by_route {
        match rail_route_geometry(&pool, key, acc.start_ts, acc.end_ts, &acc.fixes).await? {
            Some(geom) if geom.len() >= 2 => {
                eprintln!(
                    "  resolved route → {} pts ({} historic fixes)",
                    geom.len(),
                    acc.fixes.len()
                );
                routes.push((key.clone(), serde_json::Value::Array(geom)));
            }
            _ => eprintln!(
                "  route left un-snapped ({} historic fixes — thin or disconnected)",
                acc.fixes.len()
            ),
        }
    }

    eprintln!(
        "Computed {} route geometries; upserting into rail_route_cache",
        routes.len()
    );
    if !routes.is_empty() {
        // ⚠ UPSERT, never a wipe-and-rebuild. A DELETE-all here silently dropped
        // every route key not ridden inside the scan window, so browsing an
        // older day drew its rides raw forever — and it would also discard the
        // serving path's miss-driven fills for routes that never recur.
        let mut tx = pool.begin().await.context("opening the rail transaction")?;
        for (key, geom) in &routes {
            sqlx::query(
                "INSERT INTO rail_route_cache (route_key, geometry_json) VALUES (?, ?) \
                 ON DUPLICATE KEY UPDATE geometry_json = VALUES(geometry_json), \
                                         computed_at = CURRENT_TIMESTAMP",
            )
            .bind(key)
            .bind(serde_json::to_string(geom)?)
            .execute(&mut *tx)
            .await
            .with_context(|| format!("upserting rail route {key}"))?;
        }
        tx.commit().await.context("committing rail_route_cache")?;
    }
    eprintln!("rail_route_cache upserted: {} routes", routes.len());
    pool.close().await;
    Ok(())
}

/// The corridor around a pooled fix cloud, snapped — `computeRailRoute`'s twin.
///
/// Corridor-weighted snap first; if that refuses (thin cloud, ambiguous
/// corridor) and the key names a line, route between the two stations over ONLY
/// that line's ways. `None` means LEAVE IT RAW — never a guessed path.
///
/// ⚠ The line-restricted retry passes the SAME way list. Lean's
/// `snapTrainSegmentOnLine` does the filtering itself with `wayOnLine`, so
/// nothing is asked of this caller beyond the full list — which is why the
/// fallback needs no second query and no station lookup here.
async fn rail_route_geometry(
    pool: &sqlx::MySqlPool,
    key: &str,
    start_ts: f64,
    end_ts: f64,
    fixes: &[(f64, f64)],
) -> Result<Option<Vec<serde_json::Value>>> {
    use sqlx::Row as _;

    if fixes.is_empty() {
        return Ok(None);
    }
    // The bbox the corridor is scanned over, padded like `corridorBox`.
    let (mut min_lat, mut max_lat) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut min_lon, mut max_lon) = (f64::INFINITY, f64::NEG_INFINITY);
    for (la, lo) in fixes {
        min_lat = min_lat.min(*la);
        max_lat = max_lat.max(*la);
        min_lon = min_lon.min(*lo);
        max_lon = max_lon.max(*lo);
    }
    // ⚠ A METRES margin converted to degrees, with the longitude term corrected
    // for latitude — NOT a fixed degree pad. A constant 0.01 deg would be ~1.1 km
    // north-south everywhere but only ~700 m east-west in London and ~1.1 km at
    // the equator, so the corridor would silently narrow the further north the
    // ride was. This mirrors `corridorBox`.
    let d_lat = RAIL_CORRIDOR_MARGIN_M / 111_320.0;
    let mid_lat = (min_lat + max_lat) / 2.0;
    let d_lon =
        RAIL_CORRIDOR_MARGIN_M / (111_320.0 * (mid_lat * std::f64::consts::PI / 180.0).cos());
    let (min_lat, max_lat) = (min_lat - d_lat, max_lat + d_lat);
    let (min_lon, max_lon) = (min_lon - d_lon, max_lon + d_lon);
    let poly = format!(
        "POLYGON(({min_lon} {min_lat},{max_lon} {min_lat},{max_lon} {max_lat},\
         {min_lon} {max_lat},{min_lon} {min_lat}))"
    );

    // ⚠ `feature_type = 'railway'`, the mirror's BUCKET. `subtype` carries the
    // OSM value (rail, subway, station, …); filtering on subtype here would
    // drop the ways `isRailSubtype` is meant to judge.
    let line_rows = sqlx::query(
        "SELECT name, subtype, ST_AsText(geom) AS wkt FROM osm_lines \
         WHERE feature_type = 'railway' \
           AND MBRIntersects(geom, ST_GeomFromText(?, 4326)) LIMIT ?",
    )
    .bind(&poly)
    .bind(RAIL_CORRIDOR_LINE_LIMIT)
    .fetch_all(pool)
    .await
    .context("querying the rail corridor")?;

    let mut lines: Vec<serde_json::Value> = Vec::with_capacity(line_rows.len());
    for r in &line_rows {
        let wkt: String = r.try_get("wkt")?;
        let coords = parse_linestring_wkt(&wkt);
        if coords.len() < 2 {
            continue;
        }
        lines.push(serde_json::json!({
            "name": r.try_get::<Option<String>, _>("name")?,
            "subtype": r.try_get::<Option<String>, _>("subtype")?,
            "coords": coords,
        }));
    }

    let station_rows = sqlx::query(
        "SELECT name, subtype, ST_AsText(geom) AS wkt FROM osm_points \
         WHERE feature_type = 'railway' \
           AND subtype IN ('station','halt','stop','subway_entrance','tram_stop') \
           AND MBRIntersects(geom, ST_GeomFromText(?, 4326))",
    )
    .bind(&poly)
    .fetch_all(pool)
    .await
    .context("querying rail stations")?;

    let mut stations: Vec<serde_json::Value> = Vec::with_capacity(station_rows.len());
    for r in &station_rows {
        let wkt: String = r.try_get("wkt")?;
        let Some((lat, lon)) = parse_point_wkt(&wkt) else {
            continue;
        };
        stations.push(serde_json::json!({
            "name": r.try_get::<Option<String>, _>("name")?,
            "subtype": r.try_get::<Option<String>, _>("subtype")?,
            "latBits": backend::fold_payload::bits(lat),
            "lonBits": backend::fold_payload::bits(lon),
        }));
    }

    for on_line in [false, true] {
        if let Some(path) =
            backend::lean::rail_snap(key, start_ts, end_ts, &lines, &stations, fixes, on_line)?
        {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

/// `LINESTRING(lon lat, …)` → `[[latBits, lonBits], …]`.
///
/// ⚠ WKT IS `lon lat`, THE OTHER WAY ROUND. Getting it backwards puts every
/// rail way in the wrong hemisphere, where the graph builds fine and the snap
/// simply never finds a route — a silent empty answer rather than an error.
fn parse_linestring_wkt(wkt: &str) -> Vec<serde_json::Value> {
    let Some(inner) = wkt
        .trim()
        .strip_prefix("LINESTRING(")
        .and_then(|s| s.strip_suffix(')'))
    else {
        return Vec::new();
    };
    inner
        .split(',')
        .filter_map(|pair| {
            let mut it = pair.split_whitespace();
            let lon: f64 = it.next()?.parse().ok()?;
            let lat: f64 = it.next()?.parse().ok()?;
            Some(serde_json::json!([
                backend::fold_payload::bits(lat),
                backend::fold_payload::bits(lon)
            ]))
        })
        .collect()
}

/// `POINT(lon lat)` → `(lat, lon)`. Same axis-order warning as above.
fn parse_point_wkt(wkt: &str) -> Option<(f64, f64)> {
    let inner = wkt
        .trim()
        .strip_prefix("POINT(")
        .and_then(|s| s.strip_suffix(')'))?;
    let mut it = inner.split_whitespace();
    let lon: f64 = it.next()?.parse().ok()?;
    let lat: f64 = it.next()?.parse().ok()?;
    Some((lat, lon))
}

/// Margin (m) around a train run's fixes when reading its rail corridor — wide
/// enough that the line and BOTH stations fall inside the box even where the
/// fixes scatter off the track. The TypeScript's `RAIL_CORRIDOR_MARGIN_M`.
const RAIL_CORRIDOR_MARGIN_M: f64 = 1500.0;
/// The TypeScript's `LIMIT 12000`.
const RAIL_CORRIDOR_LINE_LIMIT: i64 = 12000;
/// The TypeScript's `DEFAULT_WINDOW_DAYS`.
const RAIL_DEFAULT_WINDOW_DAYS: i64 = 21;

/// Persist a day's HSMM decode, overwriting any existing row.
///
/// ⚠ `classifier_version` is RECORDED, not just written: `loadDecode` returns
/// null on a version mismatch so consumers re-decode rather than serve stale
/// segments. Writing the wrong number here does not fail — it makes every
/// reader silently discard the row and recompute, which looks like a slow
/// cache rather than a bug.
async fn save_decode(
    pool: &sqlx::MySqlPool,
    user_id: &str,
    date: &str,
    segments: &serde_json::Value,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO decoded_days (user_id, date, classifier_version, segments_json) \
         VALUES (?, ?, ?, ?) \
         ON DUPLICATE KEY UPDATE classifier_version = VALUES(classifier_version), \
                                 segments_json = VALUES(segments_json)",
    )
    .bind(user_id)
    .bind(date)
    .bind(CLASSIFIER_VERSION)
    .bind(serde_json::to_string(segments)?)
    .execute(pool)
    .await
    .with_context(|| format!("writing decoded_days for {user_id} {date}"))?;
    Ok(())
}

/// ⚠ MUST TRACK `src/hmm/persist.ts`'s `CLASSIFIER_VERSION`. Bumped when the
/// classifier output for a typical day would meaningfully change; a mismatch
/// makes every consumer treat the row as stale and re-decode.
const CLASSIFIER_VERSION: i32 = 7;

/// Decode a day's HSMM and persist it to `decoded_days`.
///
/// Tier 2 of #982 — the node cron is `src/cli/decode-day.ts`, daily at 06:00.
///
/// ⚠ THE WHOLE MODEL IS BUILT AND DECODED IN LEAN. `assemblesegments` takes raw
/// `edges`/`nodes`/`obs`/`places`, builds the route-graph model, the coverage
/// map and the trellis, decodes, and groups the path into segments. Nothing
/// here constructs a model, and the 33-40 MiB quantised payload the TypeScript
/// ships per day (#411) never exists.
///
/// ⚠ NOT ported, deliberately: `runLeanShadow`, `runWalkShadow` and ten
/// `logLean*Ledger` calls — about 40% of `decodeAndPersist`. They exist to A/B
/// the TypeScript arm against Lean. With one arm they measure nothing, and
/// keeping them would mean keeping the arm they measure.
async fn decode_day(
    user: Option<&str>,
    dates: &[String],
    days: Option<i64>,
    dry_run: bool,
) -> Result<()> {
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    backend::schema::migrate(&pool).await?;
    let st = backend::state::AppState::new(pool.clone(), cfg, reqwest::Client::new());

    let users: Vec<String> = match user {
        Some(u) => vec![u.to_string()],
        None => sqlx::query_scalar("SELECT user_id FROM nc_tokens")
            .fetch_all(&pool)
            .await
            .context("listing users")?,
    };

    let (mut attempted, mut failed, mut written) = (0u32, 0u32, 0u32);
    for user_id in &users {
        let tz = backend::sync_state::get(&pool, user_id, "home_tz")
            .await?
            .unwrap_or_else(|| "Europe/London".into());
        let targets: Vec<String> = if dates.is_empty() {
            backend::classification_inputs::decode_window(
                chrono::Utc::now(),
                days.unwrap_or(DECODE_DEFAULT_DAYS),
            )
        } else {
            dates.to_vec()
        };

        for date in &targets {
            attempted += 1;
            match decode_one(&st, &pool, user_id, date, &tz, dry_run).await {
                Ok(n) => {
                    // ⚠ `decode_one` ALREADY PRINTED the dry-run line, including
                    // the fact that nothing was written. Printing "{n} segments"
                    // again here said it twice and said it wrong the second time.
                    if !dry_run {
                        eprintln!("[{user_id} {date}] {n} segments");
                    }
                    written += 1;
                }
                Err(e) => {
                    // ⚠ One bad day must not strand the rest — the cron decodes
                    // a window and a single unparseable day is not a reason to
                    // leave the other thirteen stale. The refusal below is what
                    // makes that safe.
                    eprintln!("[{user_id} {date}] decode failed: {e:#}");
                    failed += 1;
                }
            }
        }
    }

    // ⚠ A DRY RUN WROTE NOTHING AND MUST NOT SAY "written". The 2026-08-25 dry
    // run reported `1 written, 0 failed` while writing nothing at all — a label
    // that contradicts the flag it was given is worse than no label, because it
    // is the line somebody greps to find out whether the row was replaced.
    eprintln!(
        "decode-day: {written} {}, {failed} failed of {attempted} day(s)",
        if dry_run {
            "decoded (DRY RUN, nothing written)"
        } else {
            "written"
        }
    );
    // ⚠ REFUSE rather than report success on nothing. Same rule as
    // `refresh-rail-routes`, and for the same reason: a batch job's success must
    // be predicated on evidence having been gathered, never on the absence of an
    // error. Every day failing is a broken run; a day with no data is not.
    if failed > 0 && failed == attempted {
        pool.close().await;
        anyhow::bail!(
            "every one of the {attempted} day(s) failed to decode — refusing to report a \
             successful run over no evidence (#1134)"
        );
    }
    pool.close().await;
    Ok(())
}

/// One day: gather, decode in Lean, persist.
async fn decode_one(
    st: &backend::state::AppState,
    pool: &sqlx::MySqlPool,
    user_id: &str,
    date: &str,
    tz: &str,
    dry_run: bool,
) -> Result<usize> {
    let bounds = backend::timezone::date_bounds_utc(date, Some(tz))?;
    let inputs = backend::classification_inputs::load(
        pool,
        &st.http,
        &backend::config::focus_nc_base_url(),
        &backend::classification_inputs::DayIdentity {
            user_id,
            date,
            display_tz: tz,
        },
        bounds,
        Some(tz),
    )
    .await?;
    // `head::capture` owns the observation tensor; nothing here rebuilds it.
    let cap = backend::head::capture(&inputs, date, user_id)?;
    let obs = cap.get("obs").context("capture has no obs")?.clone();

    // ── the route graph, from the mirror ────────────────────────────────────
    let (ways, stops) = route_graph_rows(pool, user_id, &obs).await?;
    let (edges, nodes) = backend::lean::build_wire_graph(&ways, &stops)?;
    // ⚠ THE GRAPH'S SIZE IS EVIDENCE, not chatter. `emitLeg` is a MARGIN test —
    // a side names a station only when every alternative naming a different one
    // trails by `MARGIN_NATS` — so the number of competing stations in range
    // decides whether a leg resolves at all. Two arms that box different regions
    // resolve differently with identical scoring, which is #1190, and this line
    // is what makes that visible in a run rather than inferable from a diff.
    println!(
        "graph {date}: {} ways, {} stops -> {} edges, {} nodes",
        ways.len(),
        stops.len(),
        edges.as_array().map_or(0, Vec::len),
        nodes.as_array().map_or(0, Vec::len)
    );

    // ── the observation tensor's raw materials ──────────────────────────────
    // ⚠ THE TENSOR IS NOT BUILT HERE AND MUST NOT BE. Lean builds it from these
    // (#411): shipping 1440 assembled rows instead is the 33-40 MiB per day the
    // port exists to delete. What crosses is the day's fixes and two lookup
    // tables that are not pure — a timezone and an OSM query.
    //
    // ⚠ OUTLIERS ARE DROPPED ONCE, HERE, and the same cleaned list feeds both the
    // tensor and the proximity lookups. The TypeScript cleans in two places
    // (`buildHsmmModel` and the `computeMinuteProximity` call) and the two agree
    // only because they clean the same input; doing it once is the same result
    // with one fewer way to disagree.
    let cleaned = backend::lean::drop_gps_outliers(&gps_fixes(&obs)?)?;
    // ⚠ THE DECODER'S PLACES ARE NOT `focus_places` ROWS. `knownPlaces` names
    // the columns (`centroidLat`, `totalDwellSec`, `displayName`); the decode
    // wire names the concepts (`lat`, `dwell`, `name`). Sending the row shape is
    // refused by name — see `decode_places`, which is the second field-shape
    // defect this path shipped and the reason there is a test for the request.
    let places = backend::classification_inputs::decode_places(inputs.get("knownPlaces"))?;
    let osm = day_osm(pool, bounds.start_utc, bounds.end_utc, &cleaned, &places).await?;
    println!("osm {date}: {}", osm.note);

    // ⚠ THE CHAIN SEED, AND IT IS FOUR FIELDS RATHER THAN ONE. Sending only
    // `priorPlaceId` is refused with `property not found: hoursSince` — the
    // third field-shape defect on this request, and the third found by probing
    // the parser instead of reading the struct.
    let continuity = load_continuity(pool, user_id, date, &places).await?;

    let req = serde_json::json!({
        "observation": {
            "startUtc": bounds.start_utc,
            "points": cleaned.iter().map(|p| serde_json::json!({
                "ts": p.ts, "lat": p.lat, "lon": p.lon, "speedKmh": p.speed_kmh
            })).collect::<Vec<_>>(),
            "hr": obs.get("hr").cloned().unwrap_or(serde_json::json!([])),
            "steps": obs.get("steps").cloned().unwrap_or(serde_json::json!([])),
            "sleep": obs.get("sleep").cloned().unwrap_or(serde_json::json!([])),
            "localCtx": backend::timezone::local_ctx_table(bounds.start_utc, tz)?,
            "proximity": osm.proximity,
            "imputeCadence": flag("USE_CADENCE_IMPUTATION"),
        },
        "edges": edges,
        "nodes": nodes,
        "places": places,
        // ⚠ ABSENT IS NOT NEUTRAL. `parseAssemble` treats a missing
        // `placeNearLine` as the EMPTY SET, which removes every place→line hard
        // zero instead of adding them — so the decode runs, looks plausible, and
        // permits boardings the TypeScript forbids. It was missing entirely
        // until 2026-08-26.
        "placeNearLine": osm.place_near_line,
        "railStopRelations": inputs.get("railStopsCache").cloned().unwrap_or(serde_json::Value::Null),
        "continuity": continuity,
        // ⚠ THE THREE C4 FLAGS, READ FROM THE ENV AS THE TypeScript READS THEM.
        // All three are `1` in `decodeFlags` and have been since C4 landed, so a
        // Rust-side `true` would decode production correctly and diverge the
        // moment anyone replays a day with `scripts/prod-db.sh` — which mirrors
        // the pod env precisely so that cannot happen.
        //
        // ⚠ `maxD` IS DELIBERATELY ABSENT: it is the model's own trellis depth,
        // and `Verified.Hsmm.Assemble.DEFAULT_MAX_DURATION` is where it lives.
        // Spelling 240 here would be a second copy that nothing compares.
        "flags": {
            "reacquireRobust": flag("USE_REACQUIRE_ROBUST_SPEED"),
            "segEvidence": flag("USE_SEGMENT_EVIDENCE"),
            "chainContext": flag("USE_CHAIN_CONTEXT"),
        },
        "date": date,
        "tz": tz,
    });

    // ⚠ `None` is DEGENERATE — Lean found no viable path. That is a real answer
    // about the day, not a fault, and it must not be written as zero segments:
    // an empty row would read as "decoded, nothing happened".
    let Some(segments) = backend::lean::assemble_segments(&req)? else {
        anyhow::bail!("the decode is degenerate — no viable path");
    };
    let segments = backend::row_json::render_segments(&segments)?;
    let n = segments.as_array().map_or(0, Vec::len);
    if dry_run {
        // ⚠ ONE SEGMENT PER LINE, in exactly the form `segments_json` would hold
        // — same field order, same encodings, same absent-versus-null. That is
        // the point: it makes the parity check `diff` against
        // `scripts/dump-decoded-segments.mjs`, which prints node's row the same
        // way, instead of a structural comparison nothing can quite trust.
        for seg in segments.as_array().unwrap_or(&Vec::new()) {
            println!("{}", serde_json::to_string(seg)?);
        }
        eprintln!("[{user_id} {date}] DRY RUN — {n} segments, nothing written");
        return Ok(n);
    }
    save_decode(pool, user_id, date, &segments).await?;
    Ok(n)
}

/// The prior day's end-of-day seed, shaped as `parseContinuity` reads it — or
/// `null`, which is a legitimate chain start rather than a fault.
///
/// ⚠ FOUR FIELDS, NOT ONE. `priorPlaceId` alone is refused with `property not
/// found: hoursSince`, and this path sent exactly that until 2026-08-26.
/// `priorPlaceCoord` is a `[lat, lon]` PAIR on the wire even though the
/// TypeScript's own type is an object — `lean/experiments/compare-assemble-*.mts`
/// convert it the same way.
///
/// ⚠ THREE ABSENCES, AND THEY ARE DIFFERENT. No ROW at all is a chain start; a
/// row whose `end_of_day_place_id` is NULL is a day that ended nowhere known;
/// a row with no `end_of_day_ts` cannot say how stale the seed is. The
/// TypeScript returns null for all three and so does this — but they are read
/// separately so a future reader can tell them apart if that ever matters.
///
/// ⚠ `u64`, NOT `i64` — `presence_log.*_place_id` is INT UNSIGNED, which sqlx
/// treats as a distinct type and refuses to hand back as signed. It fails at
/// RUNTIME on real rows only.
///
/// ⚠ `end_of_day_posterior` is `FLOAT`, so it reads as `f32`. Asking for `f64`
/// fails on real rows the same way, and the widening is exact — the node driver
/// hands the TypeScript the same widened value.
///
/// ⚠ `UNIX_TIMESTAMP`, MIRRORING THE `FROM_UNIXTIME` THE WRITE USES. Reading the
/// `TIMESTAMP` as a naive local datetime would make the staleness of the seed
/// depend on the session timezone, and `refresh-presence-log` a few hundred
/// lines down writes it through `FROM_UNIXTIME(?)`. Symmetry is the check.
///
/// ⚠ THE COORD COMES FROM THE PLACES ALREADY IN HAND, not a second query. The
/// TypeScript re-reads `focus_places` unfiltered; taking it from the list the
/// decoder was just given means the seed's coordinate is the same one the
/// trellis has a state for. A prior place that is no longer a focus place
/// yields a null coord, which is the documented un-gated case.
async fn load_continuity(
    pool: &sqlx::MySqlPool,
    user_id: &str,
    date: &str,
    places: &serde_json::Value,
) -> Result<serde_json::Value> {
    use sqlx::Row as _;
    let prev = backend::classification_inputs::shift_day(date, -1)?;
    let Some(row) = sqlx::query(
        "SELECT end_of_day_place_id, \
                CAST(UNIX_TIMESTAMP(end_of_day_ts) AS SIGNED) AS end_of_day_unix, \
                end_of_day_posterior \
         FROM presence_log WHERE user_id = ? AND date = ?",
    )
    .bind(user_id)
    .bind(&prev)
    .fetch_optional(pool)
    .await
    .context("reading the prior day's presence_log")?
    else {
        return Ok(serde_json::Value::Null);
    };
    let Some(place_id) = row.try_get::<Option<u64>, _>("end_of_day_place_id")? else {
        return Ok(serde_json::Value::Null);
    };
    let Some(last_fix) = row.try_get::<Option<i64>, _>("end_of_day_unix")? else {
        return Ok(serde_json::Value::Null);
    };
    let posterior = f64::from(row.try_get::<f32, _>("end_of_day_posterior")?);

    // ⚠ UTC MIDNIGHT OF THE DECODED DATE, not local midnight and not the day's
    // own `startUtc`. The TypeScript measures from `new Date(`${date}T00:00:00Z`)`,
    // so in London the two differ by an hour for half the year — and the
    // difference lands straight in the continuity factor's time decay.
    let today_start = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .with_context(|| format!("{date:?} is not a YYYY-MM-DD date"))?
        .and_hms_opt(0, 0, 0)
        .context("midnight is representable")?
        .and_utc()
        .timestamp();
    let hours_since = (((today_start - last_fix) as f64) / 3600.0).max(0.0);

    let coord = places
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .find(|p| p.get("id").and_then(serde_json::Value::as_u64) == Some(place_id))
        .and_then(|p| Some(serde_json::json!([p.get("lat")?, p.get("lon")?])))
        .unwrap_or(serde_json::Value::Null);

    Ok(serde_json::json!({
        "priorPlaceId": place_id,
        "priorPlaceCoord": coord,
        "hoursSince": hours_since,
        "priorPosterior": posterior,
    }))
}

/// A decode feature flag, with the TypeScript's own semantics: set and exactly
/// `"1"` is on, anything else — including unset — is off.
///
/// ⚠ NOT DEFAULTED TO `true`. Production sets all three (`decodeFlags` in
/// `kubes/dhall/apps/health.dhall`) and has since C4, so defaulting on would be
/// right in the cluster and wrong everywhere else — and `scripts/prod-db.sh`
/// mirrors the pod env precisely so that a Mac replay decodes the same day the
/// cron wrote. A parity tool that does not mirror the env is not a parity tool.
fn flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| v == "1")
}

/// `head::capture`'s `obs.points` as fixes.
///
/// ⚠ THESE ARE THE VELOCITY PIPELINE'S POINTS, not the raw ones. `rawFixes` is
/// what the route-graph bbox is built from — a wider set on purpose, since the
/// graph must contain the day even where the pipeline dropped fixes.
fn gps_fixes(obs: &serde_json::Value) -> Result<Vec<backend::lean::GpsFix>> {
    let rows = obs
        .get("points")
        .and_then(serde_json::Value::as_array)
        .context("capture's obs has no points")?;
    let f = |r: &serde_json::Value, k: &str| -> Result<f64> {
        r.get(k)
            .and_then(serde_json::Value::as_f64)
            .with_context(|| format!("a fix has no numeric {k}"))
    };
    rows.iter()
        .map(|r| {
            Ok(backend::lean::GpsFix {
                ts: r
                    .get("ts")
                    .and_then(serde_json::Value::as_i64)
                    .context("a fix has no ts")?,
                lat: f(r, "lat")?,
                lon: f(r, "lon")?,
                speed_kmh: f(r, "speedKmh")?,
            })
        })
        .collect()
}

/// Everything the decode needs from OSM, gathered in ONE trip to the mirror.
///
/// ⚠ THE TWO HALVES TRAVEL TOGETHER BECAUSE THE MIRROR IS BLOCKING-THREAD ONLY.
/// `with_mirror_answerer` is the only door and its closure cannot await, so a
/// second call would be a second `MirrorSource`, a second connection, and a
/// second chance to construct one on a runtime worker — which aborts the
/// process rather than returning an error. They are unrelated questions asked
/// through one door, not one question.
struct DayOsm {
    /// The sparse `[minuteTs, road, rail]` table, opaque — it goes into the
    /// assemble request unread.
    proximity: serde_json::Value,
    /// `"{placeId}|{lineName}"` keys the transition matrix hard-zeroes against.
    place_near_line: Vec<String>,
    /// What the mirror could and could not answer, for the run's log line.
    note: String,
}

async fn day_osm(
    pool: &sqlx::MySqlPool,
    start_utc: i64,
    end_utc: i64,
    points: &[backend::lean::GpsFix],
    places: &serde_json::Value,
) -> Result<DayOsm> {
    let pts: Vec<(i64, f64, f64)> = points.iter().map(|p| (p.ts, p.lat, p.lon)).collect();
    let plan = backend::lean::proximity_queries(start_utc, end_utc, &pts)?;
    let minute_count = plan.minutes.as_array().map_or(0, Vec::len);
    let asked = plan.queries.len();

    // ⚠ THE LINE LIST IS LEAN'S — see `lean::known_lines`.
    let lines = backend::lean::known_lines()?;
    let place_coords: Vec<(i64, f64, f64)> = places
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|p| {
            Some((
                p.get("id")?.as_i64()?,
                p.get("lat")?.as_f64()?,
                p.get("lon")?.as_f64()?,
            ))
        })
        .collect();

    let queries = plan.queries.clone();
    let now_ms = chrono::Utc::now().timestamp_millis();
    let want_lines = lines.clone();
    let (answers, stations) =
        backend::mirror_source::with_mirror_answerer(pool.clone(), now_ms, move |ans| {
            let mut out = Vec::with_capacity(queries.len());
            for q in &queries {
                // ⚠ `None` is "the mirror could not vouch for this coordinate",
                // NOT "nothing here". Sending it back as an empty way list would
                // tell the decoder there is no railway within 300 m, which is
                // evidence against rail rather than the absence of evidence
                // (#976).
                let Some(ways) = ans.nearby_ways(q.lat(), q.lon())? else {
                    continue;
                };
                out.push(backend::lean::ProximityAnswer::new(q, ways));
            }
            let mut sts: Vec<(String, Vec<(f64, f64)>)> = Vec::with_capacity(want_lines.len());
            for line in &want_lines {
                // ⚠ Same distinction, opposite consequence: a declined line is
                // SKIPPED, so no place gains a pair for it. An empty list is a
                // line no way carries and is a real answer.
                let Some(rows) = ans.stations_serving(line)? else {
                    continue;
                };
                sts.push((line.clone(), station_coords(&rows)));
            }
            Ok((out, sts))
        })
        .await?;

    let (proximity, unanswered) = backend::lean::proximity_table(&plan.minutes, &answers)?;
    let place_near_line = backend::lean::place_near_line(&place_coords, &stations)?;
    let covered = minute_count - unanswered;
    let station_total: usize = stations.iter().map(|(_, s)| s.len()).sum();
    // ⚠ THE LINE REPORTS WHAT WAS ASKED AS WELL AS WHAT CAME BACK. `2/18
    // queries` and `18/18 queries` produce tables that look equally healthy, and
    // only the ratio says a day was decoded against a mirror that mostly
    // declined (#976, and the shape #1134 reports for the Overpass crons).
    Ok(DayOsm {
        note: format!(
            "proximity {covered}/{minute_count} minutes from {}/{asked} queries; \
             place-line {} of {} lines, {station_total} stations, {} pairs",
            answers.len(),
            stations.len(),
            lines.len(),
            place_near_line.len()
        ),
        proximity,
        place_near_line,
    })
}

/// `[name, latBits, lonBits]` triples → coordinates.
///
/// ⚠ THE BIT PATTERNS ARE PARSED ONLY TO ASK. They go straight back out as bit
/// patterns on the `placenearline` request, so the coordinate Lean measures from
/// is the one the mirror answered with, to the last digit.
fn station_coords(rows: &[serde_json::Value]) -> Vec<(f64, f64)> {
    rows.iter()
        .filter_map(|r| {
            let a = r.as_array()?;
            let bits = |i: usize| -> Option<f64> {
                Some(f64::from_bits(a.get(i)?.as_str()?.parse().ok()?))
            };
            Some((bits(1)?, bits(2)?))
        })
        .collect()
}

/// The corridor polygon around a set of points, with `ROUTE_GRAPH_MARGIN_M`
/// added. ⚠ ONE FORMULA for both the way box and the station box — the #1190
/// experiment varies them independently, and two copies of the latitude
/// correction would make that comparison meaningless.
fn bbox_poly(pts: &[(f64, f64)]) -> String {
    let (mut mnla, mut mxla, mut mnlo, mut mxlo) = (
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
    );
    for (la, lo) in pts {
        mnla = mnla.min(*la);
        mxla = mxla.max(*la);
        mnlo = mnlo.min(*lo);
        mxlo = mxlo.max(*lo);
    }
    let d_lat = ROUTE_GRAPH_MARGIN_M / 111_320.0;
    let mid = (mnla + mxla) / 2.0;
    let d_lon = ROUTE_GRAPH_MARGIN_M / (111_320.0 * (mid * std::f64::consts::PI / 180.0).cos());
    format!(
        "POLYGON(({} {},{} {},{} {},{} {},{} {}))",
        mnlo - d_lon,
        mnla - d_lat,
        mxlo + d_lon,
        mnla - d_lat,
        mxlo + d_lon,
        mxla + d_lat,
        mnlo - d_lon,
        mxla + d_lat,
        mnlo - d_lon,
        mnla - d_lat
    )
}

/// The rail/road ways and station points covering a day's fixes.
///
/// ⚠ The bbox comes from the day's OWN observations, not a fixed region: a day
/// spent outside the home metro would otherwise get a graph that does not
/// contain it, and the decode would silently have no rail to match against.
async fn route_graph_rows(
    pool: &sqlx::MySqlPool,
    user_id: &str,
    obs: &serde_json::Value,
) -> Result<(Vec<serde_json::Value>, Vec<serde_json::Value>)> {
    use sqlx::Row as _;

    // ⚠ THE TRACK IS BOXED BY THE DAY. A day spent outside the home metro would
    // otherwise get a graph that does not contain it, and the decode would
    // silently have no rail to match against.
    let mut pts: Vec<(f64, f64)> = Vec::new();
    if let Some(rows) = obs.get("rawFixes").and_then(serde_json::Value::as_array) {
        for r in rows {
            if let (Some(la), Some(lo)) = (
                r.get("lat").and_then(serde_json::Value::as_f64),
                r.get("lon").and_then(serde_json::Value::as_f64),
            ) {
                pts.push((la, lo));
            }
        }
    }
    if pts.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let poly = bbox_poly(&pts);

    let line_rows = sqlx::query(
        "SELECT osm_type, osm_id, name, subtype, tags_json, ST_AsText(geom) AS wkt \
         FROM osm_lines WHERE feature_type = 'railway' \
           AND MBRIntersects(geom, ST_GeomFromText(?, 4326)) LIMIT ?",
    )
    .bind(&poly)
    .bind(RAIL_CORRIDOR_LINE_LIMIT)
    .fetch_all(pool)
    .await
    .context("querying route-graph ways")?;

    let mut ways = Vec::with_capacity(line_rows.len());
    for r in &line_rows {
        let wkt: String = r.try_get("wkt")?;
        let geom = parse_linestring_wkt(&wkt);
        if geom.len() < 2 {
            continue;
        }
        let ty: String = r.try_get("osm_type")?;
        let id: i64 = r.try_get("osm_id")?;
        ways.push(serde_json::json!({
            "id": format!("{ty}:{id}"),
            "geometry": geom,
            "name": r.try_get::<Option<String>, _>("name")?,
            "subtype": r.try_get::<Option<String>, _>("subtype")?,
            "tags": tag_pairs(r.try_get::<Option<String>, _>("tags_json")?.as_deref()),
        }));
    }

    // ⚠ THE STATIONS ARE **NOT** BOXED BY THE DAY, and that is the whole of
    // #1190. `emitLeg` names a station only when every alternative naming a
    // DIFFERENT one trails by `MARGIN_NATS` — so the candidate pool is a
    // threshold, and cutting it to the day's own extent lowers the bar. A leg
    // then resolves because of where the phone happened to be, not because of
    // where the train went, and the same ride resolves differently on two days.
    //
    // ⚠ MEASURED, not reasoned, 2026-08-26 — and three explanations died first.
    // Four arms against node's row for the same day, changing only the boxes:
    //
    //     day ways,      day stops        3706 / 694     17 of 18
    //     WHOLE lines,   day stops        4885 / 694     17 of 18
    //     lifetime ways, lifetime stops  38559 / 9474    18 of 18
    //     day ways,      LIFETIME stops   3706 / 9474    18 of 18   ← this
    //
    // A clean 2x2: the station pool decides it and the track is irrelevant.
    // Loading every line end to end — 32% more way rows — moved nothing.
    //
    // ⚠ AND IT IS THE CHEAP ONE. Node's arm boxes both by the lifetime places,
    // which is 38 559 way rows carrying geometry; this is 3706 of those plus
    // station POINTS, which carry none. `RAIL_CORRIDOR_LINE_LIMIT` is 12 000 and
    // sized for the day box — under the lifetime box it truncates with no
    // `ORDER BY`, and the measured cost of that was a Metropolitan ride decoded
    // as a short Jubilee ride with no stations at all.
    let stops_poly = {
        let rows = sqlx::query(
            // ⚠ `CAST(… AS CHAR)`: `centroid_lat/lon` are DECIMAL, which sqlx
            // refuses to hand back as f64 — and it fails on REAL ROWS ONLY.
            "SELECT CAST(centroid_lat AS CHAR) AS la, CAST(centroid_lon AS CHAR) AS lo \
             FROM focus_places WHERE user_id = ?",
        )
        .bind(user_id)
        .fetch_all(pool)
        .await
        .context("reading focus_places for the station box")?;
        let mut p: Vec<(f64, f64)> = Vec::with_capacity(rows.len());
        for r in &rows {
            let la: String = r.try_get("la")?;
            let lo: String = r.try_get("lo")?;
            p.push((la.parse()?, lo.parse()?));
        }
        // ⚠ A USER WITH NO FOCUS PLACES FALLS BACK TO THE DAY BOX rather than
        // to an empty one. `bbox_poly` on nothing is a box of infinities, which
        // MariaDB would reject or answer strangely; the day box is at least the
        // stations the ride passed.
        if p.is_empty() {
            poly.clone()
        } else {
            bbox_poly(&p)
        }
    };
    let pt_rows = sqlx::query(
        "SELECT name, tags_json, ST_AsText(geom) AS wkt FROM osm_points \
         WHERE feature_type = 'railway' \
           AND MBRIntersects(geom, ST_GeomFromText(?, 4326))",
    )
    .bind(&stops_poly)
    .fetch_all(pool)
    .await
    .context("querying route-graph stops")?;

    let mut stops = Vec::with_capacity(pt_rows.len());
    for r in &pt_rows {
        let wkt: String = r.try_get("wkt")?;
        let Some((lat, lon)) = parse_point_wkt(&wkt) else {
            continue;
        };
        stops.push(serde_json::json!({
            "latBits": backend::fold_payload::bits(lat),
            "lonBits": backend::fold_payload::bits(lon),
            "name": r.try_get::<Option<String>, _>("name")?,
            "tags": tag_pairs(r.try_get::<Option<String>, _>("tags_json")?.as_deref()),
        }));
    }
    Ok((ways, stops))
}

/// `tags_json` → `[[k, v], …]`.
///
/// ⚠ PAIRS, not an object. `BackendEntry` reads them as two-element arrays, and
/// the object spelling parses to nothing — which made `nearbyLandmarks` answer
/// `[]` for every stay while every count read as answered (#1054).
fn tag_pairs(raw: Option<&str>) -> Vec<serde_json::Value> {
    let Some(v) = raw.and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok()) else {
        return Vec::new();
    };
    v.as_object().map_or_else(Vec::new, |m| {
        m.iter()
            .filter_map(|(k, val)| val.as_str().map(|s| serde_json::json!([k, s])))
            .collect()
    })
}

/// Margin (m) around a day's fixes when reading its route graph.
const ROUTE_GRAPH_MARGIN_M: f64 = 1500.0;
/// The TypeScript's `--days N` default for the warm-cache cron.
const DECODE_DEFAULT_DAYS: i64 = 14;

/// Rebuild `presence_log` from `decoded_days` over a bounded window.
///
/// Tier 2 of #982 — the first CronJob logic to leave node. The rule is
/// `Verified.PresenceLog.computeRow`; everything here is the IO around it.
///
/// ⚠ AN UPSERT, not the DELETE+INSERT its TypeScript header claims. The code
/// there does `onDuplicateKeyUpdate` and always did; the comment is wrong and
/// mirroring the comment instead of the code would drop rows outside the
/// window on every run.
///
/// ⚠ Rows are processed in the order the query returns them, and each day's
/// segments in the order they were stored. The rollup's tie-break keeps the
/// place seen FIRST, so re-ordering either changes which place a day is
/// attributed to.
async fn refresh_presence_log(pool: &sqlx::MySqlPool, lookback: i64) -> Result<()> {
    use sqlx::Row as _;

    backend::schema::migrate(pool).await?;

    // The TypeScript builds this from `Date.now()` and slices the ISO string, so
    // the cutoff is a UTC civil date regardless of anyone's zone.
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(lookback))
        .format("%Y-%m-%d")
        .to_string();
    eprintln!("refresh-presence-log: lookback={lookback}d (cutoff={cutoff})");

    let days = sqlx::query("SELECT user_id, date, segments_json FROM decoded_days WHERE date >= ?")
        .bind(&cutoff)
        .fetch_all(pool)
        .await
        .context("reading decoded_days")?;
    eprintln!(
        "refresh-presence-log: {} decoded day(s) in window",
        days.len()
    );

    let mut tz_by_user: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let (mut inserted, mut skipped) = (0u32, 0u32);

    for row in days {
        let user_id: String = row.try_get("user_id").context("decoded_days.user_id")?;
        // ⚠ `date` is a DATE column; read it as a string the same way the rest
        // of this binary does rather than through chrono, so the value written
        // back is the value read.
        let date: String = row
            .try_get::<chrono::NaiveDate, _>("date")
            .map(|d| d.format("%Y-%m-%d").to_string())
            .context("decoded_days.date")?;
        let segments_json: String = row
            .try_get("segments_json")
            .context("decoded_days.segments_json")?;

        if !tz_by_user.contains_key(&user_id) {
            let tz: Option<String> = sqlx::query_scalar(
                "SELECT value FROM sync_state WHERE user_id = ? AND key_name = 'home_tz'",
            )
            .bind(&user_id)
            .fetch_optional(pool)
            .await
            .context("reading home_tz")?
            .flatten();
            tz_by_user.insert(
                user_id.clone(),
                tz.unwrap_or_else(|| "Europe/London".into()),
            );
        }
        let tz = &tz_by_user[&user_id];

        // ⚠ Bad JSON is SKIPPED with a warning, not an abort — one corrupt day
        // must not stop the other 89. The TypeScript does the same.
        let Ok(segments) = serde_json::from_str::<serde_json::Value>(&segments_json) else {
            eprintln!("refresh-presence-log: bad JSON for {user_id} {date}");
            skipped += 1;
            continue;
        };

        let Some(r) = backend::lean::presence_row(&segments)? else {
            skipped += 1;
            continue;
        };

        sqlx::query(
            "INSERT INTO presence_log \
               (user_id, date, tz, dominant_place_id, dominant_fraction, \
                end_of_day_place_id, end_of_day_ts, end_of_day_posterior) \
             VALUES (?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), ?) \
             ON DUPLICATE KEY UPDATE \
               tz = VALUES(tz), \
               dominant_place_id = VALUES(dominant_place_id), \
               dominant_fraction = VALUES(dominant_fraction), \
               end_of_day_place_id = VALUES(end_of_day_place_id), \
               end_of_day_ts = VALUES(end_of_day_ts), \
               end_of_day_posterior = VALUES(end_of_day_posterior)",
        )
        .bind(&user_id)
        .bind(&date)
        .bind(tz)
        .bind(r.dominant_place_id)
        .bind(r.dominant_fraction)
        .bind(r.end_of_day_place_id)
        .bind(r.end_of_day_ts)
        .bind(r.end_of_day_posterior)
        .execute(pool)
        .await
        .with_context(|| format!("writing presence_log for {user_id} {date}"))?;
        inserted += 1;
    }

    eprintln!("refresh-presence-log: inserted {inserted}, skipped {skipped}");
    Ok(())
}

/// Render `/locations` for one day and print it, for diffing against the
/// TypeScript (#982).
///
/// ⚠ What this actually tests is FLOATS AND ORDER, which no unit test here can
/// reach. Each fix carries lat, lon, altitude, speed and accuracy as JSON
/// numbers that cross V8 on one side and serde_json on the other —
/// `Verified.RowShape` refuses DOUBLE columns for exactly that reason, so
/// "these render identically" is a claim that has to be measured. And both
/// implementations concatenate across devices before a STABLE sort by `ts`, so
/// equal timestamps expose the device-walk order: a `HashMap` iteration in Rust
/// against a JSON object's insertion order in TypeScript.
///
/// Pair with `scripts/locations-check-ts.mjs` and diff.
async fn locations_check(user: &str, date: &str) -> Result<()> {
    let cfg = Config::from_env().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    // ⚠ The API path's default, NOT `None`-means-unconfigured. NC_BASE_URL is
    // empty on the serving pod and the TypeScript defaults it, so a check that
    // bailed here would be measuring a configuration this endpoint never sees.
    let base = cfg
        .nextcloud_base_url
        .clone()
        .unwrap_or_else(|| backend::classification_inputs::DAY_NEXTCLOUD_BASE_URL.to_string());

    let next = lean::next_day(date)?;
    let pt = backend::nextcloud::phonetrack::PhoneTrack::open(
        reqwest::Client::new(),
        &pool,
        &base,
        user,
    )
    .await?;
    let fetched = pt.fetch_range(&pool, date, &next).await?;
    // ⚠ Reported, not swallowed: a non-zero count means `points` is a SUBSET,
    // so a diff against it would be comparing two different questions.
    if fetched.failed_devices > 0 {
        eprintln!(
            "locations-check: {} device(s) FAILED — this is a subset of the day",
            fetched.failed_devices
        );
    }
    let out: Vec<serde_json::Value> = fetched
        .points
        .iter()
        .map(|p| {
            // ⚠ Through the JS number rule, exactly as the route does — a
            // check that serialised these differently would be diffing its own
            // rendering rather than the endpoint's.
            use backend::row_json::{js_number_opt, js_number_value};
            serde_json::json!({
                "ts": p.ts,
                "lat": js_number_value(p.lat),
                "lon": js_number_value(p.lon),
                "altitude": js_number_opt(p.altitude),
                "speed": js_number_opt(p.speed),
                "accuracy": js_number_opt(p.accuracy),
                "battery": js_number_opt(p.battery),
            })
        })
        .collect();
    println!("locations\t{}", serde_json::to_string(&out)?);
    pool.close().await;
    Ok(())
}

/// Mint a session and print its cookie value, for end-to-end verification.
///
/// ⚠ THIS CREATES REAL CREDENTIALS. It exists because the only honest way to
/// compare the Rust backend against the TypeScript one is to send the SAME
/// cookie to both — they share the sessions table, so a session minted here is
/// accepted by either. Nothing else in the port can check an authenticated
/// response body.
///
/// ⚠ Pair every call with `drop-session`. A session left behind is a working
/// credential for the named user with the full TTL ahead of it, and nothing
/// distinguishes it from one the user created by logging in.
async fn mint_session(user: &str) -> Result<()> {
    let cfg = Config::from_env().context("reading configuration")?;
    let secret = cfg
        .session_secret
        .as_deref()
        .context("SESSION_SECRET is not set; a session cannot be signed")?;
    let pool = db::connect(&cfg.db.url()).await?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let signed = backend::auth::session::create(&pool, secret, user, "smoke", now_ms).await?;
    pool.close().await;
    println!("{signed}");
    eprintln!("⚠ minted a REAL session for {user} — run `backend drop-session` when done");
    Ok(())
}

/// Destroy a session minted above.
async fn drop_session(cookie: &str) -> Result<()> {
    let cfg = Config::from_env().context("reading configuration")?;
    let secret = cfg
        .session_secret
        .as_deref()
        .context("SESSION_SECRET is not set")?;
    let pool = db::connect(&cfg.db.url()).await?;
    let gone = backend::auth::session::destroy(&pool, secret, cookie).await?;
    pool.close().await;
    // ⚠ Reported rather than assumed: a "destroyed" that removed no row means
    // the credential is still live somewhere.
    eprintln!("session removed: {gone}");
    if !gone {
        anyhow::bail!("no session row matched that cookie — it may still be valid");
    }
    Ok(())
}

/// Only mirror around focus places seen this recently — drops stale travel
/// history so the mirror tracks where the user lives NOW.
const MIRROR_RECENT_DAYS: i64 = 120;
/// Two focus places are the same metropolitan region within this. Comfortably
/// larger than a city's diameter, far smaller than the gap between cities.
const MIRROR_REGION_GAP_KM: f64 = 80.0;
/// ≈ 3.5 km. Proven size: a single whole-bbox `relation[route=bus]` over greater
/// London matches ~700 routes and pulls every member node of each, which timed
/// out on first run (#255).
const MIRROR_TILE_DEG: f64 = 0.05;
/// The margin `bboxFromFixes` adds around the home region.
const MIRROR_MARGIN_M: f64 = 1500.0;

/// The recent focus places' coordinates — the input to the region clustering.
///
/// ⚠ `centroid_lat`/`centroid_lon` ARE DECIMAL, so they must be cast to CHAR and
/// parsed. Read as `f64` directly, sqlx fails; paired with a defaulting decode
/// this is the bug that made 117 places decode to centroid 0.0 while the check
/// printed OK.
async fn mirror_focus_points(pool: &sqlx::MySqlPool) -> Result<Vec<(f64, f64)>> {
    let cutoff = chrono::Utc::now().timestamp() - MIRROR_RECENT_DAYS * 86_400;
    let rows = sqlx::query(
        "SELECT CAST(centroid_lat AS CHAR) AS lat, CAST(centroid_lon AS CHAR) AS lon \
         FROM focus_places WHERE last_seen_ts >= ?",
    )
    .bind(cutoff)
    .fetch_all(pool)
    .await
    .context("reading recent focus places")?;
    rows.iter()
        .map(|r| {
            use sqlx::Row;
            let lat: String = r.try_get("lat").context("focus_places.centroid_lat")?;
            let lon: String = r.try_get("lon").context("focus_places.centroid_lon")?;
            Ok((
                lat.parse::<f64>()
                    .with_context(|| format!("centroid_lat {lat:?} is not a number"))?,
                lon.parse::<f64>()
                    .with_context(|| format!("centroid_lon {lon:?} is not a number"))?,
            ))
        })
        .collect()
}

/// What one pass over the tiles produced.
struct MirrorHarvest {
    /// Relation id → (tile key, route). Insertion-ordered so a run's log and its
    /// writes read the same way twice.
    routes: std::collections::BTreeMap<i64, (String, backend::lean::ExtractedRoute)>,
    /// The tile keys that ANSWERED. Each is authoritative for its own rows.
    succeeded: Vec<String>,
    failures: usize,
}

/// Fetch every tile and extract what Lean keeps.
///
/// ⚠ THE DEDUP RULE DIFFERS BY ARM AND IS LEAN'S, NOT THIS FUNCTION'S: buses
/// keep the FIRST tile's copy, rail the LAST. `node(r)` returns a relation's full
/// stop list from any tile it touches, so both copies are complete — but they
/// are different, and unifying them here would be changing behaviour in the
/// shell.
async fn mirror_fetch(
    client: &reqwest::Client,
    mode: &str,
    tiles: &[backend::lean::MirrorTile],
) -> Result<MirrorHarvest> {
    use backend::lean;
    let mut routes: std::collections::BTreeMap<i64, (String, lean::ExtractedRoute)> =
        std::collections::BTreeMap::new();
    let mut succeeded: Vec<String> = Vec::new();
    let mut failures = 0usize;
    let mut breaker = lean::BreakerState::new();

    for (i, tile) in tiles.iter().enumerate() {
        let key = lean::tile_key(tile);
        let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
        // ⚠ Fail fast while the breaker is open — the whole point is not to eat
        // the timeout on calls that will not succeed. It still counts as a tile
        // failure, exactly as `OverpassBreakerOpenError` does in the TypeScript.
        breaker = lean::breaker_step(&breaker, "check", now_ms)?;
        if breaker.open {
            eprintln!(
                "  tile {}/{}: circuit breaker is open — skipped",
                i + 1,
                tiles.len()
            );
            failures += 1;
            continue;
        }

        let query = lean::overpass_query(mode, tile)?;
        match backend::overpass::fetch_once(client, &query, backend::overpass::MIRROR_TIMEOUT_MS)
            .await
        {
            backend::overpass::Outcome::Ok(body) => {
                let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
                breaker = lean::breaker_step(&breaker, "success", now_ms)?;
                let found = lean::extract_routes(mode, &body)?;
                let n = found.len();
                for r in found {
                    match mode {
                        // Buses: first tile to yield a relation owns it.
                        "bus" => {
                            routes
                                .entry(r.osm_relation_id)
                                .or_insert_with(|| (key.clone(), r));
                        }
                        // Rail: a bare `set` — the last tile wins.
                        _ => {
                            routes.insert(r.osm_relation_id, (key.clone(), r));
                        }
                    }
                }
                succeeded.push(key);
                eprintln!(
                    "  tile {}/{}: {n} relations ({} unique so far)",
                    i + 1,
                    tiles.len(),
                    routes.len()
                );
            }
            backend::overpass::Outcome::Permanent { status } => {
                // ⚠ NOT counted against the breaker: a permanent 4xx means the
                // query is wrong, and tripping the breaker on it would fail-fast
                // the tiles that would have worked.
                eprintln!(
                    "  tile {}/{}: Overpass {status} — skipped",
                    i + 1,
                    tiles.len()
                );
                failures += 1;
            }
            backend::overpass::Outcome::AllFailed { errors } => {
                let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
                breaker = lean::breaker_step(&breaker, "failure", now_ms)?;
                // ⚠ EVERY mirror is named. The 2026-08-25 dry run printed only
                // `kumi.systems` on all six failed tiles, which reads as one
                // endpoint being down while both were — #1153's misreading,
                // reproduced here before it was fixed.
                eprintln!(
                    "  tile {}/{}: {} — skipped",
                    i + 1,
                    tiles.len(),
                    errors.join("; ")
                );
                failures += 1;
            }
        }
    }
    Ok(MirrorHarvest {
        routes,
        succeeded,
        failures,
    })
}

/// Plan the mirror: recent focus places → home metro → tiles.
///
/// `None` means there is nothing to mirror, which is a clean exit.
async fn mirror_plan(pool: &sqlx::MySqlPool) -> Result<Option<backend::lean::MirrorPlan>> {
    let points = mirror_focus_points(pool).await?;
    if points.is_empty() {
        eprintln!("No recent focus places — nothing to mirror.");
        return Ok(None);
    }
    let plan = backend::lean::mirror_region(
        &points,
        MIRROR_REGION_GAP_KM,
        MIRROR_TILE_DEG,
        MIRROR_MARGIN_M,
    )?;
    let Some(plan) = plan else {
        eprintln!("No recent focus places — nothing to mirror.");
        return Ok(None);
    };
    eprintln!(
        "Recent focus places: {} in {} region(s); mirroring the home region",
        plan.place_count, plan.region_count
    );
    eprintln!(
        "Mirroring across {} tiles of bbox {:.3},{:.3}→{:.3},{:.3}",
        plan.tiles.len(),
        plan.bbox.min_lat,
        plan.bbox.min_lon,
        plan.bbox.max_lat,
        plan.bbox.max_lon
    );
    Ok(Some(plan))
}

/// ⚠ COVERAGE IS REPORTED BECAUSE A COUNT CANNOT SUBSTITUTE FOR IT. #1134's
/// measured finding is that a route count is uncorrelated with the harm — a run
/// fetching 796 of 995 routes while losing the ones the rider uses passed a
/// count floor. What fraction of the AREA was refreshed is the quantity that is
/// not, and printing it is reporting, not behaviour, so the parity diff against
/// the TypeScript arm still holds.
fn mirror_coverage_line(succeeded: usize, total: usize) -> String {
    let pct = if total == 0 {
        0.0
    } else {
        100.0 * succeeded as f64 / total as f64
    };
    format!("coverage {succeeded}/{total} tiles ({pct:.0}% of the area)")
}

/// Tier 2 of #982 — the node cron is `src/cli/refresh-rail-stops.ts`.
///
/// ⚠ A PARTIAL RUN REPLACES ONLY THE TILES THAT ANSWERED — rail now carries the
/// `tile_key` bus has had all along, added 2026-08-25 once the port's parity was
/// established. Before it, this DELETEd the whole table and rewrote what it
/// found, so a run at 10-of-18 coverage dropped every relation living only in
/// the 8 tiles that failed. The measured shape is why it was invisible: 441
/// relations found against 268 cached, so the count went UP and the summary read
/// like a healthy refresh that found more data (#1134, #1153).
///
/// ⚠ THE REFUSAL RULE IS UNCHANGED and is still the rail one — zero relations
/// with any failure. It no longer has to carry the partial case, because tile
/// ownership does.
async fn refresh_rail_stops(dry_run: bool) -> Result<()> {
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    backend::schema::migrate(&pool).await?;

    let Some(plan) = mirror_plan(&pool).await? else {
        pool.close().await;
        return Ok(());
    };

    let client = reqwest::Client::new();
    let h = mirror_fetch(&client, "rail", &plan.tiles).await?;
    let verdict =
        backend::lean::may_rebuild("rail", h.routes.len(), h.failures, plan.tiles.len(), 0)?;
    eprintln!(
        "refresh-rail-stops: {} relations, {}",
        h.routes.len(),
        mirror_coverage_line(h.succeeded.len(), plan.tiles.len())
    );
    if !verdict.may_write {
        pool.close().await;
        anyhow::bail!(
            "all {} tiles failed — leaving rail_stops_cache untouched",
            plan.tiles.len()
        );
    }

    // ⚠ THE DRY RUN STOPS HERE, AFTER the refusal and BEFORE the transaction — so
    // it exercises the fetch, the extraction and the decision, which is
    // everything a real run decides. Placing it earlier would make it a test of
    // the argument parser.
    if dry_run {
        let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM rail_stops_cache")
            .fetch_one(&pool)
            .await
            .unwrap_or(-1);
        eprintln!(
            "DRY RUN — rail_stops_cache holds {existing} relation(s); this run would {} with {} relation(s)",
            if verdict.full_rebuild {
                "rebuild it in full".to_string()
            } else {
                format!(
                    "replace {} of {} tiles",
                    h.succeeded.len(),
                    plan.tiles.len()
                )
            },
            h.routes.len()
        );
        pool.close().await;
        return Ok(());
    }

    let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM rail_stops_cache")
        .fetch_one(&pool)
        .await
        .unwrap_or(-1);
    let mut tx = pool
        .begin()
        .await
        .context("opening the rebuild transaction")?;
    if verdict.full_rebuild {
        // A complete run is authoritative for the whole bbox: anything absent is
        // absent from OSM. This is also what retires the `tile_key IS NULL` rows
        // written before the column existed.
        sqlx::query("DELETE FROM rail_stops_cache")
            .execute(&mut *tx)
            .await
            .context("clearing rail_stops_cache")?;
    } else {
        // A partial run is authoritative ONLY for the tiles that answered. Every
        // other tile keeps what it had, so the mirror cannot shrink because
        // Overpass 502'd somewhere.
        for key in &h.succeeded {
            sqlx::query("DELETE FROM rail_stops_cache WHERE tile_key = ?")
                .bind(key)
                .execute(&mut *tx)
                .await
                .with_context(|| format!("clearing tile {key}"))?;
        }
    }
    for (tile, r) in h.routes.values() {
        // ⚠ UPSERT, not a plain insert: a relation can survive the delete above
        // under a FAILED tile's key and still be re-fetched from one that
        // answered.
        sqlx::query(
            "INSERT INTO rail_stops_cache (osm_relation_id, route_type, line_ref, line_name, stops_json, tile_key) \
             VALUES (?, ?, ?, ?, ?, ?) \
             ON DUPLICATE KEY UPDATE route_type = VALUES(route_type), line_ref = VALUES(line_ref), \
               line_name = VALUES(line_name), stops_json = VALUES(stops_json), \
               tile_key = VALUES(tile_key), computed_at = CURRENT_TIMESTAMP",
        )
        .bind(r.osm_relation_id)
        .bind(r.route_type.as_deref().unwrap_or(""))
        .bind(r.route_ref.as_deref())
        .bind(r.route_name.as_deref())
        .bind(serde_json::to_string(&r.stops)?)
        .bind(tile)
        .execute(&mut *tx)
        .await
        .with_context(|| format!("writing relation {}", r.osm_relation_id))?;
    }
    tx.commit().await.context("committing the rebuild")?;
    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM rail_stops_cache")
        .fetch_one(&pool)
        .await
        .unwrap_or(existing);
    if verdict.full_rebuild {
        eprintln!(
            "rail_stops_cache rebuilt in full: {} relations",
            h.routes.len()
        );
    } else {
        eprintln!(
            "rail_stops_cache merged: {}/{} tiles replaced, {} kept their existing rows — {existing} -> {after} relations",
            h.succeeded.len(),
            plan.tiles.len(),
            h.failures
        );
    }
    pool.close().await;
    Ok(())
}

/// Tier 2 of #982 — the node cron is `src/cli/refresh-bus-routes.ts`.
///
/// ⚠ A PARTIAL RUN REPLACES ONLY THE TILES THAT ANSWERED. That is what makes it
/// lossless, and it is why the refusal can be as narrow as "every tile failed".
/// It is also why a 2-of-18 run exits 0 — see #1134.
async fn refresh_bus_routes(dry_run: bool) -> Result<()> {
    let cfg = backend::config::Config::from_env_batch().context("reading configuration")?;
    let pool = db::connect(&cfg.db.url())
        .await
        .context("connecting to the database")?;
    backend::schema::migrate(&pool).await?;

    let Some(plan) = mirror_plan(&pool).await? else {
        pool.close().await;
        return Ok(());
    };

    let client = reqwest::Client::new();
    let h = mirror_fetch(&client, "bus", &plan.tiles).await?;

    let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bus_route_cache")
        .fetch_one(&pool)
        .await
        .context("counting bus_route_cache")?;
    let verdict = backend::lean::may_rebuild(
        "bus",
        h.routes.len(),
        h.failures,
        plan.tiles.len(),
        existing,
    )?;
    eprintln!(
        "refresh-bus-routes: {} routes, {}",
        h.routes.len(),
        mirror_coverage_line(h.succeeded.len(), plan.tiles.len())
    );
    if !verdict.may_write {
        pool.close().await;
        anyhow::bail!(
            "{} — leaving bus_route_cache untouched",
            verdict.refusal.unwrap_or_else(|| "refused".into())
        );
    }

    // ⚠ Same placement as the rail arm: after the refusal, before the write.
    if dry_run {
        eprintln!(
            "DRY RUN — bus_route_cache holds {existing} route(s); this run would {} with {} route(s)",
            if verdict.full_rebuild {
                "rebuild it in full".to_string()
            } else {
                format!(
                    "replace {} of {} tiles",
                    h.succeeded.len(),
                    plan.tiles.len()
                )
            },
            h.routes.len()
        );
        pool.close().await;
        return Ok(());
    }

    let mut tx = pool
        .begin()
        .await
        .context("opening the rebuild transaction")?;
    if verdict.full_rebuild {
        // A complete run is authoritative for the whole bbox: anything absent is
        // absent from OSM. This also retires rows written before `tile_key`
        // existed.
        sqlx::query("DELETE FROM bus_route_cache")
            .execute(&mut *tx)
            .await
            .context("clearing bus_route_cache")?;
    } else {
        for key in &h.succeeded {
            sqlx::query("DELETE FROM bus_route_cache WHERE tile_key = ?")
                .bind(key)
                .execute(&mut *tx)
                .await
                .with_context(|| format!("clearing tile {key}"))?;
        }
    }
    for (tile, r) in h.routes.values() {
        // ⚠ UPSERT, not a plain insert: a route can survive the delete above
        // under a FAILED tile's key and still be re-fetched from one that
        // answered.
        sqlx::query(
            "INSERT INTO bus_route_cache (osm_relation_id, route_ref, route_name, stops_json, tile_key) \
             VALUES (?, ?, ?, ?, ?) \
             ON DUPLICATE KEY UPDATE route_ref = VALUES(route_ref), route_name = VALUES(route_name), \
               stops_json = VALUES(stops_json), tile_key = VALUES(tile_key), computed_at = CURRENT_TIMESTAMP",
        )
        .bind(r.osm_relation_id)
        .bind(r.route_ref.as_deref().unwrap_or(""))
        .bind(r.route_name.as_deref())
        .bind(serde_json::to_string(&r.stops)?)
        .bind(tile)
        .execute(&mut *tx)
        .await
        .with_context(|| format!("writing route {}", r.osm_relation_id))?;
    }
    tx.commit().await.context("committing the rebuild")?;

    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bus_route_cache")
        .fetch_one(&pool)
        .await
        .unwrap_or(existing);
    if verdict.full_rebuild {
        eprintln!("bus_route_cache rebuilt in full: {} routes", h.routes.len());
    } else {
        eprintln!(
            "bus_route_cache merged: {}/{} tiles replaced, {} kept their existing rows — {existing} -> {after} routes",
            h.succeeded.len(),
            plan.tiles.len(),
            h.failures
        );
    }
    pool.close().await;
    Ok(())
}

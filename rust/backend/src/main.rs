//! The backend entrypoint.
//!
//! `backend <subcommand>` — run it with none for the list. The dispatch is
//! here; what each subcommand does lives under `cli/`, grouped by what it
//! touches. The three that carry production:
//!
//!   check  — read the config, open the pool, and prove both against the real
//!            database. READ-ONLY, so it is safe to point at production.
//!   sync   — Fitbit + Google ingestion, forward then backward, for every linked
//!            user. `--forward-only` runs the forward pass alone and touches NO
//!            backfill state, which is the form that is safe to run beside the
//!            live cron.
//!   serve  — the HTTP server. THE server: `health-auth` runs this and nothing
//!            else does.
//!
//! ⚠ `sync` FAILS LOUDLY rather than exiting 0 having done nothing — a silent
//! success shows as a healthy scheduled run while data stops. It errors when it
//! cannot read its users or reach Lean, and reports a spent rate budget as the
//! ordinary ending it is.
//!
//! ⚠ AND IT IS NOT ENOUGH ON ITS OWN (#1231): a run that reads its users and
//! reaches Lean can still write no rows, so `daily_activity` can stop while
//! every run exits 0. `backend freshness` asks the outcome question instead, on
//! its own schedule.

use anyhow::{Context, Result};
use backend::{
    classification_inputs, config::Config, db, fitbit, lean, routes, state::AppState, sync_state,
};

mod cli;
use cli::census::*;
use cli::day::*;
use cli::decode::*;
use cli::google::*;
use cli::mirror::*;
use cli::refresh::*;
use cli::session::*;

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
            // ⚠ THE CLI MUST BE ABLE TO ASK FOR THE RAW ARM. `?walkMatch=0` is
            // the map's A/B baseline, and without a way to reach it from here
            // the only way to exercise it is a live session against the HTTP
            // route — which is why it went unnoticed that the parameter reached
            // nothing at all (#1619).
            let rest: Vec<&String> = flags.iter().filter(|f| *f != "--no-walk-match").collect();
            let walk_match = !flags.iter().any(|f| f == "--no-walk-match");
            let (user, date, tz) = match rest.as_slice() {
                [user, date] => (*user, *date, None),
                [user, date, tz] => (*user, *date, Some(tz.as_str())),
                _ => {
                    eprintln!(
                        "usage: backend velocity <user> <date> [display-tz] [--no-walk-match]"
                    );
                    std::process::exit(64);
                }
            };
            velocity(user, date, tz, walk_match).await
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
        //
        // #343 P0 measurement flags (single user only — the files are per-user):
        //   --hard-out <file>   also write the hard-gate priors blob to a file
        //   --soft-out <file>   also mine the SOFT blob (`stayResponsibilities`
        //                       → `minePriorsSoft`) to a file, printing the
        //                       effective sample size beside the hard count
        //   --dry               mine but skip the venue_type_priors and
        //                       focus_places writes
        "refresh-focus-places" => {
            let mut soft_out: Option<String> = None;
            let mut hard_out: Option<String> = None;
            let mut dry = false;
            let mut as_of: Option<chrono::DateTime<chrono::Utc>> = None;
            let mut pos: Vec<&String> = Vec::new();
            let mut it = flags.iter();
            while let Some(f) = it.next() {
                match f.as_str() {
                    "--soft-out" | "--hard-out" => {
                        let Some(path) = it.next() else {
                            eprintln!("refresh-focus-places: {f} needs a path");
                            std::process::exit(2);
                        };
                        if f == "--soft-out" {
                            soft_out = Some(path.clone());
                        } else {
                            hard_out = Some(path.clone());
                        }
                    }
                    "--dry" => dry = true,
                    "--as-of" => {
                        let Some(d) = it.next() else {
                            eprintln!("refresh-focus-places: --as-of needs a YYYY-MM-DD");
                            std::process::exit(2);
                        };
                        // End of that civil day in UTC, so the day itself is
                        // inside the window rather than cut off at its start.
                        match chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d") {
                            Ok(nd) => {
                                as_of = Some(
                                    nd.and_hms_opt(23, 59, 59)
                                        .expect("23:59:59 is a time")
                                        .and_utc(),
                                )
                            }
                            Err(e) => {
                                eprintln!("refresh-focus-places: --as-of {d:?}: {e}");
                                std::process::exit(2);
                            }
                        }
                    }
                    _ => pos.push(f),
                }
            }
            let (user, lookback): (Option<&str>, i64) = match pos.as_slice() {
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
                    eprintln!(
                        "usage: backend refresh-focus-places [user] [lookback-days] \
                         [--hard-out <file>] [--soft-out <file>] [--dry] \
                         [--as-of YYYY-MM-DD]"
                    );
                    std::process::exit(64);
                }
            };
            let sinks = MineSinks {
                soft_out,
                hard_out,
                dry,
                as_of,
            };
            if sinks.active() && user.is_none() {
                eprintln!(
                    "refresh-focus-places: --hard-out/--soft-out/--dry need an explicit user"
                );
                std::process::exit(2);
            }
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
            let r = refresh_focus_places(&pool, user, lookback, &sinks).await;
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
        // ⚠ THE DATE IS POSITIONAL, not `--date <ymd>`: a numeric second
        // argument is a day COUNT and anything else is a date. Nothing enforces
        // the label, so a wrong one here misleads before anybody types.
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
        // The deferred half of the geocode port (#1076): the serving path RECORDS
        // what it could not answer, this FETCHES it. Never inline — a Nominatim
        // round trip on the serving path is what this design exists to avoid.
        "fetch-geocodes" => {
            let mut dry = false;
            let mut limit: i64 = 200;
            let mut rest = flags.iter();
            while let Some(f) = rest.next() {
                match f.as_str() {
                    "--dry-run" => dry = true,
                    "--limit" => {
                        limit = rest
                            .next()
                            .and_then(|v| v.parse().ok())
                            .context("--limit takes a number")?;
                    }
                    _ => {
                        eprintln!("usage: backend fetch-geocodes [--dry-run] [--limit N]");
                        std::process::exit(64);
                    }
                }
            }
            fetch_geocodes(dry, limit).await
        }
        // The Overpass half of the same queue (#1658). The base OSM mirror had
        // no writer at all until this: `osm_lines`, `osm_points` and
        // `osm_coverage` were a dead snapshot of whatever the TypeScript left,
        // so every place he went that it never fetched was blank permanently.
        //
        // ⚠ The default limit is LOWER than the geocode drain's 200. These are
        // ~5 MB Overpass requests against a two-slot public endpoint, not
        // one-second Nominatim points; the skip in `fetch_osm` means one box
        // usually clears many keys, so a small number still drains a day.
        "fetch-osm" => {
            let mut dry = false;
            let mut limit: i64 = 40;
            let mut rest = flags.iter();
            while let Some(f) = rest.next() {
                match f.as_str() {
                    "--dry-run" => dry = true,
                    "--limit" => {
                        limit = rest
                            .next()
                            .and_then(|v| v.parse().ok())
                            .context("--limit takes a number")?;
                    }
                    _ => {
                        eprintln!("usage: backend fetch-osm [--dry-run] [--limit N]");
                        std::process::exit(64);
                    }
                }
            }
            fetch_osm(dry, limit).await
        }
        // #1071's instrument. Several days in ONE process, so the arena's
        // high-water is visible; `velocity` restarts the process each time and
        // therefore cannot see it.
        "velocity-many" => {
            let [user, dates @ ..] = flags else {
                eprintln!("usage: backend velocity-many <user> <YYYY-MM-DD>...");
                std::process::exit(64);
            };
            if dates.is_empty() {
                eprintln!("usage: backend velocity-many <user> <YYYY-MM-DD>...  (>=1 date)");
                std::process::exit(64);
            }
            velocity_many(user, dates).await
        }
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
        // #1730: the decision line survives the pod.
        "owntracks-log" => {
            let (user, limit) = match flags {
                [user] => (user, 200),
                [user, n] => (
                    user,
                    n.parse()
                        .with_context(|| format!("limit {n:?} is not a number"))?,
                ),
                _ => {
                    eprintln!("usage: backend owntracks-log <user> [limit]");
                    std::process::exit(64);
                }
            };
            owntracks_log(user, limit).await
        }
        "google-probe" => backend::google::probe::run().await,
        "coverage" => coverage().await,
        // #1733: the case file's heart-rate pages read these through prod-db.sh.
        "hr-trend" => match flags {
            [a, from, boundary] if *a == "--averages" => hr_trend_averages(from, boundary).await,
            [] => hr_trend("2026-06-03", false).await,
            [since] if *since != "--json" => hr_trend(since, false).await,
            [j] if *j == "--json" => hr_trend("2026-06-03", true).await,
            [j, since] | [since, j] if *j == "--json" => hr_trend(since, true).await,
            _ => {
                eprintln!(
                    "usage: backend hr-trend [--json] [SINCE] | --averages <FROM> <BOUNDARY>"
                );
                std::process::exit(64);
            }
        },
        "hrv-history" => hrv_history().await,
        "column-fill" => column_fill().await,
        "zones-census" => zones_census().await,
        "focus-audit" => focus_audit().await,
        "tz-census" => tz_census().await,
        "freshness" => freshness().await,
        "google-compare" => google_compare().await,
        "google-compare-hrv" => {
            let days = match flags {
                [] => 7,
                [d] => d
                    .parse()
                    .with_context(|| format!("days {d:?} is not a number"))?,
                _ => {
                    eprintln!("usage: backend google-compare-hrv [days]");
                    std::process::exit(64);
                }
            };
            google_compare_hrv(days).await
        }
        "google-compare-zones" => {
            let days = match flags {
                [] => 7,
                [d] => d
                    .parse()
                    .with_context(|| format!("days {d:?} is not a number"))?,
                _ => {
                    eprintln!("usage: backend google-compare-zones [days]");
                    std::process::exit(64);
                }
            };
            google_compare_zones(days).await
        }
        "google-compare-steps" => {
            let days = match flags {
                [] => 7,
                [d] => d
                    .parse()
                    .with_context(|| format!("days {d:?} is not a number"))?,
                _ => {
                    eprintln!("usage: backend google-compare-steps [days]");
                    std::process::exit(64);
                }
            };
            google_compare_steps(days).await
        }
        "google-backfill-sleep" => {
            let (days, write, allow_shrink) = match flags {
                [d] => (d, false, false),
                [d, w] if w == "--write" => (d, true, false),
                [d, w, a] if w == "--write" && a == "--allow-shrink" => (d, true, true),
                _ => {
                    eprintln!(
                        "usage: backend google-backfill-sleep <days> [--write [--allow-shrink]]"
                    );
                    std::process::exit(64);
                }
            };
            let days = days
                .parse()
                .with_context(|| format!("days {days:?} is not a number"))?;
            google_backfill_sleep(days, write, allow_shrink).await
        }
        "google-compare-sleep" => {
            let days = match flags {
                [] => 7,
                [d] => d
                    .parse()
                    .with_context(|| format!("days {d:?} is not a number"))?,
                _ => {
                    eprintln!("usage: backend google-compare-sleep [days]");
                    std::process::exit(64);
                }
            };
            google_compare_sleep(days).await
        }
        "google-compare-intraday" => {
            let days = match flags {
                [] => 7,
                [d] => d
                    .parse()
                    .with_context(|| format!("days {d:?} is not a number"))?,
                _ => {
                    eprintln!("usage: backend google-compare-intraday [days]");
                    std::process::exit(64);
                }
            };
            google_compare_intraday(days).await
        }
        "mirror-check" => {
            let [fixture] = flags else {
                eprintln!("usage: backend mirror-check <fixture.json>");
                std::process::exit(64);
            };
            mirror_check(fixture).await
        }
        // #1660: the golden-day writer.
        "capture-day" => {
            let (user, date, out, tz) = match flags {
                [user, date, out] => (user, date, out, None),
                [user, date, out, tz] => (user, date, out, Some(tz.as_str())),
                _ => {
                    eprintln!("usage: backend capture-day <user> <date> <out.json> [display-tz]");
                    std::process::exit(64);
                }
            };
            capture_day(user, date, tz, out).await
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
            // ⚠ EVERY DISPATCHED SUBCOMMAND, and `usage_lists_every_subcommand`
            // fails if one is added without a line here. The list had drifted to
            // 19 of 29 before that test existed — including four this file added
            // in one day — and the README points a reader at this output, so an
            // incomplete list is a wrong answer rather than a thin one.
            eprintln!("usage: backend <subcommand> [args]\n");
            for (name, args, what) in backend::SUBCOMMANDS {
                eprintln!("  {name:<22}{args:<26}{what}");
            }
            std::process::exit(64);
        }
        other => {
            // ⚠ RENDERED FROM `SUBCOMMANDS`, never spelled out here. A prose
            // list rots: it omits the nightly `refresh-*` crons and
            // `mint-session`, so a typo is answered with
            // a list that denied half the CLI existed.
            //
            // `usage_lists_every_subcommand` guards the table against the match
            // arms below, but it could not see a SECOND copy of the list. That
            // is the same rot its own note describes ("the printed list had 19
            // of 29"), surviving in the one place the fix did not reach.
            eprintln!("backend: unknown subcommand {other:?} — expected one of:\n");
            for (name, args, what) in backend::SUBCOMMANDS {
                eprintln!("  {name:<22}{args:<26}{what}");
            }
            std::process::exit(64);
        }
    }
}

/// Run one Fitbit ingestion pass over every linked user.
///
/// # It does NOT migrate the schema
///
/// Named here rather than left to be discovered from a diff, because it is a
/// silent absence: the run would look healthy and simply not do it. The
/// TypeScript this was once measured against called `migrate()` on startup, so
/// whichever of the sync cron and the server started first brought the schema
/// up. This does not, because
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
/// ⚠ THIS IS PRODUCTION'S SERVER. It answers `health.xinutec.org`, and there is
/// no TypeScript server left beside it — `src/server.ts` went with the TS arm
/// (#975).
///
/// It binds `AUTH_PORT`, which is what the manifest sets; see the note in the
/// body. The 8081 default is a local-run convenience and is not what production
/// uses.
async fn serve() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cfg = Config::from_env()?;
    let pool = db::connect(&cfg.db.url()).await?;
    // ⚠ `AUTH_PORT`, which is what the manifest sets. `PORT` is NOT set in
    // production, so reading it would bind 8081 while the Service and the
    // readiness probe expect 3000 — a pod that looks healthy from inside while
    // the rollout stalls (#982).
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
    // As of NOW, which is every event — and it exercises the `priorsAsOf` round
    // trip rather than stepping around it, which is the point of this check.
    let priors =
        classification_inputs::venue_priors(&pool, &user, chrono::Utc::now().timestamp()).await?;
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
            "{user} has no decoded_days row at the current classifier version — the decode \
             cron has not run for this user. ⚠ This message named a TypeScript writer \
             drifting from a Rust reader until 2026-09-01; there is no TypeScript writer \
             (#975) and CLASSIFIER_VERSION now has a single declaration, so a drift between \
             two copies is no longer one of the things this can mean"
        );
    };

    let buses = classification_inputs::bus_route_cache(&pool).await?;
    let rail_stops = classification_inputs::rail_stops_cache(&pool).await?;
    let decode = classification_inputs::hsmm_decode(&pool, &user, &check_date).await?;
    // ⚠ This probe prints what the loader produces, so it must resolve the zone
    // the same way. Passing `None` would print UTC-read windows and report a
    // healthy day while production reads them an hour later (#1633).
    let home_tz = crate::sync_state::get(&pool, &user, "home_tz").await?;
    let sleeps =
        classification_inputs::sleep_windows(&pool, &user, &check_date, home_tz.as_deref()).await?;
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

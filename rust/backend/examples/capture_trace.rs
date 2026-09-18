//! Capture a live day's OSM callback answers as an `osmTrace` (#1660).
//!
//! ⚠ **WHY THIS EXISTS: nothing has written an `osmTrace` since the TypeScript
//! backend went (#975).** Every reader of the format is in `day_shell::osm`;
//! the writer was elsewhere and left with it. The corpus froze at 2026-08-13,
//! so no recent day could become a gate — and recent days are where the
//! defects are (#1658, #1659).
//!
//! ⚠ **IT IS ONE THIRD OF A GOLDEN DAY, and saying so is the point.** A fixture
//! carries `{meta, inputs, expected}`; `inputs.osmTrace` has TEN sections and
//! this writes the THREE the `@[extern]` callbacks answer — `walkableRoads`,
//! `buildingsNear`, `drivableRoads`. The other seven and `osmRowSet` come from
//! the ANSWERER and are not captured here. A day built from this alone replays
//! with the road and walk matchers fed and every answerer lookup missing.
//!
//! ⚠ **AND IT PROVES ITSELF.** Writing a trace that cannot answer its own day
//! is the failure this repo has already had twice — a fixture whose keys the
//! fold never spells answers nothing and looks exactly like no fixture at all
//! (#1418). So after capturing, it RELOADS what it wrote and folds the same day
//! again, and reports the hit rate. Anything below 100% means the key the
//! capture wrote is not the key the lookup forms.
//!
//! ```text
//! scripts/prod-db.sh cargo run --release --example capture_trace -- pippijn 2026-09-15 /tmp/trace.json
//! ```

use anyhow::{Context, Result};
use backend::fold_converge::converge;
use backend::rowset_answerer::RowSetAnswerer;
use serde_json::{Value, json};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (Some(user), Some(date)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: capture_trace <user> <date> [out.json]");
        std::process::exit(64);
    };
    backend::lean::init().context("starting the Lean runtime")?;

    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = backend::db::connect(&cfg.db.url())
        .await
        .context("connecting")?;
    let home_tz = backend::sync_state::get(&pool, user, "home_tz")
        .await?
        .unwrap_or_else(|| "Europe/Amsterdam".into());
    let bounds = backend::timezone::date_bounds_utc(date, Some(&home_tz))
        .with_context(|| format!("bounding {date}"))?;
    let base_url = cfg
        .nextcloud_base_url
        .clone()
        .unwrap_or_else(|| backend::classification_inputs::DAY_NEXTCLOUD_BASE_URL.to_string());
    let inputs = backend::classification_inputs::load(
        &pool,
        &reqwest::Client::new(),
        &base_url,
        &backend::classification_inputs::DayIdentity {
            user_id: user,
            date,
            display_tz: &home_tz,
        },
        bounds,
        Some(&home_tz),
    )
    .await?;

    let cap = backend::head::capture(&inputs, date, user).context("head capture")?;

    // ⚠ THROUGH `converge_from_mirror`, NOT `converge` DIRECTLY. The mirror's
    // sync path REFUSES when an ambient tokio runtime exists — it cannot
    // `block_on` inside one — and the refusal is not an error, it is an EMPTY
    // ANSWER. Calling `converge` from an async main captured a trace in which
    // `buildingsNear` had zero keys and `walkableRoads` had four, and the
    // round-trip proof below still reported 100% because an empty answer
    // recorded is an empty answer returned. This is production's own entry
    // point, so the capture records what production records (health #1619 is
    // the same refusal answering every OSM read in the pod for weeks).
    backend::osm_host::start_capture();
    let now_ms = chrono::Utc::now().timestamp_millis();
    let (conv, row_set) = backend::mirror_source::converge_from_mirror_recording(
        pool.clone(),
        cap.clone(),
        inputs.clone(),
        now_ms,
    )
    .await
    .context("converge from the mirror")?;
    pool.close().await;
    let live_day: Value = serde_json::from_str(&conv.out).context("the live fold's reply")?;

    let trace = backend::osm_host::take_capture();
    let sections: Vec<(String, usize)> = trace
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| (k.clone(), v.as_object().map_or(0, serde_json::Map::len)))
        .collect();
    // ⚠ NO CALLBACK COUNT HERE. `take_counts` is a THREAD-LOCAL tally and the
    // fold just ran on a blocking worker, so reading it from this thread
    // returns 0 over a day that made 135 calls. The replay below runs on THIS
    // thread and its count is real; the capture's own evidence is the section
    // sizes.
    eprintln!(
        "captured {date}: {} round(s), {} unanswerable answerer key(s)",
        conv.rounds,
        conv.unanswerable.len(),
    );
    for (k, n) in &sections {
        eprintln!("  {k:<16} {n} key(s)");
    }

    // ── the proof ────────────────────────────────────────────────────────────
    // Reload what was just written and fold the SAME day again. Every callback
    // must now HIT. A miss here means the key the capture wrote is not the key
    // the lookup forms, which is precisely the failure that makes a fixture
    // look loaded and answer nothing.
    // ⚠ NON-EMPTINESS FIRST, because the hit rate below CANNOT see this. An
    // answer recorded as `[]` is returned as `[]` and counts as a HIT: the
    // first version of this harness captured a trace with zero buildings and
    // four ways and proudly reported 100%. A check that passes for the wrong
    // reason is worse than none — so the shape of what was written is asserted
    // before anything is said about replaying it.
    let mut empties: Vec<String> = Vec::new();
    let mut total_answers = 0usize;
    for (table, entries) in trace.as_object().into_iter().flatten() {
        let obj = entries.as_object().cloned().unwrap_or_default();
        let filled = obj
            .values()
            .filter(|v| v.as_array().is_some_and(|a| !a.is_empty()))
            .count();
        total_answers += filled;
        eprintln!("  {table:<16} {:>4} key(s), {filled} non-empty", obj.len());
        if filled == 0 && !obj.is_empty() {
            empties.push(table.clone());
        }
    }
    if total_answers == 0 {
        anyhow::bail!(
            "every captured answer is EMPTY — the mirror answered nothing for this day. \
             Either it is not configured, or its sync path refused (it cannot block inside \
             a tokio runtime), or the day lies outside osm_coverage: check with \
             `--example day_coverage` before trusting anything here"
        );
    }
    if !empties.is_empty() {
        eprintln!(
            "⚠ {} section(s) captured only EMPTY answers: {}",
            empties.len(),
            empties.join(", ")
        );
    }

    let rs = row_set.as_object().cloned().unwrap_or_default();
    let n = |k: &str| rs.get(k).and_then(Value::as_array).map_or(0, Vec::len);
    eprintln!(
        "  osmRowSet         {} line(s), {} point(s), {} declined, rail {} way(s)/{} station(s)",
        n("lines"),
        n("points"),
        n("declined"),
        rs.get("railLines")
            .and_then(|r| r.get("ways"))
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
        rs.get("railLines")
            .and_then(|r| r.get("stations"))
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
    );

    let doc = json!({ "inputs": { "osmTrace": trace } });
    backend::osm_host::load_trace_value_sections(&doc, "<captured>", true, true, true)
        .map_err(|e| anyhow::anyhow!("reloading the capture: {e}"))?;
    let mut answerer2 = RowSetAnswerer::new(&row_set).context("row set")?;
    let replay = converge(&cap, &inputs, None, &mut answerer2).context("replay")?;
    let back = backend::osm_host::take_counts();

    // ⚠ **DAY EQUALITY, NOT KEY MATCHING.** The row set is a CONVERSION —
    // positional mirror rows into the fixture's object form — and a conversion
    // that loses a field produces a fixture that is well formed and wrong. The
    // only proof worth having is that the fold reaches the same day from it.
    let replay_day: Value = serde_json::from_str(&replay.out).context("the replayed reply")?;
    if replay_day == live_day {
        eprintln!("day equality: the replay reproduces the live fold EXACTLY");
    } else {
        let differing: Vec<&str> = live_day
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(k, v)| replay_day.get(*k) != Some(*v))
            .map(|(k, _)| k.as_str())
            .collect();
        eprintln!(
            "⚠ day equality FAILED — {} top-level key(s) differ: {:?}",
            differing.len(),
            differing
        );
        eprintln!(
            "   live {} round(s)/{} unanswerable · replay {} round(s)/{} unanswerable",
            conv.rounds,
            conv.unanswerable.len(),
            replay.rounds,
            replay.unanswerable.len()
        );
    }
    let (asked, missed) = (back.asked(), back.misses());
    eprintln!(
        "replayed against the capture: {asked} asked, {missed} missed  ({:.1}% hit), \
         {total_answers} non-empty answer(s) recorded",
        if asked == 0 {
            0.0
        } else {
            100.0 * (asked - missed) as f64 / asked as f64
        }
    );
    if missed > 0 {
        anyhow::bail!(
            "{missed} of {asked} callback(s) MISSED a trace just written from the same day — \
             the captured key does not match the key the lookup forms, and a fixture built \
             from this would answer nothing while looking loaded"
        );
    }

    // ── the control ──────────────────────────────────────────────────────────
    // ⚠ **DOES THE DECLINE LIST DO ANY WORK?** Day equality above says the
    // capture is faithful; it does NOT say which part of it mattered. Replay
    // once more with `declined` stripped: if the day is STILL identical, the
    // list is inert for this day and nobody should conclude from it that a
    // low-coverage day is being reproduced. Where it is not identical, that
    // difference is precisely the gap a fixture could not express before
    // (#1658 — 2026-09-06 declines 275 questions).
    let mut stripped = rs.clone();
    stripped.remove("declined");
    let stripped = Value::Object(stripped);
    let mut answerer3 = RowSetAnswerer::new(&stripped).context("row set")?;
    let no_declines = converge(&cap, &inputs, None, &mut answerer3).context("control replay")?;
    let no_declines_day: Value =
        serde_json::from_str(&no_declines.out).context("the control reply")?;
    // ⚠ THE COUNTS GO OUT EITHER WAY. An identical DAY does not mean an
    // identical PROVENANCE: a declined key leaves the fold on defaults and is
    // counted `unanswerable`, while an empty answer is a claim that there is
    // nothing there. Those can reach the same day and are not the same fact —
    // and `routes::velocity` logs the unanswerable count as the signal that a
    // served day was built from defaults (#1658). Reporting only when the day
    // moves would hide exactly that.
    eprintln!(
        "control: unanswerable — live {} · replay {} · without `declined` {}",
        conv.unanswerable.len(),
        replay.unanswerable.len(),
        no_declines.unanswerable.len(),
    );
    // ⚠ THE DAY IS THE COARSER TEST AND IT MISSES THIS. On 2026-09-06 the output
    // is identical either way, while the unanswerable count falls 108 -> 49:
    // 59 coverage gaps answered as "nothing is there" instead of "nobody
    // knows". That is the erasure #1658 is about, and comparing days alone
    // reports it as no difference at all.
    if no_declines.unanswerable.len() != replay.unanswerable.len() {
        eprintln!(
            "control: `declined` is LOAD-BEARING — without it {} gap(s) read as \
             empty answers rather than as unknowns",
            replay.unanswerable.len() - no_declines.unanswerable.len(),
        );
    }
    if no_declines_day == live_day {
        eprintln!(
            "control: stripping `declined` leaves the DAY unchanged on this one — \
             read the counts above, not this line"
        );
    } else {
        eprintln!(
            "control: stripping `declined` CHANGES the day — the list is load-bearing \
             ({} declined key(s), {} unanswerable without them against {} with)",
            n("declined"),
            no_declines.unanswerable.len(),
            replay.unanswerable.len(),
        );
    }

    // ── the whole fixture ────────────────────────────────────────────────────
    // `{meta, inputs, expected}`, the shape a golden day carries.
    //
    // ⚠ `expected.statesOut`, NOT under `tsArm`. A `tsArm` oracle was blessed
    // from the OTHER IMPLEMENTATION and no day captured since #975 can have
    // one; this is SELF-blessed — the pipeline's own output, frozen. It catches
    // a REGRESSION and cannot catch "it was always wrong". The ground-truth
    // narrative grades correctness, and the day must be named in
    // `corpus::day::SELF_BLESSED` to be accepted (#1660).
    //
    // ⚠ `meta.captureInputs` says what the capture was taken under. Without it
    // a fixture cannot notice the constants it depends on moving, and every
    // gate stays green while the served day differs (#1071, #328).
    let mut fixture_inputs = inputs.clone();
    if let Some(o) = fixture_inputs.as_object_mut() {
        o.insert("osmTrace".into(), doc["inputs"]["osmTrace"].clone());
        o.insert("osmRowSet".into(), row_set.clone());
    }
    let out = json!({
        "meta": {
            "fixtureFormatVersion": 1,
            "capturedAt": chrono::Utc::now().to_rfc3339(),
            "date": date,
            "user": user,
            "tz": home_tz,
            "description": "",
            "captureInputs": backend::osm_host::capture_inputs(),
        },
        "inputs": fixture_inputs,
        "expected": { "statesOut": live_day.get("states").cloned().unwrap_or(Value::Null) },
    });
    eprintln!(
        "fixture: inputs {} key(s) · expected.statesOut {} state(s) · stamp {}",
        out["inputs"].as_object().map_or(0, serde_json::Map::len),
        out["expected"]["statesOut"].as_array().map_or(0, Vec::len),
        backend::osm_host::capture_inputs(),
    );
    match args.get(3) {
        Some(path) => {
            std::fs::write(path, serde_json::to_string(&out)?)?;
            eprintln!("wrote {path}");
        }
        None => println!("{}", serde_json::to_string(&out)?),
    }
    Ok(())
}

//! Capture a live day's OSM callback answers as an `osmTrace`, so a recent day
//! can become a gate. The readers are in `day_shell::osm`.
//!
//! Only the sections the `@[extern]` callbacks answer (`walkableRoads`,
//! `buildingsNear`, `drivableRoads`) are captured. The answerer sections and
//! `osmRowSet` are not: a day built from this alone feeds the road and walk
//! matchers and misses every answerer lookup.
//!
//! It then reloads what it wrote, folds the day again and reports the hit
//! rate: under 100% means the key written is not the key the lookup forms, a
//! fixture that looks loaded and answers nothing.
//!
//! ```text
//! scripts/prod-db.sh cargo run --release --example capture_trace -- "$USER" 2026-09-15 /tmp/trace.json
//! ```

use anyhow::{Context, Result};
use backend::osm_trace::{Sections, TraceAnswerer};
use backend::rowset_answerer::RowSetAnswerer;
use serde_json::{Value, json};

/// Capture one day's OSM trace from the live database.
#[derive(clap::Parser)]
struct Args {
    user: String,
    date: String,
    /// write here instead of stdout
    out: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let Args {
        user,
        date,
        out: out_path,
    } = backend::argv::parse_or_exit();
    let (user, date) = (&user, &date);
    backend::lean::init().context("starting the Lean runtime")?;

    let cfg = backend::config::Config::from_env().context("reading configuration")?;
    let pool = backend::db::connect(&cfg.db.url())
        .await
        .context("connecting")?;
    let home_tz = backend::sync_state::home_tz(&pool, user).await?;
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

    // Through `fold_from_mirror_recording`, production's own entry point, which
    // reads the mirror on a blocking thread with a runtime handle.
    let now_ms = chrono::Utc::now().timestamp_millis();
    let (conv, row_set, mut trace, geocodes) = backend::mirror_source::fold_from_mirror_recording(
        pool.clone(),
        cap.clone(),
        inputs.clone(),
        now_ms,
    )
    .await
    .context("fold from the mirror")?;
    pool.close().await;
    let live_day: Value = serde_json::from_str(&conv.out).context("the live fold's reply")?;

    // `reverseGeocode` travels the row source, not the recording answerer;
    // merged here so the fixture carries the section as older ones do.
    if let (Some(section), Some(o)) = (geocodes, trace.as_object_mut()) {
        o.insert("reverseGeocode".into(), section);
    }
    let sections: Vec<(String, usize)> = trace
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| (k.clone(), v.as_object().map_or(0, serde_json::Map::len)))
        .collect();
    eprintln!(
        "captured {date}: {} ask(s), {} declined",
        conv.asks.len(),
        conv.declined().len(),
    );
    for (k, n) in &sections {
        eprintln!("  {k:<16} {n} key(s)");
    }

    // ── the proof ────────────────────────────────────────────────────────────
    // Reload what was written and fold the same day again; every callback must
    // hit. Non-emptiness first: an answer recorded as `[]` replays as a hit, so
    // a trace with zero buildings would read 100%.
    let mut empties: Vec<String> = Vec::new();
    let mut total_answers = 0usize;
    for (table, entries) in trace.as_object().into_iter().flatten() {
        let obj = entries.as_object().cloned().unwrap_or_default();
        // The callback sections hold row lists, `reverseGeocode` an object per
        // key; counting only arrays would call the geocodes empty.
        let filled = obj
            .values()
            .filter(|v| match v {
                Value::Array(a) => !a.is_empty(),
                Value::Null => false,
                _ => true,
            })
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
    let captured = TraceAnswerer::from_fixture(&doc, "<captured>", Sections::ALL)
        .map_err(|e| anyhow::anyhow!("reloading the capture: {e}"))?;
    // The trace is answered first, and this is what the corpus gate does
    // (`tests/corpus/mod.rs`): the matcher reads and the geocodes both come
    // from it, the row set answers the rest.
    let mut answerer2 =
        backend::lean::Chain(&captured, RowSetAnswerer::new(&row_set).context("row set")?);
    let replay = backend::fold::run_day(&cap, &inputs, &mut answerer2).context("replay")?;

    // Day equality, not key matching: the row set is a conversion, and one
    // that loses a field gives a well-formed, wrong fixture.
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
            "   live {} ask(s)/{} declined · replay {} ask(s)/{} declined",
            conv.asks.len(),
            conv.declined().len(),
            replay.asks.len(),
            replay.declined().len()
        );
    }
    let (hits, missed) = replay.osm_counts();
    let asked = hits + missed;
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
    // Replay with `declined` stripped. An identical day means the list is
    // inert for this day; a difference is what a fixture without it loses.
    let mut stripped = rs.clone();
    stripped.remove("declined");
    let stripped = Value::Object(stripped);
    // The same trace as the replay arm. `declined` is the axis under test, so
    // it must be the only thing that differs.
    let mut answerer3 = backend::lean::Chain(
        &captured,
        RowSetAnswerer::new(&stripped).context("row set")?,
    );
    let no_declines =
        backend::fold::run_day(&cap, &inputs, &mut answerer3).context("control replay")?;
    let (conv_declined, replay_declined, control_declined) = (
        conv.declined().len(),
        replay.declined().len(),
        no_declines.declined().len(),
    );
    let no_declines_day: Value =
        serde_json::from_str(&no_declines.out).context("the control reply")?;
    // The counts go out either way: a declined key is `unanswerable` (the
    // signal `routes::velocity` logs for a day built from defaults), an empty
    // answer claims nothing is there. Same day, different facts.
    eprintln!(
        "control: declined — live {} · replay {} · without `declined` {}",
        conv_declined, replay_declined, control_declined,
    );
    // Stripping `declined` can only turn an unknown into an empty answer, so
    // the control must have fewer unanswerable, never more; more means the arms
    // differ in something else. Compared with `cmp`: the counts are `usize`.
    match replay_declined.cmp(&control_declined) {
        std::cmp::Ordering::Greater => eprintln!(
            "control: `declined` is LOAD-BEARING — without it {} gap(s) read as \
             empty answers rather than as unknowns",
            replay_declined - control_declined,
        ),
        std::cmp::Ordering::Less => eprintln!(
            "⚠ control: stripping `declined` left {} FEWER gap(s) than the replay \
             has. That cannot happen from the decline list alone — the two arms \
             differ in something else and this control is not measuring what it says",
            control_declined - replay_declined,
        ),
        std::cmp::Ordering::Equal => {}
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
            control_declined,
            replay_declined,
        );
    }

    // ── the whole fixture ────────────────────────────────────────────────────
    // `{meta, inputs, expected}`. `expected.statesOut` is self-blessed: it
    // catches regressions, not "always wrong", so the day must be named in
    // `corpus::day::SELF_BLESSED`. `meta.captureInputs` records the constants
    // the capture was taken under, so a fixture notices them moving.
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
            "captureInputs": backend::osm_trace::capture_inputs(),
        },
        "inputs": fixture_inputs,
        "expected": { "statesOut": live_day.get("states").cloned().unwrap_or(Value::Null) },
    });
    eprintln!(
        "fixture: inputs {} key(s) · expected.statesOut {} state(s) · stamp {}",
        out["inputs"].as_object().map_or(0, serde_json::Map::len),
        out["expected"]["statesOut"].as_array().map_or(0, Vec::len),
        backend::osm_trace::capture_inputs(),
    );
    match &out_path {
        Some(path) => {
            std::fs::write(path, serde_json::to_string(&out)?)?;
            eprintln!("wrote {path}");
        }
        None => println!("{}", serde_json::to_string(&out)?),
    }
    Ok(())
}

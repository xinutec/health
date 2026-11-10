//! The ground-truth narratives, parsed by Lean, against blessed totals.
//!
//! `tests/golden/ground-truth/*.md` is the corpus's only truth signal that is
//! not self-referential: every other check compares the pipeline against itself
//! or its blessed output. The parser is `Verified.Eval.GroundTruth`.
//!
//! # The oracle is a handful of numbers, not a file
//!
//! Row, enforceable, unparseable, zone, journey and leg totals are asserted
//! below. They are not a fixture file because the narratives are gitignored
//! (`tests/golden/*`): they name clinics, hotels and homes, and these repos are
//! public. The directory's `README.md` has no `## Audit of` section and is
//! filtered by name, so a real narrative that stops producing rows fails here
//! rather than being excluded.
//!
//! ⚠ Unparseable is a count of rows, not of distinct shapes.
//!
//! ⚠ The numbers are a tripwire, not a cross-check: there is no second
//! implementation to re-derive them from. Edit a narrative and they move, which
//! is the point. Change a constant only with the narrative edit that caused it,
//! in the same commit, saying which rows moved and why; a constant nudged to
//! turn a red gate green destroys the only signal this file has.
//!
//! # Why the reply carries civil time
//!
//! Resolving a wall clock in a named zone needs the tz database, which is data.
//! Lean stops at the anchored `(day, hh, mm)` and `timezone.rs` resolves it, so
//! this test checks the anchoring, the part that is logic.
//!
//! # Local-only
//!
//! Announces a skip rather than passing quietly when the corpus is absent, and
//! prints counts only, never a place name.

use std::path::Path;

use serde_json::{Value, json};

const NARRATIVES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden/ground-truth"
);

/// Narratives outside the blessed totals, named rather than counted.
///
/// The totals below were blessed once over a fixed set of files and stay exact
/// over them; a narrative written since is listed here, so adding one is a
/// deliberate, named act that cannot dilute a blessed number. `head_corpus`
/// makes the same split for a day with no `tsArm`.
const POST_TS: &[&str] = &[
    // The coverage cliff, and two confirmed venue misnamings on ground that
    // was blank until the geocode fetch ran.
    "2026-09-06.md",
    // The Nonos day. It does not pin the raw-mode defect: the raw mode never
    // reaches `statesOut`.
    "2026-09-14.md",
    // The CONTROL: no known defects, which nothing else in the corpus offers.
    "2026-09-15.md",
    // The first day off the mirror's ground: the Eurostar to Paris, two zones,
    // the Channel Tunnel; one known miss (the St Pancras wait read as Work).
    "2026-09-30.md",
    "2026-10-01.md",
    "2026-10-02.md",
    // The second San Sebastián day: the beach and the park named by their
    // outlines (10-03's rules), two cafés and the dinner wrong for want of OSM.
    "2026-10-03.md",
    // The third: every row served right once the user fixed two venues in OSM.
    "2026-10-04.md",
    // The fourth: the bike-shop brunch the near-field hours rule fixed.
    "2026-10-05.md",
    // The fifth: every row served right live and confirmed row by row.
    "2026-10-06.md",
    // The sixth: the café stay the teleport referee was built on.
    "2026-10-07.md",
    // Home by train, Hendaye → Paris → London, a day heavy enough to have
    // run serving out of memory. The TGV's alight, a walk read as a drive and
    // a café not yet in OSM are known-wrong.
    "2026-10-08.md",
    // A lunch out, named for the shop next door and split by a walk with no
    // steps; the lunch row is known-wrong.
    "2026-10-15.md",
    // By tube to a hospital and the night there; the night before is served
    // only since the loader reads every main sleep of a date.
    "2026-10-17.md",
    // A café served by its place's amenity label; one row, known-wrong.
    "2026-10-25.md",
    // The same café on two earlier days, by the user's "always Urban Social
    // Coffee there"; one row each, known-wrong.
    "2026-07-12.md",
    "2026-08-08.md",
    // Narrated live: the café, Drury, the Vue and Chinatown; the three venues
    // the picker misnames are known-wrong.
    "2026-11-01.md",
    // Drury 188-189 on two afternoons the user named it in writing that
    // morning; one row each, served right.
    "2026-09-27.md",
    "2026-10-11.md",
    // One row each from what the user wrote that day in another session: a
    // café, a hospital, the office.
    "2026-05-17.md",
    "2026-07-19.md",
    "2026-07-31.md",
    "2026-08-14.md",
    "2026-08-25.md",
    "2026-10-20.md",
    "2026-10-27.md",
    // Two days from what the user wrote within a week: the Eurostar home
    // through Brussels, and a restaurant by Liverpool Street.
    "2026-05-10.md",
    "2026-05-16.md",
    // A day at the office the user said they never left; its walks out and the
    // stay at the change station are known-wrong.
    "2026-11-03.md",
];

/// The blessed totals over the files not in [`POST_TS`]. Each change since the
/// blessing is explained in the commit that made it (`git log -p` on this file).
const TS_FILES: usize = 31;
const TS_ROWS: usize = 443;
const TS_ENFORCEABLE: usize = 418;
const TS_UNPARSEABLE: usize = 4;
/// Narratives whose `Times:` is not London: 04-29 (Amsterdam), 05-10
/// (Brussels), 06-24 (UTC), and 10-02 to 10-07 (Madrid).
const TS_DECLARED_TZ: usize = 9;
/// `groundTruthJourneys` over the same corpus, same source, same day. A stay
/// the day boards a ride from is its wait, so the waits before rides belong to
/// their trips; the platform waits on 06-15, 06-17 and 06-18 are rows of their
/// own, each ride row starting at its boarding; 07-16's hospital visit ends
/// where its steps begin and the hop after it is a journey of its own.
const TS_JOURNEYS: usize = 91;
const TS_LEGS: usize = 248;
/// ⚠ THE HISTOGRAM, NOT JUST THE TOTAL. The leg total could be reached with the
/// modes shuffled — a `line` assigned to a walk, or `sleeping` failing to fold
/// to `stationary`, changes what a leg IS without changing how many there are.
const TS_LEG_MODES: [(&str, usize); 4] =
    [("bus", 3), ("driving", 6), ("train", 82), ("walking", 157)];

#[test]
fn the_narrative_corpus_matches_its_blessed_shape() {
    if !Path::new(NARRATIVES).is_dir() {
        eprintln!("SKIPPED: no narratives at {NARRATIVES}; see this file's header.");
        return;
    }
    let mut names: Vec<String> = std::fs::read_dir(NARRATIVES)
        .expect("narrative dir readable")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".md"))
        // Date-named narratives only — see the README note in the header.
        .filter(|n| n.len() == 13 && n.as_bytes()[0].is_ascii_digit())
        .collect();
    names.sort();

    let (mut rows, mut enforceable, mut unparseable, mut declared_tz) = (0, 0, 0, 0);
    let (mut journeys, mut legs) = (0usize, 0usize);
    let mut leg_modes: std::collections::BTreeMap<String, usize> =
        std::collections::BTreeMap::new();
    let mut failures: Vec<String> = Vec::new();

    for name in &names {
        // A narrative in `POST_TS` is checked as hard (it must parse, resolve
        // and anchor) but feeds none of the blessed totals.
        let ts_blessed = !POST_TS.contains(&name.as_str());
        let md = std::fs::read_to_string(format!("{NARRATIVES}/{name}"))
            .unwrap_or_else(|e| panic!("reading {name}: {e}"));
        let date = &name[..10];
        let req = json!({
            "mode": "groundtruth", "markdown": md, "date": date, "tz": "Europe/London",
        });
        let reply = backend::lean::serve(&req.to_string())
            .unwrap_or_else(|e| panic!("{name}: the parser must answer: {e:#}"));
        let r: Value = serde_json::from_str(&reply).expect("the reply parses");
        if let Some(e) = r.get("error") {
            failures.push(format!("{name}: parser refused: {e}"));
            continue;
        }
        if r["tz"].as_str() != Some("Europe/London") {
            declared_tz += 1;
        }
        let day_rows = r["rows"].as_array().map_or(&[][..], Vec::as_slice);
        // Lean stops at civil time and this resolves with chrono, which handles
        // DST ambiguity explicitly. `GT_DUMP_UNIX=1` prints `name start end`
        // per row, to check a resolution against another resolver.
        let zone = r["tz"].as_str().unwrap_or("Europe/London");
        let mut resolved: Vec<Value> = Vec::new();
        for row in day_rows {
            let stamp = |d: &Value, h: &Value, m: &Value| -> Option<i64> {
                backend::timezone::wall_clock_to_unix(
                    &format!("{} {:02}:{:02}:00", d.as_str()?, h.as_u64()?, m.as_u64()?),
                    zone,
                )
            };
            let a = stamp(&row["startDay"], &row["startHh"], &row["startMm"]);
            let b = stamp(&row["endDay"], &row["endHh"], &row["endMm"]);
            // Every anchored civil time must resolve. A `None` means the zone
            // was unknown or the clock malformed, and a window that silently
            // vanished would take its truth claim with it.
            match (a, b) {
                (Some(a), Some(b)) => {
                    if std::env::var("GT_DUMP_UNIX").is_ok() {
                        println!("{name} {a} {b}");
                    }
                    resolved.push(json!({
                        "startTs": a, "endTs": b,
                        "status": row["status"], "truth": row["truth"],
                    }));
                }
                _ => failures.push(format!(
                    "{name}: a row's civil time did not resolve in {zone}"
                )),
            }
        }

        // The ground-truth side of the decoder scoreboard. Rows go back to Lean
        // resolved; the zone conversion above is the only part of this chain
        // that is not logic.
        let jreq = json!({ "mode": "journeys", "rows": resolved });
        let jreply = backend::lean::serve(&jreq.to_string())
            .unwrap_or_else(|e| panic!("{name}: journeys must answer: {e:#}"));
        let jr: Value = serde_json::from_str(&jreply).expect("the journeys reply parses");
        if let Some(e) = jr.get("error") {
            failures.push(format!("{name}: journeys refused: {e}"));
        } else {
            for j in jr["journeys"].as_array().map_or(&[][..], Vec::as_slice) {
                if !ts_blessed {
                    continue;
                }
                journeys += 1;
                for leg in j["legs"].as_array().map_or(&[][..], Vec::as_slice) {
                    legs += 1;
                    if let Some(m) = leg["mode"].as_str() {
                        *leg_modes.entry(m.to_string()).or_insert(0usize) += 1;
                    }
                }
            }
        }
        if ts_blessed {
            rows += day_rows.len();
        }
        for row in day_rows {
            if !ts_blessed {
                // still anchored-checked below; just not counted
                let (sd, ed) = (row["startDay"].as_str(), row["endDay"].as_str());
                if let (Some(sd), Some(ed)) = (sd, ed)
                    && ed < sd
                {
                    failures.push(format!(
                        "{name}: a row ends on {ed}, before it starts on {sd}"
                    ));
                }
                continue;
            }
            if row["enforceable"].as_bool() == Some(true) {
                enforceable += 1;
            }
            if row["truth"].is_null() {
                unparseable += 1;
            }
            // Anchoring is what this test owns: an end day before its start day
            // is never right, and is what dropping the midnight-wrap rule
            // would produce.
            let (sd, ed) = (row["startDay"].as_str(), row["endDay"].as_str());
            if let (Some(sd), Some(ed)) = (sd, ed)
                && ed < sd
            {
                failures.push(format!(
                    "{name}: a row ends on {ed}, before it starts on {sd}"
                ));
            }
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert_eq!(
        names.len(),
        TS_FILES + POST_TS.len(),
        "narrative count moved — a new one must be NAMED in POST_TS, not absorbed"
    );
    for n in POST_TS {
        assert!(
            names.iter().any(|x| x == n),
            "{n} is named in POST_TS but is not in the corpus — remove it from the list"
        );
    }
    assert_eq!(
        rows, TS_ROWS,
        "row count moved — see this file's header before touching it"
    );
    assert_eq!(enforceable, TS_ENFORCEABLE, "enforceable-row count moved");
    assert_eq!(unparseable, TS_UNPARSEABLE, "unparseable-cell count moved");
    assert_eq!(declared_tz, TS_DECLARED_TZ, "declared-zone count moved");
    assert_eq!(journeys, TS_JOURNEYS, "journey count moved");
    assert_eq!(legs, TS_LEGS, "leg count moved");
    assert_eq!(
        leg_modes,
        TS_LEG_MODES
            .iter()
            .map(|(m, n)| ((*m).to_string(), *n))
            .collect::<std::collections::BTreeMap<_, _>>(),
        "the leg-mode histogram moved"
    );
    eprintln!(
        "ground truth: {} files, {rows} rows, {enforceable} enforceable, \
         {unparseable} unparseable, {declared_tz} declaring their own zone; \
         {journeys} journeys, {legs} legs",
        names.len()
    );
}

//! The ground-truth narratives, parsed by Lean, against what the TypeScript got.
//!
//! `tests/golden/ground-truth/*.md` is the only NON-SELF-REFERENTIAL truth
//! signal in the corpus: every other check compares the pipeline against itself
//! or against previously-blessed pipeline output. Its parser went with the
//! TypeScript (#975) and is ported in `Verified.Eval.GroundTruth` (#1290).
//!
//! # The oracle, and why it is three numbers rather than a file
//!
//! The original `src/eval/ground-truth.ts` was recovered at `06346bd^` and run
//! over these same 32 files on 2026-08-31. It produced:
//!
//!     31 narratives   395 rows   349 enforceable   5 unparseable truth cells
//!     2 declare their own zone (`Times:`) — one CEST, one UTC
//!
//! ⚠ THE DIRECTORY HOLDS 32 `.md` FILES, NOT 31. One is a `README.md` with no
//! `## Audit of` section, so it parses to zero rows in both implementations.
//! It is filtered by NAME here rather than by "produced no rows", because a
//! real narrative that silently stopped producing rows must fail this test, not
//! be quietly excluded by the same rule.
//!
//! Those totals are asserted below. They are NOT written to a fixture file
//! because the narratives are gitignored (`tests/golden/*`) and a checked-in
//! expectation derived from them would leak the same content the ignore exists
//! to keep out — the places are clinics, hotels and homes, and these repos are
//! public (#860).
//!
//! ⚠ THE UNPARSEABLE COUNT IS 5 ROWS, NOT 1 SHAPE, and getting that wrong is
//! the mistake this note exists to stop. A first pass at these constants read
//! "1" off a DISTINCT-SHAPE extraction — 105 distinct parse shapes over the 395
//! rows, of which `null` was one shape — and wrote it in as a row count. The
//! corpus caught it immediately. When re-deriving, count ROWS.
//!
//! ⚠ SO IF YOU EDIT A NARRATIVE, THESE NUMBERS MOVE and this test goes red. That
//! is correct and it is the whole point: the corpus is a fixture, and a row
//! appearing, vanishing or changing what it asserts must be DELIBERATE.
//!
//! ⚠ **THE NUMBERS ARE A TRIPWIRE, NOT A CROSS-CHECK.** There is no second
//! implementation to re-derive them from (Pippijn, 2026-09-20: "End TS
//! comparison everywhere"), so moving one is an assertion by whoever moves it.
//! Adjust a constant ONLY with the narrative edit that caused it, in the same
//! commit, and say in the message which rows moved and why. A constant nudged
//! on its own to make a red gate green destroys the only signal this file has.
//!
//! # Why the reply carries civil time
//!
//! Resolving a wall clock in a named zone needs the tz database, which is data
//! and IO. Lean stops at the anchored `(day, hh, mm)`; `timezone.rs` resolves
//! it. This test therefore checks the ANCHORING — the part that is logic — and
//! leaves the conversion to the code that owns it.
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

/// Measured by running the recovered TypeScript over this corpus, 2026-08-31.
/// Narratives written AFTER the TypeScript went (#975), NAMED rather than
/// counted.
///
/// ⚠ **The header above says to re-derive these numbers by re-running the
/// recovered TypeScript. That is no longer possible**, and pretending otherwise
/// would either freeze the corpus at its 2026-08-13 shape or quietly reduce the
/// constants to "whatever Lean now says", which is exactly what the header
/// forbids. So the TS-blessed counts below stay EXACT over the TS-era files,
/// and a narrative written since is listed here instead.
///
/// Listing rather than counting is the point: adding one is a deliberate act
/// with a name attached, and it cannot dilute a number a human blessed from the
/// other implementation. It is the same split `head_corpus` makes for a day
/// with no `tsArm` — the fourth place #975 blocked the corpus from growing.
const POST_TS: &[&str] = &[
    // The coverage cliff (#1658), and now two confirmed venue misnamings on
    // ground that was blank until #1076's fetch ran (#325).
    "2026-09-06.md",
    // The Nonos day (#325's freshest instance). ⚠ It does NOT pin #1659 — the
    // raw mode never reaches `statesOut`.
    "2026-09-14.md",
    // The CONTROL: no known defects, which nothing else in the corpus offers.
    "2026-09-15.md",
];

const TS_FILES: usize = 31;
const TS_ROWS: usize = 395;
const TS_ENFORCEABLE: usize = 367;
const TS_UNPARSEABLE: usize = 5;
const TS_DECLARED_TZ: usize = 2;
/// `groundTruthJourneys` over the same corpus, same source, same day.
const TS_JOURNEYS: usize = 91;
const TS_LEGS: usize = 227;
/// ⚠ THE HISTOGRAM, NOT JUST THE TOTAL. 228 legs could be reached with the
/// modes shuffled — a `line` assigned to a walk, or `sleeping` failing to fold
/// to `stationary`, changes what a leg IS without changing how many there are.
const TS_LEG_MODES: [(&str, usize); 4] =
    [("bus", 3), ("driving", 6), ("train", 76), ("walking", 142)];

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
        // ⚠ A POST-TS narrative is checked exactly as hard — it must parse, its
        // civil times must resolve, its rows must anchor — but it feeds NONE of
        // the TS-blessed totals, because no TypeScript ever read it.
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
        // ⚠ THE RESOLVER DIVERGENCE — MEASURED, NOT ASSUMED. Lean stops at
        // civil time; the original resolved through `fitbitTsToUnix` (an Intl
        // round-trip) and this uses chrono, which handles DST ambiguity
        // explicitly. They could disagree on a transition inside a narrated
        // window.
        //
        // They do not, here: all 790 instants (395 start+end pairs) were
        // resolved both ways on 2026-08-31 and agreed exactly. Re-check with
        // `GT_DUMP_UNIX=1`, which prints `name start end` per row, against the
        // recovered TypeScript — do not re-assume it.
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

        // The ground-truth side of the decoder scoreboard (#1048). Rows go back
        // to Lean RESOLVED — the zone conversion above is the only part of this
        // chain that is not logic.
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
            // ⚠ ANCHORING IS THE PART THIS TEST OWNS. An end day before its
            // start day is never right, and it is the failure the day cursor
            // would produce if the midnight-wrap rule were dropped.
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

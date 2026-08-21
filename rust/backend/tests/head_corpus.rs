//! The pipeline head against the frozen TypeScript head, on the real corpus.
//!
//! Each golden fixture carries BOTH halves of this comparison: `inputs` is what
//! the loader produced, and `expected.tsArm.capture.segsRaw` is what the
//! TypeScript head computed from exactly those inputs. So the whole chain —
//! quality filter, place-snap, Kalman, segmentation — checks against 42 real
//! days with no database, no Node, and no network (#982).
//!
//! ⚠ THE COMPARISON IS ON SERIALISED TEXT. `jq` and `Value` equality both parse
//! numbers to doubles, so `25.0 == 25` and a rendering difference reads as a
//! match. The loaders' first parity pass reported clean that way while three
//! fields were still wrong. `to_string()` on both sides is the instrument.
//!
//! # Why this test is local-only, and how it says so
//!
//! `tests/golden/days` is gitignored: the fixtures carry real coordinates,
//! place names and biometrics. It ANNOUNCES A SKIP rather than passing quietly
//! — a test that silently passes when its inputs are missing reports success
//! for having done nothing.

use std::path::Path;

use serde_json::Value;

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden/days");

/// The date a fixture is for. `2026-04-29-pippijn.json` → `2026-04-29`.
fn date_of(name: &str) -> &str {
    &name[..10]
}

#[test]
fn the_head_reproduces_the_typescript_segments_on_every_golden_day() {
    if !Path::new(GOLDEN).is_dir() {
        eprintln!("SKIPPED: no golden corpus at {GOLDEN}; see this file's header.");
        return;
    }

    let mut names: Vec<String> = std::fs::read_dir(GOLDEN)
        .expect("golden dir readable")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    assert!(!names.is_empty(), "the corpus directory is empty");

    let mut agreed = 0usize;
    let mut failures: Vec<String> = Vec::new();

    for name in &names {
        let text = std::fs::read_to_string(format!("{GOLDEN}/{name}"))
            .unwrap_or_else(|e| panic!("reading {name}: {e}"));
        let fixture: Value =
            serde_json::from_str(&text).unwrap_or_else(|e| panic!("parsing {name}: {e}"));

        let Some(want) = fixture.pointer("/expected/tsArm/capture/segsRaw") else {
            // NO ORACLE is a red verdict elsewhere; here it is a fixture the
            // head cannot be judged against, and saying so beats counting it.
            failures.push(format!("{name}: no frozen tsArm to compare against"));
            continue;
        };
        let inputs = fixture.get("inputs").unwrap_or_else(|| {
            panic!("{name} has no inputs");
        });

        let got = match backend::head::run(inputs, date_of(name)) {
            Ok(h) => h,
            Err(e) => {
                failures.push(format!("{name}: head failed: {e:#}"));
                continue;
            }
        };

        let got_text = Value::Array(got.segs_raw.clone()).to_string();
        let want_text = want.to_string();
        if got_text == want_text {
            agreed += 1;
        } else {
            failures.push(format!(
                "{name}: {} segments vs {} — first difference: {}",
                got.segs_raw.len(),
                want.as_array().map_or(0, Vec::len),
                first_difference(&got.segs_raw, want.as_array().map_or(&[], Vec::as_slice)),
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "{agreed}/{} days agree on segsRaw.\n{}",
        names.len(),
        failures.join("\n")
    );
    eprintln!("{agreed}/{} days agree on segsRaw", names.len());
}

/// The first segment index that differs, with both renderings.
///
/// Printing the whole array would bury the one row that moved under thousands
/// of identical ones, and printing only the index would not say which FIELD —
/// the mistake `compare-head.mts` records making.
fn first_difference(got: &[Value], want: &[Value]) -> String {
    for i in 0..got.len().max(want.len()) {
        let g = got.get(i).map(Value::to_string);
        let w = want.get(i).map(Value::to_string);
        if g != w {
            return format!(
                "seg {i}\n    rust {}\n    ts   {}",
                g.unwrap_or_else(|| "<missing>".into()),
                w.unwrap_or_else(|| "<missing>".into()),
            );
        }
    }
    "none — the arrays render identically but compared unequal".to_string()
}

/// The user a fixture is for. `2026-04-29-pippijn.json` → `pippijn`.
fn user_of(name: &str) -> &str {
    name[11..].trim_end_matches(".json")
}

#[test]
fn the_capture_the_fold_reads_matches_the_typescript_on_every_golden_day() {
    if !Path::new(GOLDEN).is_dir() {
        eprintln!("SKIPPED: no golden corpus at {GOLDEN}; see this file's header.");
        return;
    }

    let mut names: Vec<String> = std::fs::read_dir(GOLDEN)
        .expect("golden dir readable")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    names.sort();
    assert!(!names.is_empty(), "the corpus directory is empty");

    // Every field of the capture that `build_day_request` reads, except `obs`,
    // which is checked field by field below. `tzAt` and `bestPlace` are
    // deliberately absent: the TypeScript records the answers its own run
    // happened to ask for, a serving caller starts with none, and the converge
    // loop is what makes the two meet. Comparing them would assert the
    // recording, not the head.
    const EXACT: [&str; 3] = ["segsRaw", "modeStats", "tail"];
    // The observation tensor's other five arrays carry no computed float: they
    // are input rows re-shaped, so anything but bit-exact is a defect.
    const OBS_EXACT: [&str; 5] = ["rawFixes", "displayFixes", "steps", "hr", "sleep"];

    let mut failures: Vec<String> = Vec::new();
    let mut agreed = 0usize;
    let mut bands: Vec<String> = Vec::new();

    for name in &names {
        let text = std::fs::read_to_string(format!("{GOLDEN}/{name}"))
            .unwrap_or_else(|e| panic!("reading {name}: {e}"));
        let fixture: Value =
            serde_json::from_str(&text).unwrap_or_else(|e| panic!("parsing {name}: {e}"));
        let Some(want) = fixture.pointer("/expected/tsArm/capture") else {
            failures.push(format!("{name}: no frozen tsArm to compare against"));
            continue;
        };
        let inputs = fixture.get("inputs").expect("a fixture has inputs");

        let got = match backend::head::capture(inputs, date_of(name), user_of(name)) {
            Ok(c) => c,
            Err(e) => {
                failures.push(format!("{name}: capture failed: {e:#}"));
                continue;
            }
        };

        let before = failures.len();
        for f in EXACT {
            let g = got.get(f).map(Value::to_string).unwrap_or_default();
            let w = want.get(f).map(Value::to_string).unwrap_or_default();
            if g == w {
                continue;
            }
            match (
                got.get(f).and_then(Value::as_array),
                want.get(f).and_then(Value::as_array),
            ) {
                (Some(ga), Some(wa)) => {
                    failures.push(format!("{name}: {f} — {}", first_difference(ga, wa)));
                }
                _ => failures.push(format!("{name}: {f} — {}", object_difference(&g, &w))),
            }
        }
        for f in OBS_EXACT {
            let g = got.pointer(&format!("/obs/{f}")).map(Value::to_string);
            let w = want.pointer(&format!("/obs/{f}")).map(Value::to_string);
            if g != w {
                failures.push(format!(
                    "{name}: obs.{f} — {}",
                    object_difference(&g.unwrap_or_default(), &w.unwrap_or_default())
                ));
            }
        }
        match points_verdict(got.pointer("/obs/points"), want.pointer("/obs/points")) {
            Ok(band) => {
                if !band.is_empty() {
                    bands.push(format!("{name}: {band}"));
                }
            }
            Err(e) => failures.push(format!("{name}: obs.points — {e}")),
        }
        if failures.len() == before {
            agreed += 1;
        }
    }

    for b in &bands {
        eprintln!("  libm band  {b}");
    }
    assert!(
        failures.is_empty(),
        "{agreed}/{} days pass.\n{}",
        names.len(),
        failures.join("\n")
    );
    eprintln!(
        "{agreed}/{} days pass; {} within the documented libm band",
        names.len(),
        bands.len()
    );
}

/// The first byte at which two serialised objects diverge, with context.
///
/// `obs` is megabytes of coordinates; printing both sides whole says nothing.
/// The offset plus a window either way names the field.
fn object_difference(got: &str, want: &str) -> String {
    let at = got
        .bytes()
        .zip(want.bytes())
        .position(|(a, b)| a != b)
        .unwrap_or_else(|| got.len().min(want.len()));
    let from = at.saturating_sub(60);
    fn win(s: &str, from: usize, at: usize) -> &str {
        let end = (at + 60).min(s.len());
        s.get(from.min(s.len())..end)
            .unwrap_or("<not a char boundary>")
    }
    format!(
        "diverges at byte {at} of {} vs {}\n    rust …{}…\n    ts   …{}…",
        got.len(),
        want.len(),
        win(got, from, at),
        win(want, from, at)
    )
}

/// The widest `lon` gap that is still the libm band and not a second phenomenon.
///
/// Measured 2026-08-17 (#1020) in `lean/experiments/compare-kalman.mts` by
/// perturbing `Math.cos` by ±1 ULP on the TypeScript side and re-running: a
/// 1-ULP `cos` disagreement amplifies through the covariance recursion to
/// 1…75 ULP on `lon` over a day, widest on 2026-05-14 and 05-15. So a
/// double-digit gap is the documented band rather than a new defect.
///
/// ⚠ THE ROW-COUNT BOUND FROM THAT FILE IS DELIBERATELY NOT COPIED HERE.
/// It gates at "single digits of rows per day", a number justified against ITS
/// track: every window at the 200 m ceiling, ~1,340 rows for 2026-07-07. This
/// instrument's track is the in-day window after the quality filter and the
/// place-snap — 602 rows for the same day — and 10 differing rows out of 602 is
/// the same phenomenon at a smaller denominator, not a wider one. Carrying the
/// literal across would be the "written twice" mistake that file records
/// making, in the other direction.
const LON_ULP_MAX: i64 = 75;

/// The Kalman track, judged by the three criteria `compare-kalman.mts` names.
///
/// ⚠ THIS IS NOT A TOLERANCE, AND BIT-EXACTNESS IS NOT THE BAR. Nothing in the
/// smoother is quantised, `metersToDegreesLon` calls `cos`, and Lean's `cos`
/// and V8's disagree by 1 ULP on about 7.6% of real latitudes. A handful of
/// differing `lon` rows is the EXPECTED state of a correct port, measured over
/// this corpus at 6/35 bit-exact in the TypeScript harness. Demanding
/// bit-exactness here would make the test red on its healthy state, which is
/// how that harness came to be ignored (#1020).
///
/// What is still asserted, and why each is a genuine defect:
///   * row COUNTS agree — the arms kept the same fixes. A mismatch means they
///     disagreed about which fixes are REAL, not about the last bit of one.
///   * `ts` and `lat` are EXACT. `lat` is the control: it never calls `cos`, so
///     a `lat` difference cannot be the libm gap.
///   * the `lon` and `speedKmh` gaps stay inside the amplification band —
///     [`LON_ULP_MAX`]. `speedKmh` rides along because it is computed from the
///     same longitude. Measured over this corpus: `lon` ≤10 ULP on ≤10 rows of
///     a day, `speedKmh` ≤2 ULP on ≤2 rows, and 18 of the 42 days bit-exact.
///
/// Returns the band description for a day that differs, empty for one that does
/// not, and `Err` for a fault.
fn points_verdict(got: Option<&Value>, want: Option<&Value>) -> Result<String, String> {
    let empty: Vec<Value> = Vec::new();
    let g = got.and_then(Value::as_array).unwrap_or(&empty);
    let w = want.and_then(Value::as_array).unwrap_or(&empty);
    if g.len() != w.len() {
        return Err(format!(
            "kept a different NUMBER of fixes: {} vs {}",
            g.len(),
            w.len()
        ));
    }
    let mut n = std::collections::BTreeMap::<&str, usize>::new();
    let mut worst = std::collections::BTreeMap::<&str, i64>::new();
    for (a, b) in g.iter().zip(w) {
        for f in ["ts", "lat", "lon", "speedKmh"] {
            if a.get(f).map(Value::to_string) != b.get(f).map(Value::to_string) {
                *n.entry(f).or_default() += 1;
                if let (Some(x), Some(y)) = (
                    a.get(f).and_then(Value::as_f64),
                    b.get(f).and_then(Value::as_f64),
                ) {
                    let d = (x.to_bits() as i64 - y.to_bits() as i64).abs();
                    let e = worst.entry(f).or_default();
                    *e = (*e).max(d);
                }
            }
        }
    }
    for control in ["ts", "lat"] {
        if let Some(c) = n.get(control) {
            return Err(format!(
                "differs in {control}, a control field that never calls `cos`, on {c} row(s)"
            ));
        }
    }
    for wide in ["lon", "speedKmh"] {
        let d = worst.get(wide).copied().unwrap_or(0);
        if d > LON_ULP_MAX {
            return Err(format!(
                "differs in {wide} by {d} ULP, past the {LON_ULP_MAX} the amplification band \
                 accounts for — that is no longer a `cos` disagreement"
            ));
        }
    }
    if n.is_empty() {
        return Ok(String::new());
    }
    Ok(n.iter()
        .map(|(f, c)| {
            format!(
                "{f} {c}/{} (<={}ulp)",
                g.len(),
                worst.get(f).copied().unwrap_or(0)
            )
        })
        .collect::<Vec<_>>()
        .join(" "))
}

/// Where `lean/experiments/battery-oracle.mts` wrote the TypeScript answer.
fn battery_oracle() -> String {
    std::env::var("BATTERY_ORACLE").unwrap_or_else(|_| "/tmp/battery-ts.json".to_string())
}

/// The battery chart series, against the TypeScript that builds it today.
///
/// ⚠ THE ONLY PIECE OF THE HEAD WITH NO ORACLE IN THE FIXTURE. `computeVelocity`
/// builds the chart BESIDE the fold rather than inside it, so no day request
/// carries it and `expected.tsArm.capture` has nowhere to have frozen it. The
/// oracle is produced on demand instead:
///
/// ```text
/// npx tsx lean/experiments/battery-oracle.mts
/// ```
///
/// The algorithm itself is already pinned — `Verified.Geo.Velocity.batterySeries`
/// and `appendBatteryTail` are `#guard`ed against the Node references, and the
/// gate runs `velocity-refs.mts` every verify. What this checks is the part that
/// is new in Rust: WHICH rows are handed over, that a missing `battery` field
/// and an explicit `null` both arrive as no-reading, and that the cross-day tail
/// and day end reach the call.
#[test]
fn the_battery_trace_matches_the_typescript() {
    let oracle = battery_oracle();
    if !Path::new(GOLDEN).is_dir() || !Path::new(&oracle).is_file() {
        eprintln!(
            "SKIPPED: needs the corpus at {GOLDEN} and the oracle at {oracle} \
             (npx tsx lean/experiments/battery-oracle.mts)."
        );
        return;
    }
    let want: Value =
        serde_json::from_str(&std::fs::read_to_string(&oracle).expect("the oracle file reads"))
            .expect("the oracle parses");
    let days = want.as_object().expect("the oracle is an object");
    assert!(!days.is_empty(), "the oracle is empty");

    let mut agreed = 0usize;
    let mut failures: Vec<String> = Vec::new();
    for (name, series) in days {
        let text = std::fs::read_to_string(format!("{GOLDEN}/{name}"))
            .unwrap_or_else(|e| panic!("reading {name}: {e}"));
        let fx: Value = serde_json::from_str(&text).expect("a fixture parses");
        let got = match backend::head::run(&fx["inputs"], date_of(name)) {
            Ok(h) => h,
            Err(e) => {
                failures.push(format!("{name}: head: {e:#}"));
                continue;
            }
        };
        let rows: Vec<Value> = got
            .battery
            .iter()
            .map(|(ts, lvl)| serde_json::json!([ts, lvl]))
            .collect();
        let got_text = serde_json::to_string(&rows).expect("the rows serialise");
        let want_text = series.to_string();
        if got_text == want_text {
            agreed += 1;
        } else {
            failures.push(format!(
                "{name}: {}",
                first_difference(&rows, series.as_array().map_or(&[], Vec::as_slice))
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{agreed}/{} days agree on the battery trace.\n{}",
        days.len(),
        failures.join("\n")
    );
    eprintln!("{agreed}/{} days agree on the battery trace", days.len());
}

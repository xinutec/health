//! Two-hop reachability for the Lean mode table (#1003).
//!
//! # The gap this closes
//!
//! A `ServeEntry` mode can be dispatched and exercised by nothing, and every
//! check we had passed anyway. `lean_serve.rs` asks whether `dispatch` still
//! routes to a mode — it does that by asking the mode a question, so it passes
//! while no production or test code anywhere calls it. A caller-side test like
//! `walk_gate.rs` asks the other half, and passes if the arm and its one caller
//! are renamed together. Neither sees a mode that is wired and dead, which is
//! how `gpsoutliers` sat dispatched with nothing executing it.
//!
//! So: two hops, and both must hold.
//!
//!   1. **`dispatch` routes to it** — read off the table's own arms in
//!      `lean/ServeEntry.lean`, which is the source of truth rather than a copy.
//!   2. **Something executes it** — recorded by `backend::lean::serve`, the one
//!      function every caller funnels through, when the run sets
//!      `HEALTH_MODE_TRACE`. By EXECUTION and not by grep: several callers build
//!      the mode from a parameter, so no scan of the source can see them.
//!
//! ⚠ AND HOP 1'S OWN PROBE MUST NOT SATISFY HOP 2 — see `PROBES`. That is the
//! whole difference between this check and the one that already exists.
//!
//! # What "no caller" means here, exactly
//!
//! This asks about the ARM, not about the handler behind it. `cliMain` reaches
//! `railMain`, `geoMain`, `coverageResult` and others straight from `argv`
//! WITHOUT going through `dispatch`, so a mode can have a thoroughly exercised
//! handler and a dead arm at the same time. That is a real finding rather than
//! a blind spot — an arm nothing routes to is dead weight whatever else calls
//! the function — but the reason field has to say which of the two it is, or a
//! reader will take "no caller" for "no user".
//!
//! ⚠ AND THE TRACE SEES WHAT THE GATE RUNS. A mode reached only by the serving
//! binary on a path no test covers reads as dead here. That is also worth
//! knowing, and it is also not the same thing as nothing calling it — again,
//! the reason field carries the difference.
//!
//! # Why the exception list is checked in both directions
//!
//! `noop`, `echo`, `gqdecode`, `daydecode` and `dayresp` are ablation modes that
//! must NEVER have a caller — they exist to be subtracted from a real one. So
//! the check cannot be a bare gate; it needs a list of modes allowed to have no
//! caller, and a list like that is a baseline that rots.
//!
//! It is held exact instead, which is the whole design. An entry whose mode has
//! GAINED a caller fails, so the list cannot quietly grow stale. An entry naming
//! a mode the table no longer dispatches fails, so a deleted arm cannot leave
//! its excuse behind. The list can only be right or red.
//!
//! ⚠ AND THE TWO KINDS OF EXCUSE MEAN OPPOSITE THINGS WHEN THEY BREAK, so the
//! file names which one each line is. An `ablation` mode gaining a caller is a
//! DEFECT — something in the tree is calling `noop` or `echo` as if it computed
//! something. A `dead` mode gaining one is the repair this task wants, and the
//! line just has to go. Both are red, because both mean the file is now wrong;
//! a reader of the failure should not have to guess which they are looking at.
//!
//! `dead` is a grandfathered count, in the same discipline as the dev-lint
//! baseline this repository already carries: it ratchets DOWN. Nothing may be
//! added to it without a caller being removed, and the check cannot tell the
//! difference — that part is a review question, which is why the reason field
//! is not optional.
//!
//! # Running it
//!
//! Not a `#[test]`: it must see the whole run's trace, and `cargo nextest` runs
//! test-per-process with no ordering between them. It is a gate row after the
//! two test rows, which set `HEALTH_MODE_TRACE`.
//!
//!     rm -f rust/target/mode-trace.txt
//!     HEALTH_MODE_TRACE=1 cargo nextest run --manifest-path rust/Cargo.toml --workspace …
//!     cargo run --release --manifest-path rust/Cargo.toml -p backend --example mode_reachability

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

/// This crate's directory, so the three inputs are found from the repository
/// rather than from whatever directory the row happens to run in.
fn at(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
}

/// The modes `dispatch` routes to, read off its arms.
///
/// The arms are `| .ok "<mode>" => …`, one per line, and that shape is what
/// makes the table readable as data. A mode reached any other way would be
/// missed here — and would then surface as an untracked mode in the trace,
/// which is the fourth check below.
fn dispatched(src: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for line in src.lines() {
        let t = line.trim();
        let Some(rest) = t.strip_prefix("| .ok \"") else {
            continue;
        };
        let Some(end) = rest.find('"') else { continue };
        if rest[end..]
            .trim_start_matches('"')
            .trim_start()
            .starts_with("=>")
        {
            out.insert(rest[..end].to_owned());
        }
    }
    out
}

/// Binaries whose calls do NOT count as a caller.
///
/// ⚠ WITHOUT THIS THE TWO HOPS COLLAPSE INTO ONE. `lean_serve` is the hop-1
/// probe: it asks eight modes a question for the sole purpose of proving that
/// `dispatch` still routes to them, and it is deliberately indifferent to the
/// answer — several of its cases assert only that the mode failed in its OWN
/// words. If its calls counted as use, every mode it probes would read as
/// exercised and this check would assert exactly what `lean_serve` already
/// asserts. It also asks for `nope`, which is not a mode at all.
///
/// The test binary, not the test: a file whose whole purpose is probing.
const PROBES: &[&str] = &["lean_serve"];

/// Mode -> the binaries that asked for it, from the run's trace.
fn exercised(trace: &str) -> BTreeMap<String, BTreeSet<String>> {
    let mut out: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for line in trace.lines() {
        let mut f = line.splitn(2, '\t');
        let (Some(mode), Some(who)) = (f.next(), f.next()) else {
            continue;
        };
        if mode.is_empty() {
            continue;
        }
        // `who` is the test binary's file name, which cargo suffixes with a
        // hash — `lean_serve-1a2b3c4d`. Match the stem.
        if PROBES
            .iter()
            .any(|p| who == *p || who.starts_with(&format!("{p}-")))
        {
            continue;
        }
        out.entry(mode.to_owned())
            .or_default()
            .insert(who.to_owned());
    }
    out
}

/// What an excused mode is excused AS.
///
/// The kinds exist because a caller appearing means OPPOSITE things. On
/// `Ablation` and `Bless` it is a defect — a gate run that reaches them is
/// measuring an empty reply or rewriting its own oracle. On `Dead` it is the
/// repair this task wants, and the only thing left to do is delete the line.
/// Both are red, because both mean this file is now wrong; a reader of the
/// failure should not have to work out which they are looking at.
#[derive(PartialEq, Eq)]
enum Kind {
    /// Exists to be subtracted from a real mode. A caller here is a defect.
    Ablation,
    /// Reached only under a bless env var a gate must not set. Caller = defect.
    Bless,
    /// Has no caller and should have one. Grandfathered; ratchets down.
    Dead,
}

/// Mode -> why it is allowed to have no caller.
fn baseline(src: &str, path: &std::path::Path) -> BTreeMap<String, (Kind, String)> {
    let mut out = BTreeMap::new();
    for (n, line) in src.lines().enumerate() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let f: Vec<_> = t.splitn(3, '\t').map(str::trim).collect();
        let [mode, kind, why] = f[..] else {
            panic!(
                "{}:{}: want `mode<TAB>kind<TAB>reason`, got {t:?}",
                path.display(),
                n + 1
            )
        };
        let kind = match kind {
            "ablation" => Kind::Ablation,
            "bless" => Kind::Bless,
            "dead" => Kind::Dead,
            other => panic!(
                "{}:{}: kind must be `ablation`, `bless` or `dead`, got {other:?}",
                path.display(),
                n + 1
            ),
        };
        assert!(
            !why.is_empty(),
            "{}:{}: the reason is not optional",
            path.display(),
            n + 1
        );
        out.insert(mode.to_owned(), (kind, why.to_owned()));
    }
    out
}

fn main() {
    let serve_entry = at("../../lean/ServeEntry.lean");
    let trace_path = at("../target/mode-trace.txt");
    let baseline_path = at("tests/fixtures/mode-reachability.txt");

    let src = std::fs::read_to_string(&serve_entry)
        .unwrap_or_else(|e| panic!("read {}: {e}", serve_entry.display()));
    let base_src = std::fs::read_to_string(&baseline_path)
        .unwrap_or_else(|e| panic!("read {}: {e}", baseline_path.display()));

    // ⚠ FAIL CLOSED ON AN ABSENT TRACE. With no file every mode reads as
    // "exercised by nothing", which is a red gate for the wrong reason — and
    // with an EMPTY one the check would be judging a run that never happened.
    // Either way the answer is "this row ran out of order", not a verdict.
    let Ok(trace_src) = std::fs::read_to_string(&trace_path) else {
        eprintln!(
            "no trace at {}\n\nThis row must run AFTER the test rows, and those \
             rows must set HEALTH_MODE_TRACE. Nothing is judged.",
            trace_path.display()
        );
        std::process::exit(2);
    };

    let dispatched = dispatched(&src);
    let exercised = exercised(&trace_src);
    let baseline = baseline(&base_src, &baseline_path);

    assert!(
        !dispatched.is_empty(),
        "no arms parsed out of {}",
        serve_entry.display()
    );
    if exercised.is_empty() {
        eprintln!("the trace is empty; nothing is judged");
        std::process::exit(2);
    }

    let mut dead = Vec::new();
    let mut stale = Vec::new();
    let mut orphan_excuse = Vec::new();
    let mut untabled = Vec::new();

    for mode in &dispatched {
        let has_caller = exercised.contains_key(mode);
        let excused = baseline.contains_key(mode);
        if !has_caller && !excused {
            dead.push(mode.clone());
        }
        if has_caller && excused {
            let who: Vec<_> = exercised[mode].iter().cloned().collect();
            let (kind, _) = &baseline[mode];
            let verdict = match kind {
                // Opposite readings, so the line says which it is rather than
                // leaving the reader to infer it from the mode name.
                Kind::Ablation => "AN ABLATION MODE WITH A CALLER, which is a defect",
                Kind::Bless => "A BLESS MODE REACHED BY A GATE RUN, which rewrites an oracle",
                Kind::Dead => "repaired, so the excuse must go",
            };
            stale.push(format!("{mode} — {verdict} (called by {})", who.join(", ")));
        }
    }
    for mode in baseline.keys() {
        if !dispatched.contains(mode) {
            orphan_excuse.push(mode.clone());
        }
    }
    for mode in exercised.keys() {
        if !dispatched.contains(mode) {
            untabled.push(mode.clone());
        }
    }

    let called = dispatched
        .iter()
        .filter(|m| exercised.contains_key(*m))
        .count();
    let dead_count = baseline.values().filter(|(k, _)| *k == Kind::Dead).count();
    println!(
        "{} modes dispatched · {called} executed · {} by design · {dead_count} dead",
        dispatched.len(),
        baseline.len() - dead_count
    );

    let mut red = false;
    if !dead.is_empty() {
        red = true;
        eprintln!(
            "\n{} mode(s) dispatched and executed by NOTHING:\n  {}\n\n\
             Give it a caller, or add it to {} with the reason it must not have \
             one.",
            dead.len(),
            dead.join("\n  "),
            baseline_path.display()
        );
    }
    if !stale.is_empty() {
        red = true;
        eprintln!(
            "\n{} excused mode(s) now have a caller:\n  {}",
            stale.len(),
            stale.join("\n  ")
        );
    }
    if !orphan_excuse.is_empty() {
        red = true;
        eprintln!(
            "\n{} excuse(s) name a mode the table no longer dispatches:\n  {}",
            orphan_excuse.len(),
            orphan_excuse.join("\n  ")
        );
    }
    if !untabled.is_empty() {
        red = true;
        eprintln!(
            "\n{} mode(s) were executed but are in no arm this reads:\n  {}\n\n\
             Either the arm is written in a shape `dispatched` cannot see, or a \
             caller is asking for a mode that no longer exists.",
            untabled.len(),
            untabled.join("\n  ")
        );
    }

    if red {
        std::process::exit(1);
    }
    println!("every dispatched mode is executed or excused");
}

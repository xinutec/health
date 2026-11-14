//! Two-hop reachability for the Lean mode table: a `ServeEntry` mode must be
//! both dispatched and executed by something.
//!
//!   1. `dispatch` routes to it — read off the arms in `lean/ServeEntry.lean`.
//!   2. Something executes it — recorded by `backend::lean::serve` when the run
//!      sets `HEALTH_MODE_TRACE`. By execution, not grep: several callers build
//!      the mode name from a parameter.
//!
//! `lean_serve.rs` checks hop 1 by calling each mode, so its calls must not
//! count for hop 2 (see `PROBES`); a caller-side test alone passes when the arm
//! and its one caller are renamed together.
//!
//! "No caller" is about the arm, not the handler: `cliMain` reaches some
//! handlers straight from `argv`, and a path only the serving binary takes
//! reads as dead here. The reason field says which case an entry is.
//!
//! The exception list is held exact in both directions: an entry whose mode
//! gained a caller fails, and so does one naming a mode no longer dispatched.
//! `dead` entries ratchet down like the dev-lint baseline.
//!
//! Not a `#[test]`: it needs the whole run's trace, and nextest runs one
//! process per test. It is a gate row after the two test rows:
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

/// The modes `dispatch` routes to, read off its `| .ok "<mode>" => …` arms. A
/// mode reached another way shows up as an untracked mode in the trace.
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

/// Binaries whose calls do not count as a caller. `lean_serve` probes modes
/// only to prove `dispatch` routes to them, indifferent to the answer; counting
/// it would collapse the two hops into one.
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

/// What an excused mode is excused as. A caller appearing is a defect on
/// `Ablation` and `Bless` (a gate measuring an empty reply or rewriting its own
/// oracle) and the wanted repair on `Dead`; both fail so the line is fixed.
#[derive(PartialEq, Eq, Clone, Copy)]
enum Kind {
    /// Exists to be subtracted from a real mode. A caller here is a defect.
    Ablation,
    /// Reached only under a bless env var a gate must not set. Caller = defect.
    Bless,
    /// Kept with no caller expected: `cliMain` reaches the handler from argv, and
    /// this arm is the only way a linked host can call it. Not debt.
    Spare,
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
            "spare" => Kind::Spare,
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

    // Fail closed on an absent or empty trace: it means this row ran out of
    // order, not that every mode is dead.
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
                Kind::Spare => "a spare gained a caller — good, but the line must go",
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
    let count_of = |k: Kind| baseline.values().filter(|(b, _)| *b == k).count();
    let (dead_count, spare) = (count_of(Kind::Dead), count_of(Kind::Spare));
    println!(
        "{} modes dispatched · {called} executed · {} by design · {spare} spare · {dead_count} dead",
        dispatched.len(),
        baseline.len() - dead_count - spare
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

//! Link the Lean fold into this binary.
//!
//! # The link line is READ, never restated
//!
//! Lean's own link line is nine libraries plus two nix store paths that move on
//! every `nix flake update`. Copying it here would be a second copy of a thing
//! that drifts silently — the exact defect `scripts/day-gate-smoke.sh` was
//! written twice to avoid, where a guessed layout made a check reach nothing and
//! pass. So this parses `verified_cli.rsp`, which lake WROTE when it linked the
//! real binary: whatever links the CLI links this.
//!
//! The `.rsp` lists the object files first and the flags after. The objects are
//! dropped — we link the static libs instead, which is the same code with an
//! archive index — and everything else passes through untouched.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Build the Lean archives, rather than hoping somebody already did.
///
/// ⚠ THIS IS THE SEGFAULT FIX, and it is structural rather than a check.
/// `ServeEntry`, `DayEntry` and `BackendEntry` all import `Verified`, and each
/// archive bakes in the field offsets of the datatypes it was compiled against.
/// Link a rebuilt `Verified.a` beside a stale `ServeEntry.a` and one archive
/// CONSTRUCTS a `DayState` with the old field count while the other READS a
/// field that object does not have — Lean's constructor access runs off the end
/// of the object. Two `clip_inferred` tests died exactly that way on
/// 2026-09-11, and the symptom reads as a bug in whatever changed.
///
/// ⚠ MEASURED, so the cheaper fixes can be ruled out rather than dismissed:
/// the four archives share ZERO defined symbols, so this is not a
/// duplicate-symbol problem the linker could be asked to resolve. And neither
/// mtime test works — comparing archives against the sources is fooled by a
/// `git checkout` (which gives old sources NEW mtimes), and comparing the
/// archives against EACH OTHER false-positives, because lake correctly leaves
/// an archive alone when its own sources have not moved.
///
/// The only sound statement of the invariant is "each archive is up to date
/// with respect to its own sources", and that is precisely what lake computes.
/// So the consumer builds its inputs and an unbuilt state never reaches the
/// linker. A no-op costs about a second; the alternative costs a corrupted heap.
///
/// ⚠ ALL FOUR, from EITHER crate, even though day-shell links only two. The set
/// is the superset the flake names, so building the smaller set here would let
/// `cargo build -p day-shell` leave `ServeEntry.a` stale for a later
/// `-p backend` link. The whole point is that no invocation can leave a hole.
///
/// ⚠ Works inside the nix sandbox: `health-bins` already has `pkgs.lean4` in
/// `nativeBuildInputs` and runs this same command in its `buildPhase`, so this
/// is an incremental no-op there rather than a second build.
fn build_lean_archives(lean_dir: &Path) {
    let targets = [
        "verified_cli",
        "BackendEntry:static",
        "ServeEntry:static",
        "DayEntry:static",
        "Verified:static",
    ];
    let out = Command::new("lake")
        .arg("build")
        .args(targets)
        .current_dir(lean_dir)
        .output()
        .unwrap_or_else(|e| {
            panic!(
                "could not run `lake` in {}: {e}\n\
                 The Lean archives cannot be built, and linking whatever is on \
                 disk is how a stale archive corrupts the heap. Enter the dev \
                 shell (`nix develop`) or put lake on PATH.",
                lean_dir.display()
            )
        });
    if !out.status.success() {
        panic!(
            "lake build failed in {}:\n{}\n{}",
            lean_dir.display(),
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }
}

fn main() {
    let lean_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../lean");
    build_lean_archives(&lean_dir);
    let build = lean_dir.join(".lake/build");
    let rsp = build.join("bin/verified_cli.rsp");

    // Both static libs and the rsp come from lake, and a stale or absent one is
    // the difference between "this host is wrong" and "this host was never
    // built". Say which, rather than letting the linker say neither.
    let libs = [
        build.join("lib/libverified_DayEntry.a"),
        build.join("lib/libverified_Verified.a"),
    ];
    for p in libs.iter().chain(std::iter::once(&rsp)) {
        if !p.exists() {
            panic!(
                "missing {}\n\
				 Build the Lean side first:\n    \
				 cd lean && lake build verified_cli DayEntry:static Verified:static",
                p.display()
            );
        }
    }

    let text = std::fs::read_to_string(&rsp).expect("read verified_cli.rsp");
    let toks: Vec<String> = text
        .split_whitespace()
        .map(|t| t.trim_matches('"').to_string())
        .filter(|t| !t.is_empty())
        // The compiled modules. We take them from the archives instead, so that
        // the linker drops what the host does not reach.
        .filter(|t| !t.ends_with(".o.export") && !t.ends_with(".o"))
        // ⚠ THE STUB, WHICH IS THE ONE THING IN THE RSP THIS BINARY MUST NOT
        // HAVE. `c/osm-host-stub.c` answers `DayEntry.OsmHost`'s externs with
        // zero polylines so that the SPAWNED CLI keeps its shell behaviour. A
        // host that linked it would resolve those symbols to the empty answer
        // and never call its own — and, exactly like the duplicate `_main`, it
        // would build, run and print well-formed JSON while doing so.
        //
        // Caught by noticing the host linked when it should not have: the
        // externs were unresolved, and the rsp quietly resolved them.
        .filter(|t| !t.contains("libosmhoststub"))
        .collect();

    // Ours FIRST: a static archive only satisfies symbols already undefined when
    // the linker reaches it, so the Lean runtime has to come after the code that
    // calls it.
    for l in &libs {
        println!("cargo:rustc-link-arg={}", l.display());
    }
    for t in &toks {
        println!("cargo:rustc-link-arg={t}");
    }

    // `lean.h` — the shim includes it, and the prefix is asked for rather than
    // derived from the store path in the rsp, because `--print-prefix` is the
    // question we actually mean.
    let prefix = Command::new("lean")
        .arg("--print-prefix")
        .output()
        .expect("run `lean --print-prefix` (is the dev shell active?)");
    let prefix = String::from_utf8(prefix.stdout)
        .expect("utf8")
        .trim()
        .to_string();

    cc::Build::new()
        .file("src/shim.c")
        .include(Path::new(&prefix).join("include"))
        .compile("health_shell");

    // ⚠ THE LEAN SOURCES, NOT JUST THE ARCHIVES. Without these, cargo reruns this
    // script only when an ARCHIVE changes — so editing a `.lean` file and
    // building would skip the script entirely, lake would never run, and the
    // stale archive would link exactly as before. The rebuild above is useless
    // unless something makes cargo ASK for it.
    //
    // ⚠ `.lake/` is deliberately NOT watched: it is lake's own output, this
    // script writes into it, and watching it would make every build dirty the
    // next one.
    for src in [
        "Verified",
        "DayEntry",
        "BackendEntry.lean",
        "ServeEntry.lean",
        "DayEntry.lean",
        "Verified.lean",
        "lakefile.lean",
    ] {
        println!("cargo:rerun-if-changed={}", lean_dir.join(src).display());
    }
    println!("cargo:rerun-if-changed=src/shim.c");
    println!("cargo:rerun-if-changed={}", rsp.display());
    for l in &libs {
        println!("cargo:rerun-if-changed={}", l.display());
    }
}

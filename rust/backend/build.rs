//! Link the Lean decisions into the backend binary.
//!
//! A near-copy of `rust/day-shell/build.rs`, and the duplication is deliberate
//! rather than overlooked: the two differ in WHICH static libs they take
//! (`BackendEntry` here, `DayEntry` there) and in whether the OSM stub must be
//! filtered out. Factoring them into a shared build script would need a fourth
//! crate whose only job is to be included by two build scripts, and the shared
//! part is the twenty lines that parse the `.rsp`.
//!
//! # The link line is READ, never restated
//!
//! Lean's own link line is nine libraries plus two nix store paths that move on
//! every `nix flake update`. This parses `verified_cli.rsp` — the file lake
//! WROTE when it linked the real binary — so whatever links the CLI links this.
//! The `.rsp` lists object files first and flags after; the objects are dropped
//! because the static archives carry the same code with an index, and the
//! linker can then discard what this binary does not reach.

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

    let libs = [
        build.join("lib/libverified_BackendEntry.a"),
        // The algorithm mode table (#982) and the day fold it imports.
        build.join("lib/libverified_ServeEntry.a"),
        build.join("lib/libverified_DayEntry.a"),
        build.join("lib/libverified_Verified.a"),
    ];
    // A stale or absent input is the difference between "this backend is wrong"
    // and "the Lean side was never built". Say which, rather than letting the
    // linker say neither.
    for p in libs.iter().chain(std::iter::once(&rsp)) {
        if !p.exists() {
            panic!(
                "missing {}\n\
                 Build the Lean side first:\n    \
                 cd lean && lake build verified_cli BackendEntry:static ServeEntry:static DayEntry:static Verified:static",
                p.display()
            );
        }
    }

    let text = std::fs::read_to_string(&rsp).expect("read verified_cli.rsp");
    let toks: Vec<String> = text
        .split_whitespace()
        .map(|t| t.trim_matches('"').to_string())
        .filter(|t| !t.is_empty())
        .filter(|t| !t.ends_with(".o.export") && !t.ends_with(".o"))
        // ⚠ THE STUB MUST NOT COME IN. It answers `DayEntry.OsmHost`'s externs
        // with zero polylines, and this binary DOES link `DayEntry` now, so
        // taking it would give a decode that draws no map and reports success.
        // The real implementations come from the `day-shell` crate, whose
        // `#[unsafe(no_mangle)]` symbols satisfy the same externs.
        .filter(|t| !t.contains("libosmhoststub"))
        .collect();

    // Ours FIRST: a static archive only satisfies symbols already undefined
    // when the linker reaches it, so the Lean runtime comes after the code that
    // calls into it.
    for l in &libs {
        println!("cargo:rustc-link-arg={}", l.display());
    }
    for t in &toks {
        println!("cargo:rustc-link-arg={t}");
    }

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
        .compile("health_backend_shim");

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

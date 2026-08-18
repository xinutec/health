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

fn main() {
    let lean_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../lean");
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

    println!("cargo:rerun-if-changed=src/shim.c");
    println!("cargo:rerun-if-changed={}", rsp.display());
    for l in &libs {
        println!("cargo:rerun-if-changed={}", l.display());
    }
}

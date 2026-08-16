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

fn main() {
    let lean_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../lean");
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

    println!("cargo:rerun-if-changed=src/shim.c");
    println!("cargo:rerun-if-changed={}", rsp.display());
    for l in &libs {
        println!("cargo:rerun-if-changed={}", l.display());
    }
}

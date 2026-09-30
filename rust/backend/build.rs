//! Build `verified_cli`, and tell the crate where it is.
//!
//! The backend does not link Lean; it spawns `verified_cli serve` and talks to
//! it over a pipe (`src/lean_worker.rs`, #1709). What this script does is keep
//! the dev tree honest: a `cargo build` after a `.lean` edit rebuilds the
//! binary the tests will spawn, so a test cannot run yesterday's Lean against
//! today's Rust. Production sets `VERIFIED_CLI` and never reaches the path
//! baked here.
//!
//! ⚠ SKIPPED in CI: the `rust` job sets `HEALTH_BUILD_SKIP_LEAN`. The image
//! ships the `lean` job's `verified_cli` and sets `VERIFIED_CLI`, so a
//! `lake build` here would be a second Lean build for a path production never
//! reads (.github/workflows/build.yml).

use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=HEALTH_BUILD_SKIP_LEAN");
    if std::env::var_os("HEALTH_BUILD_SKIP_LEAN").is_some() {
        return;
    }
    let lean_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../lean");
    let out = Command::new("lake")
        .args(["build", "verified_cli"])
        .current_dir(&lean_dir)
        .output()
        .unwrap_or_else(|e| {
            panic!(
                "could not run `lake` in {}: {e}\n\
                 Enter the dev shell (`nix develop`) or put lake on PATH.",
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
    let exe = lean_dir.join(".lake/build/bin/verified_cli");
    assert!(
        exe.is_file(),
        "lake built, but {} is not there",
        exe.display()
    );
    let exe = exe.canonicalize().expect("the verified_cli path resolves");
    println!("cargo:rustc-env=VERIFIED_CLI_BUILD={}", exe.display());

    // ⚠ THE LEAN SOURCES, so an edit there makes cargo ask lake again.
    // `.lake/` is deliberately NOT watched: it is lake's own output.
    for src in [
        "Verified",
        "DayEntry",
        "BackendEntry.lean",
        "ServeEntry.lean",
        "DayEntry.lean",
        "Verified.lean",
        "Main.lean",
        "lakefile.lean",
    ] {
        println!("cargo:rerun-if-changed={}", lean_dir.join(src).display());
    }
}

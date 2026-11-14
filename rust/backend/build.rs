//! Build `verified_cli`, and tell the crate where it is, so a `cargo build`
//! after a `.lean` edit rebuilds the binary tests spawn. Production sets
//! `VERIFIED_CLI`.
//!
//! Skipped in CI (`HEALTH_BUILD_SKIP_LEAN`): the image ships the `lean` job's
//! binary (.github/workflows/build.yml).

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

    // ⚠ The Lean sources, so an edit there makes cargo ask lake again.
    // `.lake/` is deliberately not watched: it is lake's own output.
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

//! The WHOLE fold request, against the TypeScript's, on the real corpus (#982).
//!
//! # Why this test is local-only, and how it says so
//!
//! `tests/golden/days` is gitignored: the fixtures carry real coordinates,
//! place names and biometrics. The committed tests beside this one work from
//! scrubbed extracts, which is enough to pin every ENCODING rule but not enough
//! to prove the assembly on a real 2.8 MB request. This one does that, and can
//! only run where the corpus is.
//!
//! ⚠ IT ANNOUNCES A SKIP RATHER THAN PASSING QUIETLY. A test that silently
//! passes when its inputs are missing is worse than no test: it reports success
//! for having done nothing, which is exactly the failure this file exists to
//! catch elsewhere.
//!
//! Prepare the inputs with:
//!
//! ```text
//! FOLD_CAPTURE=/tmp/foldcap nix develop . -c node dist/cli/golden-check.js
//! ```

use std::path::Path;

use backend::fold_payload::{AnswerTables, build_day_request};
use serde_json::Value;

/// Where `FOLD_CAPTURE` wrote the per-day captures.
fn capture_dir() -> String {
    std::env::var("FOLD_CAPTURE").unwrap_or_else(|_| "/tmp/foldcap".to_string())
}

#[test]
fn the_whole_request_matches_the_typescript_on_every_captured_day() {
    let caps = capture_dir();
    let golden = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden/days");
    if !Path::new(&caps).is_dir() || !Path::new(golden).is_dir() {
        eprintln!(
            "SKIPPED: no corpus. Captures at {caps} and fixtures at {golden} are both needed; \
             see this file's header for how to produce them."
        );
        return;
    }

    let mut entries: Vec<String> = std::fs::read_dir(&caps)
        .expect("capture dir readable")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    entries.sort();

    let mut checked = 0usize;
    for name in entries {
        let fixture = format!("{golden}/{name}");
        let (Ok(cap_raw), Ok(fx_raw)) = (
            std::fs::read_to_string(format!("{caps}/{name}")),
            std::fs::read_to_string(&fixture),
        ) else {
            continue;
        };
        let cap: Value = serde_json::from_str(&cap_raw).expect("capture parses");
        let fx: Value = serde_json::from_str(&fx_raw).expect("fixture parses");
        let inputs = &fx["inputs"];

        let got = build_day_request(
            &cap,
            inputs,
            inputs.get("osmTrace"),
            &AnswerTables::default(),
        )
        .unwrap_or_else(|e| panic!("{name}: {e:#}"));

        // The oracle is the TypeScript's own encoder, run over the same two
        // files — not a stored copy, so it cannot go stale against `dist/`.
        let want = typescript_request(&name).unwrap_or_else(|| {
            panic!("{name}: could not run the TypeScript encoder — is dist/ built?")
        });

        assert_eq!(got, want, "{name}: the request differs");
        checked += 1;
    }

    assert!(
        checked >= 20,
        "only {checked} day(s) compared — the corpus is present but nearly empty, \
         which would make this pass for the wrong reason"
    );
    eprintln!("{checked} day(s) byte-identical to the TypeScript");
}

/// Run `dist/lean/fold-payload.js` over the same capture and fixture.
fn typescript_request(name: &str) -> Option<Value> {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    let script = format!("{root}/rust/backend/tests/fixtures/whole-request-ts.mjs");
    let out = std::process::Command::new("node")
        .arg(&script)
        .arg(name)
        .env("FOLD_CAPTURE", capture_dir())
        .output()
        .ok()?;
    if !out.status.success() {
        eprintln!("{}", String::from_utf8_lossy(&out.stderr));
        return None;
    }
    serde_json::from_slice(&out.stdout).ok()
}

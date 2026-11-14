//! The decoder's parameter record: every fitted number (written by
//! `examples/fit_emissions`, with provenance) and the form settings that go
//! with them. Code holds the form, this the numbers
//! (`docs/design/probabilistic-principles.md`, Rule 8).
//!
//! It holds the user's physiology, so it is not in this repository: the pod
//! reads `DECODER_PARAMS_JSON` from a Secret, a harness names a file or per-day
//! directory in `DECODER_PARAMS`. With neither, a replay reads the golden record
//! and the decode worker refuses.
//!
//! ⚠ The Secret holds one line: `scripts/prod-db.sh` mirrors the pod's env as
//! `NAME=VALUE` lines, so a pretty-printed record arrives as `{`.
//!
//! ```json
//! { "segEmission": {…}, "transFit": {…}, "entryCounts": {…}, "fittedPriors": {…},
//!   "maxD": 1440,
//!   "provenance": {…} }
//! ```

use anyhow::{Context, Result};
use serde_json::Value;

/// The request flags the record sets, by its own key.
const FLAGS: [&str; 4] = ["segEmission", "transFit", "entryCounts", "fittedPriors"];

/// The golden copy of the record the serving pod loads (the Secret's line):
/// what a replay runs under when no arm names another.
const GOLDEN_RECORD: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden/fits/decoder-params.json"
);

/// The record for `date`: `DECODER_PARAMS` (a file, or `<dir>/<date>.json`
/// fitted without that day), else `DECODER_PARAMS_JSON`, else the golden
/// record. `None` without any: a replay runs the fixture's frozen request.
pub fn from_env(date: &str) -> Result<Option<Value>> {
    let Ok(path) = std::env::var("DECODER_PARAMS") else {
        return match std::env::var("DECODER_PARAMS_JSON") {
            Ok(text) => Ok(Some(
                serde_json::from_str(&text).context("DECODER_PARAMS_JSON is not JSON")?,
            )),
            Err(_) => golden_record(),
        };
    };
    let mut path = std::path::PathBuf::from(path);
    if path.is_dir() {
        path = path.join(format!("{date}.json"));
    }
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("DECODER_PARAMS: reading {}", path.display()))?;
    Ok(Some(serde_json::from_str(&text).with_context(|| {
        format!("DECODER_PARAMS: {} is not JSON", path.display())
    })?))
}

/// The golden record, when checked out. Separate so the env read's absence arm
/// has no `?`, which the deploy-env lint reads as "required at boot".
fn golden_record() -> Result<Option<Value>> {
    match std::fs::read_to_string(GOLDEN_RECORD) {
        Ok(text) => Ok(Some(
            serde_json::from_str(&text).context("the golden record is not JSON")?,
        )),
        Err(_) => Ok(None),
    }
}

/// Lay the record on a decode request: each flag and `maxD` the request leaves
/// unset (a harness arm's own setting wins). A missing key is an error, or that
/// part of the fit would silently be off.
pub fn apply(req: &mut Value, params: &Value) -> Result<()> {
    for k in FLAGS.iter().chain(&["maxD"]) {
        anyhow::ensure!(!params[k].is_null(), "the decoder record has no {k}");
    }
    for k in FLAGS {
        if req["flags"][k].is_null() {
            req["flags"][k] = params[k].clone();
        }
    }
    if req["maxD"].is_null() {
        req["maxD"] = params["maxD"].clone();
    }
    Ok(())
}

//! The decoder's parameter record: one JSON file holding every fitted number
//! (`examples/fit_emissions` writes it, with its provenance) and the form
//! settings that go with them. The code holds the model's form; this file holds
//! its numbers (`docs/design/probabilistic-principles.md`, Rule 8).
//!
//! It holds his physiology, so it never lives in this repository: the serving
//! pod reads it from a Secret into `DECODER_PARAMS_JSON` (the record itself, a
//! few kilobytes); the harness names a file or a per-day directory in
//! `DECODER_PARAMS`. Neither set, a decode is the shipped model's, unchanged.
//!
//! ⚠ THE SECRET HOLDS ONE LINE. `scripts/prod-db.sh` mirrors the pod's
//! environment as `NAME=VALUE` lines, so a pretty-printed record reaches a Mac
//! replay as its first line, `{`, and every day fails to decode.
//! `fit_emissions` writes it compact.
//!
//! ```json
//! { "segEmission": {…}, "transFit": {…}, "entryCounts": {…}, "fittedPriors": {…},
//!   "maxD": 1440, "modeMinuteScale": 0, "modeMinuteScaleWithGps": 0,
//!   "dropUnknown": true, "provenance": {…} }
//! ```

use anyhow::{Context, Result};
use serde_json::Value;

/// The request flags the record sets, by its own key.
const FLAGS: [&str; 10] = [
    "segEmission",
    "transFit",
    "entryCounts",
    "fittedPriors",
    "modeMinuteScale",
    "modeMinuteScaleWithGps",
    "dropUnknown",
    "dropRepeatedFixes",
    "generatorBoardingWait",
    "durationNoFloor",
];

/// The golden copy of the record the serving pod loads (the Secret's line):
/// what a replay runs under when no arm names another.
const GOLDEN_RECORD: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/golden/fits/decoder-params.json"
);

/// The record for `date`: `DECODER_PARAMS` names a file, or a directory of one
/// record per day, `<dir>/<date>.json` (each fitted without that day,
/// `fit_emissions --loo`); else `DECODER_PARAMS_JSON` is the record itself;
/// else the golden record, when the golden corpus is checked out. `None`
/// only without it: a replay then runs the fixture's frozen request alone.
pub fn from_env(date: &str) -> Result<Option<Value>> {
    let Ok(path) = std::env::var("DECODER_PARAMS") else {
        return match std::env::var("DECODER_PARAMS_JSON") {
            Ok(text) => Ok(Some(
                serde_json::from_str(&text).context("DECODER_PARAMS_JSON is not JSON")?,
            )),
            Err(_) => match std::fs::read_to_string(GOLDEN_RECORD) {
                Ok(text) => Ok(Some(
                    serde_json::from_str(&text).context("the golden record is not JSON")?,
                )),
                Err(_) => Ok(None),
            },
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

/// Lay the record on a decode request: each flag and `maxD` it carries, where
/// the request leaves them unset — a harness arm's own setting wins.
pub fn apply(req: &mut Value, params: &Value) {
    for k in FLAGS {
        let v = &params[k];
        if !v.is_null() && req["flags"][k].is_null() {
            req["flags"][k] = v.clone();
        }
    }
    if !params["maxD"].is_null() && req["maxD"].is_null() {
        req["maxD"] = params["maxD"].clone();
    }
}

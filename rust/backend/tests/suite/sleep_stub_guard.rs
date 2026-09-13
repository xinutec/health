//! Google leaves a fragment behind when it records a night while it is still in
//! progress and then never revises it. That fragment carries the SAME start
//! instant as the full night, which is the column `uniq_sleep_user_start` keys
//! on, so a backfill upsert does not land beside the night — it overwrites it
//! (#1536).
//!
//! ⚠ THE DURATIONS HERE ARE SYNTHETIC. A real sleep length is a biometric value
//! and this repo is public (#860), so the night is a round ten hours and each
//! stub is the fragment its ratio implies. The RATIOS are the measured fact,
//! and they are the only thing the bound is calibrated against.

use backend::google::sync::{SLEEP_SHRINK_REFUSAL_RATIO, refuses_as_sleep_stub};

/// A synthetic full night: ten hours.
const NIGHT_MS: i64 = 36_000_000;

/// How many times shorter each observed stub was than the night it would have
/// replaced, floored — the seven measured cases ran 8.6x to 23x.
const MEASURED_RATIOS: &[i64] = &[23, 12, 8];

/// The narrowest case observed. The bound must sit strictly below it.
const NARROWEST_MEASURED_RATIO: i64 = 8;

#[test]
fn every_measured_stub_ratio_is_refused() {
    for &ratio in MEASURED_RATIOS {
        let stub = NIGHT_MS / ratio;
        assert!(
            refuses_as_sleep_stub(stub, NIGHT_MS),
            "a session {ratio}x shorter than the night must not overwrite it"
        );
    }
}

#[test]
fn an_ordinary_revision_still_writes() {
    // Google revises a recent night's scoring and it comes out a little
    // shorter. That is the case the writer exists for; it must not be caught.
    assert!(!refuses_as_sleep_stub(NIGHT_MS - 2_000_000, NIGHT_MS));
    // Even a substantial correction stays under the bound: half a night is a
    // revision, an eighth of one is a fragment.
    assert!(!refuses_as_sleep_stub(NIGHT_MS / 2, NIGHT_MS));
}

/// ⚠ The bound is set BELOW the evidence, not at it. Refusing at the narrowest
/// observed ratio would fit the guard to the cases that happened to show the
/// class rather than to the class itself.
///
/// Checked at COMPILE time: raising the refusal ratio to or past the narrowest
/// measured case stops the build, rather than leaving a test to notice.
const _: () = assert!(SLEEP_SHRINK_REFUSAL_RATIO < NARROWEST_MEASURED_RATIO);

/// A night with no existing row is the ordinary first write. The writer only
/// consults this when a row already exists, but the rule must not refuse on a
/// zero it could be handed.
#[test]
fn a_first_write_is_never_a_stub() {
    assert!(!refuses_as_sleep_stub(NIGHT_MS, 0));
}

/// The multiply must not wrap a corrupt duration into a write.
#[test]
fn a_saturating_multiply_cannot_wrap_into_a_write() {
    assert!(!refuses_as_sleep_stub(i64::MAX, NIGHT_MS));
}

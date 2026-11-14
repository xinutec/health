//! Google can leave an unrevised fragment of a night recorded in progress, with
//! the full night's start instant, so a backfill upsert on
//! `uniq_sleep_user_start` would overwrite the night.
//!
//! ⚠ Durations are synthetic (a ten-hour night, stubs at the measured ratios):
//! real sleep lengths are biometrics and this repo is public.

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

/// The bound is below the narrowest measured ratio, not at it, so it fits the
/// class rather than the cases seen; a compile-time check enforces it.
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

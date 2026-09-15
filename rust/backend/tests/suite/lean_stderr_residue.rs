//! What survives the miss filter, and what must not.
//!
//! The serve wrapper captures Lean's stderr and used to read only the miss
//! lines out of it, discarding the rest. That is how #1619's `mirror:` refusal
//! stayed invisible for weeks while printing 85 times a request.
//!
//! ⚠ Forwarding everything is not the fix: measured on one served day, 502 of
//! 15,373 lines were misses and ~14,786 were the backtraces those misses print.
//! So the filter drops a miss AND the frame block it prints, and forwards the
//! rest.

use backend::lean::residue_of;

/// One miss exactly as Lean writes it, with the head of its backtrace.
const MISS: &str = "\
PANIC at _private.DayEntry.0.Day.hit DayEntry:52:12: verified_cli day: uncaptured nearbyWays(4629) — re-capture required
backtrace:
0   backend                             0x00000001086db124 _ZN4leanL15print_backtraceEb + 60
1   backend                             0x00000001086d1fd0 _ZN4leanL15lean_panic_implEPKcmb + 1
";

#[test]
fn a_miss_takes_its_backtrace_with_it() {
    assert_eq!(residue_of(MISS), "");
}

#[test]
fn the_line_that_mattered_survives() {
    // ⚠ THE REGRESSION THIS FILE EXISTS FOR. This is the message that named
    // #1619's cause, printed once per lookup into a file nobody read.
    let text =
        format!("{MISS}mirror: called from inside a tokio runtime; this path is sync-only.\n");
    assert_eq!(
        residue_of(&text),
        "mirror: called from inside a tokio runtime; this path is sync-only.\n"
    );
}

#[test]
fn a_panic_that_is_not_a_miss_keeps_its_backtrace() {
    // ⚠ The case the filter is dangerous for. A genuine fold panic prints the
    // same SHAPE as a miss and must be forwarded whole — dropping its frames
    // would reproduce the original defect for the one event worth seeing.
    let real = "\
PANIC at Verified.Geo.Something: index out of bounds
backtrace:
0   backend                             0x00000001086db124 _ZN4leanL15print_backtraceEb + 60
";
    assert_eq!(residue_of(real), real);
}

#[test]
fn a_frame_block_after_the_miss_ends_at_ordinary_output() {
    // Frames stop being swallowed as soon as something that is not a frame
    // appears, so a diagnostic printed straight after a miss is not lost.
    let text = format!("{MISS}osm: MIRROR walkableRoads -> 749 way(s)\nnext line\n");
    assert_eq!(
        residue_of(&text),
        "osm: MIRROR walkableRoads -> 749 way(s)\nnext line\n"
    );
}

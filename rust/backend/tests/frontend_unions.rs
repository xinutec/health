//! The frontend's hand-copied string unions must match the backend's (#337, #975).
//!
//! Two vocabularies cross to the browser and are RESTATED there by hand: a
//! day-state's `mode` and an episode geometry's `kind`. The frontend keys a
//! `Record<DayStateMode, …>` on the first, so a mode it has never heard of does
//! not fail — it falls through to a default style, silently, in production.
//!
//! ⚠ THIS REPLACES `scripts/check-frontend-unions.mjs`, WHICH LOST ITS OTHER
//! SIDE. That script compared the frontend against `src/sleep/day-state.ts`, and
//! deleting the TypeScript backend takes the only closed `DayStateMode` with it.
//! The replacement side is `Verified.Geo.WireVocab`, where the lists are tied by
//! `#guard` to the closed types that DO exist — the HSMM's `Mode` inductive and
//! `EpisodeGeometry.MOVING_MODES` — so neither end is a list nobody enforces.
//!
//! ⚠ IT IS A RUST TEST, NOT A NODE SCRIPT, on purpose: the point of #975 is that
//! CI stops needing a TypeScript runtime to check the backend.
//!
//! ⚠ IT FAILS WHEN A TARGET CANNOT BE FOUND, not only when the sets disagree.
//! A renamed type or a moved file would otherwise reduce this to a check of
//! nothing, which reads exactly like a check that passes — the property the
//! original was written with and the one easiest to lose in a port.

use std::collections::BTreeSet;
use std::path::PathBuf;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn read(rel: &str) -> String {
    let p = root().join(rel);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{} is unreadable: {e}", p.display()))
}

/// Every `"…"` literal in `src[from..]` up to the first `to`.
///
/// ⚠ REFUSES AN EMPTY RESULT. Zero members is what a moved anchor produces, and
/// an empty set compares equal to nothing useful.
fn literals(src: &str, anchor: &str, terminator: char, what: &str) -> BTreeSet<String> {
    let start = src.find(anchor).unwrap_or_else(|| {
        panic!("{what}: anchor {anchor:?} not found — did it move or get renamed?")
    }) + anchor.len();
    let rest = &src[start..];
    let end = rest
        .find(terminator)
        .unwrap_or_else(|| panic!("{what}: no {terminator:?} after {anchor:?}"));
    let body = &rest[..end];

    let mut out = BTreeSet::new();
    let mut it = body.char_indices();
    while let Some((i, c)) = it.next() {
        if c != '"' {
            continue;
        }
        let after = &body[i + 1..];
        let j = after
            .find('"')
            .unwrap_or_else(|| panic!("{what}: unterminated string literal"));
        out.insert(after[..j].to_string());
        // Skip past the closing quote.
        for _ in 0..=j {
            it.next();
        }
    }
    assert!(
        !out.is_empty(),
        "{what}: found no members after {anchor:?} — the anchor matched something that is not the union"
    );
    out
}

fn lean_list(name: &str) -> BTreeSet<String> {
    let src = read("lean/Verified/Geo/WireVocab.lean");
    literals(&src, &format!("def {name} : List String :="), ']', name)
}

#[test]
fn the_frontend_day_state_modes_are_the_backends() {
    let backend = lean_list("DAY_STATE_MODES");
    let frontend = literals(
        &read("frontend/src/app/modes.ts"),
        "export type DayStateMode =",
        ';',
        "frontend DayStateMode",
    );
    assert_eq!(
        backend,
        frontend,
        "the frontend's DayStateMode and Verified.Geo.WireVocab.DAY_STATE_MODES disagree.\n\
         backend only: {:?}\nfrontend only: {:?}",
        backend.difference(&frontend).collect::<Vec<_>>(),
        frontend.difference(&backend).collect::<Vec<_>>()
    );
    // ⚠ Pinned so the comparison cannot quietly become a one-member check that
    // happens to agree. Eleven is what both sides carry today.
    assert_eq!(backend.len(), 11, "got {backend:?}");
}

#[test]
fn the_frontend_episode_kinds_are_the_backends() {
    let backend = lean_list("EPISODE_KINDS");
    let frontend = literals(
        &read("frontend/src/app/services/health.service.ts"),
        "kind:",
        ';',
        "frontend EpisodeGeometry.kind",
    );
    assert_eq!(
        backend,
        frontend,
        "the frontend's EpisodeGeometry.kind and Verified.Geo.WireVocab.EPISODE_KINDS disagree.\n\
         backend only: {:?}\nfrontend only: {:?}",
        backend.difference(&frontend).collect::<Vec<_>>(),
        frontend.difference(&backend).collect::<Vec<_>>()
    );
    assert_eq!(backend.len(), 6, "got {backend:?}");
}

/// ⚠ THE EXTRACTOR MUST FAIL LOUDLY ON A MOVED ANCHOR. Without this, the two
/// tests above could both pass by comparing two empty sets.
#[test]
#[should_panic(expected = "not found")]
fn a_missing_anchor_is_a_failure_not_an_empty_set() {
    literals("nothing to see here", "export type Absent =", ';', "absent");
}

#[test]
#[should_panic(expected = "found no members")]
fn an_anchor_matching_no_literals_is_a_failure() {
    literals("export type Empty = ;", "export type Empty =", ';', "empty");
}

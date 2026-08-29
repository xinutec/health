//! `backend` with no subcommand must list every subcommand it dispatches.
//!
//! ⚠ THE LIST HAD DRIFTED TO 19 OF 29 before this existed, four of them added in
//! a single day, while `README.md` told the reader to run it "with no subcommand
//! for the list". An incomplete list is a WRONG answer rather than a thin one:
//! it is the same shape as every other control retired this week, one that reads
//! authoritative and is not.
//!
//! ⚠ IT READS THE SOURCE, deliberately. Comparing `SUBCOMMANDS` against a second
//! hand-written list would test its own copy; the only thing that can contradict
//! the table is the `match` that actually dispatches.

/// The match arms in `main.rs` that dispatch a subcommand.
///
/// Two shapes are dispatched and both are matched here: a plain `"name" =>` arm,
/// and `sub @ ("day-live" | "day-mirror")`, which handles two at once.
fn dispatched() -> std::collections::BTreeSet<String> {
    let src = include_str!("../src/main.rs");
    // ⚠ BOUNDED TO THE DISPATCH `match`, not the whole file. An unbounded scan
    // picked up `"bus" =>` from the Overpass mirror's mode match and reported it
    // as an undocumented subcommand — the test's first run, and its own parser
    // was the fault rather than the list. The arms of `match cmd` are the only
    // ones at this indentation inside it.
    let body = src
        .split_once("\n    match cmd {")
        .expect("main.rs dispatches on `match cmd`")
        .1;
    let mut out = std::collections::BTreeSet::new();
    let mut depth = 0i32;
    for line in body.lines() {
        // Stop at the end of the match: the first line that closes back past it.
        depth += line.matches('{').count() as i32 - line.matches('}').count() as i32;
        if depth < 0 {
            break;
        }
        // Arms of THIS match sit at exactly two levels of indent.
        if !line.starts_with("        ") || line.starts_with("         ") {
            continue;
        }
        let t = line.trim();
        // `"name" => …` — the arm shape. Excludes `"" =>`, the usage arm itself.
        if let Some(rest) = t.strip_prefix('"')
            && let Some((name, tail)) = rest.split_once('"')
            && tail.trim_start().starts_with("=>")
            && !name.is_empty()
            && name.chars().all(|c| c.is_ascii_lowercase() || c == '-')
        {
            out.insert(name.to_string());
        }
        // `sub @ ("day-live" | "day-mirror") => …`
        if t.starts_with("sub @ (") {
            for part in t.split('"').skip(1).step_by(2) {
                if part.chars().all(|c| c.is_ascii_lowercase() || c == '-') && !part.is_empty() {
                    out.insert(part.to_string());
                }
            }
        }
    }
    out
}

#[test]
fn usage_lists_every_subcommand() {
    let dispatched = dispatched();
    assert!(
        dispatched.len() > 20,
        "the source scan found only {} arms — the parser has broken, not the list",
        dispatched.len()
    );
    let listed: std::collections::BTreeSet<String> = backend::SUBCOMMANDS
        .iter()
        .map(|(name, _, _)| (*name).to_string())
        .collect();

    let undocumented: Vec<_> = dispatched.difference(&listed).collect();
    assert!(
        undocumented.is_empty(),
        "dispatched but absent from SUBCOMMANDS, so `backend` with no argument \
         would not name them: {undocumented:?}"
    );
    let phantom: Vec<_> = listed.difference(&dispatched).collect();
    assert!(
        phantom.is_empty(),
        "listed in SUBCOMMANDS but not dispatched — the usage text offers something \
         that does not run: {phantom:?}"
    );
}

/// Every entry says what it does. A blank description is a line that looks like
/// documentation and is not.
#[test]
fn every_subcommand_says_what_it_does() {
    for (name, _, what) in backend::SUBCOMMANDS {
        assert!(!what.trim().is_empty(), "{name} has no description");
    }
}

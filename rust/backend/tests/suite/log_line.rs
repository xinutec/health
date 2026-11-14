//! Flattening client text into one log field. ⚠ The security boundary of
//! `/api/telemetry`: a newline in a label would forge log lines attributed to
//! someone else. Expectations are recorded `oneLine` answers.

use backend::lean;

fn init() {
    lean::init().expect("lean host");
}

/// The attack, and the separators a bare `\n` check would miss.
#[test]
fn line_breaking_characters_cannot_reach_the_log() {
    init();
    let cases: &[(&str, &str)] = &[
        // A forged second log line.
        ("a\nclient-event user=victim", "a client-event user=victim"),
        ("a\rb", "a b"),
        ("a\r\nb", "a b"),
        // U+2028 line separator and U+2029 paragraph separator end a line in
        // readers that only `\n` would not.
        ("a\u{2028}b", "a b"),
        ("a\u{2029}b", "a b"),
        // A bidi override reorders the line as displayed, so a label can lie
        // about which field it is without containing a newline at all.
        ("a\u{202e}b", "a b"),
        // Zero-width space and BOM.
        ("a\u{200b}b", "a b"),
        ("a\u{feff}b", "a b"),
    ];
    for (raw, want) in cases {
        assert_eq!(
            lean::one_line(raw, 160).expect("oneLine"),
            *want,
            "oneLine({raw:?})"
        );
    }
}

#[test]
fn whitespace_collapses_and_ends_are_trimmed() {
    init();
    let cases: &[(&str, &str)] = &[
        ("Refresh", "Refresh"),
        ("", ""),
        ("a   b", "a b"),
        ("  a  b  ", "a b"),
        ("\t\n\r a", "a"),
        ("   ", ""),
        // Whitespace that is not control-like: NBSP and ideographic space
        // survive the first replacement and are collapsed by the second. A host
        // using one character set for both steps would get these wrong.
        ("a\u{00a0}b", "a b"),
        ("a\u{3000}b", "a b"),
    ];
    for (raw, want) in cases {
        assert_eq!(
            lean::one_line(raw, 160).expect("oneLine"),
            *want,
            "oneLine({raw:?})"
        );
    }
}

/// The cap counts code points. Counting UTF-16 units could split a surrogate
/// pair and put half a character in the log.
#[test]
fn the_cap_counts_code_points() {
    init();
    assert_eq!(lean::one_line("abcdef", 3).expect("oneLine"), "abc");
    assert_eq!(lean::one_line("abc", 10).expect("oneLine"), "abc");
    assert_eq!(lean::one_line("abcdef", 0).expect("oneLine"), "");
    // U+1D11E musical symbol G clef is one code point and two UTF-16 units.
    let got = lean::one_line("\u{1D11E}\u{1D11E}\u{1D11E}", 2).expect("oneLine");
    assert_eq!(got.chars().count(), 2);
    assert_eq!(got, "\u{1D11E}\u{1D11E}");
}

/// Every client-sent field reaches the line flattened, not only the label: a
/// newline in `kind`, `path` or `at` would forge a line as well.
#[test]
fn a_telemetry_line_is_one_line_whatever_field_carries_the_break() {
    use backend::routes::logging::telemetry_line;
    init();
    let forged = "x\nclient-event user=victim";
    for field in ["kind", "path", "label", "at"] {
        let mut ev = serde_json::json!({ "kind": "tap", "path": "/day", "label": "ok", "at": 1 });
        ev[field] = serde_json::json!(forged);
        let line = telemetry_line("u", "owner", &ev)
            .unwrap()
            .expect("an object event logs");
        assert!(!line.contains('\n'), "{field}: {line:?}");
        assert!(
            line.contains("x client-event user=victim"),
            "{field}: {line:?}"
        );
    }
    // A non-object element logs nothing.
    assert_eq!(
        telemetry_line("u", "owner", &serde_json::json!(3)).unwrap(),
        None
    );
}

/// `/client-log`'s `event` is client text too, and `data`, though serialised
/// as JSON (which escapes `\n`), can still carry U+2028 and bidi overrides.
#[test]
fn a_client_log_line_is_one_line() {
    use backend::routes::logging::client_log_line;
    init();
    let line = client_log_line(
        "u",
        &serde_json::json!({ "event": "boom\n[client/victim] x" }),
    )
    .unwrap();
    assert_eq!(line, "[client/u] boom [client/victim] x");
    let line = client_log_line(
        "u",
        &serde_json::json!({ "event": "e", "data": { "m": "a\u{2028}b\u{202e}c" } }),
    )
    .unwrap();
    assert!(
        !line.contains('\u{2028}') && !line.contains('\u{202e}'),
        "{line:?}"
    );
    assert_eq!(
        client_log_line("u", &serde_json::json!({ "event": "e" })).unwrap(),
        "[client/u] e"
    );
}

//! Flattening client text into one log field (#982).
//!
//! ⚠ This is the security boundary of `/api/telemetry`, not formatting. A label
//! is verbatim UI text written into a line as `label=…`, so a newline inside it
//! forges WHOLE LOG LINES — including further `client-event` lines attributed to
//! someone else. A log the observed thing can write into is not evidence.
//!
//! Every expectation is what the production `oneLine` returned under Node; see
//! `lean/experiments/logline-refs.mts`, which also DERIVES the Unicode tables
//! by asking V8 about every code point rather than transcribing a chart.

use backend::lean;

fn init() {
    lean::init().expect("lean host");
}

/// ⚠ THE ATTACK, and the separators a bare `\n` check would miss.
#[test]
fn line_breaking_characters_cannot_reach_the_log() {
    init();
    let cases: &[(&str, &str)] = &[
        // A forged second log line.
        ("a\nclient-event user=victim", "a client-event user=victim"),
        ("a\rb", "a b"),
        ("a\r\nb", "a b"),
        // U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR end a line in
        // readers that only `\n` would not.
        ("a\u{2028}b", "a b"),
        ("a\u{2029}b", "a b"),
        // ⚠ A bidi override reorders the line AS DISPLAYED, so a label can lie
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
        // ⚠ Whitespace that is NOT control-like: NBSP and IDEOGRAPHIC SPACE
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

/// ⚠ The cap counts CODE POINTS. Counting UTF-16 units could split a surrogate
/// pair and put half a character in the log.
#[test]
fn the_cap_counts_code_points() {
    init();
    assert_eq!(lean::one_line("abcdef", 3).expect("oneLine"), "abc");
    assert_eq!(lean::one_line("abc", 10).expect("oneLine"), "abc");
    assert_eq!(lean::one_line("abcdef", 0).expect("oneLine"), "");
    // U+1D11E MUSICAL SYMBOL G CLEF is one code point and two UTF-16 units.
    let got = lean::one_line("\u{1D11E}\u{1D11E}\u{1D11E}", 2).expect("oneLine");
    assert_eq!(got.chars().count(), 2);
    assert_eq!(got, "\u{1D11E}\u{1D11E}");
}

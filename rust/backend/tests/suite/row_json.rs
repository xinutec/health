//! The wire shape of a `selectAll()` row (#982).
//!
//! The twelve table endpoints have almost no logic, so what is worth testing is
//! not what they decide but what they RENDER. Three things are pinned here:
//!
//!   1. Lean's type → shape table, including the one that reads wrong;
//!   2. that the host's inline ISO formatter agrees with Lean's, because the
//!      serving path does NOT call Lean per value and could otherwise drift;
//!   3. that `days` coercion matches `Number()`, against outputs measured from
//!      zod itself rather than from memory.
//!
//! ⚠ What is NOT here: encoding an actual row. A `MySqlRow` cannot be built
//! without a server, so nothing in this file has ever seen a DECIMAL come off
//! the wire. `backend rows-check` does that against production, and it is the
//! only thing that does — a green run here is evidence about the RULES, not
//! about the decode.

use backend::lean::{self, RowShape};
use backend::routes::tables::js_number;
use backend::row_json::{format_date_iso, format_date_time_iso};
use chrono::{NaiveDate, NaiveDateTime};

fn init() {
    lean::init().expect("lean host");
}

#[test]
fn shape_table_matches_lean() {
    init();
    let types = [
        "BOOLEAN",
        "TINYINT",
        "SMALLINT",
        "INT",
        "INT UNSIGNED",
        "BIGINT",
        "DECIMAL",
        "VARCHAR",
        "TEXT",
        "DATE",
        "DATETIME",
        "TIMESTAMP",
    ];
    let got = lean::row_shapes(&types).expect("row shapes");
    assert_eq!(
        got,
        vec![
            // ⚠ sqlx NAMES `TINYINT(1)` "BOOLEAN" and production puts 0/1 on
            // the wire. Decoding a Rust `bool` from this column would emit
            // `true` and change the contract without failing anything.
            Some(RowShape::Num),
            Some(RowShape::Num),
            Some(RowShape::Num),
            Some(RowShape::Num),
            Some(RowShape::Num),
            // Strings, both of them, and for different reasons: exactness for
            // DECIMAL, 64-bit range for BIGINT.
            Some(RowShape::BigintStr),
            Some(RowShape::DecimalStr),
            Some(RowShape::Str),
            Some(RowShape::Str),
            Some(RowShape::DateIso),
            Some(RowShape::DateTimeIso),
            Some(RowShape::DateTimeIso),
        ]
    );
}

/// An unmapped type must REFUSE, not render as null.
///
/// ⚠ FLOAT and DOUBLE are in this list on purpose. Rendering a float to JSON
/// means reproducing V8's shortest-round-trip output, and `serde_json` is known
/// to disagree with it — so until a column needs one, refusing is the honest
/// answer and a guess would be an invisible one.
#[test]
fn unmapped_types_are_refused() {
    init();
    let types = ["DOUBLE", "FLOAT", "JSON", "BLOB", "GEOMETRY", "TIME", ""];
    let got = lean::row_shapes(&types).expect("row shapes");
    assert!(
        got.iter().all(Option::is_none),
        "an unmapped SQL type must refuse the request, got {got:?}"
    );
}

/// ⚠ THE DRIFT GUARD. `row_json` formats dates inline — a day of intraday heart
/// rate is thousands of values and a host call each would be thousands of round
/// trips — so nothing but this test stops the two renderings diverging.
#[test]
fn host_formatter_agrees_with_lean() {
    init();
    let dates = [
        (2026, 8, 22),
        (2026, 1, 1),
        (2026, 12, 31),
        // A leap day, and the days either side of it.
        (2024, 2, 28),
        (2024, 2, 29),
        (2024, 3, 1),
    ];
    for (y, m, d) in dates {
        let nd = NaiveDate::from_ymd_opt(y, m, d).expect("date");
        assert_eq!(
            format_date_iso(nd),
            lean::format_date_iso(y as i64, m as i64, d as i64).expect("lean date"),
            "DATE {y}-{m}-{d}"
        );
    }

    let times = [
        (2026, 8, 21, 23, 15, 0, 0),
        (2026, 8, 22, 16, 30, 59, 0),
        (2026, 1, 1, 0, 0, 0, 0),
        (2026, 12, 31, 23, 59, 59, 999),
        // Milliseconds are three digits, never trimmed to one or two.
        (2026, 8, 22, 0, 0, 0, 7),
        (2026, 8, 22, 0, 0, 0, 70),
        (2026, 8, 22, 0, 0, 0, 700),
    ];
    for (y, m, d, h, mi, s, ms) in times {
        let dt: NaiveDateTime = NaiveDate::from_ymd_opt(y, m, d)
            .expect("date")
            .and_hms_milli_opt(h, mi, s, ms)
            .expect("time");
        assert_eq!(
            format_date_time_iso(dt),
            lean::format_date_time_iso(
                y as i64, m as i64, d as i64, h as i64, mi as i64, s as i64, ms as i64
            )
            .expect("lean datetime"),
            "DATETIME {y}-{m}-{d} {h}:{mi}:{s}.{ms}"
        );
    }
}

/// A DATE is a full midnight-UTC timestamp on the wire, not `"2026-08-22"`.
#[test]
fn date_renders_as_a_full_timestamp() {
    let nd = NaiveDate::from_ymd_opt(2026, 8, 22).expect("date");
    assert_eq!(format_date_iso(nd), "2026-08-22T00:00:00.000Z");
}

/// `days` coercion, against what zod actually returned.
///
/// ⚠ Every expectation here is an output of
/// `lean/experiments/apiwindow-refs.mts`, which runs the production `daysParam`
/// schema under Node. They are not derived from reading the zod documentation.
#[test]
fn days_coercion_matches_number() {
    init();
    // (input, what validateDays should answer — None means reject)
    let cases: &[(&str, Option<i64>)] = &[
        ("7", Some(7)),
        ("1", Some(1)),
        ("365", Some(365)),
        ("0", None),
        ("-1", None),
        ("366", None),
        ("7.5", None),
        ("abc", None),
        // ⚠ EMPTY IS NOT ABSENT. `Number("")` is 0, which is below the minimum,
        // so `?days=` is a rejection and not the 30-day default.
        ("", None),
        // Measured against zod: it trims, reads hex, and takes an exponent or a
        // trailing ".0" as an integer.
        (" 7 ", Some(7)),
        ("0x10", Some(16)),
        ("1e2", Some(100)),
        ("7.0", Some(7)),
        ("Infinity", None),
    ];
    for (raw, want) in cases {
        let got = lean::validate_days(Some(js_number(raw))).expect("validate days");
        assert_eq!(got, *want, "days={raw:?}");
    }
    // Absent — and ONLY absent — is the default.
    assert_eq!(lean::validate_days(None).expect("absent"), Some(30));
}

/// How a JS number renders, against what V8 actually printed.
///
/// ⚠ Every expectation here is an output of `lean/experiments/rowshape-refs.mts`
/// under Node. The rule matters because JavaScript has no integer/float
/// distinction: a derived `Serialize` writes `120.0` where `JSON.stringify`
/// writes `120`. That cost 8,790 bytes of difference across one day of GPS
/// fixes on the first `/locations` parity run, and no test in this repo would
/// have caught it — only the byte diff did.
#[test]
fn numbers_render_as_javascript_renders_them() {
    use backend::row_json::{js_number_opt, js_number_value};
    let cases: &[(f64, &str)] = &[
        (120.0, "120"),
        (17.0, "17"),
        (100.0, "100"),
        (0.0, "0"),
        // ⚠ `JSON.stringify(-0)` is `0`, not `-0`.
        (-0.0, "0"),
        (1.0, "1"),
        (-1.0, "-1"),
        // Real coordinates, which must keep every digit.
        (51.5096612, "51.5096612"),
        (-0.1786201, "-0.1786201"),
        (0.5, "0.5"),
        (-0.5, "-0.5"),
        (0.1, "0.1"),
        (1.5, "1.5"),
        (2.675, "2.675"),
        (9_007_199_254_740_991.0, "9007199254740991"),
    ];
    for (v, want) in cases {
        assert_eq!(
            serde_json::to_string(&js_number_value(*v)).expect("serialise"),
            *want,
            "js_number_value({v})"
        );
    }
    // ⚠ NaN and the infinities are `null` — JSON cannot say them, and
    // `JSON.stringify` does not error either.
    for v in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert_eq!(js_number_value(v), serde_json::Value::Null, "{v}");
    }
    assert_eq!(js_number_opt(None), serde_json::Value::Null);
    assert_eq!(
        serde_json::to_string(&js_number_opt(Some(17.0))).expect("serialise"),
        "17"
    );
}

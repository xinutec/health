//! `selectAll()` rows, rendered as the client reads them.
//!
//! Twelve `/api` endpoints return every column of a table, and the frontend
//! reads types out of the JSON, so a column rendered wrong fails three layers
//! away. Declared types are not the contract (a "number" column may be DECIMAL,
//! sent as a string). The mapping was measured against production; the rule is
//! `Verified.RowShape`'s, asked once per column ([`crate::lean::row_shapes`]),
//! with ISO formatting inline (held against Lean by `tests/suite/row_json.rs`).
//!
//! * A `DATE` ships as `"2026-08-22T00:00:00.000Z"`, a full timestamp.
//! * `DECIMAL` and `BIGINT` are JSON strings: exactness, and 64-bit sleep ids.
//! * `TINYINT(1)` is `0`/`1`. ⚠ sqlx names that type `"BOOLEAN"`, so decoding
//!   what the name suggests would put `true` on the wire.
//! * ⚠ Every `DATETIME` gets a `Z`, earned or not: this dispatches on SQL type
//!   and cannot tell a UTC instant from a wall clock. No `/api` read selects a
//!   wall-clock column whole (those routes serve `COALESCE(<col>_utc,
//!   CONVERT_TZ(<col>, tz, 'UTC'))`), but a new `SELECT *` over `sleep`,
//!   `sleep_stages`, `heart_rate_intraday` or `steps_intraday` would put a
//!   false `Z` back.

use anyhow::{Context, Result, bail};
use chrono::{Datelike, NaiveDate, NaiveDateTime, Timelike};
use serde_json::{Map, Value};
use sqlx::mysql::MySqlRow;
use sqlx::{Column, Row, TypeInfo, ValueRef};

use crate::lean::{self, RowShape};

/// One column: its name, rendering and integer signedness. Signedness comes
/// from the type name: a decode-and-fall-back could succeed for the wrong reason.
struct ColumnPlan {
    name: String,
    shape: RowShape,
    unsigned: bool,
}

/// The rendering plan for one result set, resolved once and reused per row.
pub struct RowEncoder {
    columns: Vec<ColumnPlan>,
}

impl RowEncoder {
    /// Resolve the plan from a row's column metadata. An unmapped SQL type fails
    /// rather than rendering `null`, which would quietly drop a field.
    pub fn from_row(row: &MySqlRow) -> Result<Self> {
        let names: Vec<String> = row.columns().iter().map(|c| c.name().to_string()).collect();
        let types: Vec<&str> = row.columns().iter().map(|c| c.type_info().name()).collect();
        let shapes = lean::row_shapes(&types)?;

        let mut columns = Vec::with_capacity(names.len());
        for ((name, ty), shape) in names.into_iter().zip(&types).zip(shapes) {
            let Some(shape) = shape else {
                bail!(
                    "column `{name}` has SQL type `{ty}`, which Verified.RowShape does not map. \
                     Add it there — do not guess here."
                );
            };
            columns.push(ColumnPlan {
                name,
                shape,
                unsigned: ty.ends_with(" UNSIGNED"),
            });
        }
        Ok(Self { columns })
    }

    /// Render one row. Every decode propagates: a default would reach the
    /// frontend as `0` or `""`, real-looking data.
    pub fn encode(&self, row: &MySqlRow) -> Result<Value> {
        let mut out = Map::with_capacity(self.columns.len());
        for (i, col) in self.columns.iter().enumerate() {
            let raw = row
                .try_get_raw(i)
                .with_context(|| format!("column `{}`", col.name))?;
            if raw.is_null() {
                out.insert(col.name.clone(), Value::Null);
                continue;
            }
            let v = encode_value(row, i, col)
                .with_context(|| format!("column `{}` ({:?})", col.name, col.shape))?;
            out.insert(col.name.clone(), v);
        }
        Ok(Value::Object(out))
    }
}

fn encode_value(row: &MySqlRow, i: usize, col: &ColumnPlan) -> Result<Value> {
    Ok(match col.shape {
        RowShape::Num => {
            if col.unsigned {
                Value::from(row.try_get::<u64, _>(i)?)
            } else {
                Value::from(row.try_get::<i64, _>(i)?)
            }
        }
        // A string on the wire: Fitbit sleep log ids are 64-bit, beyond what a
        // JavaScript number holds exactly.
        RowShape::BigintStr => {
            if col.unsigned {
                Value::from(row.try_get::<u64, _>(i)?.to_string())
            } else {
                Value::from(row.try_get::<i64, _>(i)?.to_string())
            }
        }
        RowShape::Str => Value::from(row.try_get::<String, _>(i)?),
        // `try_get_unchecked` deliberately: sqlx refuses DECIMAL as a string,
        // but the wire sends its exact text, scale included; via a float `9.30`
        // would become `9.3`.
        RowShape::DecimalStr => Value::from(row.try_get_unchecked::<String, _>(i)?),
        RowShape::DateIso => {
            let d: NaiveDate = row.try_get(i)?;
            Value::from(format_date_iso(d))
        }
        // `try_get_unchecked` deliberately: sqlx accepts `NaiveDateTime` for
        // DATETIME but not TIMESTAMP, which share one wire encoding, so
        // `daily_activity.synced_at` failed to render. Naive also avoids
        // asserting UTC, true only while the session zone says so.
        RowShape::DateTimeIso => {
            let t: NaiveDateTime = row.try_get_unchecked(i)?;
            Value::from(format_date_time_iso(t))
        }
    })
}

/// `YYYY-MM-DDT00:00:00.000Z` — mirrors `Verified.RowShape.formatDateIso`.
pub fn format_date_iso(d: NaiveDate) -> String {
    format!(
        "{}T00:00:00.000Z",
        pad_ymd(d.year() as i64, d.month() as i64, d.day() as i64)
    )
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ`, as `Verified.RowShape.formatDateTimeIso`.
/// Sub-second is truncated to milliseconds (the client's `Date` holds no more),
/// and a leap second's `nanosecond() ≥ 1e9` is clamped.
pub fn format_date_time_iso(t: NaiveDateTime) -> String {
    let ms = (t.nanosecond() / 1_000_000).min(999);
    format!(
        "{}T{:02}:{:02}:{:02}.{:03}Z",
        pad_ymd(t.year() as i64, t.month() as i64, t.day() as i64),
        t.hour(),
        t.minute(),
        t.second(),
        ms
    )
}

/// `YYYY-MM-DD`, as `Verified.Civil.formatDate`: a year outside `[0, 9999]`
/// prints unpadded, visibly not a date, rather than truncated.
fn pad_ymd(y: i64, m: i64, d: i64) -> String {
    let year = if (0..=9999).contains(&y) {
        format!("{y:04}")
    } else {
        y.to_string()
    };
    format!("{year}-{m:02}-{d:02}")
}

/// Render a whole result set. Empty in, empty out — and no column metadata is
/// needed for that, which is why the encoder is built from the first row.
pub fn rows_to_json(rows: &[MySqlRow]) -> Result<Vec<Value>> {
    let Some(first) = rows.first() else {
        return Ok(Vec::new());
    };
    let enc = RowEncoder::from_row(first)?;
    rows.iter().map(|r| enc.encode(r)).collect()
}

/// An `f64` that serializes as JavaScript renders a number: `120`, not
/// `120.0`. Use it for every float in a response struct.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct JsNumber(pub f64);

impl serde::Serialize for JsNumber {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        // Delegating to the Value keeps one definition of the rules. An
        // independent impl here would be a second copy to drift from.
        js_number_value(self.0).serialize(s)
    }
}

/// One `f64`, rendered as `JSON.stringify` renders a JavaScript number, which
/// the client's contract follows (`serde_json` would print `120.0`):
///
///   * an integral value has no decimal point (`120`, `-1`, `0`);
///   * `-0` prints as `0`;
///   * a non-integral value prints its shortest round-trip form (`ryu`'s);
///   * `NaN` and the infinities print as `null`.
///
/// Verified for integral values up to 2^53; beyond that, where JavaScript
/// switches to exponent form, re-measure before relying on it.
pub fn js_number_value(v: f64) -> Value {
    if !v.is_finite() {
        // `JSON.stringify(NaN)` is `null`, not `NaN` — which is not valid
        // JSON — and not an error either.
        return Value::Null;
    }
    // 2^53: above this an f64 cannot represent consecutive integers, and the
    // shortest round-trip digits stop agreeing with a plain integer conversion.
    const MAX_EXACT_INT: f64 = 9_007_199_254_740_992.0;
    if v.fract() == 0.0 && v.abs() <= MAX_EXACT_INT {
        // `as i64` is exact here, and it also folds `-0.0` to `0` the way
        // `JSON.stringify` does.
        return Value::from(v as i64);
    }
    Value::from(v)
}

/// [`js_number_value`] for an optional number, so `None` stays `null`.
pub fn js_number_opt(v: Option<f64>) -> Value {
    v.map_or(Value::Null, js_number_value)
}

/// The decoded segments in a fixed field order (`startTs, endTs, mode, placeId,
/// lineName, boardStation, alightStation`): `Lean.Json.mkObj` sorts keys, and
/// `decoded_days.segments_json` is TEXT, so a stable order keeps stored rows
/// comparable by text (`jq` cannot: it equates `25.0` and `25`, and absent
/// with null). Only order is decided here; an unknown key is carried through.
pub fn render_segments(segments: &Value) -> Result<Value> {
    // Absent and NULL differ: `boardStation` is absent where the chain never
    // reached and NULL on a side it could not separate. Never insert a null.
    const ORDER: [&str; 7] = [
        "startTs",
        "endTs",
        "mode",
        "placeId",
        "lineName",
        "boardStation",
        "alightStation",
    ];
    let rows = segments
        .as_array()
        .context("assemblesegments did not return an array")?;
    let out = rows
        .iter()
        .map(|s| {
            let o = s.as_object().context("a segment is not an object")?;
            let mut m = Map::with_capacity(o.len());
            for k in ORDER {
                if let Some(v) = o.get(k) {
                    m.insert(k.into(), v.clone());
                }
            }
            // Anything Lean grew that this list has not been told about, in its
            // own order, after the known fields. Silently dropping it would make
            // a new field look like a decode that stopped producing it.
            for (k, v) in o {
                if !ORDER.contains(&k.as_str()) {
                    m.insert(k.clone(), v.clone());
                }
            }
            Ok(Value::Object(m))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Value::Array(out))
}

//! `selectAll()` rows, rendered the way the TypeScript backend renders them.
//!
//! Twelve `/api` endpoints are one line of logic each — select every column of a
//! table, hand the rows to `c.json`. The logic ports in a minute; the SHAPE is
//! the work. That response is whatever columns the table has, mapped to JS by
//! the MariaDB driver and then to text by `JSON.stringify`, and the frontend
//! reads types out of it. Get one column's rendering wrong and the failure is
//! invisible here and loud three layers away.
//!
//! ⚠ The TypeScript's own type declarations are NOT the contract.
//! `src/db/tables.ts` declares `daily_rmssd: number | null` eleven lines below a
//! comment saying DECIMAL columns arrive as strings. The mapping this module
//! implements was MEASURED against production instead —
//! `scripts/prod-db.sh node scripts/probe-row-shapes.mjs` — and the rule itself
//! lives in `Verified.RowShape`, not here.
//!
//! # What surprises
//!
//! * A `DATE` ships as `"2026-08-22T00:00:00.000Z"`, a full timestamp.
//! * `DECIMAL` and `BIGINT` are JSON STRINGS, the first for exactness and the
//!   second because a Fitbit sleep log id does not survive an f64.
//! * `TINYINT(1)` is `0`/`1`. ⚠ sqlx NAMES that type `"BOOLEAN"`, so decoding
//!   what the name suggests would put `true` on the wire.
//!
//! # Nothing here decides anything
//!
//! Which JSON shape a SQL type takes is a decision, and it is Lean's: this asks
//! [`crate::lean::row_shapes`] once per column and then only moves bytes. The
//! ISO formatting is inline rather than a host call per value — a day of
//! intraday heart rate is thousands of values — and `tests/row_json.rs` holds
//! it against Lean's over a corpus so the two cannot drift.

use anyhow::{Context, Result, bail};
use chrono::{Datelike, NaiveDate, NaiveDateTime, Timelike};
use serde_json::{Map, Value};
use sqlx::mysql::MySqlRow;
use sqlx::{Column, Row, TypeInfo, ValueRef};

use crate::lean::{self, RowShape};

/// One column: what to call it, how to render it, and whether its integer is
/// signed.
///
/// ⚠ Signedness comes from the TYPE NAME rather than from trying a decode and
/// falling back. A fallback would turn a genuine decode failure into a second
/// attempt that might succeed for the wrong reason.
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
    /// Resolve the plan from a row's column metadata.
    ///
    /// ⚠ Fails, rather than skipping the column, when Lean maps a SQL type to
    /// nothing. An unmapped type is one whose rendering nobody has checked
    /// against production; rendering it as `null` would answer with a
    /// well-formed response that quietly dropped a field.
    pub fn from_row(row: &MySqlRow) -> Result<Self> {
        let names: Vec<String> = row.columns().iter().map(|c| c.name().to_string()).collect();
        let types: Vec<&str> = row.columns().iter().map(|c| c.type_info().name()).collect();
        let shapes = lean::row_shapes(&types)?;

        let mut columns = Vec::with_capacity(names.len());
        for ((name, ty), shape) in names.into_iter().zip(&types).zip(shapes) {
            let Some(shape) = shape else {
                bail!(
                    "column `{name}` has SQL type `{ty}`, which Verified.RowShape does not map. \
                     Measure what the TypeScript emits for it and add it there — do not guess here."
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

    /// Render one row.
    ///
    /// ⚠ Every decode propagates. There is no `unwrap_or_default` here on
    /// purpose: a column that failed to decode would otherwise reach the
    /// frontend as `0` or `""`, which reads as real data rather than as loss.
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
        // ⚠ A STRING on the wire. `bigIntAsNumber: false` exists because Fitbit
        // sleep log ids are 64-bit, and the `BigInt.prototype.toJSON` patch in
        // `src/bigint-json.ts` is what turns them into these strings.
        RowShape::BigintStr => {
            if col.unsigned {
                Value::from(row.try_get::<u64, _>(i)?.to_string())
            } else {
                Value::from(row.try_get::<i64, _>(i)?.to_string())
            }
        }
        RowShape::Str => Value::from(row.try_get::<String, _>(i)?),
        // ⚠ `try_get_unchecked` DELIBERATELY. sqlx's `compatible()` for strings
        // excludes DECIMAL, but the binary protocol sends one as a
        // length-prefixed ASCII string, so these bytes are the server's exact
        // text — scale and trailing zeros included. Going via a float would
        // reformat it, and `9.30` becoming `9.3` is a changed response.
        RowShape::DecimalStr => Value::from(row.try_get_unchecked::<String, _>(i)?),
        RowShape::DateIso => {
            let d: NaiveDate = row.try_get(i)?;
            Value::from(format_date_iso(d))
        }
        // ⚠ `try_get_unchecked` DELIBERATELY, and this one was found by running
        // against production rather than by reading anything. sqlx's
        // `compatible()` accepts `NaiveDateTime` for DATETIME and REFUSES it for
        // TIMESTAMP, so `daily_activity.synced_at` failed to render at all —
        // while the two types share one binary encoding on the wire.
        //
        // Decoding both as naive is also what the JS driver effectively does: it
        // builds a `Date` from the server's wall-clock fields for either type.
        // Asking for a `DateTime<Utc>` instead would render the same text while
        // ASSERTING the value is UTC, which is only true while the connection's
        // session timezone says so.
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

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` — mirrors `Verified.RowShape.formatDateTimeIso`.
///
/// ⚠ Sub-second is TRUNCATED to milliseconds, not rounded: a JS `Date` cannot
/// hold more, so a `DATETIME(6)` loses its microseconds here exactly as it does
/// there. `nanosecond()` can also exceed 1e9 on a leap second, and that is
/// clamped rather than allowed to print a fourth digit.
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

/// `YYYY-MM-DD`, matching `Verified.Civil.formatDate`: a year outside
/// `[0, 9999]` prints unpadded rather than truncated, because a silently
/// 5-character "year" that later reparses as something else is worse than a
/// string that visibly is not a date.
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

/// One `f64`, rendered as `JSON.stringify` renders a JS number.
///
/// ⚠ JavaScript has NO integer/float distinction. `JSON.stringify(120)` is
/// `120`, while `serde_json` prints `120.0` for the same `f64` — a different
/// response for identical data. That is not hypothetical: the first
/// `/locations` parity run against production differed by 8,790 bytes across
/// 1,465 points for exactly this reason, and nothing else had caught it.
///
/// The rules, measured from V8 in `lean/experiments/rowshape-refs.mts`:
///
///   * an integral value prints with no decimal point (`120`, `-1`, `0`)
///   * `-0` prints as `0`
///   * a non-integral value prints its SHORTEST round-tripping form, which is
///     also what `ryu` (and therefore `serde_json`) produces
///   * `NaN` and the infinities print as `null` — JSON has no way to say them
///
/// ⚠ WHAT IS VERIFIED IS A RANGE. Integral values beyond 2^53 are handed to
/// `serde_json`, whose exponent formatting is NOT known to match V8's (which
/// switches to `1e+21` at that threshold and prints full digits below it). No
/// value this API carries comes near that — latitude, longitude, altitude,
/// speed, accuracy and battery are all far inside it — but a caller adding a
/// column with genuinely huge numbers must re-measure rather than assume this
/// covers them.
pub fn js_number_value(v: f64) -> Value {
    if !v.is_finite() {
        // ⚠ `JSON.stringify(NaN)` is `null`, not `NaN` — which is not valid
        // JSON — and not an error either.
        return Value::Null;
    }
    // 2^53: above this an f64 cannot represent consecutive integers, and V8's
    // shortest-round-trip digits stop agreeing with a plain integer conversion.
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

/// The decoded segments in the field order node writes them in.
///
/// ⚠ `Lean.Json.mkObj` SORTS ITS KEYS. The order `assembleSegmentsResult` spells
/// — `startTs, endTs, mode, placeId, lineName, boardStation, alightStation` —
/// does not survive; what comes back is alphabetical, measured 2026-08-26 rather
/// than assumed. Node's is insertion order, from the object literal in
/// `groupStatesIntoSegments` plus the two station fields assigned after it.
///
/// ⚠ `decoded_days.segments_json` IS TEXT, and the only real check on this port
/// is a diff against node's row. Left alone, every row would differ on key order
/// for every day, and the diff could not tell "the decode changed" from "the
/// keys moved". `jq` cannot rescue it either: it parses numbers to doubles
/// (`25.0 == 25`) and cannot see an absent key against an explicit null — and
/// both distinctions are live on this row.
///
/// ⚠ ORDER IS A FORMAT CONCERN AND NOTHING ELSE IS DECIDED HERE. `stops_json` is
/// rebuilt shell-side for exactly this reason (#1189). What the fields ARE stays
/// in Lean; an unknown key would be a Lean change this has not been told about,
/// so it is carried through rather than dropped.
pub fn render_segments(segments: &Value) -> Result<Value> {
    // ⚠ ABSENT AND NULL ARE BOTH REAL AND THEY ARE DIFFERENT. `boardStation` is
    // ABSENT on a segment the chain never reached and NULL on a resolved side it
    // could not separate — "wrong is worse than missing". Inserting a null for
    // the absent case would erase the distinction node's rows carry.
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

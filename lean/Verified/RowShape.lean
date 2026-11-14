import Verified.Civil
/-!
# What a `selectAll()` row looks like on the wire

Several `/api` endpoints return a table's rows as they are, so the response
shape is each column's SQL type as the frontend has always received it. These
mappings were observed against production, not read off the schema:

* DATE ships as `"YYYY-MM-DDT00:00:00.000Z"`, a UTC timestamp, whatever the
  process zone.
* DECIMAL is a string, its exact server text.
* BIGINT is a string too.
* `TINYINT(1)` is `0` or `1`, never `true`/`false`. ⚠ sqlx names it
  `"BOOLEAN"`, so decoding a Rust `bool` would silently change the contract.

Pure and total. UNPROVEN; the `#guard`s pin the shapes the frontend reads.
-/
namespace Verified.RowShape

/-- How one column's value is rendered into JSON. -/
inductive Shape where
  /-- A JSON number. -/
  | num
  /-- A JSON string, verbatim. -/
  | str
  /-- A JSON string holding decimal digits — BIGINT, which JS carries as a
      `bigint` and the `toJSON` patch stringifies rather than rounding. -/
  | bigintStr
  /-- A JSON string holding the server's exact DECIMAL text, scale preserved. -/
  | decimalStr
  /-- `YYYY-MM-DDT00:00:00.000Z` — a DATE, widened to midnight UTC. -/
  | dateIso
  /-- `YYYY-MM-DDTHH:MM:SS.mmmZ` — a DATETIME or TIMESTAMP. -/
  | dateTimeIso
  deriving Repr, BEq, DecidableEq

/-- The JSON shape of a column, by its sqlx type name (`MySqlTypeInfo::name`).
`none` means refuse: an unchecked type would render a well-formed wrong answer.
FLOAT and DOUBLE are refused, since no table has one and matching the client's
shortest-round-trip formatting is unverified. -/
def shapeOf (sqlType : String) : Option Shape :=
  match sqlType with
  -- "Boolean" is sqlx's name for TINYINT(1). The wire carries 0 or 1.
  | "BOOLEAN" => some Shape.num
  | "TINYINT" | "TINYINT UNSIGNED" => some Shape.num
  | "SMALLINT" | "SMALLINT UNSIGNED" => some Shape.num
  | "MEDIUMINT" | "MEDIUMINT UNSIGNED" => some Shape.num
  | "INT" | "INT UNSIGNED" => some Shape.num
  | "YEAR" => some Shape.num
  -- Not a number: > 2^53 loses precision, which is why the driver was put
  -- into `bigIntAsNumber: false` in the first place (Fitbit sleep log ids).
  | "BIGINT" | "BIGINT UNSIGNED" => some Shape.bigintStr
  | "DECIMAL" => some Shape.decimalStr
  | "VARCHAR" | "CHAR" => some Shape.str
  | "TINYTEXT" | "TEXT" | "MEDIUMTEXT" | "LONGTEXT" => some Shape.str
  | "ENUM" => some Shape.str
  | "DATE" => some Shape.dateIso
  | "DATETIME" | "TIMESTAMP" => some Shape.dateTimeIso
  | _ => none

/-- `YYYY-MM-DDT00:00:00.000Z`: a DATE as UTC midnight. -/
def formatDateIso (y : Int) (m : Int) (d : Int) : String :=
  Verified.Civil.formatDate y m d ++ "T00:00:00.000Z"

/-- Three digits, zero-padded — `JSON.stringify` of a `Date` always renders
milliseconds, even when the column has no fractional part. -/
def pad3 (n : Int) : String :=
  let s := toString n
  String.ofList (List.replicate (3 - min 3 s.length) '0') ++ s

/-- `YYYY-MM-DDTHH:MM:SS.mmmZ`, truncated to milliseconds, as the wire has
always carried it. -/
def formatDateTimeIso (y m d h mi s ms : Int) : String :=
  Verified.Civil.formatDate y m d ++ "T" ++
    Verified.Civil.pad2 h ++ ":" ++ Verified.Civil.pad2 mi ++ ":" ++
    Verified.Civil.pad2 s ++ "." ++ pad3 ms ++ "Z"

/-! ## Guards -/

-- The name is "boolean" and the shape is a number.
#guard shapeOf "BOOLEAN" == some Shape.num
#guard shapeOf "TINYINT" == some Shape.num
#guard shapeOf "SMALLINT" == some Shape.num
#guard shapeOf "INT" == some Shape.num
#guard shapeOf "INT UNSIGNED" == some Shape.num
-- A string, so 64-bit ids survive.
#guard shapeOf "BIGINT" == some Shape.bigintStr
#guard shapeOf "DECIMAL" == some Shape.decimalStr
#guard shapeOf "VARCHAR" == some Shape.str
#guard shapeOf "TEXT" == some Shape.str
#guard shapeOf "DATE" == some Shape.dateIso
#guard shapeOf "DATETIME" == some Shape.dateTimeIso
#guard shapeOf "TIMESTAMP" == some Shape.dateTimeIso
-- Refused rather than guessed — see the note on `shapeOf`.
#guard shapeOf "DOUBLE" == none
#guard shapeOf "FLOAT" == none
#guard shapeOf "JSON" == none
#guard shapeOf "BLOB" == none
#guard shapeOf "GEOMETRY" == none
#guard shapeOf "TIME" == none
#guard shapeOf "" == none

-- Observed against production: a DATE ships as a full midnight-UTC timestamp.
#guard formatDateIso 2026 8 22 == "2026-08-22T00:00:00.000Z"
#guard formatDateIso 2026 1 1 == "2026-01-01T00:00:00.000Z"

-- Observed: `sleep.start_time` and its `_utc` sibling, one hour apart.
#guard formatDateTimeIso 2026 8 21 23 15 0 0 == "2026-08-21T23:15:00.000Z"
#guard formatDateTimeIso 2026 8 21 22 15 0 0 == "2026-08-21T22:15:00.000Z"
#guard formatDateTimeIso 2026 8 22 16 30 59 0 == "2026-08-22T16:30:59.000Z"
-- Milliseconds are padded to three digits, never elided.
#guard formatDateTimeIso 2026 8 22 0 0 0 7 == "2026-08-22T00:00:00.007Z"
#guard formatDateTimeIso 2026 8 22 0 0 0 70 == "2026-08-22T00:00:00.070Z"
#guard formatDateTimeIso 2026 8 22 0 0 0 700 == "2026-08-22T00:00:00.700Z"

end Verified.RowShape

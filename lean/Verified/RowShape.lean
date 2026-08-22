import Verified.Civil
/-!
# What a `selectAll()` row looks like on the wire (port of `src/routes/api.ts`)

Ten `/api` endpoints are one line of logic each — `selectFrom(t).selectAll()`,
then `c.json(rows)`. The logic is trivial and the *shape* is not: the response
is whatever columns the table has, rendered by whatever the MariaDB driver
decided each SQL type becomes in JavaScript, then by `JSON.stringify`. Change
any of those and the frontend reads a different type from the same endpoint.

## The declared TypeScript types are NOT the shape

`src/db/tables.ts` declares `daily_rmssd: number | null` and, eleven lines
above, comments that DECIMAL columns come back as strings. Both cannot be true;
the comment is. So every mapping below is what the driver was OBSERVED to
produce against production — `scripts/probe-row-shapes.mjs` — and not what the
schema says it ought to.

## The four that surprise

* **DATE is not a date.** `date` arrives as a JS `Date` and `JSON.stringify`
  renders it in UTC, so a `DATE` column ships as `"2026-08-22T00:00:00.000Z"` —
  a full timestamp, not `"2026-08-22"`.
* **DECIMAL is a string.** Its exact server text, scale and all.
* **BIGINT is a string too**, via the `BigInt.prototype.toJSON` patch in
  `src/bigint-json.ts`. Without that patch `JSON.stringify` THROWS.
* **`TINYINT(1)` is a NUMBER, `0` or `1`** — never `true`/`false`. ⚠ sqlx names
  that column type `"BOOLEAN"`, so a host that trusts the name, decodes a Rust
  `bool` and serialises it emits `true` and silently changes the contract.

⚠ The UTC rendering above is only correct because the serving pod's TZ is
unset, and `JSON.stringify` of a `Date` uses UTC regardless. The TypeScript's
wire format therefore DEPENDS ON ITS PROCESS TIMEZONE; under `TZ=Europe/London`
a `DATE` would ship as the previous day at 23:00Z. A host that formats these
strings directly, as this module does, has no such dependency — it is the same
bytes production emits today, minus the ambient variable.

Pure and total. UNPROVEN; every `#guard` is what the driver and `JSON.stringify`
produced — see `lean/experiments/rowshape-refs.mts`.
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

/-- The JSON shape of a column, by the SQL type name its driver reports.

`none` means REFUSE. A host must fail the request rather than guess: a column
type nobody has looked at is a column whose rendering nobody has checked, and
the wrong guess is invisible — it produces a well-formed response of the wrong
type. The names are sqlx's (`MySqlTypeInfo::name`), which is where the host
reads them from.

⚠ FLOAT and DOUBLE are refused DELIBERATELY, not overlooked. Rendering a float
to JSON means reproducing V8's shortest-round-trip algorithm exactly, and Rust's
`serde_json` is known to disagree with it. None of the ten tables has such a
column, so the choice is between a refusal and an unverified renderer. -/
def shapeOf (sqlType : String) : Option Shape :=
  match sqlType with
  -- ⚠ "BOOLEAN" is sqlx's name for TINYINT(1). The wire carries 0 or 1.
  | "BOOLEAN" => some Shape.num
  | "TINYINT" | "TINYINT UNSIGNED" => some Shape.num
  | "SMALLINT" | "SMALLINT UNSIGNED" => some Shape.num
  | "MEDIUMINT" | "MEDIUMINT UNSIGNED" => some Shape.num
  | "INT" | "INT UNSIGNED" => some Shape.num
  | "YEAR" => some Shape.num
  -- ⚠ NOT a number: > 2^53 loses precision, which is why the driver was put
  -- into `bigIntAsNumber: false` in the first place (Fitbit sleep log ids).
  | "BIGINT" | "BIGINT UNSIGNED" => some Shape.bigintStr
  | "DECIMAL" => some Shape.decimalStr
  | "VARCHAR" | "CHAR" => some Shape.str
  | "TINYTEXT" | "TEXT" | "MEDIUMTEXT" | "LONGTEXT" => some Shape.str
  | "ENUM" => some Shape.str
  | "DATE" => some Shape.dateIso
  | "DATETIME" | "TIMESTAMP" => some Shape.dateTimeIso
  | _ => none

/-- `YYYY-MM-DDT00:00:00.000Z`.

A DATE has no time, so JS builds midnight — in the process timezone — and
renders it in UTC. Under the UTC pod that is midnight; see the module note. -/
def formatDateIso (y : Int) (m : Int) (d : Int) : String :=
  Verified.Civil.formatDate y m d ++ "T00:00:00.000Z"

/-- Three digits, zero-padded — `JSON.stringify` of a `Date` always renders
milliseconds, even when the column has no fractional part. -/
def pad3 (n : Int) : String :=
  let s := toString n
  String.ofList (List.replicate (3 - min 3 s.length) '0') ++ s

/-- `YYYY-MM-DDTHH:MM:SS.mmmZ`.

⚠ `ms` is truncated to milliseconds, not rounded: a JS `Date` cannot hold
more, so a `DATETIME(6)` loses its microseconds here exactly as it does there. -/
def formatDateTimeIso (y m d h mi s ms : Int) : String :=
  Verified.Civil.formatDate y m d ++ "T" ++
    Verified.Civil.pad2 h ++ ":" ++ Verified.Civil.pad2 mi ++ ":" ++
    Verified.Civil.pad2 s ++ "." ++ pad3 ms ++ "Z"

/-! ## Guards -/

-- ⚠ The name is "BOOLEAN" and the shape is a NUMBER.
#guard shapeOf "BOOLEAN" == some Shape.num
#guard shapeOf "TINYINT" == some Shape.num
#guard shapeOf "SMALLINT" == some Shape.num
#guard shapeOf "INT" == some Shape.num
#guard shapeOf "INT UNSIGNED" == some Shape.num
-- ⚠ A string, so 64-bit ids survive.
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

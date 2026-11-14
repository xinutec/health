/-!
# Civil dates — the proleptic Gregorian calendar, as exact integer arithmetic

The shared date floor: no `Float`, no tz database, no clock. (y, m, d) ↔ day
number is Howard Hinnant's `days_from_civil`, exact at every year on `Int`.

Date bugs hit one day in 1 461, which a corpus of a few months cannot show, so
the round trip is checked exhaustively over a range of years (below); the
guards name the boundaries.

The year is shifted to start in March (`m ≤ 2` borrows from the previous
year), so the leap day ends the year and month lengths follow
`(153·m' + 2) / 5`; 400-year eras of 146 097 days make the rest division.
`1970-01-01` is day 0, so `dayNumber · 86400` is the UTC midnight timestamp.
-/

namespace Verified.Civil

/-- Days from `1970-01-01` to `y-m-d`, proleptic Gregorian, negative before the
epoch. Out-of-range `m`/`d` give a consistent extension, not an error; callers
parse validated strings. -/
def daysFromCivil (y : Int) (m : Int) (d : Int) : Int :=
  -- March-based year: January and February belong to the previous one.
  let y' := if m ≤ 2 then y - 1 else y
  -- `era` is the 400-year block; Int division in Lean floors toward -∞ for
  -- `ediv`, which is what makes this work for negative years without a branch.
  let era := (if y' ≥ 0 then y' else y' - 399) / 400
  let yoe := y' - era * 400                    -- year of era, [0, 399]
  let mp := (m + 9) % 12                       -- March = 0 … February = 11
  let doy := (153 * mp + 2) / 5 + d - 1        -- day of year, [0, 365]
  let doe := yoe * 365 + yoe / 4 - yoe / 100 + doy
  era * 146097 + doe - 719468

/-- Inverse of [`daysFromCivil`] — `(y, m, d)` for a day number. -/
def civilFromDays (z : Int) : Int × Int × Int :=
  let z := z + 719468
  let era := (if z ≥ 0 then z else z - 146096) / 146097
  let doe := z - era * 146097                            -- [0, 146096]
  let yoe := (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
  let y := yoe + era * 400
  let doy := doe - (365 * yoe + yoe / 4 - yoe / 100)      -- [0, 365]
  let mp := (5 * doy + 2) / 153                           -- [0, 11]
  let d := doy - (153 * mp + 2) / 5 + 1                   -- [1, 31]
  let m := if mp < 10 then mp + 3 else mp - 9
  (if m ≤ 2 then y + 1 else y, m, d)

/-- Gregorian leap year. -/
def isLeap (y : Int) : Bool := (y % 4 == 0 && y % 100 != 0) || y % 400 == 0

/-- Length of month `m` in year `y`. -/
def monthLength (y : Int) (m : Int) : Int :=
  if m == 2 then (if isLeap y then 29 else 28)
  else if m == 4 || m == 6 || m == 9 || m == 11 then 30
  else 31

/-- Two digits, zero-padded — the `YYYY-MM-DD` component format. -/
def pad2 (n : Int) : String :=
  let s := toString n
  if s.length ≥ 2 then s else "0" ++ s

/-- Four digits, zero-padded. Years outside [0, 9999] print unpadded, visibly
not a date, rather than truncated into a different one. -/
def pad4 (n : Int) : String :=
  let s := toString n
  if s.length ≥ 4 then s else String.ofList (List.replicate (4 - s.length) '0') ++ s

/-- `YYYY-MM-DD`. -/
def formatDate (y : Int) (m : Int) (d : Int) : String :=
  pad4 y ++ "-" ++ pad2 m ++ "-" ++ pad2 d

/-- Parse `YYYY-MM-DD` strictly: three all-digit components of the right widths,
a real month, and a day within it. User input arrives through query parameters,
so 30 February and unpadded fields are refused, not normalised. -/
def parseDate (s : String) : Option (Int × Int × Int) :=
  match s.splitOn "-" with
  | [ys, ms, ds] =>
    if ys.length != 4 || ms.length != 2 || ds.length != 2 then none
    else if !(ys.all Char.isDigit && ms.all Char.isDigit && ds.all Char.isDigit) then none
    else
      let y := (ys.toNat!  : Int)
      let m := (ms.toNat!  : Int)
      let d := (ds.toNat!  : Int)
      if m < 1 || m > 12 then none
      else if d < 1 || d > monthLength y m then none
      else some (y, m, d)
  | _ => none

/-- Shift a `YYYY-MM-DD` by `n` days. `none` when the input does not parse. -/
def addDays (s : String) (n : Int) : Option String :=
  match parseDate s with
  | none => none
  | some (y, m, d) =>
    let (y', m', d') := civilFromDays (daysFromCivil y m d + n)
    some (formatDate y' m' d')

/-- UTC midnight of `YYYY-MM-DD`, as a Unix timestamp in seconds. -/
def midnightUtc (s : String) : Option Int :=
  match parseDate s with
  | none => none
  | some (y, m, d) => some (daysFromCivil y m d * 86400)

/-! ## Guards

The boundaries a reader wants named and a wrong implementation gets wrong
first. -/

#guard daysFromCivil 1970 1 1 == 0
#guard daysFromCivil 1970 1 2 == 1
#guard daysFromCivil 1969 12 31 == -1
-- 2000 is a leap year (divisible by 400); 1900 is not (divisible by 100).
#guard isLeap 2000 == true
#guard isLeap 1900 == false
#guard isLeap 2024 == true
#guard isLeap 2026 == false
#guard monthLength 2024 2 == 29
#guard monthLength 2026 2 == 28
#guard monthLength 2026 4 == 30
#guard monthLength 2026 12 == 31
-- Across the February boundary, in both directions, leap and non-leap.
#guard addDays "2024-02-28" 1 == some "2024-02-29"
#guard addDays "2026-02-28" 1 == some "2026-03-01"
#guard addDays "2024-03-01" (-1) == some "2024-02-29"
#guard addDays "2026-03-01" (-1) == some "2026-02-28"
-- Across a year boundary and a century.
#guard addDays "2026-12-31" 1 == some "2027-01-01"
#guard addDays "1900-02-28" 1 == some "1900-03-01"
#guard addDays "2000-02-28" 1 == some "2000-02-29"
-- The strictness that `new Date` lacks.
#guard parseDate "2026-02-30" == none
#guard parseDate "2026-2-03" == none
#guard parseDate "2026-13-01" == none
#guard parseDate "2026-00-01" == none
#guard parseDate "2026-01-00" == none
#guard parseDate "not-a-date" == none
#guard parseDate "2026-08-17" == some (2026, 8, 17)
#guard formatDate 2026 8 17 == "2026-08-17"
#guard formatDate 26 1 2 == "0026-01-02"
#guard midnightUtc "1970-01-01" == some 0
#guard midnightUtc "2026-08-17" == some 1786924800

/-! ## The round trip, over every day in range

Every day from 1000 to 3000, checked by execution: a bounded exhaustive check,
not a theorem over all `Int`. -/
private def roundTripsOver (lo hi : Int) : Bool :=
  let rec go (z : Int) (fuel : Nat) : Bool :=
    match fuel with
    | 0 => true
    | fuel + 1 =>
      if z > hi then true
      else
        let (y, m, d) := civilFromDays z
        if daysFromCivil y m d != z then false
        else go (z + 1) fuel
  go lo (hi - lo + 1).toNat

-- 1000-01-01 … 3000-01-01. Runs at build time; a regression cannot be committed.
#guard roundTripsOver (daysFromCivil 1000 1 1) (daysFromCivil 3000 1 1)

end Verified.Civil

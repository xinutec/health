import Verified.Civil
/-!
# How far back an API read may see

`days` is an integer in `[1, 365]`, default 30, rejected out of range, never
clamped: `days=400` is an error, not a year. Only an absent parameter defaults;
`""` reads as `0` and fails, so a host treating empty as absent would turn a
rejection into a 30-day read.

⚠ The share window caps the read: `sinceDateForSession` takes the later of
`today - days` and the share's `from`. Backwards, a recipient gets the owner's
whole history in a normal-looking response.

Pure and total. UNPROVEN; the `#guard`s pin its answers.
-/
namespace Verified.ApiWindow

def DAYS_MIN : Int := 1
def DAYS_MAX : Int := 365
def DAYS_DEFAULT : Int := 30

/-- Validate the `days` query parameter, given as the host's numeric coercion:
`none` only when absent, `NaN` when not a number, and `""` as `0`. `none` out
means reject. -/
def validateDays (v : Option Float) : Option Int :=
  match v with
  | none => some DAYS_DEFAULT
  | some x =>
    if x.isNaN then none
    -- `.int()` rejects a fractional value rather than truncating it.
    else if x != x.floor then none
    else
      let n := x.toInt64.toInt
      if n < DAYS_MIN || n > DAYS_MAX then none else some n

/-- `today - days` through the civil calendar (months, years, leap days), or
`none` when `today` does not parse. -/
def sinceDate (today : String) (days : Int) : Option String :=
  match Verified.Civil.parseDate today with
  | none => none
  | some (y, m, d) =>
    let z := Verified.Civil.daysFromCivil y m d
    let (y', m', d') := Verified.Civil.civilFromDays (z - days)
    some (Verified.Civil.formatDate y' m' d')

/-- The earliest date this request may see: the later of `today - days` and the
share's start (`none` for the owner). String comparison is chronological for
`YYYY-MM-DD`, as in `Verified.Share.dateInShareWindow`. -/
def earliestVisible (today : String) (days : Int) (shareFrom : Option String) : Option String :=
  match sinceDate today days with
  | none => none
  | some owner =>
    match shareFrom with
    | none => some owner
    | some from_ => some (if owner < from_ then from_ else owner)

/-! ## Guards -/

-- Absent is the default; in-range values pass through.
#guard validateDays none == some DAYS_DEFAULT
#guard validateDays (some 7) == some 7
#guard validateDays (some 1) == some 1
#guard validateDays (some 365) == some 365
-- Rejected, not clamped. `days=400` is an error, not a year.
#guard validateDays (some 0) == none
#guard validateDays (some (-1)) == none
#guard validateDays (some 366) == none
#guard validateDays (some 100000) == none
-- `.int()` rejects a fraction rather than truncating.
#guard validateDays (some 7.5) == none
-- `Number("abc")` is NaN; `Number("")` is 0, which fails the minimum.
#guard validateDays (some (0.0 / 0.0)) == none
#guard validateDays (some 0.0) == none

-- Plain subtraction, then the rollovers `Date.setDate` handles.
#guard sinceDate "2026-08-22" 1 == some "2026-08-21"
#guard sinceDate "2026-08-22" 30 == some "2026-07-23"
#guard sinceDate "2026-08-22" 365 == some "2025-08-22"
#guard sinceDate "2026-03-01" 1 == some "2026-02-28"
#guard sinceDate "2026-01-01" 1 == some "2025-12-31"
#guard sinceDate "2026-03-01" 60 == some "2025-12-31"
-- A leap day. 2024 is a leap year, so the day before 1 March is 29 February.
#guard sinceDate "2024-03-01" 1 == some "2024-02-29"
#guard sinceDate "2024-03-01" 2 == some "2024-02-28"
#guard sinceDate "not-a-date" 1 == none

-- The owner is bounded only by `days`.
#guard earliestVisible "2026-08-22" 30 none == some "2026-07-23"
-- A share recipient asking for a wide window gets their own start instead.
#guard earliestVisible "2026-08-22" 365 (some "2026-08-11") == some "2026-08-11"
#guard earliestVisible "2026-08-22" 30 (some "2026-08-11") == some "2026-08-11"
-- …and a narrow request is not widened to the share's start.
#guard earliestVisible "2026-08-22" 7 (some "2026-08-11") == some "2026-08-15"
#guard earliestVisible "2026-08-22" 1 (some "2026-08-11") == some "2026-08-21"

end Verified.ApiWindow

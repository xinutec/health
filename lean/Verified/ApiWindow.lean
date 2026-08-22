import Verified.Civil
/-!
# How far back an API read may see (port of `src/routes/api.ts`)

Two rules in front of every multi-day read. One is a convenience and one is a
security boundary, and they are here together because the second is three lines.

## `days` is VALIDATED, not clamped

`z.coerce.number().int().min(1).max(365).default(30)`. Zod's `.min`/`.max`
REJECT — they do not narrow — so `days=400` is an error, not a year. That
distinction is the whole reason this is written down: a clamp answers a bad
request with a plausible window, and the caller never learns it asked for
something impossible.

⚠ Absent is the only input that becomes the default. `""` is NOT absent: JS
coerces it to `0`, which fails the minimum. A host that maps an empty query
parameter to "no parameter" turns a rejection into a 30-day read.

## The share window CAPS the read, whatever `days` says

`sinceDateForSession` takes the LATER of `today - days` and the share's `from`.
A recipient asking for 365 days gets their window and nothing more.

⚠ **Getting this comparison backwards hands a recipient the owner's whole
history, and the response looks entirely normal** — same shape, same columns,
just more of them. There is no error to notice.

Pure and total. UNPROVEN; every `#guard` is what `src/routes/api.ts` and its zod
schema produced under Node — see `lean/experiments/apiwindow-refs.mts`.
-/
namespace Verified.ApiWindow

def DAYS_MIN : Int := 1
def DAYS_MAX : Int := 365
def DAYS_DEFAULT : Int := 30

/-- Validate the `days` query parameter.

The argument is what JS `Number(...)` made of it: `none` ONLY when the parameter
was absent, `NaN` when it was present and not a number. `none` OUT means reject.

⚠ The host must reproduce `Number`'s coercion, including `Number("") == 0`. See
the module note for what mapping `""` to absent would do. -/
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

/-- `today - days`, as a civil date. `none` when `today` does not parse.

⚠ Counting in DAYS, through the civil calendar — the TypeScript uses
`Date.setDate`, which rolls months and years and handles a leap day. The guards
below pin exactly those cases, because they are the ones a hand-rolled
subtraction gets wrong. -/
def sinceDate (today : String) (days : Int) : Option String :=
  match Verified.Civil.parseDate today with
  | none => none
  | some (y, m, d) =>
    let z := Verified.Civil.daysFromCivil y m d
    let (y', m', d') := Verified.Civil.civilFromDays (z - days)
    some (Verified.Civil.formatDate y' m' d')

/-- The earliest date this request may see.

`shareFrom` is the share window's start, or `none` for the owner. The answer is
the LATER of the two bounds, so a share strictly caps the read.

⚠ String comparison is correct here and only because `YYYY-MM-DD` orders
lexicographically as it orders chronologically — the same reason
`Verified.Share.dateInShareWindow` compares that way. -/
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
-- ⚠ REJECTED, not clamped. `days=400` is an error, not a year.
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
-- ⚠ A LEAP DAY. 2024 is a leap year, so the day before 1 March is 29 February.
#guard sinceDate "2024-03-01" 1 == some "2024-02-29"
#guard sinceDate "2024-03-01" 2 == some "2024-02-28"
#guard sinceDate "not-a-date" 1 == none

-- The owner is bounded only by `days`.
#guard earliestVisible "2026-08-22" 30 none == some "2026-07-23"
-- ⚠ A share recipient asking for a WIDE window gets their own start instead.
#guard earliestVisible "2026-08-22" 365 (some "2026-08-11") == some "2026-08-11"
#guard earliestVisible "2026-08-22" 30 (some "2026-08-11") == some "2026-08-11"
-- …and a NARROW request is not widened to the share's start.
#guard earliestVisible "2026-08-22" 7 (some "2026-08-11") == some "2026-08-15"
#guard earliestVisible "2026-08-22" 1 (some "2026-08-11") == some "2026-08-21"

end Verified.ApiWindow

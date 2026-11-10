import Verified.Civil

/-!
# Share links

A share token gives an unauthenticated recipient read access to a user's last N
days. Generating the token reads the CSPRNG, which is IO and stays in Rust; the
window arithmetic and the clamp are total functions guarding what a recipient
can see, how far back a link reaches, so they live here. A `days_back` reaching
0 or below silently disables a share; one past the maximum hands out more
history than the settings UI can express.

The date arithmetic is `Verified.Civil`'s.
-/

namespace Verified.Share

/-- Lower bound on a share window. -/
def SHARE_DAYS_MIN : Int := 1
/-- Upper bound on a share window — matches the settings UI's input max. -/
def SHARE_DAYS_MAX : Int := 365

/-- Compose the public URL sent to a recipient.

Strips one trailing slash. Not `trimRight '/'`: a base URL of
`https://h.example//` is a configuration mistake, and collapsing it would hide
the mistake behind a URL that works. -/
def buildShareUrl (baseUrl : String) (token : String) : String :=
  let trimmed := if baseUrl.endsWith "/" then (baseUrl.dropEnd 1).toString else baseUrl
  trimmed ++ "/share/" ++ token

/-- Inclusive `[from, to]` date range for a share with this `days_back`.

`today` is the most recent date the recipient may see. `none` for `daysBack ≤ 0`,
which the caller treats as "share disabled", and `none` when `today` does not
parse, rather than a `"NaN-NaN-NaN"` string reaching the database. -/
def shareableDateRange (today : String) (daysBack : Int) : Option (String × String) :=
  if daysBack ≤ 0 then none
  else match Verified.Civil.parseDate today with
    | none => none
    | some (y, m, d) =>
      let z := Verified.Civil.daysFromCivil y m d
      let (fy, fm, fd) := Verified.Civil.civilFromDays (z - (daysBack - 1))
      some (Verified.Civil.formatDate fy fm fd, today)

/-- Validate and clamp a requested window to `[SHARE_DAYS_MIN, SHARE_DAYS_MAX]`.

Takes an `Option Int`: whether the input is a finite integer at all is the
deserialiser's question. `none` in means `none` out, so the caller keeps its
choice between defaulting (on create) and rejecting (on update). -/
def clampShareDaysBack (value : Option Int) : Option Int :=
  match value with
  | none => none
  | some v => some (max SHARE_DAYS_MIN (min SHARE_DAYS_MAX v))

/-- May a share-viewer see this date?

The window is INCLUSIVE at both ends, and it is the same `[from, to]`
{@link shareableDateRange} produced — a viewer who may see the boundary day must
be able to load it.

String comparison, deliberately: `YYYY-MM-DD` orders lexicographically as it
does chronologically, and parsing first would add a failure mode. A malformed
date sorts somewhere and is refused or admitted consistently; it never throws.

⚠ The DEFAULT IS REFUSAL at the call site, not here. This answers "is it in the
window" for a caller that has already established there IS a window; a session
with no share-viewer is not a share-viewer with an empty window, and conflating
them would silently open every date. -/
def dateInShareWindow (date «from» to : String) : Bool :=
  «from» ≤ date && date ≤ to

/-! ## Guards -/

#guard buildShareUrl "https://h.example" "abc" == "https://h.example/share/abc"
#guard buildShareUrl "https://h.example/" "abc" == "https://h.example/share/abc"
-- One slash only — a doubled slash is a config error and stays visible.
#guard buildShareUrl "https://h.example//" "abc" == "https://h.example//share/abc"
#guard buildShareUrl "https://h.example/sub" "tok-123" == "https://h.example/sub/share/tok-123"

#guard shareableDateRange "2026-08-17" 1 == some ("2026-08-17", "2026-08-17")
#guard shareableDateRange "2026-08-17" 7 == some ("2026-08-11", "2026-08-17")
#guard shareableDateRange "2026-08-17" 0 == none
#guard shareableDateRange "2026-08-17" (-3) == none
-- Across a month, a year, and a leap day.
#guard shareableDateRange "2026-03-02" 3 == some ("2026-02-28", "2026-03-02")
#guard shareableDateRange "2024-03-02" 3 == some ("2024-02-29", "2024-03-02")
#guard shareableDateRange "2027-01-02" 4 == some ("2026-12-30", "2027-01-02")
-- The century rules: 1900 is not a leap year, 2000 is.
#guard shareableDateRange "1900-03-01" 2 == some ("1900-02-28", "1900-03-01")
#guard shareableDateRange "2000-03-01" 2 == some ("2000-02-29", "2000-03-01")
-- The widest window the settings UI can express.
#guard shareableDateRange "2026-08-17" 365 == some ("2025-08-18", "2026-08-17")
-- An unparsable `today`.
#guard shareableDateRange "not-a-date" 7 == none
#guard shareableDateRange "2026-02-30" 7 == none

#guard clampShareDaysBack none == none
#guard clampShareDaysBack (some 30) == some 30
#guard clampShareDaysBack (some 0) == some 1
#guard clampShareDaysBack (some (-5)) == some 1
#guard clampShareDaysBack (some 100000) == some 365
#guard clampShareDaysBack (some 365) == some 365
#guard clampShareDaysBack (some 1) == some 1


-- The window is inclusive at both ends: a viewer who may see the boundary day
-- must be able to load it.
#guard dateInShareWindow "2026-08-17" "2026-08-11" "2026-08-17" == true
#guard dateInShareWindow "2026-08-11" "2026-08-11" "2026-08-17" == true
#guard dateInShareWindow "2026-08-14" "2026-08-11" "2026-08-17" == true
#guard dateInShareWindow "2026-08-10" "2026-08-11" "2026-08-17" == false
#guard dateInShareWindow "2026-08-18" "2026-08-11" "2026-08-17" == false
-- A one-day share admits exactly its one day.
#guard dateInShareWindow "2026-08-17" "2026-08-17" "2026-08-17" == true
#guard dateInShareWindow "2026-08-16" "2026-08-17" "2026-08-17" == false

end Verified.Share

import Verified.Civil
/-!
# The raw recovery picture

`/internal/recovery` gives coach three daily streams, each with its freshest
value and baseline. No readiness score: coach owns that judgment, and two
scorers would disagree about what a bad day is.

`recoveryAsOf` takes a day, not today: coach's ledger judges a past session
against what it asked that morning, eased when under-recovered.

With one reading the baseline mean is that reading and `n` is 0, so a z-score
is 0, "no information yet", not huge. Variance divides by `n`: the population
of observed days.

Pure and total. UNPROVEN.
-/
namespace Verified.Recovery

/-- Days of trailing history a baseline is drawn from. -/
def BASELINE_DAYS : Int := 28

/-- Widest range `/recovery/history` answers in one call. Wider is refused, not
truncated into something that looks complete. -/
def MAX_SPAN_DAYS : Int := 400

/-- One day's reading. `none` is a no-wear night, which is dropped rather than
treated as zero — a missing night is not a night of no sleep. -/
structure Daily where
  date : String
  value : Option Float
  deriving Repr

/-- The freshest value and the baseline behind it. -/
structure Stat where
  latest : Float
  mean : Float
  sd : Float
  n : Int
  deriving Repr

private def sortByDate (xs : List (String × Float)) : List (String × Float) :=
  xs.mergeSort (fun a b => a.1 ≤ b.1)

/-- The latest reading and the mean/sd of the days before it.

`none` when the series has no readings at all. -/
def latestAndBaseline (series : List Daily) : Option Stat :=
  let clean := sortByDate (series.filterMap (fun d =>
    match d.value with | none => none | some v => some (d.date, v)))
  match clean.getLast? with
  | none => none
  | some (_, latest) =>
    let base := (clean.dropLast).map (·.2)
    if base.isEmpty then
      -- mean = latest, n = 0. See the module note.
      some { latest, mean := latest, sd := 0.0, n := 0 }
    else
      let n := base.length
      let mean := base.foldl (· + ·) 0.0 / n.toFloat
      let variance := (base.foldl (fun acc v => acc + (v - mean) * (v - mean)) 0.0) / n.toFloat
      some { latest, mean, sd := variance.sqrt, n := Int.ofNat n }

/-- The readings on or before `day`, within the baseline window: no future for
a past morning, and no baseline widening with account age. -/
def withinBaseline (series : List Daily) (day : String) : List Daily :=
  match Verified.Civil.parseDate day with
  | none => []
  | some (y, m, d) =>
    let z := Verified.Civil.daysFromCivil y m d
    let (fy, fm, fd) := Verified.Civil.civilFromDays (z - BASELINE_DAYS)
    let floor := Verified.Civil.formatDate fy fm fd
    series.filter (fun r => floor ≤ r.date && r.date ≤ day)

/-- Is this range answerable in one call? -/
def spanIsAnswerable (from_ to : String) : Bool :=
  match Verified.Civil.parseDate from_, Verified.Civil.parseDate to with
  | some (fy, fm, fd), some (ty, tm, td) =>
    let a := Verified.Civil.daysFromCivil fy fm fd
    let b := Verified.Civil.daysFromCivil ty tm td
    a ≤ b && (b - a + 1) ≤ MAX_SPAN_DAYS
  | _, _ => false

/-! ## Guards -/

private def d (date : String) (v : Float) : Daily := { date, value := some v }
private def gap (date : String) : Daily := { date, value := none }

-- No readings at all.
#guard (latestAndBaseline []).isNone
#guard (latestAndBaseline [gap "2026-08-01"]).isNone

-- One reading: the baseline is itself, and n says there is no information.
#guard (latestAndBaseline [d "2026-08-01" 50.0]).map (·.latest) == some 50.0
#guard (latestAndBaseline [d "2026-08-01" 50.0]).map (·.mean) == some 50.0
#guard (latestAndBaseline [d "2026-08-01" 50.0]).map (·.sd) == some 0.0
#guard (latestAndBaseline [d "2026-08-01" 50.0]).map (·.n) == some 0

-- The latest is by date, not by position in the list.
#guard (latestAndBaseline [d "2026-08-03" 30.0, d "2026-08-01" 10.0, d "2026-08-02" 20.0]).map (·.latest)
       == some 30.0
#guard (latestAndBaseline [d "2026-08-03" 30.0, d "2026-08-01" 10.0, d "2026-08-02" 20.0]).map (·.mean)
       == some 15.0
#guard (latestAndBaseline [d "2026-08-03" 30.0, d "2026-08-01" 10.0, d "2026-08-02" 20.0]).map (·.n)
       == some 2

-- A no-wear night is dropped, not counted as zero.
#guard (latestAndBaseline [d "2026-08-01" 10.0, gap "2026-08-02", d "2026-08-03" 30.0]).map (·.mean)
       == some 10.0

-- Population sd: values 10 and 20 about a mean of 15 give exactly 5.
#guard (latestAndBaseline [d "2026-08-01" 10.0, d "2026-08-02" 20.0, d "2026-08-03" 30.0]).map (·.sd)
       == some 5.0

-- The window is inclusive at both ends and 28 days wide.
#guard (withinBaseline [d "2026-08-22" 1.0] "2026-08-22").length == 1
#guard (withinBaseline [d "2026-07-25" 1.0] "2026-08-22").length == 1
#guard (withinBaseline [d "2026-07-24" 1.0] "2026-08-22").length == 0
-- The future is excluded: a question about a past morning must not see it.
#guard (withinBaseline [d "2026-08-23" 1.0] "2026-08-22").length == 0

#guard spanIsAnswerable "2026-08-01" "2026-08-22" == true
#guard spanIsAnswerable "2026-08-22" "2026-08-22" == true
-- Backwards is refused, not silently swapped.
#guard spanIsAnswerable "2026-08-22" "2026-08-01" == false
#guard spanIsAnswerable "2025-01-01" "2026-08-22" == false
#guard spanIsAnswerable "not-a-date" "2026-08-22" == false

end Verified.Recovery

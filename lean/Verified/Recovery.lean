import Verified.Civil
/-!
# The raw recovery picture (port of `src/stats.ts` and `src/routes/internal.ts`)

`/internal/recovery` answers another service — coach — with three daily streams
and, for each, the freshest value plus the baseline it should be judged against.

⚠ DELIBERATELY UNOPINIONATED. There is no readiness score here and there must
not be: health does not know what readiness means, and coach owns that judgment.
If both apps scored it they would drift on what a bad day is, and the athlete
would be told two different things.

## Why a PAST morning is anyone's business

Coach's prediction-error ledger judges each logged session against what it asked
that day, and it asks for less when the athlete was under-recovered. Without
knowing that, full compliance with an eased ask reads as falling short — a badly
slept night recorded as the athlete failing, which then holds their progression
back. So the ledger must be able to ask what was known on a given morning, which
is why `recoveryAsOf` takes the day rather than assuming today.

## The empty-baseline case is not zero

⚠ With one reading and nothing behind it, the baseline mean is THE READING
ITSELF and `n` is 0 — not a mean of zero. A zero mean would make the first
reading look enormously above baseline; this way any z-score the caller computes
is 0, which is the honest "no information yet". `n` is what tells them so.

⚠ The variance divides by `n`, not `n - 1`: this is the population of days
observed, not a sample drawn from a larger one.

Pure and total. UNPROVEN.
-/
namespace Verified.Recovery

/-- Days of trailing history a baseline is drawn from. -/
def BASELINE_DAYS : Int := 28

/-- Widest range `/recovery/history` will answer in one call.

⚠ A refusal, not a truncation. Answering a 10-year request with 400 days would
look like a complete answer to a caller who asked for more. -/
def MAX_SPAN_DAYS : Int := 400

/-- One day's reading. `none` is a no-wear night, which is DROPPED rather than
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

/-- The latest reading and the mean/sd of the days BEFORE it.

`none` when the series has no readings at all. -/
def latestAndBaseline (series : List Daily) : Option Stat :=
  let clean := sortByDate (series.filterMap (fun d =>
    match d.value with | none => none | some v => some (d.date, v)))
  match clean.getLast? with
  | none => none
  | some (_, latest) =>
    let base := (clean.dropLast).map (·.2)
    if base.isEmpty then
      -- ⚠ mean = latest, n = 0. See the module note.
      some { latest, mean := latest, sd := 0.0, n := 0 }
    else
      let n := base.length
      let mean := base.foldl (· + ·) 0.0 / n.toFloat
      let variance := (base.foldl (fun acc v => acc + (v - mean) * (v - mean)) 0.0) / n.toFloat
      some { latest, mean, sd := variance.sqrt, n := Int.ofNat n }

/-- The readings on or before `day`, no older than the baseline window.

⚠ Both ends matter. Without the upper bound a query about a past morning would
see the future; without the lower bound the baseline would creep wider the
longer the account has existed, and an old reading would quietly still count. -/
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

-- ⚠ ONE reading: the baseline is itself, and n says there is no information.
#guard (latestAndBaseline [d "2026-08-01" 50.0]).map (·.latest) == some 50.0
#guard (latestAndBaseline [d "2026-08-01" 50.0]).map (·.mean) == some 50.0
#guard (latestAndBaseline [d "2026-08-01" 50.0]).map (·.sd) == some 0.0
#guard (latestAndBaseline [d "2026-08-01" 50.0]).map (·.n) == some 0

-- The latest is by DATE, not by position in the list.
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
-- ⚠ The FUTURE is excluded: a question about a past morning must not see it.
#guard (withinBaseline [d "2026-08-23" 1.0] "2026-08-22").length == 0

#guard spanIsAnswerable "2026-08-01" "2026-08-22" == true
#guard spanIsAnswerable "2026-08-22" "2026-08-22" == true
-- ⚠ Backwards is refused, not silently swapped.
#guard spanIsAnswerable "2026-08-22" "2026-08-01" == false
#guard spanIsAnswerable "2025-01-01" "2026-08-22" == false
#guard spanIsAnswerable "not-a-date" "2026-08-22" == false

end Verified.Recovery

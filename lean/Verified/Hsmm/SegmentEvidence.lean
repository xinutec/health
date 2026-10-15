import Verified.Hsmm.Emissions
import Verified.Hsmm.Observation
import Verified.Hsmm.FloatScore
/-!
# A segment's net-displacement window

What `SegmentEmission` scores a segment's displacement on: the net displacement
between the fixes bracketing the segment, the slop of those fixes outside its
minutes (which widens the spread), and its measured step total — resolved from
the observation tensor once per `(length, end)` and shared by every state.
-/
namespace Verified.Hsmm.SegmentEvidence


/-- Unattributable-motion spread per minute of bracket slop (m/min). -/
def SLOP_SPEED_M_PER_MIN : Float := 500
/-- Caller-resolved segment geometry: net displacement between the bracketing
    fixes, the (already-squared) slop variance, and the measured step total. -/
structure Window where
  dispM : Float
  slopVar : Float
  steps : Float

/-! ## Window resolution over the observation tensor

A prefix sum of MEASURED cadence for the O(1) step total, and the bracketing
`prevGpsFix` / `nextGpsFix` with their slop (fix time outside the segment's own
minutes). The only transcendental is `haversineMeters` (≤1 ULP); the slop and
step arithmetic is exact. -/

open Verified.Hsmm.Observation (ObsRow Fix)
open Verified.Hsmm.FloatScore (haversineMeters)

/-- Prefix sums of MEASURED cadence: `pref[i] = Σ_{k<i} cadence(k)` (absent → 0),
    so a segment's step total is one subtraction. -/
def stepPrefix (obs : Array ObsRow) : Array Float :=
  -- Starts at one entry and only grows, so the running total is always there.
  obs.foldl (init := #[0.0]) fun a o => a.push (a.back?.getD 0 + o.cadence.getD 0)

/-- The caller-side `Window` for `[startIndex, segEnd]`, or `none` ("assert
    nothing") when a bracketing fix is missing or non-advancing. `startIndex` may
    be negative for early segments; it is clamped for the `first`/step lookups
    exactly as the TS `Math.max(0, startIndex)`. -/
def windowFor (obs : Array ObsRow) (pref : Array Float) (startIndex segEnd : Int) : Option Window :=
  if hse : segEnd < 0 ∨ segEnd ≥ (obs.size : Int) then none
  else
    let loIdx := (max 0 startIndex).toNat
    if hlo : loIdx ≥ obs.size then none
    else
      let first := obs[loIdx]
      let last := obs[segEnd.toNat]'(by omega)
      match first.prevGpsFix, last.nextGpsFix with
      | some before, some after =>
        if decide (after.ts ≤ before.ts) then none
        else
          let segStartTs := first.ts
          let segEndTs := last.ts + 60
          let slopMin := ((max 0 (segStartTs - before.ts)).toNat.toFloat
                        + (max 0 (after.ts - segEndTs)).toNat.toFloat) / 60
          let sl := SLOP_SPEED_M_PER_MIN * slopMin
          let hiIdx := (min (obs.size : Int) (segEnd + 1)).toNat
          -- `pref` is `stepPrefix obs`, one longer than the tensor; a shorter
          -- table (not constructible) asserts no steps.
          some ⟨haversineMeters before.lat before.lon after.lat after.lon,
                sl * sl, (pref[hiIdx]?).getD 0 - (pref[loIdx]?).getD 0⟩
      | _, _ => none

/-- The window of the segment of length `d` ending at `segEnd`. It depends on
    the segment and not on the state, so the duration build resolves it once per
    `(d, segEnd)` and scores every state class from it (#1774). -/
def windowAt (obs : Array ObsRow) (pref : Array Float) (d segEnd : Nat) : Option Window :=
  windowFor obs pref ((segEnd : Int) - (d : Int) + 1) (segEnd : Int)

-- A bracketed blackout and a variant with three minutes of right slop.
private def sev (i : Nat) (prev next : Option Fix) : ObsRow :=
  { ts := 1000 + (i : Int) * 60, gps := none, hr := none, cadence := some 100,
    hourLocal := 0, dayOfWeekLocal := 0, inBed := false, roadDistM := none, railDistM := none,
    reacquireAgeMin := none, prevGpsFix := prev, nextGpsFix := next }
private def sevObs : Array ObsRow := #[
  sev 0 none none,
  sev 1 (some ⟨1060, 51.5, -0.1⟩) none,          -- segStart bracket (slop 0 left)
  sev 2 none none, sev 3 none none, sev 4 none none,
  sev 5 none (some ⟨1360, 51.508, -0.1⟩),        -- segEnd bracket (segEndTs=1360, slop 0)
  sev 6 none (some ⟨1600, 51.508, -0.1⟩),        -- right-slop variant (after 1600 > 1420)
  sev 7 none none]
private def sevPref : Array Float := stepPrefix sevObs

#guard stepPrefix sevObs == #[0, 100, 200, 300, 400, 500, 600, 700, 800]
-- 890 m between the brackets, no slop, 500 steps.
#guard (windowAt sevObs sevPref 5 5).map (fun w => (w.slopVar, w.steps)) == some (0, 500)
#guard (windowAt sevObs sevPref 5 5).any fun w => w.dispM > 889 && w.dispM < 891
-- Starting at minute 2: no left bracket, so no window.
#guard (windowAt sevObs sevPref 5 6).isNone
-- Three minutes of right slop at 500 m a minute, 600 steps.
#guard (windowAt sevObs sevPref 6 6).map (fun w => (w.slopVar, w.steps)) == some (2250000, 600)

end Verified.Hsmm.SegmentEvidence

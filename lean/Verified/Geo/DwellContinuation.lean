import Verified.Geo.SegmentMerge
import Verified.Geo.DayState
/-!
# Dwell-prior continuation (port of `src/geo/dwell-continuation.ts`)

When the phone goes quiet at a strong focus_place with no closing bracket,
silence is evidence the user is still there. Model P(still here | Δ) as an
exponential survival curve in elapsed time, with mean dwell τ = totalDwell /
visits; continue the stay while P ≥ a floor. The whole module ports:

* `meanDwellSec` — τ, or `none` when the stats can't support one (exact).
* `dwellSurvival` — `exp(-max(0,Δ)/τ)` (≤1 ULP).
* `dwellContinuation` — how far to carry the stay: to where P hits the floor
  (`Δ = τ·ln(1/floor)`, `Math.round`ed), clamped to the day end; `none` when
  weakly established / unusable / no trailing room.
* `applyDwellContinuation` — the DayState orchestration around them: pick the
  anchor, bind the day's last stay centroid to a focus place, and splice the
  inferred stay in after the anchor.

UNPROVEN; pinned by the `#guard`s against Node/V8
(`lean/experiments/dwell-refs.mts`, `lean/experiments/apply-dwell-refs.mts`).
-/

namespace Verified.Geo.DwellContinuation

def MIN_ESTABLISH_DAYS : Int := 5
def CONFIDENCE_FLOOR : Float := 0.5

structure DwellPlace where
  totalDwellSec : Float
  visitCount : Int
  uniqueDays : Int
  deriving Inhabited

/-- Mean visit length τ (seconds), or `none` when the stats can't support one. -/
def meanDwellSec (p : DwellPlace) : Option Float :=
  if decide (p.visitCount ≤ 0) || decide (p.totalDwellSec ≤ 0) then none
  else some (p.totalDwellSec / Float.ofInt p.visitCount)

/-- P(still here) after `elapsedSec` at a place with mean dwell `tauSec`. -/
def dwellSurvival (elapsedSec tauSec : Float) : Float :=
  if decide (tauSec ≤ 0) then 0 else Float.exp ((- max 0 elapsedSec) / tauSec)

/-- How far to continue a stay forward: to where P hits `floor`, clamped to the
    day end. `(endTs, tauSec)`, or `none` when weakly established / unusable /
    no trailing room. -/
def dwellContinuation (place : DwellPlace) (lastEndTs dayEndTs : Int) (floor : Float := 0.5) :
    Option (Int × Float) :=
  if decide (place.uniqueDays < MIN_ESTABLISH_DAYS) then none
  else if decide (lastEndTs ≥ dayEndTs) then none
  else match meanDwellSec place with
    | none => none
    | some tau =>
      let horizonSec := tau * Float.log (1 / floor)
      let roundH := (Float.floor (horizonSec + 0.5)).toInt64.toInt
      let endTs := min dayEndTs (lastEndTs + roundH)
      if decide (endTs ≤ lastEndTs) then none else some (endTs, tau)

/-! ## Parity with Node/V8 (`lean/experiments/dwell-refs.mts`) -/

private def approxD (a b : Float) : Bool := Float.abs (a - b) < 1e-9

#guard meanDwellSec ⟨72000, 24, 30⟩ == some 3000
#guard meanDwellSec ⟨72000, 0, 30⟩ == none
#guard meanDwellSec ⟨0, 24, 30⟩ == none

#guard approxD (dwellSurvival 1800 3600) 0.6065306597126334
#guard dwellSurvival 0 3600 == 1
#guard dwellSurvival 3600 0 == 0
#guard dwellSurvival (-500) 3600 == 1

private def home : DwellPlace := ⟨1080000, 30, 30⟩   -- τ = 36000
private def cafe : DwellPlace := ⟨108000, 30, 10⟩     -- τ = 3600
#guard match dwellContinuation home 1000 100000 with | some (e, t) => e == 25953 && approxD t 36000 | none => false
#guard match dwellContinuation home 1000 10000 with | some (e, _) => e == 10000 | none => false
#guard dwellContinuation ⟨1080000, 30, 3⟩ 1000 100000 == none
#guard dwellContinuation home 100000 100000 == none
#guard dwellContinuation ⟨0, 30, 30⟩ 1000 100000 == none
#guard match dwellContinuation cafe 1000 100000 0.8 with | some (e, _) => e == 1803 | none => false

/-! ## `applyDwellContinuation` — the DayState orchestration

Pure: no DB, no clock. The caller supplies the day's states, its segments, the
mined focus places and the day end; this decides whether to splice one inferred
stay onto the trailing edge.

Three details the port has to carry, each of which reads as incidental and is
not:

* **The anchor is the latest-ENDING state that STARTED before the day end**, not
  the array's last element. Day-state assembly brackets the day with sleep
  windows, so the array can end with tomorrow's early-hours sleep while the last
  thing that actually happened today is an earlier daytime stay. The `endTs`
  comparison is strict, so a tie keeps the EARLIER state.
* **The stay centroid is the LAST segment carrying one**, found by reversing —
  not the last segment, which may have none.
* **An EMPTY `place` or `tz` string is falsy in the TS object spread**, so it is
  DROPPED rather than inherited as `""`. Same rule `EpisodeGeometry` records.
-/

open Verified.Hsmm.FloatScore (haversineMeters)
open Verified.Geo.DayState (DayState)

/-- Max distance to bind the day's last observed stay to a focus place. Falls
back to the place's own radius when that is larger. -/
def PLACE_MATCH_M : Float := 120

/-- The `KnownPlaceProjection` fields this pass reads. The dwell stats are
optional because fixtures captured before they existed replay as "no dwell
prior" — which the `?? 0` below turns into a refusal, not a guess. -/
structure DwellCandidate where
  centroidLat : Float
  centroidLon : Float
  radiusM : Option Float := none
  totalDwellSec : Option Float := none
  visitCount : Option Int := none
  uniqueDays : Int
  deriving Inhabited, BEq, Repr

/-- The pipeline's segment record. This pass reads and rewrites a subset of
it; it names the whole thing so that `Verified.Geo.PassFold` can hand the same
value to every pass in the cascade without a lossy projection at each hop. -/
abbrev Seg := Verified.Geo.SegmentMerge.Seg

/-- A JS-truthy string: `""` is falsy, so it is dropped rather than inherited. -/
private def truthy (s : Option String) : Option String :=
  match s with
  | some "" => none
  | other => other

/-- The index of the state to continue from: the latest-ENDING state that
STARTED before the day end. `none` when every state starts at or after it. -/
def anchorIndex (states : Array DayState) (dayEndTs : Int) : Option Nat := Id.run do
  let mut best : Option Nat := none
  for i in [0:states.size] do
    let s := states[i]!
    if s.startTs ≥ dayEndTs then continue
    match best with
    | some b => if s.endTs > states[b]!.endTs then best := some i
    | none => best := some i
  return best

/-- The day's last observed stay centroid — the LAST segment carrying one. -/
def lastCentroid (segments : Array Seg) : Option (Float × Float) :=
  segments.foldl (init := none) fun acc s =>
    match s.centroidLat, s.centroidLon with
    | some la, some lo => some (la, lo)
    | _, _ => acc

/-- The nearest focus place within reach of a coordinate, where reach is
`max PLACE_MATCH_M radiusM`. Improves only on STRICT `<`, so a distance tie
keeps the earlier candidate. -/
def bindPlace (lat lon : Float) (places : Array DwellCandidate) : Option DwellCandidate :=
  (places.foldl (init := (none, (1.0 : Float) / 0.0)) fun (best, bestD) p =>
    let d := haversineMeters lat lon p.centroidLat p.centroidLon
    let reach := max PLACE_MATCH_M (p.radiusM.getD 0)
    if decide (d ≤ reach) && decide (d < bestD) then (some p, d) else (best, bestD)).1

/-- Splice one inferred stay onto the trailing edge when the day's last stay
binds to an established focus place. The time past the survival horizon is left
BLANK — an honest gap beats a fabricated stay.

Composes after sleep-bridging and empty-day inference: where those already
carried the stay to the day end there is no trailing room, so this is a no-op.

Two of the TS's guards are PROVABLY unpinnable, and are kept as it has them so
nobody "simplifies" them away — both probed at zero:

* `states.isEmpty` is a short-circuit only. On an empty array `anchorIndex`
  returns `none`, which returns the array unchanged by the same path.
* `anchor.endTs ≥ dayEndTs` is shadowed by `dwellContinuation`'s own
  `lastEndTs ≥ dayEndTs`, which refuses the identical condition one step later. -/
def applyDwellContinuation
    (states : Array DayState) (segments : Array Seg)
    (knownPlaces : Array DwellCandidate) (dayEndTs : Int) : Array DayState :=
  if states.isEmpty then states
  else match anchorIndex states dayEndTs with
  | none => states
  | some ai =>
    let anchor := states[ai]!
    if anchor.mode ≠ "stationary" && anchor.mode ≠ "sleeping" then states
    else if anchor.endTs ≥ dayEndTs then states
    else match lastCentroid segments with
      | none => states
      | some (la, lo) =>
        match bindPlace la lo knownPlaces with
        | none => states
        | some best =>
          let place : DwellPlace :=
            ⟨best.totalDwellSec.getD 0, best.visitCount.getD 0, best.uniqueDays⟩
          match dwellContinuation place anchor.endTs dayEndTs with
          | none => states
          | some (endTs, _) =>
            let continuation : DayState :=
              { startTs := anchor.endTs, endTs, mode := "stationary",
                place := truthy anchor.place, inferred := some true,
                tz := truthy anchor.tz }
            -- Insert directly after the anchor, preserving relative order.
            states.extract 0 (ai + 1) ++ #[continuation] ++ states.extract (ai + 1) states.size

/-! ### Parity with Node/V8 (`lean/experiments/apply-dwell-refs.mts`) -/

section ApplyGuards

private def DAY_END : Int := 1000000

/-- τ = 36000 s (10 h), so the 0.5 floor puts the horizon at 36000·ln2 ≈ 24953 s. -/
private def homeFocus : DwellCandidate :=
  { centroidLat := 51.5, centroidLon := -0.2,
    totalDwellSec := some 1080000, visitCount := some 30, uniqueDays := 30 }

/-- A stay carrying only a centroid. The window and mode are what the shared
record requires, not what this pass reads — it looks at the centroid alone. -/
private def noCentroid : Seg := { startTs := 0, endTs := 0, mode := "stationary" }
private def at' (lat lon : Float) : Seg := { noCentroid with centroidLat := some lat, centroidLon := some lon }
private def here : Array Seg := #[at' 51.5 (-0.2)]

private def stay : DayState :=
  { startTs := 900000, endTs := 950000, mode := "stationary",
    place := some "Home", tz := some "Europe/London" }

private def cont (startTs endTs : Int) (place tz : Option String) : DayState :=
  { startTs, endTs, mode := "stationary", place, inferred := some true, tz }

private def run (states : Array DayState) (segments : Array Seg := here)
    (places : Array DwellCandidate := #[homeFocus]) (dayEndTs : Int := DAY_END) : Array DayState :=
  applyDwellContinuation states segments places dayEndTs

#guard run #[stay] == #[stay, cont 950000 974953 (some "Home") (some "Europe/London")]
#guard run #[] == #[]

-- The anchor is the latest-ENDING state that STARTED before the day end, so the
-- next night's sleep bracket cannot claim it, and the splice lands mid-array.
private def tomorrowSleep : DayState :=
  { startTs := 1010000, endTs := 1040000, mode := "sleeping", place := some "Home" }
#guard run #[stay, tomorrowSleep]
  == #[stay, cont 950000 974953 (some "Home") (some "Europe/London"), tomorrowSleep]

-- An `endTs` tie keeps the EARLIER state — which only shows through `place`.
private def first : DayState := { startTs := 900000, endTs := 950000, mode := "stationary", place := some "First" }
private def second : DayState := { startTs := 910000, endTs := 950000, mode := "stationary", place := some "Second" }
#guard run #[first, second] == #[first, cont 950000 974953 (some "First") none, second]

#guard run #[tomorrowSleep] == #[tomorrowSleep]
#guard run #[{ stay with mode := "walking" }] == #[{ stay with mode := "walking" }]
#guard run #[{ stay with mode := "sleeping" }]
  == #[{ stay with mode := "sleeping" }, cont 950000 974953 (some "Home") (some "Europe/London")]
#guard run #[{ stay with endTs := DAY_END }] == #[{ stay with endTs := DAY_END }]

-- An EMPTY string is falsy in the TS spread, so it is DROPPED, not inherited.
private def blank : DayState := { stay with place := some "", tz := some "" }
#guard run #[blank] == #[blank, cont 950000 974953 none none]
private def bare : DayState := { startTs := 900000, endTs := 950000, mode := "stationary" }
#guard run #[bare] == #[bare, cont 950000 974953 none none]

-- The centroid is the LAST segment carrying one, not the last segment…
#guard run #[stay] (here.push noCentroid) == #[stay, cont 950000 974953 (some "Home") (some "Europe/London")]
-- …and with two real centroids it is the LATER, which is what makes it the
-- day's last stay: only that one is in reach, so taking the first would refuse.
#guard run #[stay] #[at' 51.51 (-0.2), at' 51.5 (-0.2)]
  == #[stay, cont 950000 974953 (some "Home") (some "Europe/London")]
-- BOTH coordinates are required — a half-populated centroid is not one.
#guard run #[stay] #[noCentroid, { noCentroid with centroidLat := some 51.5 }] == #[stay]

-- The place match: within `max(120 m, radiusM)`, nearest wins, ties keep FIRST.
private def far : DwellCandidate := { homeFocus with centroidLat := 51.51 }   -- ~1.1 km
#guard run #[stay] here #[far] == #[stay]
#guard run #[stay] here #[{ far with radiusM := some 2000 }]
  == #[stay, cont 950000 974953 (some "Home") (some "Europe/London")]
-- The NEARER place wins even though it is second, and its shorter τ shows it.
#guard run #[stay] here #[{ homeFocus with centroidLat := 51.5008 }, { homeFocus with totalDwellSec := some 108000 }]
  == #[stay, cont 950000 952495 (some "Home") (some "Europe/London")]
-- Exactly equidistant: the first survives, and its LONGER τ shows it.
#guard run #[stay] here
    #[{ homeFocus with centroidLon := -0.2 + 0.0005 },
      { homeFocus with centroidLon := -0.2 - 0.0005, totalDwellSec := some 108000 }]
  == #[stay, cont 950000 974953 (some "Home") (some "Europe/London")]

-- The kernel's own refusals, reached THROUGH the pass.
#guard run #[stay] here #[{ homeFocus with uniqueDays := 4 }] == #[stay]
#guard run #[stay] here #[{ centroidLat := 51.5, centroidLon := -0.2, uniqueDays := 30 }] == #[stay]
-- Each missing stat refuses on its OWN, so the two `?? 0` defaults are pinned
-- separately: a fixture predating either field is a refusal, not a guess.
#guard run #[stay] here
    #[{ centroidLat := 51.5, centroidLon := -0.2, uniqueDays := 30, visitCount := some 30 }] == #[stay]
#guard run #[stay] here
    #[{ centroidLat := 51.5, centroidLon := -0.2, uniqueDays := 30, totalDwellSec := some 1080000 }] == #[stay]
-- τ = 1 s: a 0.69 s horizon ROUNDS UP to a one-second stay…
#guard run #[stay] here #[{ homeFocus with totalDwellSec := some 30, visitCount := some 30 }]
  == #[stay, cont 950000 950001 (some "Home") (some "Europe/London")]
-- …and τ = 0.7 s rounds to 0, which is no room at all.
#guard run #[stay] here #[{ homeFocus with totalDwellSec := some 21, visitCount := some 30 }] == #[stay]

end ApplyGuards

end Verified.Geo.DwellContinuation

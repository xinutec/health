import Verified.Hsmm.FloatScore
/-!
# HSMM→pipeline place-override decision leaves (port of `src/hmm/place-override.ts`)

`applyHsmmPlaceOverride` overlays the HSMM's place / train-line picks onto the
heuristic pipeline's segments. That record-cloning orchestration (over the full
`EnrichedSegment`) stays shell; here we port its pure DECISION leaves:

* `decideHsmmTrainOverride` — the weighted movement→train call (HSMM line
  support vs GPS road-following; not a veto).
* `findDominantTrainLineName` / `findDominantStationaryPlaceId` — the
  max-temporal-overlap winner over the HSMM segments across a pipeline
  segment's window (insertion-order tie-break, mirroring JS `Map`).
* `doorstepConsistent` — the #244 gate: a place whose centroid is >1.5 km from
  the stay's own GPS is a teleport, not a refinement.

Overlap/argmax are exact integer/discrete; the doorstep gate reuses the shared
`haversineMeters` (≤1 ULP). UNPROVEN; pinned by the `#guard`s against Node/V8.
-/

namespace Verified.Geo.PlaceOverride

open Verified.Hsmm.FloatScore (haversineMeters)

def MOVEMENT_TO_TRAIN_MIN_AVG_KMH : Float := 8
def MAX_PLACE_OVERRIDE_DISTANCE_M : Float := 1500

/-- The minimal HSMM segment shape these leaves read. -/
structure HmmSeg where
  startTs : Int
  endTs : Int
  mode : String
  lineName : Option String := none
  placeId : Option Int := none
  deriving Inhabited

/-- Should the HSMM's `train @ line` override the pipeline's movement label?
    Fires when line support outweighs road-following, above the walk/ride speed
    split. Not a veto. -/
def decideHsmmTrainOverride (avgSpeedKmh lineOverlapFraction : Float)
    (roadCorridorFraction : Option Float) : Bool :=
  if decide (avgSpeedKmh < MOVEMENT_TO_TRAIN_MIN_AVG_KMH) then false
  else if decide (lineOverlapFraction ≤ 0) then false
  else decide (lineOverlapFraction > roadCorridorFraction.getD 0)

/-- Add `v` to key `k`'s running total, preserving first-seen (insertion) order
    — the tie-break the JS `Map` argmax below relies on. -/
private def bumpOrdered {K : Type} [BEq K] (acc : List (K × Float)) (k : K) (v : Float) : List (K × Float) :=
  if acc.any (fun p => p.1 == k) then acc.map (fun p => if p.1 == k then (p.1, p.2 + v) else p)
  else acc ++ [(k, v)]

/-- First key with the maximum total (strict `>` keeps the earliest-inserted). -/
private def argmaxFirst {K : Type} (acc : List (K × Float)) : Option (K × Float) :=
  acc.foldl (fun best p => match best with
    | none => some p
    | some b => if decide (p.2 > b.2) then some p else some b) none

/-- Rail line the HSMM gives the most train-overlap-seconds across `[segStart,
    segEnd)`, with that overlap as a fraction of the segment duration. `none`
    when no train-with-known-line segment overlaps. Assumes time-sorted HSMM
    segments (true by construction). -/
def findDominantTrainLineName (segStart segEnd : Int) (hmm : List HmmSeg) :
    Option (String × Float) := Id.run do
  let mut counts : List (String × Float) := []
  for h in hmm do
    if decide (h.endTs ≤ segStart) then pure ()
    else if decide (h.startTs ≥ segEnd) then pure ()   -- sorted ⇒ same as TS `break`
    else if h.mode != "train" then pure ()
    else match h.lineName with
      | some ln =>
        if ln == "unknown_rail" then pure ()
        else
          let overlap := min segEnd h.endTs - max segStart h.startTs
          if decide (overlap > 0) then counts := bumpOrdered counts ln (Float.ofInt overlap)
      | none => pure ()
  match argmaxFirst counts with
  | some (line, best) => return some (line, best / max 1 (Float.ofInt (segEnd - segStart)))
  | none => return none

/-- Focus-place id the HSMM gives the most stationary-overlap-seconds across the
    window. `none` when no on-network stationary segment dominates. -/
def findDominantStationaryPlaceId (segStart segEnd : Int) (hmm : List HmmSeg) : Option Int := Id.run do
  let mut counts : List (Int × Float) := []
  for h in hmm do
    if decide (h.endTs ≤ segStart) then pure ()
    else if decide (h.startTs ≥ segEnd) then pure ()
    else if h.mode != "stationary" then pure ()
    else match h.placeId with
      | some pid =>
        let overlap := min segEnd h.endTs - max segStart h.startTs
        if decide (overlap > 0) then counts := bumpOrdered counts pid (Float.ofInt overlap)
      | none => pure ()
  match argmaxFirst counts with
  | some (id, _) => return some id
  | none => return none

/-- Doorstep-consistency gate (#244): the HSMM place is a refinement only if its
    centroid is within `MAX_PLACE_OVERRIDE_DISTANCE_M` of the stay's own GPS. -/
def doorstepConsistent (segLat segLon placeLat placeLon : Float) : Bool :=
  decide (haversineMeters segLat segLon placeLat placeLon ≤ MAX_PLACE_OVERRIDE_DISTANCE_M)

/-! ## Parity with Node/V8 (`lean/experiments/place-override-refs.mts`) -/

#guard decideHsmmTrainOverride 25 0.9 (some 0.2) == true
#guard decideHsmmTrainOverride 5 0.9 (some 0.2) == false
#guard decideHsmmTrainOverride 25 0.0 none == false
#guard decideHsmmTrainOverride 25 0.3 (some 0.8) == false
#guard decideHsmmTrainOverride 25 0.5 none == true
#guard decideHsmmTrainOverride 25 0.4 (some 0.4) == false

private def trainHmm : List HmmSeg := [
  ⟨0, 100, "train", some "Victoria", none⟩, ⟨100, 300, "train", some "Northern", none⟩,
  ⟨300, 400, "train", some "unknown_rail", none⟩, ⟨400, 500, "walking", none, none⟩]
private def approxP (a b : Float) : Bool := Float.abs (a - b) < 1e-9
#guard match findDominantTrainLineName 0 600 trainHmm with
  | some (l, f) => l == "Northern" && approxP f 0.3333333333333333
  | none => false
#guard match findDominantTrainLineName 0 150 trainHmm with
  | some (l, f) => l == "Victoria" && approxP f 0.6666666666666666
  | none => false
#guard findDominantTrainLineName 1000 2000 trainHmm == none

private def placeHmm : List HmmSeg := [
  ⟨0, 100, "stationary", none, some 7⟩, ⟨100, 400, "stationary", none, some 9⟩,
  ⟨400, 500, "stationary", none, none⟩, ⟨500, 600, "walking", none, some 3⟩]
#guard findDominantStationaryPlaceId 0 600 placeHmm == some 9
#guard findDominantStationaryPlaceId 0 150 placeHmm == some 7
#guard findDominantStationaryPlaceId 1000 2000 placeHmm == none

#guard doorstepConsistent 51.5 (-0.1) 51.5009 (-0.1) == true   -- ~100 m
#guard doorstepConsistent 51.5 (-0.1) 51.52 (-0.1) == false    -- ~2224 m

end Verified.Geo.PlaceOverride

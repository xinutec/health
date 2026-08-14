import Verified.Hsmm.FloatScore
import Verified.Geo.SegmentMerge
/-!
# HSMM→pipeline place-override decision leaves (port of `src/hmm/place-override.ts`)

`applyHsmmPlaceOverride` overlays the HSMM's place / train-line picks onto the
heuristic pipeline's segments. The WHOLE pass is here now — see "The pass itself"
below; this section is its decision leaves:

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

/-! ## Parity with Node/V8 (`lean/experiments/place-override-refs.mts`)

HISTORICAL NOTE on the leaf guards below. Their reference values were first
produced by a VERBATIM REIMPLEMENTATION of the two private helpers inside the
harness — my transcription checked against my transcription, which a shared
misreading passes. The harness no longer contains those copies: the composite
guards further down drive the real exported `applyHsmmPlaceOverride`, and they
reach the same leaves (H2/H3 the place argmax and its window, H16 the line
argmax, H16a/H16b the overlap FRACTION bracketed through the caller's own
threshold). These leaf guards are kept because they are cheaper to read, and
they are now corroborated rather than self-certified. -/

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

/-! ## The pass itself

`applyHsmmPlaceOverride` used to be listed here as shell — "that record-cloning
orchestration stays shell" — on the old rule that record sequencing belongs
outside Lean. The stay-split work superseded that rule: where the output RECORDS
are the answer rather than a decision about them, the rewrite ports. This is
such a pass, and it is wholly pure — `places` is a lookup table, not I/O.

Three arms, dispatched on the EFFECTIVE mode:

* `stationary` → the place override, gated by #244's doorstep test;
* already `train` → left alone, deliberately. The pipeline's own line
  attribution is finer-grained than per-line route-graph evidence, so
  train-vs-train is not adjudicated here;
* anything else → the weighted movement→train promotion.

## Probe survivors

33 perturbations, 30 fire. The three that do not, each with a reason rather than
a shrug:

* **`lineOverlapFraction ≤ 0` vs `< 0`.** Provably the same answer. `counts`
  only ever receives overlaps the `overlap > 0` test admitted, so any fraction
  reaching this line is strictly positive; and at exactly 0 the `<` form falls
  through to `0 > 0`, which is false too. Separating them needs a NEGATIVE
  `roadCorridorFraction`, and that field is a share of samples in [0, 1].
* **The `seg.place == some name` short-circuit.** A pure performance guard:
  removing it writes the value the segment already holds. No output can move.
* **The doorstep bar's `≤` vs `<`.** Needs a haversine landing exactly on
  1500.0 m — the same knife-edge as elsewhere in this port (one latitude ULP
  moves the output ~7.9e-10 m against an output ULP near 1e-13 m). The CONSTANT
  is bracketed on both sides: H7a at ~1.2 km overrides, H7 at ~3.2 km refuses.
-/

open Verified.Geo.SegmentMerge (Seg effectiveMode)

/-- What the pipeline knows about a focus place the HSMM can name. -/
structure PlaceLookup where
  displayName : Option String
  lat : Option Float
  lon : Option Float
  deriving Inhabited, BEq, Repr

/-- Generic clustering-bucket markers assigned by `assignDisplayNames`
(`src/geo/focus-places.ts`). These are NOT venue labels — they identify a
cluster's KIND (you sleep here sometimes) without naming the venue. The
pipeline's `bestPlace` lookup has already resolved a real venue name, and the
override must not overwrite it with the bucket marker. -/
def GENERIC_BUCKET_LABELS : List String := ["Stay"]

/-- `places.get(id)`. -/
def lookupPlace (places : List (Int × PlaceLookup)) (id : Int) : Option PlaceLookup :=
  (places.find? (·.1 == id)).map (·.2)

/-- The stationary arm. Every refusal returns the segment untouched. -/
def maybeOverridePlace (seg : Seg) (hmm : List HmmSeg) (places : List (Int × PlaceLookup)) : Seg :=
  match findDominantStationaryPlaceId seg.startTs seg.endTs hmm with
  | none => seg
  | some placeId =>
    match lookupPlace places placeId with
    | none => seg
    | some place =>
      match place.displayName with
      | none => seg
      | some name =>
        if GENERIC_BUCKET_LABELS.contains name then seg
        else if seg.place == some name then seg
        else
          -- The #244 doorstep gate. SKIPPED when the stay has no centroid: a
          -- truly GPS-dark stay legitimately anchors via the prior, and it is
          -- only when the stay's own GPS says otherwise that the override is a
          -- teleport rather than a refinement.
          match seg.centroidLat, seg.centroidLon, place.lat, place.lon with
          | some sLat, some sLon, some pLat, some pLon =>
            if doorstepConsistent sLat sLon pLat pLon then { seg with place := some name } else seg
          | _, _, _, _ => { seg with place := some name }

/-- The movement→train arm. -/
def maybeOverrideMovementToTrain (seg : Seg) (hmm : List HmmSeg) : Seg :=
  match findDominantTrainLineName seg.startTs seg.endTs hmm with
  | none => seg
  | some (line, overlapFraction) =>
    if !decideHsmmTrainOverride seg.avgSpeed overlapFraction seg.roadCorridorFraction then seg
    else
      -- Both `mode` and `refinedMode`, so the override sticks through to the
      -- display (which reads `refinedMode ?? mode`). The reason is REPLACED
      -- because the pipeline's biometric/cadence reasoning no longer applies.
      -- `vehicleKind` must go for the same reason and one more: it is the bus
      -- passes' judgement of the leg AS a road vehicle, and the day-state
      -- flattening ranks it ABOVE refinedMode — left in place it renders this
      -- train as a bus (#365).
      { seg with
        mode := "train", refinedMode := some "train",
        refinedReason := some s!"hsmm route evidence — {line}",
        wayName := some line, vehicleKind := none }

/-- Dispatch on the effective mode. -/
def maybeOverride (seg : Seg) (hmm : List HmmSeg) (places : List (Int × PlaceLookup)) : Seg :=
  let mode := effectiveMode seg
  if mode == "stationary" then maybeOverridePlace seg hmm places
  else if mode != "train" then maybeOverrideMovementToTrain seg hmm
  else seg

/-- Overlay the HSMM's place / train-line picks onto the pipeline's segments.
Each segment is decided independently; the count and order never change. -/
def applyHsmmPlaceOverride (segments : Array Seg) (hmm : Array HmmSeg)
    (places : List (Int × PlaceLookup)) : Array Seg :=
  segments.map fun seg => maybeOverride seg hmm.toList places

/-- The projection the guards compare: every field either arm can touch. -/
def projSeg (s : Seg) : String × Option String × Option String × Option String × Option String × Option String :=
  (s.mode, s.refinedMode, s.place, s.wayName, s.refinedReason, s.vehicleKind)

/-! ## Guards

GENERATED by `lean/experiments/place-override-refs.mts` — do not hand-edit.
Every value is what the real exported `applyHsmmPlaceOverride` returned.
-/

namespace Guards

private def PLACES : List (Int × PlaceLookup) := [
  (7, ⟨(some "Work"), (some 51.5308), (some (-0.1238))⟩),
  (9, ⟨(some "Home"), (some 51.5405), (some (-0.1425))⟩),
  (11, ⟨(some "Stay"), (some 51.5308), (some (-0.1238))⟩),
  (13, ⟨none, (some 51.5308), (some (-0.1238))⟩),
  (15, ⟨(some "Far Clinic"), (some 51.56), (some (-0.1238))⟩),
  (17, ⟨(some "Mid Clinic"), (some 51.5416), (some (-0.1238))⟩)]

-- H1: a stay the HSMM attributes to place 9 — overridden to its display name.
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000600, mode := "stationary", refinedMode := none, avgSpeed := 0.0, place := none, wayName := none, refinedReason := none, centroidLat := (some 51.5405), centroidLon := (some (-0.1425)), vehicleKind := none, roadCorridorFraction := none }]
    #[⟨1751000000, 1751000600, "stationary", none, (some 9)⟩] PLACES).map projSeg ==
  #[("stationary", none, (some "Home"), none, none, none)]

-- H2: two candidate places; the one with the most overlap SECONDS wins, not the first. The centroid sits at the WINNER, so the doorstep gate is not what decides.
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000600, mode := "stationary", refinedMode := none, avgSpeed := 0.0, place := none, wayName := none, refinedReason := none, centroidLat := (some 51.5405), centroidLon := (some (-0.1425)), vehicleKind := none, roadCorridorFraction := none }]
    #[⟨1751000000, 1751000100, "stationary", none, (some 7)⟩, ⟨1751000100, 1751000600, "stationary", none, (some 9)⟩] PLACES).map projSeg ==
  #[("stationary", none, (some "Home"), none, none, none)]

-- H3: the same pair over a shorter window, where the ORDER of the winner flips — 7 now holds more of it.
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000150, mode := "stationary", refinedMode := none, avgSpeed := 0.0, place := none, wayName := none, refinedReason := none, centroidLat := (some 51.5308), centroidLon := (some (-0.1238)), vehicleKind := none, roadCorridorFraction := none }]
    #[⟨1751000000, 1751000100, "stationary", none, (some 7)⟩, ⟨1751000100, 1751000600, "stationary", none, (some 9)⟩] PLACES).map projSeg ==
  #[("stationary", none, (some "Work"), none, none, none)]

-- H4: the dominant place is the generic bucket marker `Stay`. It names a cluster KIND, not a venue, so it must not overwrite anything — the pipeline's own place stands.
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000600, mode := "stationary", refinedMode := none, avgSpeed := 0.0, place := (some "Clinic C"), wayName := none, refinedReason := none, centroidLat := (some 51.5308), centroidLon := (some (-0.1238)), vehicleKind := none, roadCorridorFraction := none }]
    #[⟨1751000000, 1751000600, "stationary", none, (some 11)⟩] PLACES).map projSeg ==
  #[("stationary", none, (some "Clinic C"), none, none, none)]

-- H5: the dominant place has no display name — nothing to override with.
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000600, mode := "stationary", refinedMode := none, avgSpeed := 0.0, place := (some "Somewhere"), wayName := none, refinedReason := none, centroidLat := (some 51.5308), centroidLon := (some (-0.1238)), vehicleKind := none, roadCorridorFraction := none }]
    #[⟨1751000000, 1751000600, "stationary", none, (some 13)⟩] PLACES).map projSeg ==
  #[("stationary", none, (some "Somewhere"), none, none, none)]

-- H6: the HSMM agrees with the pipeline — an override that changes nothing.
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000600, mode := "stationary", refinedMode := none, avgSpeed := 0.0, place := (some "Work"), wayName := none, refinedReason := none, centroidLat := (some 51.5308), centroidLon := (some (-0.1238)), vehicleKind := none, roadCorridorFraction := none }]
    #[⟨1751000000, 1751000600, "stationary", none, (some 7)⟩] PLACES).map projSeg ==
  #[("stationary", none, (some "Work"), none, none, none)]

-- H7: #244 doorstep gate: the HSMM's place sits ~3.2 km from the stay's own GPS centroid. That is a teleport, not a refinement — the decoder filled a GPS-dark interior with a prior and won on overlap. Refused.
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000600, mode := "stationary", refinedMode := none, avgSpeed := 0.0, place := (some "Work"), wayName := none, refinedReason := none, centroidLat := (some 51.5308), centroidLon := (some (-0.1238)), vehicleKind := none, roadCorridorFraction := none }]
    #[⟨1751000000, 1751000600, "stationary", none, (some 15)⟩] PLACES).map projSeg ==
  #[("stationary", none, (some "Work"), none, none, none)]

-- H8: the SAME far place, but the stay has no centroid at all. A truly GPS-dark stay legitimately anchors via the prior, so the gate is skipped and the override lands.
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000600, mode := "stationary", refinedMode := none, avgSpeed := 0.0, place := (some "Work"), wayName := none, refinedReason := none, centroidLat := none, centroidLon := none, vehicleKind := none, roadCorridorFraction := none }]
    #[⟨1751000000, 1751000600, "stationary", none, (some 15)⟩] PLACES).map projSeg ==
  #[("stationary", none, (some "Far Clinic"), none, none, none)]

-- H9: the place id the HSMM names is not in the lookup — no override.
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000600, mode := "stationary", refinedMode := none, avgSpeed := 0.0, place := (some "Work"), wayName := none, refinedReason := none, centroidLat := (some 51.5308), centroidLon := (some (-0.1238)), vehicleKind := none, roadCorridorFraction := none }]
    #[⟨1751000000, 1751000600, "stationary", none, (some 99)⟩] PLACES).map projSeg ==
  #[("stationary", none, (some "Work"), none, none, none)]

-- H10: an off-network HSMM stay (no place id) and a walking one — neither is a candidate.
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000600, mode := "stationary", refinedMode := none, avgSpeed := 0.0, place := (some "Work"), wayName := none, refinedReason := none, centroidLat := (some 51.5308), centroidLon := (some (-0.1238)), vehicleKind := none, roadCorridorFraction := none }]
    #[⟨1751000000, 1751000300, "stationary", none, none⟩, ⟨1751000300, 1751000600, "walking", none, (some 9)⟩] PLACES).map projSeg ==
  #[("stationary", none, (some "Work"), none, none, none)]

-- H11: a DRIVING leg the HSMM calls a train on a known line, at ride speed and off any road corridor. Promoted: mode AND refinedMode both become train, the reason is rewritten, the line becomes the wayName — and `vehicleKind` is CLEARED, because the day-state flattening ranks it above refinedMode and would otherwise render this train as a bus (#365).
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000600, mode := "driving", refinedMode := none, avgSpeed := 25.0, place := none, wayName := none, refinedReason := (some "cadence says vehicle"), centroidLat := none, centroidLon := none, vehicleKind := (some "bus"), roadCorridorFraction := (some 0.1) }]
    #[⟨1751000000, 1751000600, "train", (some "Victoria"), none⟩] PLACES).map projSeg ==
  #[("train", (some "train"), none, (some "Victoria"), (some "hsmm route evidence — Victoria"), none)]

-- H12: the 2026-05-25 taxi: the HSMM credits a line the vehicle merely drove past, but the trace hugs roads throughout. Line support 0.25 loses to road-following 0.8 — refused, and this is a WEIGHING, not a veto.
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000600, mode := "driving", refinedMode := none, avgSpeed := 25.0, place := none, wayName := none, refinedReason := none, centroidLat := none, centroidLon := none, vehicleKind := none, roadCorridorFraction := (some 0.8) }]
    #[⟨1751000000, 1751000150, "train", (some "Circle"), none⟩] PLACES).map projSeg ==
  #[("driving", none, none, none, none, none)]

-- H13: walking pace under the 8 km/h split — movement to a tube entrance, not a ride.
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000600, mode := "walking", refinedMode := none, avgSpeed := 5.0, place := none, wayName := none, refinedReason := none, centroidLat := none, centroidLon := none, vehicleKind := none, roadCorridorFraction := (some 0.1) }]
    #[⟨1751000000, 1751000600, "train", (some "Victoria"), none⟩] PLACES).map projSeg ==
  #[("walking", none, none, none, none, none)]

-- H14: no GPS samples at all (an underground gap the HSMM reconstructed). The trace cannot contradict, so the HSMM stands.
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000600, mode := "driving", refinedMode := none, avgSpeed := 25.0, place := none, wayName := none, refinedReason := none, centroidLat := none, centroidLon := none, vehicleKind := none, roadCorridorFraction := none }]
    #[⟨1751000000, 1751000300, "train", (some "Victoria"), none⟩] PLACES).map projSeg ==
  #[("train", (some "train"), none, (some "Victoria"), (some "hsmm route evidence — Victoria"), none)]

-- H15: `unknown_rail` is not a line name — no candidate, no override.
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000600, mode := "driving", refinedMode := none, avgSpeed := 25.0, place := none, wayName := none, refinedReason := none, centroidLat := none, centroidLon := none, vehicleKind := none, roadCorridorFraction := (some 0.1) }]
    #[⟨1751000000, 1751000600, "train", (some "unknown_rail"), none⟩] PLACES).map projSeg ==
  #[("driving", none, none, none, none, none)]

-- H16: two lines; the one holding more overlap SECONDS wins and becomes the wayName.
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000600, mode := "driving", refinedMode := none, avgSpeed := 25.0, place := none, wayName := none, refinedReason := none, centroidLat := none, centroidLon := none, vehicleKind := none, roadCorridorFraction := (some 0.1) }]
    #[⟨1751000000, 1751000100, "train", (some "Victoria"), none⟩, ⟨1751000100, 1751000500, "train", (some "Northern"), none⟩] PLACES).map projSeg ==
  #[("train", (some "train"), none, (some "Northern"), (some "hsmm route evidence — Northern"), none)]

-- H16a: BRACKETING the private overlap fraction through the export. Northern holds 400 s of a 600 s segment, so the fraction is 0.666…; a road-corridor share of 0.66 loses to it and the override fires. With H16b just above, the fraction the caller never returns is pinned to an interval — the bus-matcher technique of reading a private value out of production code by bisecting its caller's threshold.
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000600, mode := "driving", refinedMode := none, avgSpeed := 25.0, place := none, wayName := none, refinedReason := none, centroidLat := none, centroidLon := none, vehicleKind := none, roadCorridorFraction := (some 0.66) }]
    #[⟨1751000000, 1751000100, "train", (some "Victoria"), none⟩, ⟨1751000100, 1751000500, "train", (some "Northern"), none⟩] PLACES).map projSeg ==
  #[("train", (some "train"), none, (some "Northern"), (some "hsmm route evidence — Northern"), none)]

-- H16b: the same segment against 0.67, which beats the fraction — refused. So 0.66 < overlapFraction ≤ 0.67, without any test-only export.
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000600, mode := "driving", refinedMode := none, avgSpeed := 25.0, place := none, wayName := none, refinedReason := none, centroidLat := none, centroidLon := none, vehicleKind := none, roadCorridorFraction := (some 0.67) }]
    #[⟨1751000000, 1751000100, "train", (some "Victoria"), none⟩, ⟨1751000100, 1751000500, "train", (some "Northern"), none⟩] PLACES).map projSeg ==
  #[("driving", none, none, none, none, none)]

-- H7a: the HSMM place sits ~1.2 km from the stay centroid — inside the 1500 m doorstep bar, outside a 1000 m one. With H7 at 3.2 km above, the bar is straddled.
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000600, mode := "stationary", refinedMode := none, avgSpeed := 0.0, place := (some "Work"), wayName := none, refinedReason := none, centroidLat := (some 51.5308), centroidLon := (some (-0.1238)), vehicleKind := none, roadCorridorFraction := none }]
    #[⟨1751000000, 1751000600, "stationary", none, (some 17)⟩] PLACES).map projSeg ==
  #[("stationary", none, (some "Mid Clinic"), none, none, none)]

-- H2a: two places holding EXACTLY equal overlap (300 s each of a 600 s window). The argmax keeps the FIRST — mirroring the JS Map insertion order — so place 7 wins. Under a last-wins tie-break place 9 would win and then FAIL the doorstep gate 1.7 km away, so the tie-break is observable through the output rather than only through the winner.
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000600, mode := "stationary", refinedMode := none, avgSpeed := 0.0, place := (some "Somewhere"), wayName := none, refinedReason := none, centroidLat := (some 51.5308), centroidLon := (some (-0.1238)), vehicleKind := none, roadCorridorFraction := none }]
    #[⟨1751000000, 1751000300, "stationary", none, (some 7)⟩, ⟨1751000300, 1751000600, "stationary", none, (some 9)⟩] PLACES).map projSeg ==
  #[("stationary", none, (some "Work"), none, none, none)]

-- H13a: 7 km/h — under the 8 km/h walk/ride split but over a 6 km/h one. With H13 (5 km/h) and the exact-8 decide case, the split is bracketed on both sides.
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000600, mode := "walking", refinedMode := none, avgSpeed := 7.0, place := none, wayName := none, refinedReason := none, centroidLat := none, centroidLon := none, vehicleKind := none, roadCorridorFraction := (some 0.1) }]
    #[⟨1751000000, 1751000600, "train", (some "Victoria"), none⟩] PLACES).map projSeg ==
  #[("walking", none, none, none, none, none)]

-- H17: a leg the pipeline ALREADY calls a train is left alone — the pipeline's line attribution is finer-grained than per-line route-graph evidence, so train-vs-train is deliberately skipped.
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000600, mode := "train", refinedMode := none, avgSpeed := 25.0, place := none, wayName := (some "Piccadilly"), refinedReason := none, centroidLat := none, centroidLon := none, vehicleKind := none, roadCorridorFraction := (some 0.1) }]
    #[⟨1751000000, 1751000600, "train", (some "Victoria"), none⟩] PLACES).map projSeg ==
  #[("train", none, none, (some "Piccadilly"), none, none)]

-- H18: `refinedMode` decides which arm runs, not `mode`: a leg classified `driving` but refined to `stationary` takes the PLACE arm.
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000600, mode := "driving", refinedMode := (some "stationary"), avgSpeed := 0.0, place := (some "Work"), wayName := none, refinedReason := none, centroidLat := (some 51.5405), centroidLon := (some (-0.1425)), vehicleKind := none, roadCorridorFraction := none }]
    #[⟨1751000000, 1751000600, "stationary", none, (some 9)⟩] PLACES).map projSeg ==
  #[("driving", (some "stationary"), (some "Home"), none, none, none)]

-- H19: several segments in one call — each decided independently, order preserved, count unchanged.
#guard (applyHsmmPlaceOverride #[{ startTs := 1751000000, endTs := 1751000300, mode := "stationary", refinedMode := none, avgSpeed := 0.0, place := none, wayName := none, refinedReason := none, centroidLat := (some 51.5405), centroidLon := (some (-0.1425)), vehicleKind := none, roadCorridorFraction := none }, { startTs := 1751000300, endTs := 1751000600, mode := "driving", refinedMode := none, avgSpeed := 25.0, place := none, wayName := none, refinedReason := none, centroidLat := none, centroidLon := none, vehicleKind := none, roadCorridorFraction := (some 0.1) }]
    #[⟨1751000000, 1751000300, "stationary", none, (some 9)⟩, ⟨1751000300, 1751000600, "train", (some "Northern"), none⟩] PLACES).map projSeg ==
  #[("stationary", none, (some "Home"), none, none, none), ("train", (some "train"), none, (some "Northern"), (some "hsmm route evidence — Northern"), none)]

/-! ### `decideHsmmTrainOverride` — exported, so called for real. -/

-- a confident line over a rail-consistent trace
#guard decideHsmmTrainOverride 25.0 0.9 (some 0.2) == true
-- walking pace
#guard decideHsmmTrainOverride 5.0 0.9 (some 0.2) == false
-- no line support at all
#guard decideHsmmTrainOverride 25.0 0.0 none == false
-- a thin line over a road-hugging trace
#guard decideHsmmTrainOverride 25.0 0.3 (some 0.8) == false
-- no samples, so nothing contradicts
#guard decideHsmmTrainOverride 25.0 0.5 none == true
-- EXACTLY equal — the test is strictly greater, so no
#guard decideHsmmTrainOverride 25.0 0.4 (some 0.4) == false
-- EXACTLY at the speed split — the bar is `< 8`, so this rides
#guard decideHsmmTrainOverride 8.0 0.9 (some 0.2) == true

/-! ### The #244 doorstep gate, at its own bar. -/

-- 100.07543398026468 m and 2223.8985328915223 m — the 1500 m bar sits between them.
#guard doorstepConsistent 51.5 (-0.1) 51.5009 (-0.1) == true
#guard doorstepConsistent 51.5 (-0.1) 51.52 (-0.1) == false

end Guards

end Verified.Geo.PlaceOverride

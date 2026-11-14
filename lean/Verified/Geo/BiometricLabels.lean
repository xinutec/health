import Verified.Geo.SegmentMerge
import Verified.Geo.BiometricWindows
import Verified.JsNum
-- For `PEDESTRIAN_MIN_CADENCE_SPM`: the burst route in `correctStationaryWalkThrough`
-- counts minutes at the fleet's pedestrian floor rather than inventing one.
import Verified.Geo.Worldline
import Verified.Fix
/-!
# Biometric label rewrites

The four passes that let the step counter overrule GPS on a segment's mode:

| decision                        | velocity pass          | direction                |
| ------------------------------- | ---------------------- | ------------------------ |
| `correctModeFromCadence`        | `cadenceCorrect`       | walking → driving        |
| `revertIsolatedCadenceDrives`   | `revertIsolatedCadence`| undoes the above         |
| `demoteJitterWalkToStationary`  | `jitterWalkToStay`     | walking → stationary     |
| `applyStationaryWalkThrough`    | `walkThrough`          | stationary → walking     |

The cadence windows are {@link Verified.Geo.BiometricWindows}'. Each pass returns
a {@link Decision} per segment (and the sequence pass a merge plan as `[start,
end)` ranges); the shell rewrites the record, appending a flip's reason fragment
to `refinedReason` with `"; "`.

Every output is a label, an index or a formatted string, so the gate is exact:
reason strings use {@link Verified.JsNum.toFixed}, thresholds are compared on
bit-identical sums, and the only Float-computed guard is the stay-extent veto
(haversine against 80 m, ≤1 ULP). A `NaN` coordinate would differ (Lean's `max`
gives 0), which the quality pre-filter rules out.
-/

namespace Verified.Geo.BiometricLabels

open Verified.Geo.BiometricWindows (StepPoint Seg cadenceForSegment peakCadenceForSegment)
open Verified.Hsmm.FloatScore (haversineMeters)

/-! ## Thresholds

The calibration constants. -/

/-- Below this many steps per minute a "walking" segment is a passenger, not a
    walker. Deliberately low — a false positive corrupts the timeline more
    visibly than a false negative. -/
def WALKING_MIN_CADENCE : Float := 5
def CADENCE_CORRECTION_MIN_DURATION_S : Int := 3 * 60
def WALKING_MAX_SPEED_KMH : Float := 15
def CADENCE_CORRECTION_FRESHNESS_S : Int := 30 * 60
def CADENCE_REVERT_PEDESTRIAN_AVG_KMH : Float := 7
def STATIONARY_JITTER_MAX_PEAK_CADENCE : Float := 20
def STATIONARY_JITTER_MAX_LINEARITY : Float := 0.35
def STATIONARY_WALK_PEAK_CADENCE : Float := 80
/-- …but a walk that keeps stopping never produces one unmistakable minute, so
walking minutes are a second route in: several at pedestrian cadence,
separated by pauses, are a walk with pauses. -/
def STATIONARY_WALK_MIN_BURST_MINUTES : Nat := 3
def STATIONARY_WALK_MIN_AVG_SPEED_KMH : Float := 1.0
def STATIONARY_WALK_STAY_MIN_DURATION_S : Int := 10 * 60
def STATIONARY_WALK_STAY_MAX_EXTENT_M : Float := 80
def STATIONARY_WALK_THROUGH_MAX_DURATION_S : Int := 45 * 60

/-! ## Shapes -/

/-- A Kalman-filtered fix, as much of one as the extent veto reads. -/
abbrev Fix := Verified.GeoFix

/-- The pipeline segment record, whole, so `Verified.Geo.PassFold` hands one
value to every pass. These passes read a few fields and construct nothing. -/
abbrev LabelSeg := Verified.Geo.SegmentMerge.Seg

/-- What a pass decided about one segment. `flip` carries the new mode, the
    reason FRAGMENT to append, and the refinement tag to add (most passes add
    none). -/
inductive Decision where
  | keep
  | flip (mode : String) (reason : String) (kind : Option String)
  deriving Inhabited, BEq, Repr

def effectiveMode (s : LabelSeg) : String := s.refinedMode.getD s.mode

/-- The mode a segment carries once a decision is applied. -/
def modeAfter (s : LabelSeg) : Decision → String
  | .keep => effectiveMode s
  | .flip m _ _ => m

/-- The window shape `cadenceForSegment` / `peakCadenceForSegment` read. -/
private def win (s : LabelSeg) : Seg :=
  { startTs := s.startTs, endTs := s.endTs, mode := s.mode, pointCount := s.pointCount }

/-- How many whole minutes inside the window are at pedestrian cadence or more:
how much of the window was walking, which an interrupted walk can answer. Whole
minutes by containment (`stepMinuteInside`). -/
def walkingMinutesInSegment (seg : Seg) (stepPoints : List StepPoint) : Nat :=
  stepPoints.foldl (fun n sp =>
    if Verified.Geo.BiometricWindows.stepMinuteInside sp seg
        && decide (sp.steps ≥ Verified.Geo.Worldline.PEDESTRIAN_MIN_CADENCE_SPM)
    then n + 1 else n) 0

/--
`toFixed` for a reason string. Its `none` case (`|x| ≥ 10^21`) cannot arise for
a cadence or a ratio, so it yields `"?"`, which no real reason contains.
-/
private def fx (x : Float) (f : Nat) : String := (Verified.JsNum.toFixed x f).getD "?"

/-- Only correct once a step row lands at-or-after the segment's end within the
    freshness window: proof Fitbit has synced THROUGH the segment, so "no
    steps" means "stood still" rather than "not pulled yet". -/
private def hasFreshData (s : LabelSeg) (stepPoints : List StepPoint) : Bool :=
  stepPoints.any fun sp =>
    decide (sp.ts ≥ s.endTs) && decide (sp.ts ≤ s.endTs + CADENCE_CORRECTION_FRESHNESS_S)

/-! ## walking → driving -/

/--
A "walking" segment with near-zero cadence is a passenger in slow traffic or on
an escalator. Runs before merge, so a neighbouring drive can absorb it. No step
data means no correction: a false positive is the worse error.
-/
def correctModeFromCadence (seg : LabelSeg) (stepPoints : List StepPoint) : Decision :=
  if stepPoints.isEmpty then .keep
  else if seg.endTs - seg.startTs < CADENCE_CORRECTION_MIN_DURATION_S then .keep
  else if effectiveMode seg != "walking" then .keep
  else if seg.avgSpeed > WALKING_MAX_SPEED_KMH then .keep
  else if !hasFreshData seg stepPoints then .keep
  else
    let cadence := cadenceForSegment (win seg) stepPoints
    if cadence ≥ WALKING_MIN_CADENCE then .keep
    else .flip "driving" s!"low cadence ({fx cadence 0}/min)" (some "low-cadence")

/-! ## …and undoing it -/

/-- A segment that {@link correctModeFromCadence} flipped, identified by its
    tag rather than by substring-matching the reason. -/
private def isCadenceFlip (s : LabelSeg) : Bool :=
  s.mode == "walking" && s.refinedMode == some "driving" && s.refinedKinds.contains "low-cadence"

/-- A neighbour counts as real driving only if GPS classified it that way. A
    sibling cadence flip does not vouch for its neighbour — otherwise a run of
    flips would vouch for each other and none would ever revert. -/
private def isRealDrive (s : LabelSeg) : Bool :=
  effectiveMode s == "driving" && !isCadenceFlip s

/-- Scanning outward, the first segment that constitutes independent evidence:
    stationary stops and other cadence flips are transparent. -/
private def firstEvidence (l : List LabelSeg) : Option LabelSeg :=
  l.find? fun s => !(effectiveMode s == "stationary" || isCadenceFlip s)

/-- Whether the nearest independent evidence in that direction is real driving.
    `none` (ran off the end of the day) is not driving. -/
private def evidenceIsDrive (l : List LabelSeg) : Bool :=
  match firstEvidence l with
  | none => false
  | some s => isRealDrive s

/--
Undo a cadence flip with no vehicular context: under-recorded steps make a real
slow walk read as a passenger trip, which speed cannot tell apart. A flip
reverts when no adjacent leg is real driving and the leg is pedestrian-paced.
The `"low-cadence"` tag stays, so {@link isCadenceFlip} also requires
`refinedMode == "driving"`.
-/
def revertIsolatedCadenceDrives (segments : List LabelSeg) : List Decision :=
  segments.zipIdx.map fun (s, i) =>
    if !isCadenceFlip s then .keep
    else if s.avgSpeed ≥ CADENCE_REVERT_PEDESTRIAN_AVG_KMH then .keep
    else if evidenceIsDrive (segments.take i).reverse || evidenceIsDrive (segments.drop (i + 1)) then .keep
    else .flip "walking" "reverted cadence-drive: no adjacent driving (isolated pedestrian leg)" none

/-! ## walking → stationary -/

/--
Demote a "walking" segment to stationary when the watch took no walking step
and the path only jittered round one spot (indoors, with urban-canyon GPS). The
chair case, where {@link correctModeFromCadence} is the vehicle case. One clear
walking minute, or a directed path, vetoes it.
-/
def demoteJitterWalkToStationary (seg : LabelSeg) (stepPoints : List StepPoint) : Decision :=
  if stepPoints.isEmpty then .keep
  else if seg.endTs - seg.startTs < CADENCE_CORRECTION_MIN_DURATION_S then .keep
  else if effectiveMode seg != "walking" then .keep
  else if seg.linearity ≥ STATIONARY_JITTER_MAX_LINEARITY then .keep
  else if !hasFreshData seg stepPoints then .keep
  else
    let peak := peakCadenceForSegment (win seg) stepPoints
    if peak ≥ STATIONARY_JITTER_MAX_PEAK_CADENCE then .keep
    else
      .flip "stationary"
        s!"no walking steps (peak {fx peak 0}/min) + non-directed path (linearity {fx seg.linearity 2}) — sitting, GPS jitter"
        (some "gps-jitter")

/-! ## stationary → walking -/

/-- The fixes inside a segment's window; inclusive at both ends, the pipeline's
    dominant convention. -/
private def samplesInWindow (points : List Fix) (seg : LabelSeg) : List Fix :=
  points.filter fun p => decide (p.ts ≥ seg.startTs) && decide (p.ts ≤ seg.endTs)

/--
Physical-plausibility veto: a long segment whose fixes never leave a tight
radius is a stay, whatever a step burst or a multipath-inflated `avgSpeed`
says. `true` means vetoed; skipped without fixes.
-/
private def looksLikeStay (seg : LabelSeg) (points : List Fix) : Bool :=
  if seg.endTs - seg.startTs < STATIONARY_WALK_STAY_MIN_DURATION_S then false
  else
    let w := samplesInWindow points seg
    if w.isEmpty then false
    else
      let n := Float.ofNat w.length
      let cLat := (w.foldl (fun a p => a + p.lat) 0) / n
      let cLon := (w.foldl (fun a p => a + p.lon) 0) / n
      let extent := w.foldl (fun m p => max m (haversineMeters cLat cLon p.lat p.lon)) 0
      extent ≤ STATIONARY_WALK_STAY_MAX_EXTENT_M

/--
The converse of {@link correctModeFromCadence}: a "stationary" segment becomes
walking when the watch recorded an unmistakable walking burst and the GPS shows
it translated (a slow park stroll scores stationary on GPS). The speed guard
and extent veto separate walking in place. The burst itself proves the watch
had data. Runs after the rail and drive absorbers, which claim an interchange
walk first.
-/
def correctStationaryWalkThrough (seg : LabelSeg) (stepPoints : List StepPoint)
    (points : List Fix := []) : Decision :=
  if stepPoints.isEmpty then .keep
  else if seg.endTs - seg.startTs < CADENCE_CORRECTION_MIN_DURATION_S then .keep
  else if effectiveMode seg != "stationary" then .keep
  else if seg.endTs - seg.startTs > STATIONARY_WALK_THROUGH_MAX_DURATION_S then .keep
  else if seg.avgSpeed < STATIONARY_WALK_MIN_AVG_SPEED_KMH then .keep
  else if looksLikeStay seg points then .keep
  else
    let peak := peakCadenceForSegment (win seg) stepPoints
    let bursts := walkingMinutesInSegment (win seg) stepPoints
    let sustained := bursts ≥ STATIONARY_WALK_MIN_BURST_MINUTES
    if peak < STATIONARY_WALK_PEAK_CADENCE && !sustained then .keep
    else if peak < STATIONARY_WALK_PEAK_CADENCE then
      .flip "walking"
        s!"walking bursts ({bursts} min at {fx Verified.Geo.Worldline.PEDESTRIAN_MIN_CADENCE_SPM 0}+/min) with GPS movement"
        none
    else .flip "walking" s!"walking burst ({fx peak 0}/min) with GPS movement" none

/-- A stop bracketed by the same place on both sides is pacing within that
    place, part of the stay; only a stop between different places, or between
    moving legs, is a walk-through. -/
private def bracketedBySamePlace (segments : List LabelSeg) (i : Nat) : Bool :=
  match i, segments[i - 1]?, segments[i + 1]? with
  | 0, _, _ => false  -- no predecessor; `i - 1` truncates to 0 on `Nat`
  | _ + 1, some prev, some next =>
    effectiveMode prev == "stationary" && effectiveMode next == "stationary"
      && prev.place.isSome && prev.place == next.place
  | _, _, _ => false

/-- The plan the shell applies: one decision per input segment and the output
    segments as `[start, end)` ranges over the decided sequence, covering it
    exactly once in order. -/
structure WalkThroughPlan where
  decisions : List Decision
  runs : List (Nat × Nat)
  deriving Inhabited, BEq, Repr

/-- Coalesce consecutive walking segments into one run; anything else is a
    singleton. Walking-only by design — a blanket merge collapses two distinct
    train legs at an interchange. -/
private def walkingRuns (modes : List String) : List (Nat × Nat) :=
  let step := fun (acc : List (Nat × Nat)) (m : String) =>
    match acc with
    | (s, e) :: rest =>
      if m == "walking" && modes[e - 1]? == some "walking" then (s, e + 1) :: rest
      else (e, e + 1) :: (s, e) :: rest
    | [] => [(0, 1)]
  (modes.foldl step []).reverse

/--
{@link correctStationaryWalkThrough} over a time-ordered sequence, with the
cross-segment place guard, then merged. The guard reads the original
neighbours, so order does not matter. A flip implies dropping the stay's
`place`/`city`, which the shell does.
-/
def applyStationaryWalkThrough (segments : List LabelSeg) (stepPoints : List StepPoint)
    (points : List Fix := []) : WalkThroughPlan :=
  let decisions := segments.zipIdx.map fun (seg, i) =>
    if effectiveMode seg != "stationary" then .keep
    else if bracketedBySamePlace segments i then .keep
    else correctStationaryWalkThrough seg stepPoints points
  let modes := (segments.zip decisions).map fun (s, d) => modeAfter s d
  ⟨decisions, walkingRuns modes⟩

/-! ## Guards

The `fx` and `walkingRuns` guards pin structure; the pass guards pin one branch
each, every early return included, since the branch that never fires in London
fires on a travel day. Reference values are recorded answers. -/

private def T0 : Int := 1778457600

private def sp (ts : Int) (steps : Float) : StepPoint := ⟨ts, steps⟩

/-- A walking segment, three minutes long, with a fresh step row at its end. -/
private def walkSeg (mins : Int := 5) (avg : Float := 3) (lin : Float := 0.8) : LabelSeg :=
  { startTs := T0, endTs := T0 + mins * 60, mode := "walking", avgSpeed := avg, linearity := lin }

/-- Step rows covering the window at `perMin`, plus the freshness row. -/
private def steady (perMin : Float) (mins : Int := 5) : List StepPoint :=
  (List.range mins.toNat).map (fun k => sp (T0 + Int.ofNat k * 60) perMin) ++ [sp (T0 + mins * 60) perMin]

/-! ### `fx` — the reason strings round halves up -/

#guard fx 0 0 == "0"
#guard fx 4.5 0 == "5"
-- Ties go half-up on the magnitude, and the double nearest 0.35 lies below it
-- while the one nearest 0.45 lies above — the pair that refutes any simpler rule.
#guard fx 0.35 1 == "0.3"
#guard fx 0.45 1 == "0.5"
#guard fx 0.115 2 == "0.12"
-- Linearity is printed at 2dp, cadence at 0dp; both pad.
#guard fx 0.1 2 == "0.10"
#guard fx (1.0 / 0.0) 0 == "Infinity"

/-! ### `walkingRuns` — walking coalesces, nothing else does -/

#guard walkingRuns [] == []
#guard walkingRuns ["walking"] == [(0, 1)]
#guard walkingRuns ["walking", "walking", "walking"] == [(0, 3)]
#guard walkingRuns ["stationary", "stationary"] == [(0, 1), (1, 2)]
#guard walkingRuns ["walking", "stationary", "walking"] == [(0, 1), (1, 2), (2, 3)]
#guard walkingRuns ["walking", "walking", "train", "walking"] == [(0, 2), (2, 3), (3, 4)]
-- Two train legs at an interchange must not collapse (the 05-22 golden).
#guard walkingRuns ["train", "train"] == [(0, 1), (1, 2)]

/-! ### `correctModeFromCadence` — one case per early return -/

-- No Fitbit data at all: no correction, whatever the GPS said.
#guard correctModeFromCadence (walkSeg) [] == .keep
-- Too short to be confident.
#guard correctModeFromCadence { walkSeg 2 with } (steady 0 2) == .keep
-- Not walking.
#guard correctModeFromCadence { walkSeg with mode := "driving" } (steady 0) == .keep
-- Already too fast for the walking boundary to be worth fighting.
#guard correctModeFromCadence { walkSeg with avgSpeed := 20 } (steady 0) == .keep
-- Zero cadence but Fitbit has not synced through the window.
#guard correctModeFromCadence (walkSeg) [sp T0 0] == .keep
-- Cadence at the threshold is not low (the comparison is `≥`).
#guard correctModeFromCadence (walkSeg) (steady 5) == .keep
-- The correction itself.
#guard correctModeFromCadence (walkSeg) (steady 0)
  == .flip "driving" "low cadence (0/min)" (some "low-cadence")

/-! ### `revertIsolatedCadenceDrives` -/

private def flipped (avg : Float := 3) : LabelSeg :=
  { walkSeg with refinedMode := some "driving", refinedKinds := #["low-cadence"], avgSpeed := avg }
private def realDrive : LabelSeg := { walkSeg with mode := "driving", avgSpeed := 40 }
private def plainWalk : LabelSeg := walkSeg
private def stay : LabelSeg := { walkSeg with mode := "stationary", avgSpeed := 0 }
private def revert : Decision :=
  .flip "walking" "reverted cadence-drive: no adjacent driving (isolated pedestrian leg)" none

-- Isolated between walks: reverted.
#guard revertIsolatedCadenceDrives [plainWalk, flipped, plainWalk] == [.keep, revert, .keep]
-- Stationary stops are transparent to the outward scan.
#guard revertIsolatedCadenceDrives [plainWalk, stay, flipped, stay, plainWalk]
  == [.keep, .keep, revert, .keep, .keep]
-- A real drive on either side is vehicular context: kept.
#guard revertIsolatedCadenceDrives [realDrive, flipped, plainWalk] == [.keep, .keep, .keep]
#guard revertIsolatedCadenceDrives [plainWalk, flipped, realDrive] == [.keep, .keep, .keep]
-- …and it stays visible through an intervening stop.
#guard revertIsolatedCadenceDrives [realDrive, stay, flipped, plainWalk] == [.keep, .keep, .keep, .keep]
-- Two flips do not vouch for each other — both revert.
#guard revertIsolatedCadenceDrives [plainWalk, flipped, flipped, plainWalk]
  == [.keep, revert, revert, .keep]
-- Fast enough that the cadence call is left to own it.
#guard revertIsolatedCadenceDrives [plainWalk, flipped 12, plainWalk] == [.keep, .keep, .keep]
-- A GPS-classified drive is not a flip, so nothing to revert.
#guard revertIsolatedCadenceDrives [plainWalk, realDrive, plainWalk] == [.keep, .keep, .keep]
-- At the day's edges the scan runs off the end, which is not driving.
#guard revertIsolatedCadenceDrives [flipped] == [revert]

/-! ### `demoteJitterWalkToStationary` -/

private def jitter : LabelSeg := { walkSeg with linearity := 0.15 }

#guard demoteJitterWalkToStationary jitter [] == .keep
#guard demoteJitterWalkToStationary { jitter with linearity := 0.5 } (steady 0) == .keep
#guard demoteJitterWalkToStationary { jitter with mode := "driving" } (steady 0) == .keep
#guard demoteJitterWalkToStationary jitter [sp T0 0] == .keep
-- One clear walking minute vetoes the demotion, even with the rest at zero.
#guard demoteJitterWalkToStationary jitter (sp (T0 + 120) 60 :: steady 0) == .keep
-- Linearity exactly at the ceiling is not jitter (`≥`).
#guard demoteJitterWalkToStationary { jitter with linearity := 0.35 } (steady 0) == .keep
#guard demoteJitterWalkToStationary jitter (steady 0)
  == .flip "stationary"
      "no walking steps (peak 0/min) + non-directed path (linearity 0.15) — sitting, GPS jitter"
      (some "gps-jitter")

/-! ### `correctStationaryWalkThrough` -/

private def stroll : LabelSeg :=
  { startTs := T0, endTs := T0 + 5 * 60, mode := "stationary", avgSpeed := 1.4 }
private def burst : List StepPoint := sp (T0 + 120) 95 :: steady 0

#guard correctStationaryWalkThrough stroll [] == .keep
#guard correctStationaryWalkThrough { stroll with mode := "walking" } burst == .keep
-- Pacing in place: the step burst is there, the translation is not.
#guard correctStationaryWalkThrough { stroll with avgSpeed := 0.2 } burst == .keep
-- A multi-hour dwell that contains a walk is not wholesale-flipped.
#guard correctStationaryWalkThrough { stroll with endTs := T0 + 60 * 60 } burst == .keep
-- No unmistakable minute: peak below the burst threshold.
#guard correctStationaryWalkThrough stroll (steady 40) == .keep
-- The flip itself.
#guard correctStationaryWalkThrough stroll burst
  == .flip "walking" "walking burst (95/min) with GPS movement" none

-- The extent veto. Twelve minutes inside ~50 m of the centroid is a stay, no
-- matter how the step burst and a jitter-inflated avgSpeed read (06-17's
-- surgery dwell).
private def dwell : LabelSeg := { stroll with endTs := T0 + 12 * 60 }
private def tight : List Fix :=
  [⟨T0, 51.5200, -38.1300⟩, ⟨T0 + 300, 51.5202, -38.1301⟩, ⟨T0 + 700, 51.5201, -38.1299⟩]
private def spread : List Fix :=
  [⟨T0, 51.5200, -38.1300⟩, ⟨T0 + 300, 51.5240, -38.1360⟩, ⟨T0 + 700, 51.5280, -38.1420⟩]
private def burst12 : List StepPoint := sp (T0 + 120) 95 :: steady 0 12

#guard correctStationaryWalkThrough dwell burst12 tight == .keep
#guard correctStationaryWalkThrough dwell burst12 spread
  == .flip "walking" "walking burst (95/min) with GPS movement" none
-- Without fixes the geometry is unavailable and the older behaviour stands.
#guard correctStationaryWalkThrough dwell burst12 [] != .keep
-- Under the duration floor the veto does not apply, even to tight fixes.
#guard correctStationaryWalkThrough stroll burst tight != .keep

/-! ### `applyStationaryWalkThrough` — the sequence guard and the merge

Three consecutive five-minute windows, so a merged run ends later than an
unmerged one and the merge plan can be checked. -/

private def W : Int := 300
/-- The stroll under test: the middle window, translating, GPS-read as a stop. -/
private def strollB : LabelSeg :=
  { startTs := T0 + W, endTs := T0 + 2 * W, mode := "stationary", avgSpeed := 1.4 }
private def stayAt (place : Option String) (k : Int) : LabelSeg :=
  { startTs := T0 + k * W, endTs := T0 + (k + 1) * W, mode := "stationary", avgSpeed := 0, place }
private def walkAt (k : Int) : LabelSeg :=
  { startTs := T0 + k * W, endTs := T0 + (k + 1) * W, mode := "walking", avgSpeed := 3, linearity := 0.8 }
/-- Zero throughout, with the one unmistakable walking minute inside the
    stroll's window. -/
private def burstSeq : List StepPoint :=
  (List.range 16).map fun k => sp (T0 + Int.ofNat k * 60) (if k == 7 then 95 else 0)
private def flipWalk : Decision := .flip "walking" "walking burst (95/min) with GPS movement" none

-- Bracketed by the same place: intra-place pacing, kept. This is what keeps a
-- "stationary @ Work" afternoon from fragmenting.
#guard (applyStationaryWalkThrough [stayAt (some "Work") 0, strollB, stayAt (some "Work") 2] burstSeq).decisions
  == [.keep, .keep, .keep]
-- Transitioning between two different places is a genuine walk-through.
#guard (applyStationaryWalkThrough [stayAt (some "Work") 0, strollB, stayAt (some "Home") 2] burstSeq).decisions
  == [.keep, flipWalk, .keep]
-- Two stays with no place on the left bracket are not "the same place".
#guard (applyStationaryWalkThrough [stayAt none 0, strollB, stayAt none 2] burstSeq).decisions
  == [.keep, flipWalk, .keep]
-- The flipped stop coalesces with the walks beside it rather than surfacing as
-- a separate "walking @ <park>" sliver.
#guard (applyStationaryWalkThrough [walkAt 0, strollB, walkAt 2] burstSeq).runs == [(0, 3)]
#guard (applyStationaryWalkThrough [stayAt (some "Work") 0, strollB, stayAt (some "Home") 2] burstSeq).runs
  == [(0, 1), (1, 2), (2, 3)]

end Verified.Geo.BiometricLabels

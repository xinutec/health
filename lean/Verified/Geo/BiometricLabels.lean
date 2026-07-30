import Verified.Geo.BiometricWindows
import Verified.JsNum
/-!
# Biometric label rewrites

Ports the second half of `src/geo/biometrics.ts` — the four passes that use the
step counter to overrule what GPS alone decided about a segment's mode:

| TS                              | velocity pass          | direction                |
| ------------------------------- | ---------------------- | ------------------------ |
| `correctModeFromCadence`        | `cadenceCorrect`       | walking → driving        |
| `revertIsolatedCadenceDrives`   | `revertIsolatedCadence`| undoes the above         |
| `demoteJitterWalkToStationary`  | `jitterWalkToStay`     | walking → stationary     |
| `applyStationaryWalkThrough`    | `walkThrough`          | stationary → walking     |

The first half (`enrichSegmentWithBiometrics`, `cadenceForSegment`,
`peakCadenceForSegment`) is in {@link Verified.Geo.BiometricWindows}; this
module consumes it rather than restating it.

## Decisions, not records

Same split as `bridgeStayRuns`: Lean decides, the shell rewrites the record.
Each pass returns a {@link Decision} per input segment, and the sequence pass
additionally returns a merge PLAN as `[start, end)` ranges. Nothing here
constructs a segment, so the port cannot drift on fields it does not model.

A {@link Decision.flip} carries the reason FRAGMENT, not the final string: the
TS appends it to any existing `refinedReason` with `"; "`, which is pure string
concatenation the shell already does elsewhere.

## Exactness

The decisions are discrete, so this admits an EXACT gate rather than the
bounded-ULP one `Kalman` needs — every output is a label, an index or a
formatted string, never a fresh real. Three things carry that claim:

* **The reason strings embed `toFixed`.** `cadence.toFixed(0)`,
  `linearity.toFixed(2)`. Lean's `Float` printer is a different algorithm
  entirely, so these go through {@link Verified.JsNum.toFixed}, which
  implements ECMA-262 21.1.3.3 against the double's exact binary value.
* **The thresholds are compared, not computed.** `cadenceForSegment` and
  `peakCadenceForSegment` are sums and comparisons over the same bit-identical
  step rows, so both arms see the same Float and land the same side of the
  same constant.
* **One Float-computed guard exists**: the stay-extent veto in
  {@link correctStationaryWalkThrough} takes a centroid and a `haversineMeters`
  (≤1 ULP, `atan2`) max, compared against 80 m. That is the single place a libm
  difference could flip a decision, and only for a segment whose extent sits
  within 1 ULP of exactly 80 m.

Stated boundary: the extent max uses Lean's `max`, which answers `0` where
`Math.max` answers `NaN`, so a `NaN` fix coordinate would diverge. Haversine
over finite coordinates cannot produce one, and the quality pre-filter has
already run by this point.
-/

namespace Verified.Geo.BiometricLabels

open Verified.Geo.BiometricWindows (StepPoint Seg cadenceForSegment peakCadenceForSegment)
open Verified.Hsmm.FloatScore (haversineMeters)

/-! ## Thresholds

Every one of these is a verbatim copy of a `const` in `src/geo/biometrics.ts`;
the rationale for each value lives on the TS declaration and is not restated. -/

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
def STATIONARY_WALK_MIN_AVG_SPEED_KMH : Float := 1.0
def STATIONARY_WALK_STAY_MIN_DURATION_S : Int := 10 * 60
def STATIONARY_WALK_STAY_MAX_EXTENT_M : Float := 80
def STATIONARY_WALK_THROUGH_MAX_DURATION_S : Int := 45 * 60

/-! ## Shapes -/

/-- A Kalman-filtered fix, as much of one as the extent veto reads. -/
structure Fix where
  ts : Int
  lat : Float
  lon : Float
  deriving Inhabited, BEq

/-- The segment fields these four passes actually read. `refinedReason` is
    absent deliberately — a pass appends to it but never branches on it, so
    carrying it would be transport with no decision content. -/
structure LabelSeg where
  startTs : Int
  endTs : Int
  mode : String
  refinedMode : Option String := none
  /-- The machine-readable refinement tags; `revertIsolatedCadenceDrives`
      branches on `"low-cadence"`. -/
  refinedKinds : List String := []
  avgSpeed : Float := 0
  maxSpeed : Float := 0
  linearity : Float := 0
  pointCount : Nat := 0
  place : Option String := none
  wayName : Option String := none
  deriving Inhabited, BEq

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
private def win (s : LabelSeg) : Seg := ⟨s.startTs, s.endTs, s.mode, s.pointCount⟩

/--
`toFixed` for a reason string.

The one unported `toFixed` arm (a finite `|x| ≥ 10^21`) cannot arise here —
cadence is steps per minute and linearity is a ratio in `[0,1]` — so a `none`
means the input was already nonsense. Rather than invent a spelling JS would
not print, this yields a marker that cannot equal any TS output, so such a call
DIVERGES loudly in the shadow ledger instead of quietly agreeing.
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
an escalator, not a walker. Runs BEFORE merge so a neighbouring drive can absorb
the relabelled leg.

Conservative on missing data: an empty step series means no correction, because
we do not know the cadence and a false positive is the worse error.
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
Undo a cadence flip that has no vehicular context.

The flip exists to let a neighbouring drive absorb a slow leg, and it trusts
the step counter completely — so when steps under-record (phone in hand, an
irregular gait) a real slow walk reads as a passenger trip. Speed cannot
separate them: a slow vehicle GPS mistook for walking is, by GPS alone,
indistinguishable from a walk.

Context can. A flip reverts when BOTH: no adjacent real driving in either
direction, and the leg is pedestrian-paced.

Note the tag is NOT removed on revert — a reverted segment still carries
`"low-cadence"`, which is why {@link isCadenceFlip} also requires
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
Demote a "walking" segment to stationary when the watch says no walking step
was taken AND the path just jittered around one spot — sitting indoors while
urban-canyon GPS wanders enough to score as a slow walk.

This is the third outcome for a low-cadence "walk":
{@link correctModeFromCadence} handles the case that translates (a vehicle),
this one the case that does not (a chair).

Two guards keep it off a real walk Fitbit under-counted: one clear walking
minute anywhere in the window vetoes it, and so does a directed path.
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

/-- The fixes inside a segment's window; INCLUSIVE at both ends, the pipeline's
    dominant convention. -/
private def samplesInWindow (points : List Fix) (seg : LabelSeg) : List Fix :=
  points.filter fun p => decide (p.ts ≥ seg.startTs) && decide (p.ts ≤ seg.endTs)

/--
Physical-plausibility veto: a long segment whose fixes never leave a tight
radius is a STAY, whatever a step burst or a jitter-inflated `avgSpeed` says.
`avgSpeed` is the mean of PER-FIX speeds, so multipath lifts it above the
translation threshold without the user going anywhere; the geometry — net-zero
displacement — dominates.

`true` means "vetoed". Skipped without fixes: absent the geometry the older
behaviour stands.
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
Symmetric counterpart to {@link correctModeFromCadence}: relabel a "stationary"
segment into walking when the watch recorded an unmistakable walking burst AND
the GPS shows the segment actually translated. A slow meandering walk-through
(a park stroll) scores as stationary on GPS alone; the step counter knows
better.

Steps alone cannot tell walking-in-place from walking-somewhere — that is what
the speed guard is for, and the extent veto behind it.

No freshness guard is needed: the trigger is the PRESENCE of a high-cadence
minute inside the window, which is itself proof Fitbit has data for it.

MUST run after the rail / drive absorbers. Walking through a station during an
interchange is genuine walking, but it belongs to the train journey and those
passes claim it first.
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
    if peak < STATIONARY_WALK_PEAK_CADENCE then .keep
    else .flip "walking" s!"walking burst ({fx peak 0}/min) with GPS movement" none

/-- A stationary stop bracketed by the SAME place on both sides is intra-place
    pacing — walking to the office bathroom and back — part of that stay, not a
    journey leg. Only a stop that TRANSITIONS between different places (or sits
    between moving legs) is a genuine walk-through. -/
private def bracketedBySamePlace (segments : List LabelSeg) (i : Nat) : Bool :=
  match i, segments[i - 1]?, segments[i + 1]? with
  | 0, _, _ => false  -- no predecessor; `i - 1` truncates to 0 on `Nat`
  | _ + 1, some prev, some next =>
    effectiveMode prev == "stationary" && effectiveMode next == "stationary"
      && prev.place.isSome && prev.place == next.place
  | _, _, _ => false

/-- The plan the shell applies: one decision per input segment, plus the output
    segments as `[start, end)` ranges over the DECIDED sequence. The ranges
    cover the input exactly once in order, so the shell walks them without
    needing to redo the grouping. -/
structure WalkThroughPlan where
  decisions : List Decision
  runs : List (Nat × Nat)
  deriving Inhabited, BEq, Repr

/-- Coalesce consecutive WALKING segments into one run; anything else is a
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
Apply {@link correctStationaryWalkThrough} across a time-ordered sequence, with
the cross-segment guard the per-segment rule cannot see, then merge.

The place-continuity guard reads the ORIGINAL neighbours, not the decided ones,
so the pass has no order dependence.

A flip here additionally drops the stay `place` / `city` — a walk-through is no
longer a stop. That is implied by the flip and left to the shell rather than
modelled as a separate decision.
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

Two kinds, and they fail differently. The `fx` and `walkingRuns` guards pin
pure structure. The pass guards pin one BRANCH each — every early return above
has a case here, because a corpus shadow only exercises the branches the corpus
happens to reach, and the branch that never fires in London is exactly the one
that will fire on a travel day.

Reference values come from Node v24.18.0 via
`lean/experiments/biometric-labels-refs.mts`, which imports the real
`src/geo/biometrics.ts` rather than a restatement of it. -/

private def T0 : Int := 1778457600

private def sp (ts : Int) (steps : Float) : StepPoint := ⟨ts, steps⟩

/-- A walking segment, three minutes long, with a fresh step row at its end. -/
private def walkSeg (mins : Int := 5) (avg : Float := 3) (lin : Float := 0.8) : LabelSeg :=
  { startTs := T0, endTs := T0 + mins * 60, mode := "walking", avgSpeed := avg, linearity := lin }

/-- Step rows covering the window at `perMin`, plus the freshness row. -/
private def steady (perMin : Float) (mins : Int := 5) : List StepPoint :=
  (List.range mins.toNat).map (fun k => sp (T0 + Int.ofNat k * 60) perMin) ++ [sp (T0 + mins * 60) perMin]

/-! ### `fx` — the reason strings go through the JS rounding rule -/

#guard fx 0 0 == "0"
#guard fx 4.5 0 == "5"
-- Ties go half-up on the MAGNITUDE, and the double nearest 0.35 lies below it
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
-- Two train legs at an interchange must NOT collapse — the 2026-05-22 golden.
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
-- Cadence at the threshold is NOT low (the comparison is `≥`).
#guard correctModeFromCadence (walkSeg) (steady 5) == .keep
-- The correction itself.
#guard correctModeFromCadence (walkSeg) (steady 0)
  == .flip "driving" "low cadence (0/min)" (some "low-cadence")

/-! ### `revertIsolatedCadenceDrives` -/

private def flipped (avg : Float := 3) : LabelSeg :=
  { walkSeg with refinedMode := some "driving", refinedKinds := ["low-cadence"], avgSpeed := avg }
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
-- Linearity exactly at the ceiling is NOT jitter (`≥`).
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
-- matter how the step burst and a jitter-inflated avgSpeed read (the
-- 2026-06-17 Bloomsbury Surgery dwell).
private def dwell : LabelSeg := { stroll with endTs := T0 + 12 * 60 }
private def tight : List Fix :=
  [⟨T0, 51.5200, -0.1300⟩, ⟨T0 + 300, 51.5202, -0.1301⟩, ⟨T0 + 700, 51.5201, -0.1299⟩]
private def spread : List Fix :=
  [⟨T0, 51.5200, -0.1300⟩, ⟨T0 + 300, 51.5240, -0.1360⟩, ⟨T0 + 700, 51.5280, -0.1420⟩]
private def burst12 : List StepPoint := sp (T0 + 120) 95 :: steady 0 12

#guard correctStationaryWalkThrough dwell burst12 tight == .keep
#guard correctStationaryWalkThrough dwell burst12 spread
  == .flip "walking" "walking burst (95/min) with GPS movement" none
-- Without fixes the geometry is unavailable and the older behaviour stands.
#guard correctStationaryWalkThrough dwell burst12 [] != .keep
-- Under the duration floor the veto does not apply, even to tight fixes.
#guard correctStationaryWalkThrough stroll burst tight != .keep

/-! ### `applyStationaryWalkThrough` — the sequence guard and the merge

A sequence pass needs a real timeline, so these fixtures are three CONSECUTIVE
five-minute windows rather than three segments sharing one. With a shared
window the merge plan is unrecoverable from the TS output — a merged run and an
unmerged one end at the same instant — so the referee could not have checked
it, and the guard would have been self-referential. -/

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

-- Bracketed by the same place: intra-place pacing, kept. This is what stopped
-- the 2026-05-12 "stationary @ Work" afternoon fragmenting.
#guard (applyStationaryWalkThrough [stayAt (some "Work") 0, strollB, stayAt (some "Work") 2] burstSeq).decisions
  == [.keep, .keep, .keep]
-- Transitioning between two DIFFERENT places is a genuine walk-through.
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

import Verified.Hsmm.Assembly
import Verified.Hsmm.EmissionFull
import Verified.Hsmm.RouteModel
import Verified.Hsmm.TrainCandidates
import Verified.Hsmm.StateSpace
import Verified.Hsmm.SegmentEmission
/-!
# Model orchestration — the Lean twin of `buildHsmmModel`

Bundles the resolved per-day context (observation tensor, state space, route-graph
model, train-generator coverage, place maps, duration fits, C4 flags, continuity)
and produces the five per-cell model callbacks — `emitAt`/`entryAt`/`initAt`/
`transAt`/`durAt` — by composing the ported factor kernels exactly as
`buildHsmmModel` (decode.ts) wires them. Feeding these through `Assembly`'s
`buildCellTensor`/`buildVector` (with `quantize`) yields the integer tensors the
verified trellis reads — the whole model, built in Lean from parsed inputs.

The callbacks add NO new arithmetic over the composition layer: each is a lookup
into the bundled maps (`isCovered ts`, `placeCoords`, the mode's
`baselineFit`) feeding an already-V8-pinned composed callback. So the guards here
check the RESOLUTION — that each callback pulls the right observation row, state,
coverage verdict, and place datum — riding on the composition's own parity pins
(`EmissionFull`/`Assembly`). End-to-end NUMERIC parity against `buildHsmmModel`
for a real day is the `Main.lean` + `compare.mjs` step; this is its pure core.

The `date → tz`-resolved context and the shell-parsed edges / station annotation
enter as already-built Lean structures (the settled I/O boundary). Still deferred
(NOT in the served flag set or null in prod): the `placeNearLine` station-graph
transition hard-zero, learned emissions, per-place HR. UNPROVEN; pinned by the
`#guard`s.
-/

namespace Verified.Hsmm.Assemble

open Verified.Hsmm.FloatScore (negInf)
open Verified.Hsmm.Emissions (Mode State)
open Verified.Hsmm.Observation (ObsRow Fix)
open Verified.Hsmm.Duration (GammaFit)
open Verified.Hsmm.RouteModel (RouteGraphModel LineEdge)
open Verified.Hsmm.StateSpace (FocusPlaceRef buildStateSpace)

/-- `KNOWN_LINES` — the served state space's train lines (decode.ts). -/
def KNOWN_LINES : List String :=
  ["Metropolitan Line", "Jubilee Line", "Victoria Line", "Piccadilly Line", "Bakerloo Line",
   "Northern Line", "Circle Line", "Hammersmith & City Line", "District Line", "Central Line",
   "Elizabeth Line"]

/-- `BASELINE_DURATION_FITS` — per-mode moments-matched Gamma fits (decode.ts). -/
def baselineFit : Mode → GammaFit
  | .stationary => ⟨0.85, 0.0043, 132⟩
  | .walking    => ⟨1.07, 0.034, 60⟩
  | .cycling    => ⟨1.0, 0.05, 0⟩
  | .driving    => ⟨0.42, 0.008, 24⟩
  | .train      => ⟨1.74, 0.053, 24⟩
  | .plane      => ⟨1.0, 0.011, 0⟩
  | .unknown    => ⟨0.45, 0.0034, 15⟩

/-- Everything `buildHsmmModel` resolves once per day, bundled: the observation
    tensor + state space, the route-graph model and its derived views, the
    train-generator coverage map, the place priors, and the C4 flags. -/
structure ModelContext where
  obs : Array ObsRow
  states : Array State
  model : RouteGraphModel
  connGraph : RouteConnectivity.Graph
  modeledLines : List String
  edgesByLine : Std.HashMap String (List LineEdge)
  placeCoords : Std.HashMap Int (Float × Float)
  hourProfiles : Std.HashMap Int (Array Float)
  visitWeights : Std.HashMap Int Float
  nPlaces : Nat
  coverage : Std.HashMap Int (List String)
  placeNearLine : Std.HashSet String
  continuity : Option Continuity.ContinuityContext
  /-- No floor under the duration prior: a segment as short as the decoder's
      minute is scored by its mode's fitted duration, not by
      `Duration.minDurationByMode`'s hand-set two minutes. -/
  durationNoFloor : Bool := false
  /-- Per mode, the fitted log-share of narrated rows a minute long, in place
      of the floor's hand −10 under `minDurationByMode`; `none` keeps the hand
      number (`flags.fittedPriors.oneMinuteLog`, the harness's arm). -/
  oneMinuteLog : Mode → Option Float := fun _ => none
  chainOn : Bool
  stepPref : Array Float
  /-- Per minute, what the line-proximity term asks of the graph
      (`RouteModel.minuteLines`) — computed once per minute, not per state (#1774). -/
  minuteLines : Array RouteModel.MinuteLines := #[]
  /-- Per minute, each train state's rail gap evidence by `stateKey`, computed
      once per bracketing pair (`RouteModel.railKey`) and shared by every minute
      of it (#1774). A state absent from the map scores 0, as a non-train state
      does in `routeRailEvidence`. -/
  railByMinute : Array (Std.HashMap String Float) := #[]
  /-- The emission parameters per mode: the shipped table unless a request
      carries a fitted one (`flags.fittedPriors`, the harness's arm). -/
  priors : Mode → Emissions.ModePrior := Emissions.modePriors
  /-- The duration Gamma per mode, likewise. -/
  fits : Mode → GammaFit := baselineFit
  /-- The mainline's duration (`unknown_rail`), when fitted apart from the
      named lines': a TGV and a Tube hop are not one length distribution. -/
  mainlineFit : Option GammaFit := none
  /-- The platform wait's duration, the journey's wait legs (`WAIT_MARK`). -/
  waitFit : Option GammaFit := none
  /-- The wait's duration floor, minutes: below it the leg is impossible (the
      narrator folds a shorter pause into the walk). -/
  waitMin : Float := Duration.minDurationByMode .stationary
  /-- Per-family weights (`EmissionFull.TermWeights`), all `1` when shipped. -/
  weights : EmissionFull.TermWeights := {}
  /-- `SegmentEmission`'s terms (heart rate per segment, fix presence as a
      chain, net displacement, the speed of each pair of fixes), from the
      decoder record's `segEmission`. -/
  segEm : SegmentEmission.Prepared
  segPref : SegmentEmission.Prefix := default
  /-- The listed places in local metres (`SegmentEmission.placesLocal`), the
      centres of the unlisted place's prior (`unlistedCentre`). -/
  placePrior : Array (Float × Float) := #[]
  /-- Per listed place in play, where its visits are centred
      (`listedCentre`): empty without it, and the place keeps the per-minute
      place term. -/
  pinPriors : Std.HashMap Int SegmentEmission.PinPrior := {}
  /-- Under `spot`: the placeless stay's spot table and each listed place in
      play's (`SegmentEmission.spotTable`), and the length they are cut at. -/
  spotPlaceless : FloatArray := FloatArray.empty
  spotListed : Std.HashMap Int FloatArray := {}
  spotMaxD : Nat := 0
  /-- Under `position`: the frame's origin, each lit minute's fix in it with
      its core noise, the last lit minute before each, and the broad prior's
      log density at each fix (where a fix with nothing before it may be). -/
  posRef : Float × Float := (0, 0)
  posXY : Array (Option (Float × Float × Float)) := #[]
  posPrev : Array (Option Nat) := #[]
  posBroad : Array Float := #[]
  /-- Under `position`, each listed place not in play, where its visits are:
      every fix of a stay there is scored about its pin, one at a time. -/
  pinFar : Std.HashMap Int SegmentEmission.PinPrior := {}
  /-- Under `position`, per minute: what the last fix before says of which
      place a stay beginning there is at (`positionEntryTable`), per place
      and for a place not on the list; empty without a fix before. -/
  posEntry : Array (Std.HashMap Int Float × Float) := #[]
  /-- Under `position`, per state the gaps' rings by minutes of motion
      (`SegmentEmission.gapTables`; empty for a stay), and per minute the
      first lit minute at or after it and the last lit one before it (both
      `T + 1` long). -/
  posGaps : Array (Array SegmentEmission.GapTable) := #[]
  /-- Under `position` with `stopChain`, per state its vehicle table
      (`SegmentEmission.vehicleTable`), and with `moveHold` a chainless moving
      state's (`SegmentEmission.holdTable`); `none` for the rest. -/
  posVehicle : Array (Option FloatArray) := #[]
  posNext : Array Nat := #[]
  posLast : Array (Option Nat) := #[]
  /-- The transition weight: the shipped uniform split unless the harness
      carries a fitted mode matrix (`Transitions.fittedWeight`). -/
  transWeight : State → State → Float := Transitions.transitionWeight
  /-- Per minute, the best train state's line-proximity term: `LineProximity`
      ranks a train's lines and says nothing about train against other modes. -/
  lineProxBest : Array Float := #[]
  /-- Per source state, `log` of the stay states it may move to: a transition
      into a stay gives that back, so the place is chosen by the entry prior
      alone and not also by the even split. -/
  stayEntryLog : Array Float := #[]
  /-- The same for the train states, under `SegmentEmission.Params.trainLine`:
      the line is chosen by the entry alone. -/
  trainEntryLog : Array Float := #[]
  /-- Per state, the prefix sums over minute pairs `(t, t+1)` of the pair's
      speed score under the state (`pairTables`): entry `i` sums
      the pairs before `i`. -/
  pairPref : Array (Array Float) := #[]
  /-- Per minute `t`, the score of pair `(t, t+1)` across a boundary. -/
  pairBoundary : Array Float := #[]
  /-- Per place, its count of visits (stay beginnings), when the request
      carries them. -/
  visitCounts : Std.HashMap Int Float := {}
  /-- Per local hour, `log P(place | a stay begins)` for each place and for a
      place not on the list (`entryCountsTable`); empty without the arm. -/
  entryTable : Array (Std.HashMap Int Float × Float) := #[]
  /-- Per stay segment `(d, e)` at `(d − 1) · T + e`, what moving about inside
      the place adds to its all-still reading (`stayMoveTable`); empty without
      `stayMove`. -/
  stayMoveCorr : FloatArray := FloatArray.empty
  /-- The same for a walk's pauses (`walkPauseTable`); empty without
      `walkPause`. -/
  walkPauseCorr : FloatArray := FloatArray.empty

/-- The journey's wait state: stationary, no place, this in `lineName`. A leg
    of the journey state only; the outer trellis never holds it. -/
def WAIT_MARK : String := "wait"

/-- The longest segment the HSMM will consider, in minutes.

⚠ A MODEL PARAMETER, NOT A TUNING KNOB, and it belongs here because it is the
`maxD` of the `O(T·S·maxD)` trellis every arm must agree on. The TypeScript twin
is `DEFAULT_MAX_DURATION` in `src/hmm/hsmm-viterbi.ts`, which goes with the rest
of the TS arms (#975); after that this is the only copy, which is why the shell
now omits `maxD` and lets the request default to it rather than spelling 240 in
Rust.

Four hours: long enough for a workday stay to be one segment, short enough that
the duration axis stays affordable at S ≈ 160. -/
def DEFAULT_MAX_DURATION : Nat := 240

/-- A segment does not continue into itself: the duration prior alone owns a
    segment's length, so the self-loop holds no mass and the cross mass is all
    of it. -/
def NO_SELF_LOOP : Float := negInf

/-- Assemble the resolved context from parsed inputs (mirrors `buildHsmmModel`'s
    map construction). `places` carry coords/profiles/dwell; the visit weight is
    dwell-normalised (`1/nPlaces` when total dwell is 0). -/
def buildContext (obs : Array ObsRow) (model : RouteGraphModel)
    (places : List (FocusPlaceRef × Float × Float × Option (Array Float) × Float))
    (coverage : Std.HashMap Int (List String)) (placeNearLine : Std.HashSet String)
    (continuity : Option Continuity.ContinuityContext)
    (chainOn : Bool) (segEm : SegmentEmission.Params) : ModelContext :=
  -- A line is a state only where the day's route graph has its track: abroad
  -- a London line had no evidence against it and named a TGV (10-01).
  let lines := KNOWN_LINES.filter (RouteModel.linesInGraph model).contains
  let totalDwell := places.foldl (fun a (_, _, _, _, dwell) => a + dwell) 0.0
  let nPlaces := places.length
  let placeCoords := places.foldl (fun m (p, lat, lon, _, _) => m.insert p.id (lat, lon))
    ({} : Std.HashMap Int (Float × Float))
  let hourProfiles := places.foldl (fun m (p, _, _, prof, _) =>
    match prof with | some pr => m.insert p.id pr | none => m)
    ({} : Std.HashMap Int (Array Float))
  let visitWeights := places.foldl (fun m (p, _, _, _, dwell) =>
    m.insert p.id (if totalDwell > 0 then dwell / totalDwell else 1.0 / nPlaces.toFloat))
    ({} : Std.HashMap Int Float)
  { obs
    states := (buildStateSpace (places.map (·.1)) lines
      ++ [(⟨.train, none, some Emissions.UNKNOWN_METRO⟩ : State)]
      -- The journey state (`segEm.journey`): mode `unknown`, which no other
      -- state wears; `Journey` fills its cell.
      -- Two of them, so a journey longer than the bound decodes as two back
      -- to back (the trellis never continues a state into itself).
      ++ (if segEm.journey.isSome then [(⟨.unknown, none, none⟩ : State), (⟨.unknown, none, some "second"⟩ : State)] else [])
      ++ (if segEm.journey.any (·.wait) then [(⟨.stationary, none, some WAIT_MARK⟩ : State)] else [])).toArray
    model
    connGraph := RouteModel.toConnGraph model
    modeledLines := RouteModel.linesInGraph model
    edgesByLine := RouteModel.buildEdgesByLine model
    placeCoords, hourProfiles, visitWeights, nPlaces, coverage, placeNearLine, continuity
    chainOn
    segEm := SegmentEmission.prepare segEm obs.size
    stepPref := SegmentEvidence.stepPrefix obs
    minuteLines := obs.map (RouteModel.minuteLines model)
    railByMinute :=
      let connGraph := RouteModel.toConnGraph model
      let trainStates := (buildStateSpace (places.map (·.1)) lines
        ++ [(⟨.train, none, some Emissions.UNKNOWN_METRO⟩ : State)]).filter (·.mode == .train)
      -- Walked minutes (cadence at `INTERCHANGE_CADENCE_SPM` or more) and the
      -- run each belongs to. An INTERCHANGE minute is a walked minute whose run
      -- lies ENTIRELY inside the gap: a run touching the gap's first bookend
      -- is the walk to the platform (06-09: 20:21–20:28 past the 20:26 fix),
      -- one touching its last is the walk off the train. No length is asked
      -- of it — the interchange at King's Cross was a walk–pause–walk whose
      -- minutes never ran three in a row. Rows are one a minute from the first
      -- row's `ts`, so a bookend's row is arithmetic (`Observation.bucketIndex`).
      let walked : Array Bool := obs.map fun o => (o.cadence.getD 0) ≥ RouteModel.INTERCHANGE_CADENCE_SPM
      let runOf : Array (Nat × Nat) := Id.run do  -- (start, end) of each walked minute's run
        let mut out := Array.replicate walked.size (0, 0)
        let mut i := 0
        while i < walked.size do
          if walked.getD i false then
            let mut j := i
            while j + 1 < walked.size && walked.getD (j + 1) false do j := j + 1
            for k in [i:j + 1] do out := out.setIfInBounds k (i, j)
            i := j + 1
          else i := i + 1
        return out
      let t0 : Int := (obs[0]?.map (·.ts)).getD 0
      let rowOf := fun (ts : Int) => ((ts - t0) / 60).toNat
      -- An interchange strictly between rows `lo` and `hi`.
      let walkedIn := fun (lo hi : Nat) => Id.run do
        if hi ≤ lo + 1 then return false
        for k in [lo + 1:hi] do
          if walked.getD k false then
            let (rs, re) := runOf.getD k (0, 0)
            if rs > lo && re < hi then return true
        return false
      (obs.zipIdx.foldl (fun (acc : Array (Std.HashMap String Float) ×
            Std.HashMap (Bool × Option Int × Option Int × Bool × Bool) (Std.HashMap String Float)) (o, i) =>
        let (before, after) := match o.gps, o.prevGpsFix, o.nextGpsFix with
          | none, some p, some n => (walkedIn (rowOf p.ts) i, walkedIn i (rowOf n.ts))
          | _, _, _ => (false, false)
        let (g?, pts, nts) := RouteModel.railKey o
        let key := (g?, pts, nts, before, after)
        match acc.2.get? key with
        | some m => (acc.1.push m, acc.2)
        | none =>
          let m := trainStates.foldl (fun (m : Std.HashMap String Float) st =>
            let v := RouteModel.routeRailEvidence model connGraph st o false before after
            if v == 0 then m else m.insert (StateSpace.stateKey st) v) {}
          (acc.1.push m, acc.2.insert key m)) (#[], {})).1 }

/-- Whether the train generator vouches a ride at `ts`. -/
private def coveredAt (c : ModelContext) (ts : Int) : Bool := TrainCandidates.isCovered c.coverage ts

private def SEG_ZERO : Float := 0

/-- The median reported accuracy of a fix on the narrated days (10 m), for a
    fix that carries none. -/
def ACCURACY_DEFAULT_M : Float := 10

private def KMH_PER_MS : Float := 3.6
private def MIN_ONE : Float := 1
private def SECONDS_PER_MINUTE_F : Float := 60

/-- A span's speed `v` (km/h, squared GPS noise `noise`) under a mode's prior:
    the moving Gaussian, the fixes' accuracy in quadrature with its spread
    and beside it a standstill component for a vehicle that
    stops (`ModePrior.stopShare`). -/
def spanScore (prior : Emissions.ModePrior) (v noise : Float) : Float :=
  let extra := noise
  let sd := Float.sqrt (prior.speedStd * prior.speedStd + extra)
  let moving := FloatScore.logNormalPdf v prior.speedMean sd
  if prior.stopShare > SEG_ZERO then
    let stopped := FloatScore.logNormalPdf v SEG_ZERO
      (Float.sqrt (prior.stopStd * prior.stopStd + extra))
    let mx := max moving stopped
    mx + Float.log (prior.stopShare * Float.exp (stopped - mx)
      + (MIN_ONE - prior.stopShare) * Float.exp (moving - mx))
  else moving

/-- The one-minute span between minute `t` and `t + 1`, both lit:
    `(km/h, (km/h)² noise)`. -/
def pairSpan (obs : Array ObsRow) (t : Nat) : Option (Float × Float) := do
  let a ← (obs[t]?).bind (·.gps)
  let b ← (obs[t + 1]?).bind (·.gps)
  let perS := KMH_PER_MS / (MIN_ONE * SECONDS_PER_MINUTE_F)
  let ea := a.accuracyM.getD ACCURACY_DEFAULT_M
  let eb := b.accuracyM.getD ACCURACY_DEFAULT_M
  pure (FloatScore.haversineMeters a.lat a.lon b.lat b.lon * perS,
    (ea * ea + eb * eb) * perS * perS)

/-- Under `position`, a moving state's speed density: its prior's speeds,
    standstill and outlier share. -/
def stateQuad (c : ModelContext) (st : State) : SegmentEmission.SpeedQuad :=
  let prior := Emissions.priorOf c.priors st
  let eps := ((c.segEm.p.speedEps.find? (·.1 == st.mode)).map (·.2)).getD SEG_ZERO
  SegmentEmission.modeSpeedQuad prior.speedMean prior.speedStd prior.stopShare prior.stopStd eps c.segEm.p.uMaxKmh

/-- What a moving state's speed density depends on, as a key: states with
    the same key share their tables. `none` for a stay or the journey. -/
def speedKey (c : ModelContext) (st : State) : Option String :=
  if st.mode == .stationary || st.mode == .unknown then none else
  let prior := Emissions.priorOf c.priors st
  let eps := ((c.segEm.p.speedEps.find? (·.1 == st.mode)).map (·.2)).getD SEG_ZERO
  some s!"{prior.speedMean}|{prior.speedStd}|{prior.stopShare}|{prior.stopStd}|{eps}"

/-- The stop chain's class of a state: the mainline's, or a train's. -/
def stopClass (st : State) : Option String :=
  if st.mode != .train then none else if Emissions.isMainline st then some "mainline" else some "train"

/-- A vehicle's speed over `g` minutes under its stop chain: standing still
    throughout with the stationary share `π = toStop / (toStop + 1 − stay)`
    times `stay^(g−1)`, else moving. Cached for the gaps up to a cap past
    which the share is negligible. -/
def chainQuads (prior : Emissions.ModePrior) (eps uMax : Float) (sc : SegmentEmission.StopChain) :
    Nat → SegmentEmission.SpeedQuad :=
  let pi := sc.toStop / (sc.toStop + MIN_ONE - sc.stay)
  let cap := 30
  let qs := (Array.range (cap + 1)).map fun g =>
    let share := pi * Float.exp (Verified.FloatConst.natToFloat (g - 1) * Float.log sc.stay)
    SegmentEmission.modeSpeedQuad prior.speedMean prior.speedStd share prior.stopStd eps uMax
  fun g => qs[min (max g 1) cap]!

/-- Under `position`, per state its gap tables (empty for a stay), one per
    distinct speed density and stop chain. -/
def positionGapTables (c : ModelContext) (pp : SegmentEmission.PositionParams) : Array (Array SegmentEmission.GapTable) :=
  (c.states.foldl (fun (acc : Array (Array SegmentEmission.GapTable) × Std.HashMap String (Array SegmentEmission.GapTable)) st =>
    match speedKey c st with
    | none => (acc.1.push #[], acc.2)
    | some key =>
      let key := key ++ "|" ++ ((stopClass st).getD "")
      match acc.2.get? key with
      | some g => (acc.1.push g, acc.2)
      | none =>
        let sc := (stopClass st).bind fun k => (c.segEm.p.stopChain.find? (·.1 == k)).map (·.2)
        let qOf := sc.map fun sc =>
          let eps := ((c.segEm.p.speedEps.find? (·.1 == st.mode)).map (·.2)).getD SEG_ZERO
          chainQuads (Emissions.priorOf c.priors st) eps c.segEm.p.uMaxKmh sc
        let g := SegmentEmission.gapTables c.posXY c.posPrev pp (stateQuad c st) qOf
        (acc.1.push g, acc.2.insert key g)) (#[], {})).1

/-- Under `position` with `stopChain`, per state its vehicle table: the
    moving and stopped readings of each consecutive lit minute (the state's
    speed without its standstill, and the standstill alone), the full
    mixture where minutes are not told apart. One table per class. With
    `moveHold`, a moving state without a chain has its `holdTable`, one per
    speed density. -/
def positionVehicleTables (c : ModelContext) (pp : SegmentEmission.PositionParams) (maxD : Nat) :
    Array (Option FloatArray) := Id.run do
  let q := c.segEm
  if q.p.stopChain.isEmpty && q.p.moveHold == 0 then return c.states.map fun _ => none
  let lit := c.posXY.map (·.isSome)
  let consec := (Array.range lit.size).map fun t => lit[t]! && t > 0 && lit[t - 1]!
  let mut byClass : Std.HashMap String FloatArray := {}
  let mut out : Array (Option FloatArray) := #[]
  for st in c.states do
    match stopClass st, (stopClass st).bind fun k => (q.p.stopChain.find? (·.1 == k)).map (·.2) with
    | some k, some sc =>
      match byClass.get? k with
      | some t => out := out.push (some t)
      | none =>
        let prior := Emissions.priorOf c.priors st
        let eps := ((q.p.speedEps.find? (·.1 == st.mode)).map (·.2)).getD SEG_ZERO
        let qMove := SegmentEmission.modeSpeedQuad prior.speedMean prior.speedStd SEG_ZERO prior.stopStd eps q.p.uMaxKmh
        let qStop := SegmentEmission.modeSpeedQuad prior.speedMean prior.speedStd MIN_ONE prior.stopStd eps q.p.uMaxKmh
        let qMix := SegmentEmission.modeSpeedQuad prior.speedMean prior.speedStd prior.stopShare prior.stopStd eps q.p.uMaxKmh
        let mixed := SegmentEmission.moveIncrements c.posXY c.posPrev pp qMix c.posBroad
          (some (chainQuads prior eps q.p.uMaxKmh sc))
        let moving := SegmentEmission.moveIncrements c.posXY c.posPrev pp qMove c.posBroad
        let stopped := SegmentEmission.moveIncrements c.posXY c.posPrev pp qStop c.posBroad
        let t := SegmentEmission.vehicleTable moving stopped mixed lit consec sc maxD
        byClass := byClass.insert k t
        out := out.push (some t)
    | _, _ =>
      -- A moving state without a chain: each fix from the last that was not a
      -- far stray (`moveHold`).
      match speedKey c st with
      | some key =>
        if q.p.moveHold == 0 then out := out.push none else
        match byClass.get? key with
        | some t => out := out.push (some t)
        | none =>
          let qs := stateQuad c st
          let first := SegmentEmission.moveIncrements c.posXY c.posPrev pp qs c.posBroad
          let t := SegmentEmission.holdTable c.posXY first pp qs q.p.moveHold maxD
          byClass := byClass.insert key t
          out := out.push (some t)
      | none => out := out.push none
  return out

/-- A moving segment `[lo, hi)`'s claim on a gap at its start: the
    displacement across a gap belongs to the minutes that moved, so the
    segment's first fix after a gap begun before it is scored over the
    segment's own minutes of the gap, not the whole gap — a ride that starts
    late inside a dark stretch moves faster, and splitting a ride shortens
    the second leg's time. (A claim by a dark tail on the fix after it would
    count the same displacement again when the next segment moves too.) -/
def gapEdge (c : ModelContext) (s lo hi : Nat) : Float :=
  match c.posGaps[s]? with
  | none => SEG_ZERO
  | some gt =>
  if gt.isEmpty || hi ≤ lo then SEG_ZERO else
  let T := c.obs.size
  let f := c.posNext.getD lo T
  if f ≥ hi then SEG_ZERO else
  match (c.posPrev[f]?).join, gt[f]? with
  | some tp, some tab =>
    if tp < lo && f - tp > 1 then (tab.ring[f - lo + 1]?).getD SEG_ZERO - (tab.ring[f - tp]?).getD SEG_ZERO
    else SEG_ZERO
  | _, _ => SEG_ZERO

/-- The pair tables: per state the prefix sums of each pair's score under
    it (with the mode's outlier share), and per minute the score of its pair
    across a boundary: exponential at `pairBoundaryMeanKmh`, else uniform over
    0–`uMaxKmh`. Both weighted as the base
    emission; empty without the flag. -/
def pairTables (c : ModelContext) : Array (Array Float) × Array Float :=
  let q := c.segEm
  match q.p.position with
  | some pp =>
    -- Each lit minute under a moving state: its fix from the fix before, at
    -- the state's speed in any direction. A stay's fixes are its spot
    -- table's; no pair belongs to a boundary.
    -- One prefix per distinct speed density: the named lines share the
    -- train's, so they are computed once (the states number in the hundreds).
    let (pref, _) := c.states.foldl (fun (acc : Array (Array Float) × Std.HashMap String (Array Float)) st =>
      match speedKey c st with
      | none => (acc.1.push (Array.replicate (c.obs.size + 1) SEG_ZERO), acc.2)
      | some key => match acc.2.get? key with
        | some pr => (acc.1.push pr, acc.2)
        | none =>
          let pr := (SegmentEmission.moveIncrements c.posXY c.posPrev pp (stateQuad c st) c.posBroad).foldl
            (fun a x => a.push (a.back! + c.weights.base * x)) #[SEG_ZERO]
          (acc.1.push pr, acc.2.insert key pr)) (#[], {})
    (pref, Array.replicate c.obs.size SEG_ZERO)
  | none =>
  let spans := (Array.range c.obs.size).map (pairSpan c.obs)
  let pref := c.states.map fun st =>
    let prior := Emissions.priorOf c.priors st
    spans.foldl (fun acc sp =>
      let x := match sp with
        | some (v, noise) =>
          let g := spanScore prior v noise
          c.weights.base * (g + SegmentEmission.speedRobust q.p st.mode g)
        | none => SEG_ZERO
      acc.push (acc.back! + x)) #[SEG_ZERO]
  let bound := spans.map fun sp =>
    match sp, q.p.pairBoundaryMeanKmh with
    | some (v, _), some m =>
      let e := q.p.pairBoundaryEps.getD SEG_ZERO
      c.weights.base * Float.log ((MIN_ONE - e) * Float.exp (SEG_ZERO - v / m) / m + e / q.p.uMaxKmh)
    | some _, none => c.weights.base * (SEG_ZERO - Float.log q.p.uMaxKmh)
    | none, _ => SEG_ZERO
  (pref, bound)

/-- The base emission's terms a minute still carries under `SegmentEmission`:
    the segment scores the awake heart rate and fix presence of every mode it
    has parameters for (`segEmAt`), the asleep heart rate with `asleep`, the
    stay's position with `unlistedCentre` and `listedCentre`, and every fix's speed
    (`pairTables`); the minute keeps the rest — cadence, the bed, a listed
    place's distance, a fitless mode's presence and heart rate, and a fixless
    minute's speed term. -/
def segBaseAt (q : SegmentEmission.Prepared) (c : ModelContext) (st : State) (o : ObsRow) : Float :=
  let thin := EmissionFull.toThin o
  let prior := Emissions.priorOf c.priors st
  let fitted := q.p.byMode.any (·.1 == st.mode)
  let presence := if fitted then SEG_ZERO else FloatScore.logBernoulli o.gps.isSome prior.gpsPresentProb
  let keepHr := if o.inBed then q.p.asleep.isNone else !fitted
  let hr := if keepHr then Emissions.hrTerm st thin prior else SEG_ZERO
  let speed := if o.gps.isSome then SEG_ZERO else Emissions.speedTerm st thin prior
  let cad := match o.cadence with | none => SEG_ZERO | some k => Emissions.logCadencePdf k prior
  let bed := if o.inBed then Float.log (Emissions.inBedProbByMode st.mode) else SEG_ZERO
  let placeCoord := match st.placeId with | some pid => c.placeCoords.get? pid | none => none
  let centred := match st.placeId with
    | none => q.p.unlistedCentre.isSome || c.spotMaxD > 0
    | some pid => c.pinPriors.contains pid
  let place := if q.p.position.isSome then
      match q.p.position, st.placeId, o.gps with
      | some pp, some pid, some g =>
        if st.mode != .stationary then SEG_ZERO else
        match c.pinFar.get? pid with
        | some pin =>
          let (x, y) := SegmentEmission.localXY c.posRef g.lat g.lon
          SegmentEmission.fixLog pp ((x - pin.x) * (x - pin.x) + (y - pin.y) * (y - pin.y)) pin.s2
            (SegmentEmission.coreVar pp (g.accuracyM.getD ACCURACY_DEFAULT_M))
        | none => SEG_ZERO
      | _, _, _ => SEG_ZERO
    else if st.mode == .stationary && centred then SEG_ZERO
    else match q.p.placeSigmaM, q.p.placeEps with
      | some sg, some eps => Emissions.placeTermWith st thin placeCoord sg eps
      | _, _ => Emissions.placeTerm st thin placeCoord
  presence + speed + hr + cad + bed + place

/-- What `SegmentEmission` adds per minute: the fix chain's class given the
    minute before, and a train's best line-proximity rank. -/
def segMinuteAt (q : SegmentEmission.Prepared) (c : ModelContext) (t : Nat) (st : State)
    (o : ObsRow) : Float :=
  let chain := (SegmentEmission.obsMinute q.p st.mode (SegmentEmission.obsClass o)
      (if t == 0 then none else (c.obs[t - 1]?).map SegmentEmission.obsClass)).getD SEG_ZERO
  let rank :=
    if st.mode == .train then
      -c.weights.lineProximity * (c.lineProxBest[t]?).getD SEG_ZERO
    else SEG_ZERO
  chain + rank

/-- `emission(s, obs[t])` — the full composed emission. Coverage does not reach
    it (#238, 2026-09-29): the per-minute line factors stay live on a
    generator-covered minute; see `EmissionFull`. -/
def emitAt (c : ModelContext) (t s : Nat) : Float :=
  -- A minute or state off the model is impossible, hence `−∞` — the tensors
  -- are built over exactly `obs.size × states.size`, so it is never asked.
  match c.obs[t]?, c.states[s]? with
  | some o, some st =>
    -- A journey's minutes are scored by its legs (`Journey`).
    if st.mode == .unknown then SEG_ZERO else
    let minute := c.minuteLines.getD t (RouteModel.minuteLines c.model o)
    let railEv := if st.mode != .train then 0.0
      else match c.railByMinute[t]? with
        | some m => m.getD (StateSpace.stateKey st) 0.0
        | none => RouteModel.routeRailEvidence c.model c.connGraph st o false
    c.weights.base * segBaseAt c.segEm c st o
      + EmissionFull.emissionRestWith c.modeledLines minute railEv c.placeCoords c.continuity
          st o c.priors c.weights
      + segMinuteAt c.segEm c t st o
  | _, _ => negInf

private def SEG_ONE : Float := 1
/-- A flat hour profile, for a place without one. -/
private def UNIFORM_HOUR : Float := 1 / 24
private def HOURS : Nat := 24

/-- A place's share of hour `h` from its profile (dwell by hour, normalised to
    sum to one), flat when it has none. -/
private def hourShare (profiles : Std.HashMap Int (Array Float)) (p : Int) (h : Nat) : Float :=
  match profiles.get? p with
  | some pr =>
    if pr.size != HOURS then UNIFORM_HOUR else
    let tot := pr.foldl (· + ·) SEG_ZERO
    if tot > SEG_ZERO then pr.getD h SEG_ZERO / tot else UNIFORM_HOUR
  | none => UNIFORM_HOUR

/-- `P(place | a stay begins at hour h)` from counts of visits, smoothed with
    two pseudo-counts (`alpha` on the place, `beta` on its hour): a place's
    share `(n_p + α) / (V + α·(K + 1))`, its hour `(n_p·prof_p[h] + β·g[h]) /
    (n_p + β)` with `g` the visit-weighted hour profile over all places, and
    a place not on the list `α / (V + α·(K + 1)) · g[h]`, or a measured share
    of stays at no listed place when `newShare` is given; normalised over the
    places and that one. Per hour: each place's log probability and the
    unlisted place's. Replaces the entry prior's ratios and floors, which gave
    a four-visit place at an unprofiled hour about −12. -/
def entryCountsTable (places : List Int) (visits : Std.HashMap Int Float)
    (profiles : Std.HashMap Int (Array Float)) (alpha beta : Float)
    (newShare : Option Float := none) :
    Array (Std.HashMap Int Float × Float) :=
  let v := places.foldl (fun a p => a + visits.getD p SEG_ZERO) SEG_ZERO
  let k := Verified.FloatConst.natToFloat places.length
  (Array.range HOURS).map fun h =>
    let g := if v > SEG_ZERO
      then places.foldl (fun a p => a + visits.getD p SEG_ZERO * hourShare profiles p h) SEG_ZERO / v
      else UNIFORM_HOUR
    let w := places.map fun p =>
      let n := visits.getD p SEG_ZERO
      (p, (n + alpha) / (v + alpha * (k + SEG_ONE)) * ((n * hourShare profiles p h + beta * g) / (n + beta)))
    -- The unlisted place's mass: the Dirichlet's `α / (V + α(K+1))`, or a
    -- measured share of stays at no listed place (`newShare`), the listed
    -- places sharing the rest.
    let known := w.foldl (fun a (_, x) => a + x) SEG_ZERO
    let unk := match newShare with
      | some p => if p < SEG_ONE then known * p / (SEG_ONE - p) else known
      | none => alpha / (v + alpha * (k + SEG_ONE)) * g
    let tot := known + unk
    (w.foldl (fun m (p, x) => m.insert p (Float.log (x / tot))) {}, Float.log (unk / tot))

/-- The counts model's entry for a stay at hour `h`, when the table is built. -/
def entryCountsAt (c : ModelContext) (st : State) (h : Nat) : Option Float :=
  match c.entryTable[h]? with
  | some (m, unk) => some (match st.placeId with | some pid => m.getD pid unk | none => unk)
  | none => none

/-- The train generator's entry for a train starting at `ts`
    (`SegmentEmission.TrainLine`): the line term — `log q` for a line it vouches
    there, the rest sharing `1 − q` evenly, `1/n` each where it is silent or
    vouches none of them — plus the coverage term. -/
def trainLineLog (c : ModelContext) (tl : SegmentEmission.TrainLine) (covered : Bool) (ts : Int)
    (st : State) : Float :=
  let q := tl.vouchedShare
  let trains := c.states.filter (·.mode == .train)
  let n := Verified.FloatConst.natToFloat trains.size
  let vouched := TrainCandidates.linesAt c.coverage ts
  let isV := fun (x : State) => x.lineName.any vouched.contains
  let v := Verified.FloatConst.natToFloat (trains.filter isV).size
  let line :=
    if !covered || v == 0 || v == n then -Float.log n
    else if isV st then Float.log q else Float.log ((1 - q) / (n - v))
  line + if covered then tl.covered else tl.uncovered

/-- Under `position`, the stay entry's evidence from where he was: for a stay
    beginning at minute `t`, the last fix before it (minute `tp`), reached
    across the boundary at `reachM` metres a minute. Each place's chance of
    being entered from there is its footprint convolved with the reach (with
    the boundary's outlier share `reachEps` of the broad prior: he came from
    anywhere), a place not on the list the broad prior's at that fix
    (`posBroad`). Per minute, `log z_P − log Σ_Q π_Q z_Q`, with `π` the
    entry's share by hour: added to `log π_P`, the stay's place is its
    posterior given the hour and the fix, a probability, so the fix is not
    scored twice. Empty for a minute with no fix before. -/
def positionEntryTable (c : ModelContext) (reachM reachEps : Float) : Array (Std.HashMap Int Float × Float) :=
  (Array.range c.obs.size).map fun t => Id.run do
    let none_ : Std.HashMap Int Float × Float := ({}, SEG_ZERO)
    let some tp := (c.posPrev[t]?).join | return none_
    let some (xp, yp, Rp) := (c.posXY[tp]?).join | return none_
    let some o := c.obs[t]? | return none_
    let some (pis, piU) := c.entryTable[o.hourLocal]? | return none_
    let g := Verified.FloatConst.natToFloat (t - tp)
    let vr := Rp + reachM * reachM * g * g
    let lb := c.posBroad.getD tp SEG_ZERO
    let pinOf := fun (pid : Int) => match c.pinPriors.get? pid with
      | some pp => some pp
      | none => c.pinFar.get? pid
    -- log z per place, and the normaliser over the places and the unlisted one.
    let lz := pis.fold (fun (m : Std.HashMap Int Float) pid _ =>
      match pinOf pid with
      | some pp =>
        let d2 := (xp - pp.x) * (xp - pp.x) + (yp - pp.y) * (yp - pp.y)
        m.insert pid (SegmentEmission.logSumExp
          #[Float.log (MIN_ONE - reachEps) + SegmentEmission.logN2 d2 (pp.s2 + vr), Float.log reachEps + lb])
      | none => m.insert pid lb) {}
    let terms := pis.fold (fun (acc : Array Float) pid lp => acc.push (lp + lz.getD pid lb)) #[piU + lb]
    let L := SegmentEmission.logSumExp terms
    return (lz.fold (fun m pid v => m.insert pid (v - L)) {}, lb - L)

/-- `entry(s, obs[t])` — the base entry prior, or a train's generator entry
    (`trainLineLog`), with the hour profile / visit weight / coverage verdict
    resolved for the state. -/
def entryAt (c : ModelContext) (t s : Nat) : Float :=
  match c.obs[t]?, c.states[s]? with
  | none, _ | _, none => negInf
  | some o, some st =>
  if st.mode == .unknown then SEG_ZERO else
  -- The wait's station is the ride's: the ride's entry prices the journey
  -- from it, once. A stay's entry (the share of stays at no listed place)
  -- is fitted on visits, a population the platform is not in.
  if st.lineName == some WAIT_MARK then SEG_ZERO else
  let covered := coveredAt c o.ts
  let profile := match st.placeId with | some pid => c.hourProfiles.get? pid | none => none
  let weight := match st.placeId with | some pid => c.visitWeights.get? pid | none => none
  match (if st.mode == .stationary then entryCountsAt c st o.hourLocal else none) with
  | some v =>
    -- Under `position`, what the fix before says of the place (evidence, not
    -- a prior: unweighted).
    let pos := match c.posEntry[t]? with
      | some (m, unk) => if m.isEmpty && unk == SEG_ZERO then SEG_ZERO else
        match st.placeId with | some pid => m.getD pid unk | none => unk
      | none => SEG_ZERO
    c.weights.entry * v + pos
  | none =>
  match (if st.mode == .train then c.segEm.p.trainLine else none) with
  | some tl => c.weights.entry * trainLineLog c tl covered o.ts st
  | none =>
    c.weights.entry * Assembly.entryLogProbFull st o.hourLocal true profile c.nPlaces weight

/-- `initial(s)` — uniform 0. -/
def initAt (c : ModelContext) (s : Nat) : Float :=
  match c.states[s]? with
  | some st => Assembly.initialLogProbFull st
  | none => negInf

/-- The half of `durAt` that does not depend on the segment end: the state
    mode's duration prior at `d`. One per `(s, d)`; `durAtFrom` finishes each
    `e` from it. `durAt_eq_durAtFrom` says the split is exact (#1774). -/
def durPriorBase (c : ModelContext) (s d : Nat) : Float :=
  match c.states[s]? with
  | none => negInf
  | some st =>
    -- A journey's length is its legs' lengths, each priced by its own prior.
    if st.mode == .unknown then SEG_ZERO else
    let fit := match c.mainlineFit with
      | some f => if Emissions.isMainline st then f else c.fits st.mode
      | none => c.fits st.mode
    let isWait := st.lineName == some WAIT_MARK
    let fit := if isWait then c.waitFit.getD fit else fit
    c.weights.duration * Duration.logDurationProbWith d.toFloat fit
      (if c.durationNoFloor then MIN_ONE else if isWait then c.waitMin else Duration.minDurationByMode st.mode)
      (match c.oneMinuteLog st.mode with | some v => v | none => Duration.HARD_FLOOR_LOG_PROB)

/-- A segment of mode `base` read minute by minute as its own activity or as
    `alt`'s (a spell entered at `aIn`, kept at `pStay`), the first and last
    minute its own, less the all-`base` reading the minutes already carry.
    One sweep forward from each start. -/
def spellTable (c : ModelContext) (maxD : Nat) (aIn pStay : Float) (base alt : Mode) : FloatArray := Id.run do
  let T := c.obs.size
  let own := Emissions.priorOf c.priors ⟨base, none, none⟩
  let other := Emissions.priorOf c.priors ⟨alt, none, none⟩
  let gain : Array Float := c.obs.map fun o => match o.cadence with
    | some k => c.weights.base * (Emissions.logCadencePdf k other - Emissions.logCadencePdf k own)
    | none => SEG_ZERO
  let stay0 := Float.log (MIN_ONE - aIn)
  let enter := Float.log aIn - stay0
  let keep := Float.log pStay - stay0
  let leave := Float.log (MIN_ONE - pStay) - stay0
  let mut out := Verified.FloatConst.floats (maxD * T) SEG_ZERO
  for s0 in [0:T] do
    let mut vm := Verified.FloatConst.negInf
    let mut v1 := Verified.FloatConst.negInf
    for d in [2:maxD + 1] do
      let e := s0 + d - 1
      if e ≥ T then break
      let vm' := max (max enter (vm + keep)) (v1 + enter) + gain.getD e SEG_ZERO
      v1 := max (vm + leave) v1
      vm := vm'
      out := out.set! ((d - 1) * T + e) (max SEG_ZERO v1)
  return out

/-- `ModelContext.stayMoveCorr`: for every stay segment of length `d ≤ maxD`
    ending at `e`, the best reading of its minutes as still or moving about the
    place (`stayMove`'s rates, a moving minute's steps scored as a walk's) less
    the all-still reading the stay's minutes already carry. A spell comes back:
    the stay's first and last minutes are still, so a walk that leaves for
    elsewhere is never a spell — only moving about inside, out and back
    (`lean/experiments/round-trip-census.py`: of 68 narrated walks between two
    named stays, one returns to the place it left). Three readings, swept
    forward from each start: still before any spell (the all-still reading,
    `0`), moving, and still after a spell. -/
def stayMoveTable (c : ModelContext) (maxD : Nat) : FloatArray :=
  match c.segEm.p.stayMove with
  | some (aIn, pStay) => spellTable c maxD aIn pStay .stationary .walking
  | none => FloatArray.empty

/-- `ModelContext.walkPauseCorr`: the same for a walk, whose spells are pauses
    — a still minute's steps scored as a stay's — and which begins and ends
    walking (`walkPause`'s rates, fitted by EM on the narrated walks). -/
def walkPauseTable (c : ModelContext) (maxD : Nat) : FloatArray :=
  match c.segEm.p.walkPause with
  | some (aIn, pStay) => spellTable c maxD aIn pStay .walking .stationary
  | none => FloatArray.empty

/-- What moving about adds to stay `x` over minutes `[lo, hi)`: at a listed
    place, a building whose rooms he moves between; under `position` at every
    stay, since the fixes decide whether he left (a walk between two shops is
    a change of place there, not a spell). Without it a placeless stay keeps
    the all-still reading, so a short walk between two shops tens of metres
    apart stays a walk. -/
def stayMoveAt (c : ModelContext) (x : State) (lo hi : Nat) : Float :=
  if x.mode != .stationary || (x.placeId.isNone && c.segEm.p.position.isNone)
    || c.stayMoveCorr.size == 0 || hi ≤ lo then SEG_ZERO
  else c.stayMoveCorr.get! ((hi - lo - 1) * c.obs.size + (hi - 1))

/-- A stay's centre, integrated out once per segment: a placeless stay's
    around the listed places (`unlistedCentre`), a listed place's around its
    own pin (`listedCentre`). -/
def centreTerm (c : ModelContext) (x : State) (st : SegmentEmission.Stats) : Float :=
  if x.mode != .stationary then SEG_ZERO else
  let spotAt := fun (t : FloatArray) =>
    let d := st.hi - st.lo
    if d == 0 || d > c.spotMaxD || st.hi == 0 then SEG_ZERO
    else (t[Verified.Hsmm.triOff c.spotMaxD (st.hi - 1) + (d - 1)]?).getD SEG_ZERO
  if c.spotMaxD > 0 then
    match x.placeId with
    | none => spotAt c.spotPlaceless
    | some pid => match c.spotListed.get? pid with
      | some t => spotAt t
      | none => SEG_ZERO
  else
  match x.placeId with
  | none => match c.segEm.p.unlistedCentre with
    | some h => SegmentEmission.centreScore st h c.placePrior true
    | none => SEG_ZERO
  | some pid => match c.pinPriors.get? pid with
    | some pp => SegmentEmission.listedCentreScore st pp
    | none => SEG_ZERO
/-- What a segment's edge minutes change (`edgeCadence`): its first and last
    minute's steps scored by the mode's edge cadence in place of the interior
    one the minute's emission carried (`segBaseAt`); one minute for a
    one-minute segment, nothing for a minute unworn. -/
def edgeCadenceAt (c : ModelContext) (x : State) (lo hi : Nat) : Float :=
  if hi ≤ lo then SEG_ZERO else
  match c.segEm.p.edgeCadence.find? (·.1 == x.mode) with
  | none => SEG_ZERO
  | some (_, (z, m, sd)) =>
    let prior := Emissions.priorOf c.priors x
    let edge : Emissions.ModePrior :=
      { prior with expectedZeroProb := z, cadencePositiveMean := m, cadencePositiveStd := sd }
    let one := fun (t : Nat) => match (c.obs[t]?).bind (·.cadence) with
      | some k => c.weights.base * (Emissions.logCadencePdf k edge - Emissions.logCadencePdf k prior)
      | none => SEG_ZERO
    if hi - lo == 1 then one lo else one lo + one (hi - 1)

/-- What pausing adds to walk `x` over minutes `[lo, hi)`. -/
def walkPauseAt (c : ModelContext) (x : State) (lo hi : Nat) : Float :=
  if x.mode != .walking || c.walkPauseCorr.size == 0 || hi ≤ lo then SEG_ZERO
  else c.walkPauseCorr.get! ((hi - lo - 1) * c.obs.size + (hi - 1))

/-- A vehicle segment's fixes from its table where it has one, else `dflt`
    (the per-minute sum). -/
def vehicleOr (c : ModelContext) (s : Nat) (st : SegmentEmission.Stats) (dflt : Float) : Float :=
  match (c.posVehicle[s]?).join with
  | some t =>
    let d := st.hi - st.lo
    if d == 0 || st.hi == 0 then dflt else
    (t[Verified.Hsmm.triOff c.spotMaxD (st.hi - 1) + (d - 1)]?).getD dflt
  | none => dflt

/-- The segment-level emission of state `s` over a segment of length `d` with
    window `w` (its net displacement) and statistics `st`. -/
def segEmFrom (c : ModelContext) (s d : Nat) (w : Option SegmentEvidence.Window)
    (st : SegmentEmission.Stats) (level : Bool := true)
    (dv : Option SegmentEmission.DispVec := none) : Float :=
  let q := c.segEm
  match c.states[s]? with
  | some x =>
    -- The journey state carries the heart-rate level alone (its `unknown`
    -- table); a leg under it (`level := false`) keeps its mode's sleep and
    -- fix-presence terms and the rest, without the level.
    if x.mode == .unknown then (SegmentEmission.scorePreparedParts q x.mode st).2 else
    (if level then SegmentEmission.scorePrepared q x.mode st
     else SegmentEmission.sleepScore q.p st + (SegmentEmission.scorePreparedParts q x.mode st).1)
      + centreTerm c x st
      + (if st.hi == 0 then SEG_ZERO else
           let pr := (c.pairPref[s]?).getD #[]
           -- Under `position` an entry is the fix of its minute given the one
           -- before: the segment's own minutes. Else the pairs inside
           -- `[lo, hi)`, and the one across its end.
           if q.p.position.isSome then vehicleOr c s st ((pr[st.hi]?).getD SEG_ZERO - (pr[st.lo]?).getD SEG_ZERO)
             + gapEdge c s st.lo st.hi
           else (pr[st.hi - 1]?).getD SEG_ZERO - (pr[st.lo]?).getD SEG_ZERO
             + (c.pairBoundary[st.hi - 1]?).getD SEG_ZERO)
      -- The displacement vector built once per `(d, e)` by the cells loop,
      -- else here.
      -- Under `position` every fix is scored once already; the net
      -- displacement between the bracketing fixes would score them again.
      + (if q.p.position.isSome && !q.p.positionDisp then SEG_ZERO else match dv with
         | some v => SegmentEmission.dispPosteriorPrep q.p x.mode v
         | none => SegmentEmission.dispPosteriorScore q.p x.mode d w)
      + stayMoveAt c x st.lo st.hi
      + walkPauseAt c x st.lo st.hi
      + edgeCadenceAt c x st.lo st.hi
  | none => SEG_ZERO

/-- `segEmFrom`'s terms one by one, for the path debugger: the heart-rate and
    fix-presence model, the stay's centre, the fix pairs inside the
    segment, the pair across its end, and the net displacement. Their sum is
    `segEmFrom` (guarded below on a real context). -/
def segEmParts (c : ModelContext) (s d : Nat) (w : Option SegmentEvidence.Window)
    (st : SegmentEmission.Stats) : List (String × Float) :=
  let q := c.segEm
  match c.states[s]? with
  | some x =>
    [("hrFix", SegmentEmission.scorePrepared q x.mode st),
     ("centre", centreTerm c x st),
     ("pairs", if st.hi == 0 then SEG_ZERO else
       let pr := (c.pairPref[s]?).getD #[]
       if q.p.position.isSome then vehicleOr c s st ((pr[st.hi]?).getD SEG_ZERO - (pr[st.lo]?).getD SEG_ZERO) + gapEdge c s st.lo st.hi
       else (pr[st.hi - 1]?).getD SEG_ZERO - (pr[st.lo]?).getD SEG_ZERO),
     ("pairBoundary", if st.hi == 0 then SEG_ZERO else (c.pairBoundary[st.hi - 1]?).getD SEG_ZERO),
     ("disp", if q.p.position.isSome && !q.p.positionDisp then SEG_ZERO else SegmentEmission.dispPosteriorScore q.p x.mode d w),
     ("stayMove", stayMoveAt c x st.lo st.hi),
     ("walkPause", walkPauseAt c x st.lo st.hi),
     ("edgeCadence", edgeCadenceAt c x st.lo st.hi)]
  | none => []

/-- Per minute, the best line-proximity term over the train states. -/
def lineProxBestTable (c : ModelContext) : Array Float :=
  (Array.range c.obs.size).map fun t =>
    match c.obs[t]? with
    | none => SEG_ZERO
    | some o =>
      let ml := c.minuteLines.getD t (RouteModel.minuteLines c.model o)
      let best := c.states.foldl (fun acc st =>
        if st.mode == .train then max acc (RouteModel.lineProximityFactorWith c.modeledLines ml st o false)
        else acc) negInf
      if best == negInf then SEG_ZERO else best

/-- `segEmFrom` over the segment of length `d` ending at `e`. -/
def segEmAt (c : ModelContext) (s d e : Nat) : Float :=
  segEmFrom c s d (SegmentEvidence.windowAt c.obs c.stepPref d e)
    (SegmentEmission.statsAt c.segPref d e)

/-- `durAt` given `durPriorBase c s d`: only the train-hop relaxation and the
    segment emission are resolved at `e`. -/
def durAtFrom (c : ModelContext) (s d e : Nat) (base : Float) : Float :=
  match c.states[s]? with
  | none => negInf
  | some st =>
  let covered := match c.obs[e]? with | some o => coveredAt c o.ts | none => false
  Assembly.durationLogProbFrom st d covered (Duration.minDurationByMode .train) base
    + segEmAt c s d e

/-- Whether minute `e` is covered — one per `e`, shared by every state. -/
def coveredAtE (c : ModelContext) (e : Nat) : Bool :=
  match c.obs[e]? with | some o => coveredAt c o.ts | none => false

/-- `durAtFrom` with what depends only on `(d, e)` — the coverage and the
    segment's window — resolved by the caller once for every state (#1774). -/
def durAtFromW (c : ModelContext) (s d : Nat) (covered : Bool)
    (w : Option SegmentEvidence.Window) (sst : SegmentEmission.Stats) (base : Float)
    (level : Bool := true) (dv : Option SegmentEmission.DispVec := none) : Float :=
  match c.states[s]? with
  | none => negInf
  | some st =>
  Assembly.durationLogProbFrom st d covered (Duration.minDurationByMode .train) base
    + segEmFrom c s d w sst level dv

/-- The journey state's index, when the context has one. -/
def journeyIdx (c : ModelContext) : Option Nat := c.states.findIdx? (·.mode == .unknown)

/-- A state that is a journey's leg: every moving state, and the wait. -/
def isLegState (st : State) : Bool :=
  (st.mode != .stationary && st.mode != .unknown) || st.lineName == some WAIT_MARK

/-- The leg states' indices. -/
def legIdxs (c : ModelContext) : Array Nat :=
  (c.states.zipIdx.filter fun (st, _) => isLegState st).map (·.2)

theorem durAtFrom_eq_W (c : ModelContext) (s d e : Nat) (base : Float) :
    durAtFrom c s d e base
      = durAtFromW c s d (coveredAtE c e) (SegmentEvidence.windowAt c.obs c.stepPref d e)
          (SegmentEmission.statsAt c.segPref d e) base := by
  unfold durAtFrom durAtFromW coveredAtE segEmAt
  cases c.states[s]? <;> rfl

/-- `duration(s, d, obs[e])` — the mode's duration prior at `d`, the train-hop
    relaxation and the segment emission at `e`. DEFINED as the split
    (`durPriorBase` then `durAtFrom`) since 2026-09-29, so the hoisted decoder
    and this reference cannot drift. -/
def durAt (c : ModelContext) (s d e : Nat) : Float :=
  durAtFrom c s d e (durPriorBase c s d)

theorem durAt_eq_durAtFrom (c : ModelContext) (s d e : Nat) :
    durAt c s d e = durAtFrom c s d e (durPriorBase c s d) := rfl

/-- What a transition into a stay gives back (`ModelContext.stayEntryLog`);
    `0` otherwise. -/
def stayEntryAt (c : ModelContext) (a : Nat) (dst : State) : Float :=
  if dst.mode == .stationary then c.stayEntryLog.getD a SEG_ZERO
  else if dst.mode == .train then c.trainEntryLog.getD a SEG_ZERO
  else SEG_ZERO

/-- `transition(a, b, obs[t])` — static prior + chain context (with the `−∞`
    short-circuit), chain penalty resolved over the model + place coords. -/
def transAt (c : ModelContext) (a b t : Nat) : Float :=
  match c.states[a]?, c.states[b]? with
  | none, _ | _, none => negInf
  | some src, some dst =>
  let chainVal :=
    if c.chainOn then
      match c.obs[t]? with
      | some o => RouteModel.chainContext c.edgesByLine c.placeCoords src dst o (coveredAt c o.ts)
      | none => negInf
    else 0.0
  let placeNear := fun (pid : Int) (line : String) => c.placeNearLine.contains s!"{pid}|{line}"
  Assembly.transitionLogProbFull placeNear c.states.toList NO_SELF_LOOP src dst c.chainOn
    (c.weights.chain * chainVal) c.transWeight
    + stayEntryAt c a dst

/-- Quantised emission tensor `emit[t][s]`. -/
def buildEmit (c : ModelContext) : Array (Array (Option Float)) :=
  Assembly.buildCellTensor c.obs.size c.states.size (emitAt c)
/-- Quantised entry tensor `entry[t][s]`. -/
def buildEntry (c : ModelContext) : Array (Array (Option Float)) :=
  Assembly.buildCellTensor c.obs.size c.states.size (entryAt c)
/-- Quantised initial vector `init[s]`. -/
def buildInit (c : ModelContext) : Array (Option Float) :=
  Assembly.buildVector c.states.size (initAt c)

-- Parity of the RESOLUTION wiring (composition values ride on EmissionFull /
-- Assembly's own V8 pins). A connected-underground "Jubilee Line" pair so the
-- route-rail term fires on a bracketed no-GPS train minute.
private def jEdge (id : String) (g : List RouteGraph.LatLon) (n1 n2 : String) : RouteModel.RouteEdge :=
  ⟨id, g, ["Jubilee Line"], true, n1, n2⟩
private def jm : RouteGraphModel := RouteModel.buildRouteGraphModel #[
  jEdge "way:1" [⟨51.50, -0.10⟩, ⟨51.525, -0.075⟩] "nA" "nMid",
  jEdge "way:2" [⟨51.525, -0.075⟩, ⟨51.55, -0.05⟩] "nMid" "nB"]
private def obsTrain : ObsRow :=
  { ts := 1600, gps := none, hr := none, cadence := none, hourLocal := 9, dayOfWeekLocal := 0,
    inBed := false, roadDistM := none, railDistM := none, prevGpsFix := some ⟨1000, 51.50, -0.10⟩, nextGpsFix := some ⟨1600, 51.55, -0.05⟩ }
private def places : List (FocusPlaceRef × Float × Float × Option (Array Float) × Float) :=
  [(⟨5, some "Home"⟩, 51.52, -0.13, none, 100.0)]
-- A record with no fitted mode: every base term stays per minute.
private def segNone : SegmentEmission.Params := { sigmaW := 8, rho := 0.8, byMode := [] }
-- Uncovered day, and a day where the generator vouches "Jubilee Line" at ts 1600.
private def ctxU : ModelContext := buildContext #[obsTrain] jm places {} {} none false segNone
private def ctxC : ModelContext :=
  buildContext #[obsTrain] jm places (({} : Std.HashMap Int (List String)).insert 1600 ["Jubilee Line"])
    {} none false segNone
private def jubIdx : Nat := (ctxU.states.findIdx? (fun s => s.lineName == some "Jubilee Line")).getD 0
private def statIdx : Nat := (ctxU.states.findIdx? (fun s => s.placeId == some 5)).getD 0
private def noneIdx : Nat := (ctxU.states.findIdx? (fun s => s.mode == .stationary && s.placeId == none)).getD 0
private def jub : State := ⟨.train, none, some "Jubilee Line"⟩
private def approxG (a b : Float) : Bool := Float.abs (a - b) < 1e-6

-- State space built correctly: KNOWN_LINES present, place 5 present.
#guard KNOWN_LINES.length == 11
#guard ctxU.states.size == 9           -- 4 movement + 2 stationary + the graph's one line + unknown_rail + unknown_metro
#guard ctxU.nPlaces == 1

-- emitAt: with no fitted mode the composed value is EmissionFull's V8-pinned
-- emission, and coverage does not reach it — it flows through the entry and
-- duration terms (below).
#guard approxG (emitAt ctxU 0 jubIdx)
  (EmissionFull.emissionLogProbFull jm (RouteModel.toConnGraph jm) (RouteModel.linesInGraph jm)
    ctxU.placeCoords none jub obsTrain)
#guard (emitAt ctxU 0 jubIdx) == (emitAt ctxC 0 jubIdx)

-- entryAt: a train's entry is the generator's, under a record that carries it.
private def segLine : SegmentEmission.Params :=
  { segNone with trainLine := some { vouchedShare := 0.9, covered := 1.2, uncovered := -1.5 } }
private def trainsN : Float := Verified.FloatConst.natToFloat (ctxU.states.filter (·.mode == .train)).size
-- Covered and vouched: `log q` and the coverage term.
#guard approxG (entryAt { ctxC with segEm := SegmentEmission.prepare segLine 1 } 0 jubIdx)
  (Float.log 0.9 + 1.2)
-- Uncovered: the even split over the train states and the uncovered term.
#guard approxG (entryAt { ctxU with segEm := SegmentEmission.prepare segLine 1 } 0 jubIdx)
  (-Float.log trainsN - 1.5)
-- Without it, no train term at all (train state ⇒ base entry 0).
#guard entryAt ctxC 0 jubIdx == 0

-- durAt: coverage resolution drives the one-stop-hop relaxation of the sub-floor.
#guard durAt ctxC jubIdx 1 0 == 0                          -- covered sub-floor hop → relaxed
#guard durAt ctxU jubIdx 1 0 == -10                        -- uncovered → hard floor

-- transAt: the `−∞` hard-zero short-circuit survives the chain-context layer.
#guard transAt { ctxU with chainOn := true } statIdx noneIdx 0 == negInf  -- stat@5 → stat@none

-- tensor dims.
#guard (buildEmit ctxU).size == 1 && (buildEmit ctxU)[0]!.size == 9
#guard (buildInit ctxU).size == 9

-- Under `position` a moving segment's fixes are its own minutes': the walk over
-- minutes 1–2 scores the fixes of minutes 1 and 2, each from the one before.
private def walkFix (ts : Int) (lat : Float) : ObsRow :=
  { obsTrain with ts, gps := some ⟨lat, -0.1, 0, some 5⟩, prevGpsFix := none, nextGpsFix := none }
private def ppPos : SegmentEmission.PositionParams :=
  { lam := 0.02, e1 := 0.16, r1 := 60, e2 := 0.02, r2 := 5000, e3 := 0.001, r3 := 600000, rho := 0.03, tm := 30 }
private def ctxPos : ModelContext :=
  let obs := #[walkFix 0 51.5, walkFix 60 51.5006, walkFix 120 51.5012]
  let c0 := buildContext obs jm places {} {} none false { segNone with position := some ppPos }
  let xy := SegmentEmission.fixesLocal obs (51.5, -0.1) ACCURACY_DEFAULT_M ppPos
  let c1 := { c0 with posRef := (51.5, -0.1), posXY := xy, posPrev := SegmentEmission.prevLit obs,
                      posBroad := Array.replicate 3 0 }
  { c1 with pairPref := (pairTables c1).1 }
private def walkIdx : Nat := (ctxPos.states.findIdx? (·.mode == .walking)).getD 0
#guard
  let inc := SegmentEmission.moveIncrements ctxPos.posXY ctxPos.posPrev ppPos
    (let pr := Emissions.priorOf ctxPos.priors ⟨.walking, none, none⟩
     SegmentEmission.modeSpeedQuad pr.speedMean pr.speedStd pr.stopShare pr.stopStd 0 300) #[0, 0, 0]
  let st := SegmentEmission.statsAt ctxPos.segPref 2 2
  let pairs := ((segEmParts ctxPos walkIdx 2 none { st with lo := 1, hi := 3 }).find? (·.1 == "pairs")).map (·.2)
  match pairs with
  | some v => (v - (inc[1]! + inc[2]!)).abs < 1e-9
  | none => false

end Verified.Hsmm.Assemble

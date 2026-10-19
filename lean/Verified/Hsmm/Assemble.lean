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
into the bundled maps (`isCovered ts`, `lineValid`, `placeCoords`, the mode's
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
  reacquireRobust : Bool
  /-- No floor under the duration prior: a segment as short as the decoder's
      minute is scored by its mode's fitted duration, not by
      `Duration.minDurationByMode`'s hand-set two minutes. -/
  durationNoFloor : Bool := false
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
    (reacquireRobust chainOn : Bool) (segEm : SegmentEmission.Params) : ModelContext :=
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
      ++ (if segEm.journey.isSome then [(⟨.unknown, none, none⟩ : State)] else [])).toArray
    model
    connGraph := RouteModel.toConnGraph model
    modeledLines := RouteModel.linesInGraph model
    edgesByLine := RouteModel.buildEdgesByLine model
    placeCoords, hourProfiles, visitWeights, nPlaces, coverage, placeNearLine, continuity
    reacquireRobust, chainOn
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
private def MIN_TWO : Float := 2
private def SECONDS_PER_MINUTE_F : Float := 60

/-- A span's speed `v` (km/h, squared GPS noise `noise`) under a mode's prior:
    the moving Gaussian, the fixes' accuracy in quadrature with its spread
    and beside it a standstill component for a vehicle that
    stops (`ModePrior.stopShare`). -/
def spanScore (p : SegmentEmission.Params) (prior : Emissions.ModePrior) (v noise : Float) : Float :=
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

/-- The pair tables: per state the prefix sums of each pair's score under
    it (with the mode's outlier share), and per minute the score of its pair
    across a boundary: exponential at `pairBoundaryMeanKmh`, else uniform over
    0–`uMaxKmh`. Both weighted as the base
    emission; empty without the flag. -/
def pairTables (c : ModelContext) : Array (Array Float) × Array Float :=
  let q := c.segEm
  let spans := (Array.range c.obs.size).map (pairSpan c.obs)
  let pref := c.states.map fun st =>
    let prior := Emissions.priorOf c.priors st
    spans.foldl (fun acc sp =>
      let x := match sp with
        | some (v, noise) =>
          let g := spanScore q.p prior v noise
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
    placeless stay's position with `unlistedCentre`, and every fix's speed
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
  let place := if q.p.unlistedCentre.isSome && st.mode == .stationary && st.placeId.isNone then SEG_ZERO
    else Emissions.placeTerm st thin placeCoord
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

/-- `entry(s, obs[t])` — base entry prior + train-generator entry, with the
    hour profile / visit weight / coverage verdict resolved for the state. -/
def entryAt (c : ModelContext) (t s : Nat) : Float :=
  match c.obs[t]?, c.states[s]? with
  | none, _ | _, none => negInf
  | some o, some st =>
  if st.mode == .unknown then SEG_ZERO else
  let covered := coveredAt c o.ts
  let lineValid := match st.lineName with
    | some l => (TrainCandidates.linesAt c.coverage o.ts).contains l
    | none => false
  let profile := match st.placeId with | some pid => c.hourProfiles.get? pid | none => none
  let weight := match st.placeId with | some pid => c.visitWeights.get? pid | none => none
  match (if st.mode == .stationary then entryCountsAt c st o.hourLocal else none) with
  | some v => c.weights.entry * v
  | none =>
    c.weights.entry * Assembly.entryLogProbFull st o.hourLocal true profile c.nPlaces weight covered lineValid

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
    c.weights.duration * Duration.logDurationProb d.toFloat fit
      (if c.durationNoFloor then MIN_ONE else Duration.minDurationByMode st.mode)

/-- The segment-level emission of state `s` over a segment of length `d` with
    window `w` (its net displacement) and statistics `st`. -/
def segEmFrom (c : ModelContext) (s d : Nat) (w : Option SegmentEvidence.Window)
    (st : SegmentEmission.Stats) (level : Bool := true) : Float :=
  let q := c.segEm
  match c.states[s]? with
  | some x =>
    -- The journey state carries the heart-rate level alone (its `unknown`
    -- table); a leg under it (`level := false`) keeps its mode's sleep and
    -- fix-presence terms and the rest, without the level.
    if x.mode == .unknown then (SegmentEmission.scorePreparedParts q x.mode st).2 else
    (if level then SegmentEmission.scorePrepared q x.mode st
     else SegmentEmission.sleepScore q.p st + (SegmentEmission.scorePreparedParts q x.mode st).1)
      + (match q.p.unlistedCentre with
         | some h =>
           if x.mode == .stationary && x.placeId.isNone then
             SegmentEmission.centreScore st h c.placePrior true
           else SEG_ZERO
         | none => SEG_ZERO)
      + (if st.hi == 0 then SEG_ZERO else
           -- The pairs inside `[lo, hi)`, and the one across its end.
           let pr := (c.pairPref[s]?).getD #[]
           (pr[st.hi - 1]?).getD SEG_ZERO - (pr[st.lo]?).getD SEG_ZERO
             + (c.pairBoundary[st.hi - 1]?).getD SEG_ZERO)
      + SegmentEmission.dispPosteriorScore q.p x.mode d w
  | none => SEG_ZERO

/-- `segEmFrom`'s terms one by one, for the path debugger: the heart-rate and
    fix-presence model, the placeless stay's centre, the fix pairs inside the
    segment, the pair across its end, and the net displacement. Their sum is
    `segEmFrom` (guarded below on a real context). -/
def segEmParts (c : ModelContext) (s d : Nat) (w : Option SegmentEvidence.Window)
    (st : SegmentEmission.Stats) : List (String × Float) :=
  let q := c.segEm
  match c.states[s]? with
  | some x =>
    [("hrFix", SegmentEmission.scorePrepared q x.mode st),
     ("centre", match q.p.unlistedCentre with
       | some h =>
         if x.mode == .stationary && x.placeId.isNone then
           SegmentEmission.centreScore st h c.placePrior true
         else SEG_ZERO
       | none => SEG_ZERO),
     ("pairs", if st.hi == 0 then SEG_ZERO else
       let pr := (c.pairPref[s]?).getD #[]
       (pr[st.hi - 1]?).getD SEG_ZERO - (pr[st.lo]?).getD SEG_ZERO),
     ("pairBoundary", if st.hi == 0 then SEG_ZERO else (c.pairBoundary[st.hi - 1]?).getD SEG_ZERO),
     ("disp", SegmentEmission.dispPosteriorScore q.p x.mode d w)]
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
    (level : Bool := true) : Float :=
  match c.states[s]? with
  | none => negInf
  | some st =>
  Assembly.durationLogProbFrom st d covered (Duration.minDurationByMode .train) base
    + segEmFrom c s d w sst level

/-- The journey state's index, when the context has one. -/
def journeyIdx (c : ModelContext) : Option Nat := c.states.findIdx? (·.mode == .unknown)

/-- A state that is a journey's leg: every moving state. -/
def isLegState (st : State) : Bool := st.mode != .stationary && st.mode != .unknown

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
  if dst.mode == .stationary then c.stayEntryLog.getD a SEG_ZERO else SEG_ZERO

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
    inBed := false, roadDistM := none, railDistM := none, reacquireAgeMin := none,
    prevGpsFix := some ⟨1000, 51.50, -0.10⟩, nextGpsFix := some ⟨1600, 51.55, -0.05⟩ }
private def places : List (FocusPlaceRef × Float × Float × Option (Array Float) × Float) :=
  [(⟨5, some "Home"⟩, 51.52, -0.13, none, 100.0)]
-- A record with no fitted mode: every base term stays per minute.
private def segNone : SegmentEmission.Params := { sigmaW := 8, rho := 0.8, byMode := [] }
-- Uncovered day, and a day where the generator vouches "Jubilee Line" at ts 1600.
private def ctxU : ModelContext := buildContext #[obsTrain] jm places {} {} none false false segNone
private def ctxC : ModelContext :=
  buildContext #[obsTrain] jm places (({} : Std.HashMap Int (List String)).insert 1600 ["Jubilee Line"])
    {} none false false segNone
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
    ctxU.placeCoords false none jub obsTrain)
#guard (emitAt ctxU 0 jubIdx) == (emitAt ctxC 0 jubIdx)

-- entryAt: covered + line-valid → the +3 generator boost (train state ⇒ base entry 0).
#guard entryAt ctxC 0 jubIdx == 3
#guard entryAt ctxU 0 jubIdx == 0                          -- uncovered → generator silent

-- durAt: coverage resolution drives the one-stop-hop relaxation of the sub-floor.
#guard durAt ctxC jubIdx 1 0 == 0                          -- covered sub-floor hop → relaxed
#guard durAt ctxU jubIdx 1 0 == -10                        -- uncovered → hard floor

-- transAt: the `−∞` hard-zero short-circuit survives the chain-context layer.
#guard transAt { ctxU with chainOn := true } statIdx noneIdx 0 == negInf  -- stat@5 → stat@none

-- tensor dims.
#guard (buildEmit ctxU).size == 1 && (buildEmit ctxU)[0]!.size == 9
#guard (buildInit ctxU).size == 9

end Verified.Hsmm.Assemble

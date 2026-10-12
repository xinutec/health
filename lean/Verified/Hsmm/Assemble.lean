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
  segEvidenceOn : Bool
  /-- #366's three arm knobs, carried in the request's `flags` and absent from
      every production request, so the defaults are the shipped model: the
      per-minute mode prior's scale at minutes without a GPS fix (the
      no-evidence fallback) and at minutes with one, and the scale of
      `modeEntryLog`, the per-segment entry prior derived from it. -/
  modeMinuteScale : Float := 1.0
  modeMinuteScaleWithGps : Float := 1.0
  modeEntryScale : Float := 0.0
  /-- Longest ride's head, in minutes; 0 = no head state in the space (#366). -/
  rideHeadMin : Nat := 0
  /-- How much of the stay–ride gap in the per-minute mode prior a head minute
      is credited: 1 prices it like a stay, 0 like its ride. -/
  rideHeadCredit : Float := 1.0
  chainOn : Bool
  stepPref : Array Float
  selfLoop : Float
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
  /-- Per-family weights (`EmissionFull.TermWeights`), all `1` when shipped. -/
  weights : EmissionFull.TermWeights := {}
  /-- `SegmentEmission`'s terms (heart rate per segment, fix presence as a
      chain, net displacement) in place of the per-minute heart-rate and
      fix-presence terms and `SegmentEvidence`; `none`, the shipped model,
      keeps those. Harness-only (`flags.segEmission`). -/
  segEm : Option SegmentEmission.Prepared := none
  segPref : SegmentEmission.Prefix := default
  /-- The prior over an unlisted place's centre (`SegmentEmission.placePriorOf`),
      for `unlistedCentre`. -/
  placePrior : Option (Float × Float × Float) := none
  /-- The transition weight: the shipped uniform split unless the harness
      carries a fitted mode matrix (`Transitions.fittedWeight`). -/
  transWeight : State → State → Float := Transitions.transitionWeight
  /-- Per minute, the best train state's line-proximity term (`lineRankOnly`). -/
  lineProxBest : Array Float := #[]
  /-- Per source state, `log` of the stay states it may move to (harness arm
      `placeByEntry`): a transition into a stay gives that back, so the place
      is chosen by the entry prior alone and not also by the even split. -/
  stayEntryLog : Array Float := #[]
  /-- Per minute, the net speed between the nearest fixes either side of it
      and the squared GPS noise on that span (`windowSpeedTable`). -/
  windowSpeed : Array (Option (Float × Float)) := #[]
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

/-- Assemble the resolved context from parsed inputs (mirrors `buildHsmmModel`'s
    map construction). `places` carry coords/profiles/dwell; the visit weight is
    dwell-normalised (`1/nPlaces` when total dwell is 0). -/
def buildContext (obs : Array ObsRow) (model : RouteGraphModel)
    (places : List (FocusPlaceRef × Float × Float × Option (Array Float) × Float))
    (coverage : Std.HashMap Int (List String)) (placeNearLine : Std.HashSet String)
    (continuity : Option Continuity.ContinuityContext)
    (reacquireRobust segEvidenceOn chainOn : Bool)
    (modeMinuteScale : Float := 1.0) (modeEntryScale : Float := 0.0)
    (modeMinuteScaleWithGps : Float := 1.0) (rideHeadMin : Nat := 0)
    (rideHeadCredit : Float := 1.0) : ModelContext :=
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
      ++ (if rideHeadMin > 0 then [StateSpace.RIDE_HEAD_STATE, StateSpace.RIDE_HEAD_TRAIN_STATE] else [])
      ++ [(⟨.train, none, some Emissions.UNKNOWN_METRO⟩ : State)]).toArray
    model
    connGraph := RouteModel.toConnGraph model
    modeledLines := RouteModel.linesInGraph model
    edgesByLine := RouteModel.buildEdgesByLine model
    placeCoords, hourProfiles, visitWeights, nPlaces, coverage, placeNearLine, continuity
    reacquireRobust, segEvidenceOn, chainOn, modeMinuteScale, modeEntryScale, modeMinuteScaleWithGps
    rideHeadMin, rideHeadCredit
    stepPref := SegmentEvidence.stepPrefix obs
    selfLoop := Transitions.defaultSelfLoop
    minuteLines := obs.map (RouteModel.minuteLines model)
    railByMinute :=
      let connGraph := RouteModel.toConnGraph model
      let trainStates := (buildStateSpace (places.map (·.1)) lines
        ++ (if rideHeadMin > 0 then [StateSpace.RIDE_HEAD_TRAIN_STATE] else [])
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

/-- Per minute, the net speed (km/h) across the minute and the squared GPS
    noise on that span in (km/h)², for the windowed speed term: between the
    neighbouring minutes' aggregates when both are lit (two minutes), from
    the one lit neighbour to this minute's own aggregate when the other is
    dark (one minute), `none` when both are dark. A span across a dark gap
    would describe the gap, not the minute — the gap term owns that — and a
    lit minute beside a dark one must not fall back to its fix's
    instantaneous speed (a stay's fix that jumped 200 m read as 20 km/h). A
    fix without a reported accuracy carries the corpus median. -/
def windowSpeedTable (obs : Array ObsRow) : Array (Option (Float × Float)) :=
  let n := obs.size
  let at_ := fun (i : Nat) => (obs[i]?).bind (·.gps)
  (Array.range n).map fun t =>
    let own := at_ t
    let prev := if t == 0 then none else at_ (t - 1)
    let next := at_ (t + 1)
    let span := fun (a b : Observation.GpsAgg) (minutes : Float) =>
      let perS := KMH_PER_MS / (minutes * SECONDS_PER_MINUTE_F)
      let ea := a.accuracyM.getD ACCURACY_DEFAULT_M
      let eb := b.accuracyM.getD ACCURACY_DEFAULT_M
      some (FloatScore.haversineMeters a.lat a.lon b.lat b.lon * perS,
            (ea * ea + eb * eb) * perS * perS)
    match prev, next, own with
    | some a, some b, _ => span a b MIN_TWO
    | some a, none, some g => span a g MIN_ONE
    | none, some b, some g => span g b MIN_ONE
    | _, _, _ => none

/-- With `SegmentEmission` the awake heart rate is scored per segment
    (`segEmAt`) and fix presence by its chain: the minute's own terms for the
    two come out and the chain's goes in. `0` without it (the shipped model). -/
def segMinuteAt (c : ModelContext) (t : Nat) (st : State) (o : ObsRow) : Float :=
  match c.segEm with
  | none => SEG_ZERO
  | some q =>
    let prior := Emissions.priorOf c.priors st
    let out :=
      (if !q.p.byMode.any (·.1 == st.mode) then SEG_ZERO
       else
        c.weights.base * (FloatScore.logBernoulli o.gps.isSome prior.gpsPresentProb
          + (if o.inBed then SEG_ZERO else Emissions.hrTerm st (EmissionFull.toThin o) prior)))
      -- With `asleep`, the asleep minutes' heart rate is scored per segment
      -- for every state, so the minute term (whose mean depended on the
      -- state) comes out everywhere.
      + (if q.p.asleep.isSome && o.inBed then
           c.weights.base * Emissions.hrTerm st (EmissionFull.toThin o) prior
         else SEG_ZERO)
      -- With `unlistedCentre` the placeless stay's position is scored per
      -- segment (`segEmFrom`), so its per-minute off-network term comes out.
      + (if q.p.unlistedCentre && st.mode == .stationary && st.placeId.isNone && o.gps.isSome then
           c.weights.base * Emissions.OFF_NETWORK_LOG_PRIOR
         else SEG_ZERO)
    let prevLit := if t == 0 then none else (c.obs[t - 1]?).map (·.gps.isSome)
    let speed := match o.gps with
      | some g =>
        let prior := Emissions.priorOf c.priors st
        -- The base's whole speed term: the Gaussian and, after a gap, the
        -- reacquire correction on top of it; the windowed speed replaces both.
        let own := FloatScore.logNormalPdf g.speedKmh prior.speedMean prior.speedStd
          + EmissionFull.reacquireCorrection st o c.reacquireRobust c.priors
        let windowed :=
          if !q.p.speedWindow then own
          else match (c.windowSpeed[t]?).getD none with
            | some (v, noise) =>
              -- The fixes' own accuracy, in quadrature with the mode's spread
              -- (`accuracyNoise`).
              let extra := if q.p.accuracyNoise then noise else SEG_ZERO
              let sd := Float.sqrt (prior.speedStd * prior.speedStd + extra)
              let moving := FloatScore.logNormalPdf v prior.speedMean sd
              -- A vehicle stops: a standstill component beside the moving one
              -- (`ModePrior.stopShare`), each with the span's GPS noise.
              if prior.stopShare > SEG_ZERO then
                let stopped := FloatScore.logNormalPdf v SEG_ZERO
                  (Float.sqrt (prior.stopStd * prior.stopStd + extra))
                let mx := max moving stopped
                mx + Float.log (prior.stopShare * Float.exp (stopped - mx)
                  + (MIN_ONE - prior.stopShare) * Float.exp (moving - mx))
              else moving
            | none => own
        c.weights.base * (windowed - own + SegmentEmission.speedRobust q.p st.mode windowed)
      | none => SEG_ZERO
    let chain := match SegmentEmission.obsMinute q.p st.mode (SegmentEmission.obsClass o)
        (if t == 0 then none else (c.obs[t - 1]?).map SegmentEmission.obsClass) with
      | some v => v
      | none => (SegmentEmission.fixMinute q.p st.mode o.gps.isSome prevLit).getD SEG_ZERO
    let rank :=
      if q.p.lineRankOnly && st.mode == .train then
        -c.weights.lineProximity * (c.lineProxBest[t]?).getD SEG_ZERO
      else SEG_ZERO
    -- A dark minute's share of the pair bracketing it (`gapPairs`).
    let pair := match o.gps, o.prevGpsFix, o.nextGpsFix with
      | none, some a, some b =>
        if !q.p.gapPairs then SEG_ZERO else
        let k := ((b.ts - a.ts) / Observation.SECONDS_PER_MINUTE).toNat
        if k < 2 then SEG_ZERO else
        let dM := FloatScore.haversineMeters a.lat a.lon b.lat b.lon
        c.weights.base * SegmentEmission.dispScore q.p st.mode k (some ⟨dM, SEG_ZERO, SEG_ZERO⟩)
          / Verified.FloatConst.natToFloat (k - 1)
      | _, _, _ => SEG_ZERO
    chain - out + speed + rank + pair

/-- `emission(s, obs[t])` — the full composed emission. Coverage does not reach
    it (#238, 2026-09-29): the per-minute line factors stay live on a
    generator-covered minute; see `EmissionFull`. -/
def emitAt (c : ModelContext) (t s : Nat) : Float :=
  -- A minute or state off the model is impossible, hence `−∞` — the tensors
  -- are built over exactly `obs.size × states.size`, so it is never asked.
  match c.obs[t]?, c.states[s]? with
  | some o, some st =>
    EmissionFull.emissionLogProbFullWith c.modeledLines
      (c.minuteLines.getD t (RouteModel.minuteLines c.model o))
      (if st.mode != .train then 0.0
       else match c.railByMinute[t]? with
         | some m => m.getD (StateSpace.stateKey st) 0.0
         | none => RouteModel.routeRailEvidence c.model c.connGraph st o false)
      c.placeCoords c.reacquireRobust c.continuity st o c.priors c.weights
    -- The per-minute mode prior is inside the sum above at scale 1; the arm
    -- knob adds the difference, so the shipped model is untouched at 1.
    + ((if o.gps.isSome then c.modeMinuteScaleWithGps else c.modeMinuteScale) - 1.0)
        * Emissions.modePriorLog st.mode
    -- The ride's head is `driving` with the crawl mixture, priced per minute
    -- like a stay rather than like a ride (#366): the per-minute mode prior
    -- is the no-evidence fallback, and a crawling fix IS evidence — charged
    -- at driving's −3.9 a minute it outweighs the mixture's +2.9 on every
    -- crawling minute and the head never decodes (measured 2026-09-29: the
    -- eleven frozen days re-decoded identically with it in the space).
    + (if Emissions.isRideHead st then
         Emissions.rideHeadSpeedAdjust st.mode (o.gps.map (·.speedKmh))
           + c.rideHeadCredit * (Emissions.modePriorLog .stationary - Emissions.modePriorLog st.mode)
       else 0.0)
    -- With `SegmentEmission` the awake heart rate is scored per segment
    -- (`segEmAt`) and fix presence by its chain, so their minute terms go.
    + segMinuteAt c t st o
  | _, _ => negInf

/-- The per-SEGMENT entry log-prior by mode (#366): the entry rate that, with
    the mode's typical duration, reproduces the per-minute occupancy prior —
    `rate_m ∝ P(m) / D̄_m`, `D̄_m` the mode's Gamma mean (α/β), normalised over
    the modes. "Entering a ride is rare" charged ONCE, where the per-minute
    prior charges it every minute and so grows without bound with a true ride's
    length (05-25's crawl: 35.6 of a 37.6-nat margin against the true state). -/
def modeEntryLog (m : Mode) : Float :=
  let rate := fun (x : Mode) =>
    let f := baselineFit x
    Float.exp (Emissions.modePriorLog x) / (f.alpha / f.beta)
  let modes : List Mode := [.stationary, .walking, .cycling, .driving, .train, .plane, .unknown]
  let total := modes.foldl (fun a x => a + rate x) 0.0
  Float.log (rate m / total)

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
  let covered := coveredAt c o.ts
  let lineValid := match st.lineName with
    | some l => (TrainCandidates.linesAt c.coverage o.ts).contains l
    | none => false
  let profile := match st.placeId with | some pid => c.hourProfiles.get? pid | none => none
  let weight := match st.placeId with | some pid => c.visitWeights.get? pid | none => none
  match (if st.mode == .stationary then entryCountsAt c st o.hourLocal else none) with
  | some v => c.weights.entry * v + c.modeEntryScale * modeEntryLog st.mode
  | none =>
    c.weights.entry * Assembly.entryLogProbFull st o.hourLocal true profile c.nPlaces weight covered lineValid
      + c.modeEntryScale * modeEntryLog st.mode

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
    -- A ride's head lasts at most `rideHeadMin` minutes (#366).
    if Emissions.isRideHead st && d > c.rideHeadMin then negInf
    else c.weights.duration * Duration.logDurationProb d.toFloat (c.fits st.mode) (Duration.minDurationByMode st.mode)

/-- The segment-level emission of state `s` over a segment of length `d` with
    window `w` and statistics `st`. Where it scores the displacement, the
    `SegmentEvidence` term the duration already holds is taken back out. -/
def segEmFrom (c : ModelContext) (s d : Nat) (w : Option SegmentEvidence.Window)
    (st : SegmentEmission.Stats) : Float :=
  match c.segEm, c.states[s]? with
  | some q, some x =>
    SegmentEmission.scorePrepared q x.mode st
      + (match c.placePrior with
         | some pr =>
           if q.p.unlistedCentre && x.mode == .stationary && x.placeId.isNone then
             SegmentEmission.centreScore st pr
           else SEG_ZERO
         | none => SEG_ZERO)
      + (if q.p.disp.any (·.1 == x.mode) || q.p.dispPosterior then
           (if q.p.dispPosterior then SegmentEmission.dispPosteriorScore q.p x.mode d w
            else if q.p.dispSegment then SegmentEmission.dispScore q.p x.mode d w else SEG_ZERO)
             - (if c.segEvidenceOn then
                  c.weights.segmentEvidence * SegmentEvidence.segmentEvidenceOf x.mode d w
                else SEG_ZERO)
         else SEG_ZERO)
  | _, _ => SEG_ZERO

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
    segment evidence are resolved at `e`. -/
def durAtFrom (c : ModelContext) (s d e : Nat) (base : Float) : Float :=
  match c.states[s]? with
  | none => negInf
  | some st =>
  let covered := match c.obs[e]? with | some o => coveredAt c o.ts | none => false
  Assembly.durationLogProbFrom c.obs c.stepPref st d e covered
    (Duration.minDurationByMode .train) base c.segEvidenceOn c.weights.segmentEvidence
    + segEmAt c s d e

/-- Whether minute `e` is covered — one per `e`, shared by every state. -/
def coveredAtE (c : ModelContext) (e : Nat) : Bool :=
  match c.obs[e]? with | some o => coveredAt c o.ts | none => false

/-- `durAtFrom` with what depends only on `(d, e)` — the coverage and the
    segment's window — resolved by the caller once for every state (#1774). -/
def durAtFromW (c : ModelContext) (s d : Nat) (covered : Bool)
    (w : Option SegmentEvidence.Window) (sst : SegmentEmission.Stats) (base : Float) : Float :=
  match c.states[s]? with
  | none => negInf
  | some st =>
  Assembly.durationLogProbFromW st d covered (Duration.minDurationByMode .train) base
    c.segEvidenceOn w c.weights.segmentEvidence
    + segEmFrom c s d w sst

theorem durAtFrom_eq_W (c : ModelContext) (s d e : Nat) (base : Float) :
    durAtFrom c s d e base
      = durAtFromW c s d (coveredAtE c e) (SegmentEvidence.windowAt c.obs c.stepPref d e)
          (SegmentEmission.statsAt c.segPref d e) base := by
  unfold durAtFrom durAtFromW coveredAtE segEmAt
  cases c.states[s]? <;> rfl

/-- `duration(s, d, obs[e])` — the mode's duration prior at `d`, the train-hop
    relaxation and the segment evidence at `e`. DEFINED as the split
    (`durPriorBase` then `durAtFrom`) since 2026-09-29, so the hoisted decoder
    and this reference cannot drift. -/
def durAt (c : ModelContext) (s d e : Nat) : Float :=
  durAtFrom c s d e (durPriorBase c s d)

theorem durAt_eq_durAtFrom (c : ModelContext) (s d e : Nat) :
    durAt c s d e = durAtFrom c s d e (durPriorBase c s d) := rfl

/-- What a transition into a stay gives back under `placeByEntry` (see
    `ModelContext.stayEntryLog`); `0` otherwise. -/
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
  Assembly.transitionLogProbFull placeNear c.states.toList c.selfLoop src dst c.chainOn
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
-- Uncovered day, and a day where the generator vouches "Jubilee Line" at ts 1600.
private def ctxU : ModelContext := buildContext #[obsTrain] jm places {} {} none false false false
private def ctxC : ModelContext :=
  buildContext #[obsTrain] jm places (({} : Std.HashMap Int (List String)).insert 1600 ["Jubilee Line"])
    {} none false false false
private def jubIdx : Nat := (ctxU.states.findIdx? (fun s => s.lineName == some "Jubilee Line")).getD 0
private def statIdx : Nat := (ctxU.states.findIdx? (fun s => s.placeId == some 5)).getD 0
private def noneIdx : Nat := (ctxU.states.findIdx? (fun s => s.mode == .stationary && s.placeId == none)).getD 0
private def jub : State := ⟨.train, none, some "Jubilee Line"⟩
private def approxG (a b : Float) : Bool := Float.abs (a - b) < 1e-6

-- State space built correctly: KNOWN_LINES present, place 5 present.
#guard KNOWN_LINES.length == 11
#guard ctxU.states.size == 10          -- 5 movement + 2 stationary + the graph's one line + unknown_rail + unknown_metro
#guard ctxU.nPlaces == 1

-- emitAt: the composed value is EmissionFull's V8-pinned emission, and coverage
-- does not reach it — it flows through the entry and duration terms (below).
#guard approxG (emitAt ctxU 0 jubIdx)
  (EmissionFull.emissionLogProbFull jm (RouteModel.toConnGraph jm) (RouteModel.linesInGraph jm)
    ctxU.placeCoords false none jub obsTrain)
#guard (emitAt ctxU 0 jubIdx) == (emitAt ctxC 0 jubIdx)

-- entryAt: covered + line-valid → the +3 generator boost (train state ⇒ base entry 0).
#guard entryAt ctxC 0 jubIdx == 3
#guard entryAt ctxU 0 jubIdx == 0                          -- uncovered → generator silent

-- The ride's head (#366): absent at 0, present when asked, crawl-adjusted, capped.
private def ctxH : ModelContext :=
  buildContext #[obsTrain] jm places {} {} none false false false 1.0 0.0 1.0 10
private def headIdx : Nat := (ctxH.states.findIdx? Emissions.isRideHead).getD 0
private def drvIdx : Nat := (ctxH.states.findIdx? (fun s => s.mode == .driving && !Emissions.isRideHead s)).getD 0
#guard ctxU.states.any Emissions.isRideHead == false
#guard (ctxH.states.filter Emissions.isRideHead).size == 2
-- No fix on `obsTrain`, so the head differs from `driving` by the prior swap alone.
#guard Float.abs (emitAt ctxH 0 headIdx - emitAt ctxH 0 drvIdx
  - (Emissions.modePriorLog .stationary - Emissions.modePriorLog .driving)) < 1e-9
#guard durPriorBase ctxH headIdx 10 == durPriorBase ctxH drvIdx 10
#guard durPriorBase ctxH headIdx 11 == negInf
#guard durPriorBase ctxH drvIdx 11 != negInf

-- durAt: coverage resolution drives the one-stop-hop relaxation of the sub-floor.
#guard durAt ctxC jubIdx 1 0 == 0                          -- covered sub-floor hop → relaxed
#guard durAt ctxU jubIdx 1 0 == -10                        -- uncovered → hard floor

-- transAt: the `−∞` hard-zero short-circuit survives the chain-context layer.
#guard transAt { ctxU with chainOn := true } statIdx noneIdx 0 == negInf  -- stat@5 → stat@none

-- tensor dims.
#guard (buildEmit ctxU).size == 1 && (buildEmit ctxU)[0]!.size == 10
#guard (buildInit ctxU).size == 10

end Verified.Hsmm.Assemble

import Verified.Hsmm.Assembly
import Verified.Hsmm.EmissionFull
import Verified.Hsmm.RouteModel
import Verified.Hsmm.TrainCandidates
import Verified.Hsmm.StateSpace
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
  chainOn : Bool
  stepPref : Array Float
  selfLoop : Float

/-- Assemble the resolved context from parsed inputs (mirrors `buildHsmmModel`'s
    map construction). `places` carry coords/profiles/dwell; the visit weight is
    dwell-normalised (`1/nPlaces` when total dwell is 0). -/
def buildContext (obs : Array ObsRow) (model : RouteGraphModel)
    (places : List (FocusPlaceRef × Float × Float × Option (Array Float) × Float))
    (coverage : Std.HashMap Int (List String)) (placeNearLine : Std.HashSet String)
    (continuity : Option Continuity.ContinuityContext)
    (reacquireRobust segEvidenceOn chainOn : Bool) : ModelContext :=
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
    states := (buildStateSpace (places.map (·.1)) KNOWN_LINES).toArray
    model
    connGraph := RouteModel.toConnGraph model
    modeledLines := RouteModel.linesInGraph model
    edgesByLine := RouteModel.buildEdgesByLine model
    placeCoords, hourProfiles, visitWeights, nPlaces, coverage, placeNearLine, continuity
    reacquireRobust, segEvidenceOn, chainOn
    stepPref := SegmentEvidence.stepPrefix obs
    selfLoop := Transitions.defaultSelfLoop }

/-- Whether the train generator vouches a ride at `ts`. -/
private def coveredAt (c : ModelContext) (ts : Int) : Bool := TrainCandidates.isCovered c.coverage ts

/-- `emission(s, obs[t])` — the full composed emission, with `isCovered` resolved
    from the coverage map at the minute's ts. -/
def emitAt (c : ModelContext) (t s : Nat) : Float :=
  let o := c.obs[t]!
  EmissionFull.emissionLogProbFull c.model c.connGraph c.modeledLines c.placeCoords
    c.reacquireRobust (coveredAt c o.ts) c.continuity c.states[s]! o

/-- `entry(s, obs[t])` — base entry prior + train-generator entry, with the
    hour profile / visit weight / coverage verdict resolved for the state. -/
def entryAt (c : ModelContext) (t s : Nat) : Float :=
  let o := c.obs[t]!
  let st := c.states[s]!
  let covered := coveredAt c o.ts
  let lineValid := match st.lineName with
    | some l => (TrainCandidates.linesAt c.coverage o.ts).contains l
    | none => false
  let profile := match st.placeId with | some pid => c.hourProfiles.get? pid | none => none
  let weight := match st.placeId with | some pid => c.visitWeights.get? pid | none => none
  Assembly.entryLogProbFull st o.hourLocal true profile c.nPlaces weight covered lineValid

/-- `initial(s)` — uniform 0. -/
def initAt (c : ModelContext) (s : Nat) : Float := Assembly.initialLogProbFull c.states[s]!

/-- `duration(s, d, segEnd)` — train-hop-aware duration prior + segment evidence,
    with `covered` resolved at the segment's end minute. -/
def durAt (c : ModelContext) (s d e : Nat) : Float :=
  let st := c.states[s]!
  let covered := match c.obs[e]? with | some o => coveredAt c o.ts | none => false
  Assembly.durationLogProbFull c.obs c.stepPref st d e covered
    (baselineFit st.mode) (Duration.minDurationByMode st.mode) (Duration.minDurationByMode .train)
    c.segEvidenceOn

/-- `transition(a, b, obs[t])` — static prior + chain context (with the `−∞`
    short-circuit), chain penalty resolved over the model + place coords. -/
def transAt (c : ModelContext) (a b t : Nat) : Float :=
  let src := c.states[a]!
  let dst := c.states[b]!
  let chainVal :=
    if c.chainOn then
      let o := c.obs[t]!
      RouteModel.chainContext c.edgesByLine c.placeCoords src dst o (coveredAt c o.ts)
    else 0.0
  let placeNear := fun (pid : Int) (line : String) => c.placeNearLine.contains s!"{pid}|{line}"
  Assembly.transitionLogProbFull placeNear c.states.toList c.selfLoop src dst c.chainOn chainVal

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
#guard ctxU.states.size == 19          -- 5 movement + 2 stationary + 11 lines + unknown_rail
#guard ctxU.nPlaces == 1

-- emitAt: `isCovered` resolved from the coverage map flips the route-rail term.
-- RHS uses the LITERAL verdict, so a mis-resolution would diverge; the composed
-- value itself is EmissionFull's V8-pinned emission.
#guard approxG (emitAt ctxU 0 jubIdx)
  (EmissionFull.emissionLogProbFull jm (RouteModel.toConnGraph jm) (RouteModel.linesInGraph jm)
    ctxU.placeCoords false false none jub obsTrain)     -- uncovered → route-rail active
#guard approxG (emitAt ctxC 0 jubIdx)
  (EmissionFull.emissionLogProbFull jm (RouteModel.toConnGraph jm) (RouteModel.linesInGraph jm)
    ctxC.placeCoords false true none jub obsTrain)       -- covered → route-rail gated off
#guard (emitAt ctxU 0 jubIdx) != (emitAt ctxC 0 jubIdx)  -- coverage genuinely flows through

-- entryAt: covered + line-valid → the +3 generator boost (train state ⇒ base entry 0).
#guard entryAt ctxC 0 jubIdx == 3
#guard entryAt ctxU 0 jubIdx == 0                          -- uncovered → generator silent

-- durAt: coverage resolution drives the one-stop-hop relaxation of the sub-floor.
#guard durAt ctxC jubIdx 1 0 == 0                          -- covered sub-floor hop → relaxed
#guard durAt ctxU jubIdx 1 0 == -10                        -- uncovered → hard floor

-- transAt: the `−∞` hard-zero short-circuit survives the chain-context layer.
#guard transAt { ctxU with chainOn := true } statIdx noneIdx 0 == negInf  -- stat@5 → stat@none

-- tensor dims.
#guard (buildEmit ctxU).size == 1 && (buildEmit ctxU)[0]!.size == 19
#guard (buildInit ctxU).size == 19

end Verified.Hsmm.Assemble

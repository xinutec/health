import Verified.Hsmm.FloatScore
/-!
# Worldline feasibility invariants (port of `src/eval/worldline-feasibility.ts`)

The physical-impossibility gate the velocity pipeline runs over a finished
timeline: it flags legs that cannot have happened as labelled —

* `impossible-mode-kinematics` — a *walking* leg sustaining a vehicle-paced run
  (the "64 km/h walk down the corridor"), or a *train* leg sustaining a
  pedestrian-paced run while the wearer steps at walking cadence (an arrival
  walk stranded inside a ride).
* `invalid-rail-triple` — a `Board → Alight · Line` naming a station the line
  does not serve.
* `degenerate-train-leg` — boards and alights at the same station.
* `rail-discontinuity` — boards where the previous train did not alight, with
  no relocating leg between.

Distance is the equirectangular `fixDistanceM` (`cos` of the mean latitude ⇒ ≤1
ULP). Everything else is arithmetic, `Math.round`, and discrete string/set
logic ⇒ exact, incl. `parseRailWayName` (a pure separator split, ported here so
the check is self-contained). The `detail` sentences are reproduced verbatim.
UNPROVEN; pinned by the `#guard`s against Node/V8.
-/

namespace Verified.Geo.Worldline

/-! ## Constants (verbatim) -/
def EARTH_R_M : Float := 6371000
def KINEMATIC_VEHICLE_STEP_KMH : Float := 15
def KINEMATIC_MIN_RUN_NET_M : Float := 250
def KINEMATIC_MIN_RUN_STEPS : Nat := 2
def PEDESTRIAN_STEP_MAX_KMH : Float := 9
def PEDESTRIAN_MIN_RUN_NET_M : Float := 120
def PEDESTRIAN_MIN_RUN_S : Float := 90
def PEDESTRIAN_MIN_CADENCE_SPM : Float := 60
def NON_RELOCATING : List String := ["stationary", "sleeping", "unknown"]
def KINEMATIC_ASSERTED_MODES : List String := ["walking"]
def PEDESTRIAN_ASSERTED_VEHICLE_MODES : List String := ["train"]
def RAIL_STATION_SEP : String := " → "
def RAIL_LINE_SEP : String := " · "

private def pi : Float := 3.141592653589793

/-! ## Shapes -/

structure FeasibilityLeg where
  startTs : Int
  endTs : Int
  mode : String
  wayName : Option String := none
  deriving Inhabited

structure FeasibilityFix where
  ts : Int
  lat : Float
  lon : Float
  deriving Inhabited

structure FeasibilityStepPoint where
  ts : Int
  steps : Float
  deriving Inhabited

structure FeasibilityViolation where
  kind : String
  startTs : Int
  endTs : Int
  detail : String
  deriving Repr, BEq

/-- Parsed train label: two stations and an optional line. -/
structure RailTriple where
  board : String
  alight : String
  line : Option String
  deriving Inhabited, BEq

/-! ## Helpers -/

/-- `Math.round` (half toward +∞) of a non-negative magnitude, as its integer string. -/
private def roundStr (x : Float) : String := toString (Float.floor (x + 0.5)).toInt64.toInt

/-- Equirectangular metres between two fixes (mean-latitude `cos` scaling). -/
def fixDistanceM (a b : FeasibilityFix) : Float :=
  let rad := pi / 180
  let dLat := (b.lat - a.lat) * rad
  let dLon := (b.lon - a.lon) * rad * Float.cos (((a.lat + b.lat) / 2) * rad)
  Float.sqrt (dLat * dLat + dLon * dLon) * EARTH_R_M

/-- Parse `Board → Alight · Line`. `none` without the station arrow; the line is
    optional. Splits on the FIRST separator (tail rejoined), mirroring the TS
    `indexOf`/`slice`. -/
def parseRailWayName (wayName : Option String) : Option RailTriple :=
  match wayName with
  | none => none
  | some s =>
    let parts := s.splitOn RAIL_STATION_SEP
    match parts with
    | [] => none
    | [_] => none
    | board :: rest =>
      let restStr := String.intercalate RAIL_STATION_SEP rest
      let dotParts := restStr.splitOn RAIL_LINE_SEP
      match dotParts with
      | [] => some ⟨board, restStr, none⟩
      | [alight] => some ⟨board, alight, none⟩
      | alight :: lineRest => some ⟨board, alight, some (String.intercalate RAIL_LINE_SEP lineRest)⟩

/-- Mean steps/min over `[startTs, endTs]` from per-minute buckets, or `none`
    when no bucket overlaps (no data ≠ zero cadence). -/
def meanCadenceSpm (steps : List FeasibilityStepPoint) (startTs endTs : Int) : Option Float := Id.run do
  let mut total : Float := 0
  let mut overlapped := false
  for s in steps do
    if decide (s.ts + 60 ≤ startTs) || decide (s.ts ≥ endTs) then pure ()
    else
      overlapped := true
      total := total + s.steps
  if !overlapped then return none
  return some (total / max 1 (Float.ofInt (endTs - startTs) / 60))

private def fixesIn (points : List FeasibilityFix) (l : FeasibilityLeg) : Array FeasibilityFix :=
  (points.filter (fun p => decide (p.ts ≥ l.startTs) && decide (p.ts ≤ l.endTs))).toArray

/-- Walking legs that sustain a vehicle-paced run over real net distance. -/
def checkModeKinematics (legs : List FeasibilityLeg) (points : List FeasibilityFix) :
    List FeasibilityViolation := Id.run do
  let mut viol : List FeasibilityViolation := []
  for l in legs do
    if KINEMATIC_ASSERTED_MODES.contains l.mode then
      let fixes := fixesIn points l
      let mut runStart : Option Nat := none
      let mut runSteps : Nat := 0
      let mut peakKmh : Float := 0
      let mut worst : Option (Float × Nat × Float) := none
      for i in [1:fixes.size] do
        let dt := fixes[i]!.ts - fixes[i-1]!.ts
        let stepM := fixDistanceM fixes[i-1]! fixes[i]!
        let stepKmh := if decide (dt > 0) then (stepM / dt.toNat.toFloat) * 3.6 else 0
        if decide (stepKmh ≥ KINEMATIC_VEHICLE_STEP_KMH) then
          if runStart.isNone then
            runStart := some (i-1); runSteps := 0; peakKmh := 0
          runSteps := runSteps + 1
          peakKmh := max peakKmh stepKmh
          let netM := fixDistanceM fixes[runStart.getD 0]! fixes[i]!
          if decide (runSteps ≥ KINEMATIC_MIN_RUN_STEPS) && decide (netM ≥ KINEMATIC_MIN_RUN_NET_M)
              && (worst.isNone || decide (netM > (worst.getD (0,0,0)).1)) then
            worst := some (netM, runSteps, peakKmh)
        else
          runStart := none
      match worst with
      | some (netM, steps, peak) =>
        viol := viol ++ [⟨"impossible-mode-kinematics", l.startTs, l.endTs,
          s!"{l.mode} leg sustains a vehicle-paced run: {roundStr netM} m net over {steps} consecutive fast steps (peak {roundStr peak} km/h) — not physically {l.mode}"⟩]
      | none => pure ()
  return viol

/-- Train legs that sustain a pedestrian-paced run over real net distance while
    the wearer steps at walking cadence. -/
def checkVehiclePedestrianRuns (legs : List FeasibilityLeg) (points : List FeasibilityFix)
    (steps : List FeasibilityStepPoint) : List FeasibilityViolation := Id.run do
  let mut viol : List FeasibilityViolation := []
  for l in legs do
    if PEDESTRIAN_ASSERTED_VEHICLE_MODES.contains l.mode then
      let fixes := fixesIn points l
      let mut runStart : Option Nat := none
      let mut worst : Option (Float × Float × Float) := none  -- (netM, durS, cadence)
      for i in [1:fixes.size] do
        let dt := fixes[i]!.ts - fixes[i-1]!.ts
        let stepKmh := if decide (dt > 0) then (fixDistanceM fixes[i-1]! fixes[i]! / dt.toNat.toFloat) * 3.6 else 0
        if decide (stepKmh ≤ PEDESTRIAN_STEP_MAX_KMH) && decide (dt > 0) then
          if runStart.isNone then runStart := some (i-1)
          let rs := runStart.getD 0
          let durS := Float.ofInt (fixes[i]!.ts - fixes[rs]!.ts)
          let netM := fixDistanceM fixes[rs]! fixes[i]!
          if decide (durS ≥ PEDESTRIAN_MIN_RUN_S) && decide (netM ≥ PEDESTRIAN_MIN_RUN_NET_M)
              && (worst.isNone || decide (netM > (worst.getD (0,0,0)).1)) then
            match meanCadenceSpm steps fixes[rs]!.ts fixes[i]!.ts with
            | some cadence =>
              if decide (cadence ≥ PEDESTRIAN_MIN_CADENCE_SPM) then worst := some (netM, durS, cadence)
            | none => pure ()
        else
          runStart := none
      match worst with
      | some (netM, durS, cadence) =>
        viol := viol ++ [⟨"impossible-mode-kinematics", l.startTs, l.endTs,
          s!"{l.mode} leg sustains a pedestrian-paced stepping run: {roundStr netM} m net over {roundStr durS} s at {roundStr cadence} steps/min — not riding"⟩]
      | none => pure ()
  return viol

private def norm (s : String) : String := s.trimAscii.toString.map Char.toLower

/-- Train legs whose labelled board/alight are stations the line does not serve. -/
def checkRailTriples (legs : List FeasibilityLeg) (lineStations : List (String × List String)) :
    List FeasibilityViolation := Id.run do
  let mut viol : List FeasibilityViolation := []
  for l in legs do
    if l.mode == "train" then
      match parseRailWayName l.wayName with
      | some rail =>
        match rail.line with
        | some line =>
          match lineStations.find? (fun p => p.1 == line) with
          | some (_, served) =>
            if !served.isEmpty then
              let names := served.map norm
              for (role, station) in [("boards at", rail.board), ("alights at", rail.alight)] do
                if !names.contains (norm station) then
                  viol := viol ++ [⟨"invalid-rail-triple", l.startTs, l.endTs,
                    s!"train labelled {line} {role} {station}, a station that line does not serve"⟩]
          | none => pure ()
        | none => pure ()
      | none => pure ()
  return viol

/-- The full feasibility check: kinematics + pedestrian runs + rail triples +
    the degenerate/continuity chain, in that violation order. -/
def checkWorldlineFeasibility (legs : List FeasibilityLeg)
    (points : Option (List FeasibilityFix) := none)
    (steps : Option (List FeasibilityStepPoint) := none)
    (lineStations : Option (List (String × List String)) := none) :
    List FeasibilityViolation := Id.run do
  let mut viol : List FeasibilityViolation :=
    match points with | some pts => checkModeKinematics legs pts | none => []
  match points, steps with
  | some pts, some st => if !st.isEmpty then viol := viol ++ checkVehiclePedestrianRuns legs pts st
  | _, _ => pure ()
  match lineStations with
  | some ls => viol := viol ++ checkRailTriples legs ls
  | none => pure ()
  -- degenerate + continuity chain
  let mut prevAlight : Option String := none
  let mut relocated := false
  for l in legs do
    if l.mode == "train" then
      let rail := parseRailWayName l.wayName
      let board := rail.map (·.board)
      let alight := rail.map (·.alight)
      match board, alight with
      | some b, some a =>
        if b == a then
          viol := viol ++ [⟨"degenerate-train-leg", l.startTs, l.endTs,
            s!"train boards and alights at the same station ({b})"⟩]
      | _, _ => pure ()
      match prevAlight, board with
      | some pa, some b =>
        if !relocated && b != pa then
          viol := viol ++ [⟨"rail-discontinuity", l.startTs, l.endTs,
            s!"train boards at {b} but the previous train alighted at {pa} with no travel between"⟩]
      | _, _ => pure ()
      prevAlight := alight
      relocated := false
    else if !NON_RELOCATING.contains l.mode then
      relocated := true
  return viol

/-! ## Parity with Node/V8 (`lean/experiments/worldline-refs.mts`) -/

#guard parseRailWayName (some "A → B · Victoria") == some ⟨"A", "B", some "Victoria"⟩
#guard parseRailWayName (some "A → B") == some ⟨"A", "B", none⟩
#guard parseRailWayName (some "no arrow here") == none
#guard parseRailWayName none == none

private def steps3 : List FeasibilityStepPoint := [⟨0, 100⟩, ⟨60, 110⟩, ⟨120, 0⟩]
private def approxC (a b : Float) : Bool := Float.abs (a - b) < 1e-9
#guard match meanCadenceSpm steps3 0 180 with | some v => approxC v 70 | none => false
#guard match meanCadenceSpm steps3 0 120 with | some v => approxC v 105 | none => false
#guard meanCadenceSpm steps3 1000 2000 == none

private def walkLeg : List FeasibilityLeg := [⟨0, 200, "walking", none⟩]
private def fastFixes : List FeasibilityFix :=
  [⟨0, 51.5000, -0.1000⟩, ⟨30, 51.5053, -0.1000⟩, ⟨60, 51.5106, -0.1000⟩, ⟨90, 51.5159, -0.1000⟩]
#guard checkWorldlineFeasibility walkLeg (some fastFixes) ==
  [⟨"impossible-mode-kinematics", 0, 200,
    "walking leg sustains a vehicle-paced run: 1768 m net over 3 consecutive fast steps (peak 71 km/h) — not physically walking"⟩]

private def trainLeg : List FeasibilityLeg := [⟨0, 200, "train", some "A → A"⟩]
private def slowFixes : List FeasibilityFix :=
  [⟨0, 51.5000, -0.1000⟩, ⟨60, 51.5008, -0.1000⟩, ⟨120, 51.5016, -0.1000⟩, ⟨180, 51.5024, -0.1000⟩]
private def walkCadence : List FeasibilityStepPoint := [⟨0, 100⟩, ⟨60, 100⟩, ⟨120, 100⟩]
#guard checkWorldlineFeasibility trainLeg (some slowFixes) (some walkCadence) ==
  [⟨"impossible-mode-kinematics", 0, 200,
    "train leg sustains a pedestrian-paced stepping run: 267 m net over 180 s at 100 steps/min — not riding"⟩,
   ⟨"degenerate-train-leg", 0, 200, "train boards and alights at the same station (A)"⟩]

private def timeline : List FeasibilityLeg :=
  [⟨0, 100, "train", some "Victoria → Highbury · Victoria"⟩,
   ⟨100, 200, "train", some "Kings Cross → Farringdon · Metropolitan"⟩]
private def lineStations : List (String × List String) :=
  [("Victoria", ["Victoria", "Highbury"]), ("Metropolitan", ["Farringdon"])]
#guard checkWorldlineFeasibility timeline none none (some lineStations) ==
  [⟨"invalid-rail-triple", 100, 200,
    "train labelled Metropolitan boards at Kings Cross, a station that line does not serve"⟩,
   ⟨"rail-discontinuity", 100, 200,
    "train boards at Kings Cross but the previous train alighted at Highbury with no travel between"⟩]

private def relocatedTl : List FeasibilityLeg :=
  [⟨0, 100, "train", some "A → B · L1"⟩, ⟨100, 150, "walking", none⟩, ⟨150, 200, "train", some "C → D · L1"⟩]
#guard checkWorldlineFeasibility relocatedTl == []

end Verified.Geo.Worldline

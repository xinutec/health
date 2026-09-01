import Verified.Geo.RailAbsorbers
/-!
# Worldline feasibility (port of `src/eval/worldline-feasibility.ts`, #1048)

A model-independent assertion on the OUTPUT timeline: a real worldline is one
continuous path through space-time, so some outputs are simply impossible
regardless of how the cascade produced them. This checks the impossibilities the
pipeline has actually emitted, on the final drawn legs, with no dependency on
the model that built them.

Pippijn's requirement, 2026-09-01, is exactly this module's subject: *"Correct
or at least viable trajectory is important. It shouldn't show definitely-wrong
interpretations that can't be right given the data."*

## The four invariants

* **impossible-mode-kinematics** — a `walking` leg whose fixes sustain a
  vehicle-paced run over a real distance (the "64 km/h walk down the rail
  corridor"), and its symmetric twin: a `train` leg sustaining a
  pedestrian-paced run while the wearer steps at walking cadence (the "train at
  walking pace down the street").
* **invalid-rail-triple** — a leg labelled `Board → Alight · Line` naming a
  station that line does not reach (#181/#351).
* **rail-discontinuity** — two train legs with nothing relocating between them
  must share a station: you cannot step off at one and instantly board at
  another.
* **degenerate-train-leg** — a train boarding and alighting at the same station.

## ⚠ ZERO FALSE POSITIVES IS THE DESIGN CONSTRAINT, NOT AN ASPIRATION

Every threshold here is set so the check asserts only when there is no innocent
reading, and each conservatism is load-bearing:

* Only `walking` is asserted for vehicle pace. A stationary leg's sparse
  blackout fixes teleport in consistent pairs (cell-tower hops).
* Only `train` is asserted for pedestrian pace. Buses and cars genuinely crawl
  at walking pace in traffic, where a bumpy ride's phantom wrist-cadence could
  false-positive.
* The pedestrian invariant needs FOUR signals to agree — pace band, duration,
  net displacement and cadence — so a signal-stop crawl (no cadence), a platform
  dwell (no net distance) and a brief slow patch (no duration) never assert.
  Without step data it does not assert at all.
* Line membership is proximity-inferred and therefore OVER-inclusive, so
  ABSENCE is the strong signal; over-inclusion can only produce false
  NEGATIVES. An empty list means the line is unknown, not that it serves
  nothing, and never asserts.
* Rail continuity asserts only when the station pair is DETERMINABLE. A
  bare-line leg breaks the chain rather than producing a false positive.

## ⚠ THE DISTANCE IS EQUIRECTANGULAR, NOT HAVERSINE

`fixDistanceM` is a flat-earth approximation with a cosine correction at the
midpoint latitude — NOT the `haversineMeters` used elsewhere in this codebase.
Substituting haversine would change every threshold comparison slightly and is
the obvious "tidying" to make here. It is reproduced operation for operation.
-/

namespace Verified.Eval.Feasibility

open Verified.Geo.RailAbsorbers (parseRailWayName)

inductive Kind where
  | railDiscontinuity | degenerateTrainLeg | impossibleModeKinematics | invalidRailTriple
  deriving BEq, Repr, Inhabited

def Kind.toString : Kind → String
  | .railDiscontinuity => "rail-discontinuity"
  | .degenerateTrainLeg => "degenerate-train-leg"
  | .impossibleModeKinematics => "impossible-mode-kinematics"
  | .invalidRailTriple => "invalid-rail-triple"

structure Violation where
  kind : Kind
  /-- The offending (later) leg's window. -/
  startTs : Int
  endTs : Int
  detail : String
  deriving BEq, Repr, Inhabited

/-- The minimal drawn-leg shape this needs — structurally a `DayState`. -/
structure Leg where
  startTs : Int
  endTs : Int
  mode : String
  wayName : Option String := none
  deriving BEq, Repr, Inhabited

structure Fix where
  ts : Int
  lat : Float
  lon : Float
  deriving BEq, Repr, Inhabited

structure StepPoint where
  ts : Int
  steps : Float
  deriving BEq, Repr, Inhabited

/-! ## Constants -/

/-- Per-step pace above which a fix pair is vehicle motion, not on-foot motion.
The physical walking ceiling is 12 km/h; 15 gives the same GPS-noise headroom
the vehicle-carve and alight-anchor passes use. -/
def KINEMATIC_VEHICLE_STEP_KMH : Float := 15
/-- A vehicle-paced run only counts as impossible when it travels an
inter-station-scale distance. Jitter cannot accumulate this as NET
displacement. -/
def KINEMATIC_MIN_RUN_NET_M : Float := 250
/-- …across at least this many consecutive fast steps. A SINGLE fast step is a
GPS reacquire teleport, not a ride. -/
def KINEMATIC_MIN_RUN_STEPS : Nat := 2

/-- Per-step pace at or below which a fix pair could be on-foot motion. Brisk
walking tops out ~7 km/h; 9 leaves GPS-noise headroom. (A train CAN move this
slowly — which is why pace alone never asserts; cadence must agree.) -/
def PEDESTRIAN_STEP_MAX_KMH : Float := 9
def PEDESTRIAN_MIN_RUN_NET_M : Float := 120
/-- A sub-minute slow patch is a signal-stop crawl; the acceptance case (a
stolen station-exit walk) runs ~2 minutes. -/
def PEDESTRIAN_MIN_RUN_S : Float := 90
/-- A seated rider on a crawling train shows near-zero steps/min; genuine
walking is ≳100. 60 splits them with margin on both sides. -/
def PEDESTRIAN_MIN_CADENCE_SPM : Float := 60

def EARTH_R_M : Float := 6371000

/-- Modes that do NOT move the user between distinct stations. A stay or sleep
between two train legs cannot put you at a different boarding station; a
walking/driving leg can. -/
def isNonRelocating (m : String) : Bool :=
  m == "stationary" || m == "sleeping" || m == "unknown"

/-! ## Distance -/

/-- ⚠ EQUIRECTANGULAR, not haversine — see the module header. -/
def fixDistanceM (a b : Fix) : Float :=
  let rad := 3.141592653589793 / 180
  let dLat := (b.lat - a.lat) * rad
  let dLon := (b.lon - a.lon) * rad * Float.cos (((a.lat + b.lat) / 2) * rad)
  Float.sqrt (dLat * dLat + dLon * dLon) * EARTH_R_M

/-! ## The kinematic invariants -/

structure PacedRun where
  netM : Float
  steps : Nat
  peakKmh : Float
  deriving BEq, Repr, Inhabited

/-- The worst sustained vehicle-paced run inside a window's fixes.

⚠ EXTRACTED so a probe can ask this question on modes the INVARIANT
deliberately does not assert on, without restating the rule and drifting from
it. Measuring a mode and asserting on it are different decisions; only the
second has to be zero-false-positive. -/
def worstVehiclePacedRun (fixes : Array Fix) : Option PacedRun := Id.run do
  let mut runStart : Int := -1
  let mut runSteps : Nat := 0
  let mut worst : Option PacedRun := none
  let mut peakKmh : Float := 0
  for i in [1:fixes.size] do
    let dt := fixes[i]!.ts - fixes[i-1]!.ts
    let stepM := fixDistanceM fixes[i-1]! fixes[i]!
    let stepKmh := if dt > 0 then stepM / Float.ofInt dt * 3.6 else 0
    if stepKmh ≥ KINEMATIC_VEHICLE_STEP_KMH then
      if runStart < 0 then
        runStart := Int.ofNat (i - 1)
        runSteps := 0
        peakKmh := 0
      runSteps := runSteps + 1
      peakKmh := max peakKmh stepKmh
      let netM := fixDistanceM fixes[runStart.toNat]! fixes[i]!
      if runSteps ≥ KINEMATIC_MIN_RUN_STEPS && netM ≥ KINEMATIC_MIN_RUN_NET_M
          && (match worst with | none => true | some w => netM > w.netM) then
        worst := some { netM, steps := runSteps, peakKmh }
    else
      runStart := -1
  return worst

private def fixesIn (points : Array Fix) (a b : Int) : Array Fix :=
  points.filter (fun p => p.ts ≥ a && p.ts ≤ b)

private def roundI (f : Float) : Int := (Verified.JsNum.jsRound f).toInt64.toInt

/-- A `walking` leg whose fixes sustain a vehicle-paced run over a real distance
contains movement that is not walking — a ride tail stranded by a mis-placed
segment boundary.

⚠ WALKING ONLY. See the module header. -/
def checkModeKinematics (legs : Array Leg) (points : Array Fix) : Array Violation :=
  legs.filterMap fun l =>
    if l.mode != "walking" then none
    else match worstVehiclePacedRun (fixesIn points l.startTs l.endTs) with
      | none => none
      | some w => some {
          kind := .impossibleModeKinematics, startTs := l.startTs, endTs := l.endTs,
          detail := s!"{l.mode} leg sustains a vehicle-paced run: {roundI w.netM} m net over " ++
            s!"{w.steps} consecutive fast steps (peak {roundI w.peakKmh} km/h) — " ++
            s!"not physically {l.mode}" }

/-- Mean steps/min over `[startTs, endTs]` from per-minute buckets, or `none`
when no bucket overlaps the window.

⚠ NO DATA ≠ ZERO CADENCE, and the distinction is what stops the pedestrian
invariant asserting on a day with no step stream at all. -/
def meanCadenceSpm (steps : Array StepPoint) (startTs endTs : Int) : Option Float := Id.run do
  let mut total : Float := 0
  let mut overlapped := false
  for s in steps do
    if s.ts + 60 ≤ startTs || s.ts ≥ endTs then continue
    overlapped := true
    total := total + s.steps
  if !overlapped then return none
  return some (total / max 1 (Float.ofInt (endTs - startTs) / 60))

/-- The symmetric invariant (#356): a `train` leg whose fixes sustain a
pedestrian-paced run over a real net distance WHILE the wearer steps at walking
cadence contains movement that is not riding.

⚠ ALL FOUR SIGNALS MUST AGREE — pace band, duration, net displacement, cadence.
See the module header for what each one rules out. -/
def checkVehiclePedestrianRuns (legs : Array Leg) (points : Array Fix)
    (steps : Array StepPoint) : Array Violation :=
  legs.filterMap fun l =>
    if l.mode != "train" then none else Id.run do
      let fixes := fixesIn points l.startTs l.endTs
      let mut runStart : Int := -1
      let mut worst : Option (Float × Float × Float) := none
      for i in [1:fixes.size] do
        let dt := fixes[i]!.ts - fixes[i-1]!.ts
        let stepKmh := if dt > 0 then fixDistanceM fixes[i-1]! fixes[i]! / Float.ofInt dt * 3.6 else 0
        if stepKmh ≤ PEDESTRIAN_STEP_MAX_KMH && dt > 0 then
          if runStart < 0 then runStart := Int.ofNat (i - 1)
          let rs := runStart.toNat
          let durS := Float.ofInt (fixes[i]!.ts - fixes[rs]!.ts)
          let netM := fixDistanceM fixes[rs]! fixes[i]!
          if durS ≥ PEDESTRIAN_MIN_RUN_S && netM ≥ PEDESTRIAN_MIN_RUN_NET_M
              && (match worst with | none => true | some (wn, _, _) => netM > wn) then
            match meanCadenceSpm steps fixes[rs]!.ts fixes[i]!.ts with
            | some cadence => if cadence ≥ PEDESTRIAN_MIN_CADENCE_SPM then
                worst := some (netM, durS, cadence)
            | none => pure ()
        else
          runStart := -1
      match worst with
      | none => return none
      | some (netM, durS, cadence) => return some {
          kind := .impossibleModeKinematics, startTs := l.startTs, endTs := l.endTs,
          detail := s!"{l.mode} leg sustains a pedestrian-paced stepping run: {roundI netM} m net over " ++
            s!"{roundI durS} s at {roundI cadence} steps/min — not riding" }

/-! ## The rail invariants -/

/-- Line → the stations it serves.

⚠ MEMBERSHIP IS PROXIMITY-INFERRED and therefore OVER-inclusive, so ABSENCE is
the strong signal: a labelled endpoint missing from a NON-EMPTY list is a
station nowhere near the line's tracks. Over-inclusion can only produce false
NEGATIVES, which is what keeps this zero-false-positive. An EMPTY list means the
line is unknown to the mirror, not that it serves nothing, and never asserts. -/
abbrev LineMembership := Array (String × Array String)

private def norm (s : String) : String :=
  s.trimAscii.toString.toLower

/-- The valid-triple invariant (#181/#351): a train leg labelled
`Board → Alight · Line` must name two stations the line actually reaches. -/
def checkRailTriples (legs : Array Leg) (lineStations : LineMembership) : Array Violation := Id.run do
  let mut out : Array Violation := #[]
  for l in legs do
    if l.mode != "train" then continue
    match parseRailWayName l.wayName with
    | none => continue
    | some rail =>
      -- ⚠ TRUTHINESS: the original tests `rail.line`, so an empty line is absent.
      match rail.line with
      | none => continue
      | some line =>
        if line == "" then continue
        match lineStations.find? (·.1 == line) with
        | none => continue          -- unknown line — cannot assert
        | some (_, served) =>
          if served.isEmpty then continue
          let names := served.map norm
          for (role, station) in [("boards at", rail.board), ("alights at", rail.alight)] do
            if !names.contains (norm station) then
              out := out.push {
                kind := .invalidRailTriple, startTs := l.startTs, endTs := l.endTs,
                detail := s!"train labelled {line} {role} {station}, a station that line does not serve" }
  return out

/-! ## The whole check -/

/-- Every feasibility violation in a drawn timeline.

The rail chain: assert continuity only when both endpoints are determinable and
nothing has relocated the user since the previous train. A leg with no
determinable alight BREAKS the chain rather than being asserted across. -/
def checkWorldlineFeasibility (legs : Array Leg) (points : Array Fix)
    (steps : Array StepPoint) (lineStations : LineMembership) : Array Violation := Id.run do
  let mut out := checkModeKinematics legs points
  if !steps.isEmpty then
    out := out ++ checkVehiclePedestrianRuns legs points steps
  out := out ++ checkRailTriples legs lineStations
  let mut prevAlight : Option String := none
  let mut relocatedSincePrevTrain := false
  for l in legs do
    if l.mode == "train" then
      let rail := parseRailWayName l.wayName
      let board := rail.map (·.board)
      let alight := rail.map (·.alight)
      match board, alight with
      | some b, some a =>
        if b == a then
          out := out.push {
            kind := .degenerateTrainLeg, startTs := l.startTs, endTs := l.endTs,
            detail := s!"train boards and alights at the same station ({b})" }
      | _, _ => pure ()
      match prevAlight, board with
      | some pa, some b =>
        if !relocatedSincePrevTrain && b != pa then
          out := out.push {
            kind := .railDiscontinuity, startTs := l.startTs, endTs := l.endTs,
            detail := s!"train boards at {b} but the previous train alighted at {pa} with no travel between" }
      | _, _ => pure ()
      prevAlight := alight
      relocatedSincePrevTrain := false
    else if !isNonRelocating l.mode then
      relocatedSincePrevTrain := true
  return out


/-! ## Witnesses

⚠ SYNTHETIC ONLY (#860): coordinates are a bare degree grid and station names
are Greek letters, so nothing here carries a real place.

Checked differentially against the recovered TypeScript over the real corpus by
`rust/backend/tests/feasibility_corpus.rs`: 42 days, perturbed into 295 cases so
every invariant fires — **924 violations, 3,696 field comparisons, 0
disagreements**. Seven ablations, all seven moving that count.
-/

section Witnesses

private def fx (ts : Int) (lon : Float) : Fix := { ts, lat := 0, lon }
private def lg (s e : Int) (m : String) (w : Option String := none) : Leg :=
  { startTs := s, endTs := e, mode := m, wayName := w }

-- Equirectangular, and at the equator that is the flat answer. ⚠ 1111.95 m, not
-- 1113.19: `EARTH_R_M` is the MEAN radius 6371000, not the WGS84 equatorial one.
#guard (fixDistanceM (fx 0 0) (fx 0 0.01) - 1111.95).abs < 0.5
#guard fixDistanceM (fx 0 0) (fx 0 0) == 0

/-! ### impossible-mode-kinematics, the vehicle direction -/

-- 1112 m in 30 s is 133 km/h, twice, over 2224 m net: impossible on foot.
private def fastWalk : Array Fix := #[fx 0 0, fx 30 0.01, fx 60 0.02]
#guard (worstVehiclePacedRun fastWalk).isSome
#guard (checkModeKinematics #[lg 0 60 "walking"] fastWalk).size == 1
#guard (checkModeKinematics #[lg 0 60 "walking"] fastWalk)[0]!.kind == .impossibleModeKinematics
-- ⚠ ONE fast step is a GPS reacquire teleport, not a ride.
#guard (worstVehiclePacedRun #[fx 0 0, fx 30 0.01]) == none
-- ⚠ NET displacement, not distance travelled: jitter is fast and goes nowhere.
#guard (worstVehiclePacedRun #[fx 0 0, fx 30 0.01, fx 60 0]) == none
-- Walking pace never asserts, however long it runs.
#guard (worstVehiclePacedRun #[fx 0 0, fx 3000 0.01, fx 6000 0.02]) == none
-- ⚠ ONLY `walking` IS ASSERTED — a stationary leg's blackout fixes can teleport
-- in consistent pairs, so asserting there would not be zero-false-positive.
#guard (checkModeKinematics #[lg 0 60 "stationary"] fastWalk).size == 0
#guard (checkModeKinematics #[lg 0 60 "train"] fastWalk).size == 0
#guard (checkModeKinematics #[lg 0 60 "driving"] fastWalk).size == 0
-- …but the MEASUREMENT stays available on those modes, which is why
-- `worstVehiclePacedRun` is exported separately from the assertion.
#guard (worstVehiclePacedRun fastWalk).isSome
-- Fixes outside the leg's window are not its evidence.
#guard (checkModeKinematics #[lg 100 200 "walking"] fastWalk).size == 0

/-! ### impossible-mode-kinematics, the pedestrian direction -/

-- 278 m in 200 s is 5 km/h — pedestrian pace over a real distance.
private def slowTrain : Array Fix := #[fx 0 0, fx 100 0.00125, fx 200 0.0025]
private def cadence (spm : Float) : Array StepPoint :=
  #[{ ts := 0, steps := spm }, { ts := 60, steps := spm }, { ts := 120, steps := spm },
    { ts := 180, steps := spm }]
#guard (checkVehiclePedestrianRuns #[lg 0 200 "train"] slowTrain (cadence 110)).size == 1
-- ⚠ ALL FOUR SIGNALS MUST AGREE. Cadence separates a walk from a crawling
-- train, and a seated rider shows near-zero steps.
#guard (checkVehiclePedestrianRuns #[lg 0 200 "train"] slowTrain (cadence 5)).size == 0
-- ⚠ NO STEP DATA IS NOT ZERO CADENCE — it asserts nothing at all.
#guard (checkVehiclePedestrianRuns #[lg 0 200 "train"] slowTrain #[]).size == 0
#guard meanCadenceSpm #[] 0 200 == none
#guard meanCadenceSpm (cadence 60) 0 120 == some 60
-- A window no bucket overlaps is unknown, not zero.
#guard meanCadenceSpm (cadence 60) 100000 100200 == none
-- ⚠ TRAIN ONLY. Buses and cars genuinely crawl in traffic, where a bumpy
-- ride's phantom wrist-cadence could false-positive.
#guard (checkVehiclePedestrianRuns #[lg 0 200 "bus"] slowTrain (cadence 110)).size == 0
#guard (checkVehiclePedestrianRuns #[lg 0 200 "driving"] slowTrain (cadence 110)).size == 0
-- A brief slow patch is a signal stop: under 90 s never asserts.
#guard (checkVehiclePedestrianRuns #[lg 0 60 "train"] #[fx 0 0, fx 60 0.0025] (cadence 110)).size == 0

/-! ### invalid-rail-triple -/

private def served : LineMembership := #[("Red Line", #["Alpha", "Beta"])]
#guard (checkRailTriples #[lg 0 9 "train" (some "Alpha → Beta · Red Line")] served).size == 0
#guard (checkRailTriples #[lg 0 9 "train" (some "Alpha → Gamma · Red Line")] served).size == 1
-- BOTH endpoints are checked, so a leg wrong at both ends reports twice.
#guard (checkRailTriples #[lg 0 9 "train" (some "Delta → Gamma · Red Line")] served).size == 2
-- Case and surrounding space do not matter.
#guard (checkRailTriples #[lg 0 9 "train" (some "alpha → BETA · Red Line")] served).size == 0
-- ⚠ AN UNKNOWN LINE CANNOT ASSERT — absence from the mirror is not evidence.
#guard (checkRailTriples #[lg 0 9 "train" (some "Alpha → Gamma · Blue Line")] served).size == 0
-- ⚠ AND AN EMPTY LIST MEANS UNKNOWN, NOT "SERVES NOTHING". Four such entries
-- exist across the 42 corpus days; without this guard every leg on such a line
-- is a violation.
#guard (checkRailTriples #[lg 0 9 "train" (some "Alpha → Beta · Grey Line")]
    #[("Grey Line", #[])]).size == 0
-- A leg naming no line carries no triple to check.
#guard (checkRailTriples #[lg 0 9 "train" (some "Alpha → Beta")] served).size == 0
#guard (checkRailTriples #[lg 0 9 "train" none] served).size == 0
#guard (checkRailTriples #[lg 0 9 "walking" (some "Alpha → Gamma · Red Line")] served).size == 0

/-! ### rail-discontinuity and degenerate-train-leg -/

private def noFix : Array Fix := #[]
private def chain (ls : List Leg) : Array Violation :=
  checkWorldlineFeasibility ls.toArray noFix #[] #[]

#guard (chain [lg 0 9 "train" (some "Alpha → Beta"), lg 9 18 "train" (some "Gamma → Delta")]).size == 1
#guard (chain [lg 0 9 "train" (some "Alpha → Beta"), lg 9 18 "train" (some "Gamma → Delta")])[0]!.kind
    == .railDiscontinuity
-- Boarding where you alighted is continuous.
#guard (chain [lg 0 9 "train" (some "Alpha → Beta"), lg 9 18 "train" (some "Beta → Gamma")]).size == 0
-- ⚠ A STAY DOES NOT RELOCATE YOU — the chain survives it and still asserts.
#guard (chain [lg 0 9 "train" (some "Alpha → Beta"), lg 9 18 "stationary",
               lg 18 27 "train" (some "Gamma → Delta")]).size == 1
#guard (chain [lg 0 9 "train" (some "Alpha → Beta"), lg 9 18 "sleeping",
               lg 18 27 "train" (some "Gamma → Delta")]).size == 1
-- ⚠ A WALK DOES — you could legitimately have walked to another station.
#guard (chain [lg 0 9 "train" (some "Alpha → Beta"), lg 9 18 "walking",
               lg 18 27 "train" (some "Gamma → Delta")]).size == 0
#guard (chain [lg 0 9 "train" (some "Alpha → Beta"), lg 9 18 "driving",
               lg 18 27 "train" (some "Gamma → Delta")]).size == 0
-- ⚠ AN UNDETERMINABLE PAIR BREAKS THE CHAIN rather than asserting across it.
#guard (chain [lg 0 9 "train" (some "Red Line"), lg 9 18 "train" (some "Gamma → Delta")]).size == 0
#guard (chain [lg 0 9 "train" (some "Alpha → Beta"), lg 9 18 "train" (some "Red Line"),
               lg 18 27 "train" (some "Gamma → Delta")]).size == 0
-- A train that boards and alights at the same station.
#guard (chain [lg 0 9 "train" (some "Alpha → Alpha")]).size == 1
#guard (chain [lg 0 9 "train" (some "Alpha → Alpha")])[0]!.kind == .degenerateTrainLeg
#guard (chain []).size == 0

-- The whole check composes, and each input's ABSENCE silences exactly its own
-- invariant — the zero-false-positive rule applied to missing data.
#guard (checkWorldlineFeasibility #[lg 0 60 "walking"] fastWalk #[] #[]).size == 1
#guard (checkWorldlineFeasibility #[lg 0 60 "walking"] #[] #[] #[]).size == 0
#guard (checkWorldlineFeasibility #[lg 0 200 "train"] slowTrain #[] #[]).size == 0
#guard (checkWorldlineFeasibility #[lg 0 200 "train"] slowTrain (cadence 110) #[]).size == 1
#guard (checkWorldlineFeasibility #[lg 0 9 "train" (some "Alpha → Gamma · Red Line")] #[] #[] #[]).size == 0
#guard (checkWorldlineFeasibility #[lg 0 9 "train" (some "Alpha → Gamma · Red Line")] #[] #[] served).size == 1

end Witnesses

end Verified.Eval.Feasibility

import Verified.Geo.RailAbsorbers
import Verified.Fix
/-!
# Worldline feasibility

A real worldline is one continuous path through space-time, so some timelines
are impossible however they were produced. This checks the final drawn legs for
the impossibilities the pipeline has emitted (the user's requirement: never show
an interpretation the data rules out):

* impossible-mode-kinematics: a `walking` leg sustaining vehicle pace over a real
  distance, or a `train` leg sustaining walking pace while the wearer steps at
  walking cadence;
* invalid-rail-triple: `Board → Alight · Line` naming a station the line does
  not reach;
* rail-discontinuity: two train legs with nothing relocating between them must
  share a station;
* degenerate-train-leg: boarding and alighting at the same station;
* teleport: two stays at different places with nothing between, further apart
  than walkable in the time, beyond the fixes' noise. A stay is where its name
  was asked (`DayState.placeAt`), else where its fixes put it.

## ⚠ Zero false positives is the design constraint

Each check asserts only when no innocent reading exists. Vehicle pace is
asserted only on `walking` (a stationary leg's blackout fixes hop cell towers);
walking pace only on `train` (buses crawl in traffic) and only when pace,
duration, net displacement and cadence all agree, never without step data. Line
membership is proximity-inferred and so over-inclusive, which can only miss; an
empty list is unknown and never asserts. Rail continuity asserts only for a
determinable station pair.

The distance (`fixDistanceM`) is equirectangular with a midpoint cosine, not
haversine: swapping it is the obvious tidy and would move every threshold.
-/

namespace Verified.Eval.Feasibility

open Verified.Geo.RailAbsorbers (parseRailWayName)

inductive Kind where
  | railDiscontinuity | degenerateTrainLeg | impossibleModeKinematics | invalidRailTriple
  | teleport
  deriving BEq, Repr, Inhabited

def Kind.toString : Kind → String
  | .railDiscontinuity => "rail-discontinuity"
  | .degenerateTrainLeg => "degenerate-train-leg"
  | .impossibleModeKinematics => "impossible-mode-kinematics"
  | .invalidRailTriple => "invalid-rail-triple"
  | .teleport => "teleport"

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
  place : Option String := none
  /-- Where the name was asked for (`DayState.placeAt`). -/
  placeAt : Option (Float × Float) := none
  deriving BEq, Repr, Inhabited

abbrev Fix := Verified.GeoFix

/-- A raw fix with the radius the phone reported for it, metres. -/
structure AccFix where
  ts : Int
  lat : Float
  lon : Float
  accuracyM : Float
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
inter-station-scale distance. Jitter cannot accumulate this as net
displacement. -/
def KINEMATIC_MIN_RUN_NET_M : Float := 250
/-- …across at least this many consecutive fast steps. A single fast step is a
GPS reacquire teleport, not a ride. -/
def KINEMATIC_MIN_RUN_STEPS : Nat := 2

/-- Per-step pace at or below which a fix pair could be on-foot motion. Brisk
walking tops out ~7 km/h; 9 leaves GPS-noise headroom. (A train can move this
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

/-- The on-foot ceiling in metres a second: what walking covers between stays. -/
def WALK_MAX_MPS : Float := KINEMATIC_VEHICLE_STEP_KMH / 3.6

/-- How many standard deviations of location noise a stay→stay distance must
exceed, beyond what walking covers, to be a teleport. -/
def TELEPORT_SIGMAS : Float := 3

/-- Modes that do not move the user between distinct stations. A stay or sleep
between two train legs cannot put you at a different boarding station; a
walking/driving leg can. -/
def isNonRelocating (m : String) : Bool :=
  m == "stationary" || m == "sleeping" || m == "unknown"

/-! ## Distance -/

/-- Equirectangular, not haversine — see the module header. -/
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
  /-- The run's first and last fix. -/
  fromTs : Int
  toTs : Int
  deriving BEq, Repr, Inhabited

/-- The worst sustained vehicle-paced run in a window's fixes, separate so a
probe can measure modes the invariant does not assert on without restating it. -/
def worstVehiclePacedRun (fixes : Array Fix) : Option PacedRun := Id.run do
  let mut runStart : Int := -1
  -- The run's first fix, carried with its index so the read needs no bound.
  let mut runFirst : Option Fix := none
  let mut runSteps : Nat := 0
  let mut worst : Option PacedRun := none
  let mut peakKmh : Float := 0
  for hm_i : i in [1:fixes.size] do
    have hb_i : i < fixes.size := hm_i.upper
    let dt := fixes[i].ts - fixes[i - 1].ts
    let stepM := fixDistanceM fixes[i - 1] fixes[i]
    let stepKmh := if dt > 0 then stepM / Float.ofInt dt * 3.6 else 0
    if stepKmh ≥ KINEMATIC_VEHICLE_STEP_KMH then
      if runStart < 0 then
        runStart := Int.ofNat (i - 1)
        runFirst := some fixes[i - 1]
        runSteps := 0
        peakKmh := 0
      runSteps := runSteps + 1
      peakKmh := max peakKmh stepKmh
      -- Set on the branch above whenever `runStart` is; the default is the
      -- same fix that branch stores.
      let netM := fixDistanceM (runFirst.getD fixes[i - 1]) fixes[i]
      if runSteps ≥ KINEMATIC_MIN_RUN_STEPS && netM ≥ KINEMATIC_MIN_RUN_NET_M
          && (match worst with | none => true | some w => netM > w.netM) then
        worst := some { netM, steps := runSteps, peakKmh,
                        fromTs := (runFirst.getD fixes[i - 1]).ts, toTs := fixes[i].ts }
    else
      runStart := -1
      runFirst := none
  return worst

private def fixesIn (points : Array Fix) (a b : Int) : Array Fix :=
  points.filter (fun p => p.ts ≥ a && p.ts ≤ b)

private def roundI (f : Float) : Int := (Verified.JsNum.jsRound f).toInt64.toInt

/-- Steps/min every minute a walked run touches must reach for its fixes to be
the noise, not the walk. Real walking is ≳100; a ride's minute reaches 90 only
when most of it was walked. -/
def KINEMATIC_WALKED_MIN_SPM : Float := 90

/-- Every minute bucket from `fromTs`'s to `toTs`'s is present and at walking
cadence. A missing minute is not a walked one. -/
def walkedThrough (steps : Array StepPoint) (fromTs toTs : Int) : Bool := Id.run do
  let first := fromTs / 60
  let last := toTs / 60
  for m in [0:(last - first + 1).toNat] do
    match steps.find? (fun s => s.ts / 60 == first + Int.ofNat m) with
    | some s => if s.steps < KINEMATIC_WALKED_MIN_SPM then return false
    | none => return false
  return true

/-- A `walking` leg sustaining a vehicle-paced run over a real distance holds a
ride tail stranded by a misplaced boundary. Walking only. A run the wearer
stepped through at walking cadence is the fixes moving, not the wearer. -/
def checkModeKinematics (legs : Array Leg) (points : Array Fix)
    (steps : Array StepPoint := #[]) : Array Violation :=
  legs.filterMap fun l =>
    if l.mode != "walking" then none
    else match worstVehiclePacedRun (fixesIn points l.startTs l.endTs) with
      | none => none
      | some w =>
        if walkedThrough steps w.fromTs w.toTs then none
        else some {
          kind := .impossibleModeKinematics, startTs := l.startTs, endTs := l.endTs,
          detail := s!"{l.mode} leg sustains a vehicle-paced run: {roundI w.netM} m net over " ++
            s!"{w.steps} consecutive fast steps (peak {roundI w.peakKmh} km/h) — " ++
            s!"not physically {l.mode}" }

/-- Mean steps/min over `[startTs, endTs]` from per-minute buckets, or `none`
with no bucket, which keeps the pedestrian invariant silent without a step
stream. -/
def meanCadenceSpm (steps : Array StepPoint) (startTs endTs : Int) : Option Float := Id.run do
  let mut total : Float := 0
  let mut overlapped := false
  for s in steps do
    if s.ts + 60 ≤ startTs || s.ts ≥ endTs then continue
    overlapped := true
    total := total + s.steps
  if !overlapped then return none
  return some (total / max 1 (Float.ofInt (endTs - startTs) / 60))

/-- The converse: a `train` leg sustaining a walking-paced run over a real net
distance while the wearer steps at walking cadence holds movement that is not
riding. All four signals must agree. -/
def checkVehiclePedestrianRuns (legs : Array Leg) (points : Array Fix)
    (steps : Array StepPoint) : Array Violation :=
  legs.filterMap fun l =>
    if l.mode != "train" then none else Id.run do
      let fixes := fixesIn points l.startTs l.endTs
      let mut runStart : Int := -1
      let mut runFirst : Option Fix := none
      let mut worst : Option (Float × Float × Float) := none
      for hm_i : i in [1:fixes.size] do
        have hb_i : i < fixes.size := hm_i.upper
        let dt := fixes[i].ts - fixes[i - 1].ts
        let stepKmh := if dt > 0 then fixDistanceM fixes[i - 1] fixes[i] / Float.ofInt dt * 3.6 else 0
        if stepKmh ≤ PEDESTRIAN_STEP_MAX_KMH && dt > 0 then
          if runStart < 0 then
            runStart := Int.ofNat (i - 1)
            runFirst := some fixes[i - 1]
          let rs := runFirst.getD fixes[i - 1]
          let durS := Float.ofInt (fixes[i].ts - rs.ts)
          let netM := fixDistanceM rs fixes[i]
          if durS ≥ PEDESTRIAN_MIN_RUN_S && netM ≥ PEDESTRIAN_MIN_RUN_NET_M
              && (match worst with | none => true | some (wn, _, _) => netM > wn) then
            match meanCadenceSpm steps rs.ts fixes[i].ts with
            | some cadence => if cadence ≥ PEDESTRIAN_MIN_CADENCE_SPM then
                worst := some (netM, durS, cadence)
            | none => pure ()
        else
          runStart := -1
          runFirst := none
      match worst with
      | none => return none
      | some (netM, durS, cadence) => return some {
          kind := .impossibleModeKinematics, startTs := l.startTs, endTs := l.endTs,
          detail := s!"{l.mode} leg sustains a pedestrian-paced stepping run: {roundI netM} m net over " ++
            s!"{roundI durS} s at {roundI cadence} steps/min — not riding" }

/-! ## The rail invariants -/

/-- Line → the stations it serves. Proximity-inferred, so absence is the strong
signal (a labelled endpoint missing from a non-empty list is nowhere near the
line); an empty list means unknown and never asserts. -/
abbrev LineMembership := Array (String × Array String)

private def norm (s : String) : String :=
  s.trimAscii.toString.toLower

/-- The valid-triple invariant: a train leg labelled
`Board → Alight · Line` must name two stations the line actually reaches. -/
def checkRailTriples (legs : Array Leg) (lineStations : LineMembership) : Array Violation := Id.run do
  let mut out : Array Violation := #[]
  for l in legs do
    if l.mode != "train" then continue
    match parseRailWayName l.wayName with
    | none => continue
    | some rail =>
      -- An empty line name counts as no line.
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

/-! ## The teleport invariant -/

/-- Where a stay's fixes put it and how precisely: means weighted by
1/accuracy². The noise is not divided by √n: indoor errors are correlated, and
crediting √n put two halves of one night at Home fifteen σ apart. -/
def stayLocation (fixes : Array AccFix) : Option (Fix × Float) := Id.run do
  let mut w := 0.0
  let mut lat := 0.0
  let mut lon := 0.0
  let mut acc := 0.0
  for f in fixes do
    if f.accuracyM ≤ 0 then continue
    let k := 1 / (f.accuracyM * f.accuracyM)
    w := w + k
    lat := lat + k * f.lat
    lon := lon + k * f.lon
    acc := acc + k * f.accuracyM
  if w == 0 then return none
  return some ({ ts := 0, lat := lat / w, lon := lon / w }, acc / w)

private def isStay (m : String) : Bool := m == "stationary" || m == "sleeping"

/-- Stays at different places with nothing relocating between them must be
reachable on foot in the time between. A stay with no name, or no fixes to
measure its noise by, is not judged. -/
def checkTeleports (legs : Array Leg) (fixes : Array AccFix) : Array Violation := Id.run do
  let mut out : Array Violation := #[]
  -- The last stay, while nothing that relocates has followed it.
  let mut prev : Option Leg := none
  for l in legs do
    if isStay l.mode then
      if let some a := prev then
        if let (some pa, some pb) := (a.place, l.place) then
          let at_ (s : Leg) := stayLocation (fixes.filter fun f => f.ts ≥ s.startTs && f.ts ≤ s.endTs)
          if let (true, some (ea, sa), some (eb, sb)) := (pa != pb, at_ a, at_ l) then
            let pos (s : Leg) (e : Fix) : Fix :=
              match s.placeAt with | some (lat, lon) => { ts := 0, lat, lon } | none => e
            let d := fixDistanceM (pos a ea) (pos l eb)
            let gap := Float.ofInt (max 0 (l.startTs - a.endTs))
            let reach := WALK_MAX_MPS * gap
            let noise := Float.sqrt (sa * sa + sb * sb)
            if d > reach + TELEPORT_SIGMAS * noise then
              out := out.push {
                kind := .teleport, startTs := l.startTs, endTs := l.endTs,
                detail := s!"{a.mode} @ {pa} → {l.mode} @ {pb} with no travel between: " ++
                  s!"{roundI d} m apart in {roundI gap} s, where walking reaches {roundI reach} m " ++
                  s!"and the fixes place the stays within {roundI noise} m" }
      prev := some l
    else if !isNonRelocating l.mode then
      prev := none
  return out

/-! ## The whole check -/

/-- Every feasibility violation in a drawn timeline. Rail continuity is asserted
only between determinable endpoints with nothing relocating between trains; an
undeterminable alight breaks the chain. -/
def checkWorldlineFeasibility (legs : Array Leg) (points : Array Fix)
    (steps : Array StepPoint) (lineStations : LineMembership)
    (accFixes : Array AccFix := #[]) : Array Violation := Id.run do
  let mut out := checkModeKinematics legs points steps
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
  return out ++ checkTeleports legs accFixes


/-! ## Witnesses

⚠ Synthetic only: a bare degree grid and Greek-letter station names.
`rust/backend/tests/corpus/feasibility.rs` runs the real corpus, perturbed so
every invariant fires.
-/

section Witnesses

private def fx (ts : Int) (lon : Float) : Fix := { ts, lat := 0, lon }
private def lg (s e : Int) (m : String) (w : Option String := none) : Leg :=
  { startTs := s, endTs := e, mode := m, wayName := w }

-- Equirectangular, and at the equator that is the flat answer. 1111.95 m, not
-- 1113.19: `EARTH_R_M` is the mean radius 6371000, not the WGS84 equatorial one.
#guard (fixDistanceM (fx 0 0) (fx 0 0.01) - 1111.95).abs < 0.5
#guard fixDistanceM (fx 0 0) (fx 0 0) == 0

/-! ### impossible-mode-kinematics, the vehicle direction -/

-- 1112 m in 30 s is 133 km/h, twice, over 2224 m net: impossible on foot.
private def fastWalk : Array Fix := #[fx 0 0, fx 30 0.01, fx 60 0.02]
#guard (worstVehiclePacedRun fastWalk).isSome
#guard (checkModeKinematics #[lg 0 60 "walking"] fastWalk).size == 1
#guard (checkModeKinematics #[lg 0 60 "walking"] fastWalk)[0]!.kind == .impossibleModeKinematics
-- One fast step is a GPS reacquire teleport, not a ride.
#guard (worstVehiclePacedRun #[fx 0 0, fx 30 0.01]) == none
-- Net displacement, not distance travelled: jitter is fast and goes nowhere.
#guard (worstVehiclePacedRun #[fx 0 0, fx 30 0.01, fx 60 0]) == none
-- Walking pace never asserts, however long it runs.
#guard (worstVehiclePacedRun #[fx 0 0, fx 3000 0.01, fx 6000 0.02]) == none
-- Only `walking` is asserted — a stationary leg's blackout fixes can teleport
-- in consistent pairs, so asserting there would not be zero-false-positive.
#guard (checkModeKinematics #[lg 0 60 "stationary"] fastWalk).size == 0
#guard (checkModeKinematics #[lg 0 60 "train"] fastWalk).size == 0
#guard (checkModeKinematics #[lg 0 60 "driving"] fastWalk).size == 0
-- …but the measurement stays available on those modes, which is why
-- `worstVehiclePacedRun` is exported separately from the assertion.
#guard (worstVehiclePacedRun fastWalk).isSome
-- Fixes outside the leg's window are not its evidence.
#guard (checkModeKinematics #[lg 100 200 "walking"] fastWalk).size == 0
-- Stepped through at walking cadence, the run is the fixes moving: no violation.
#guard (checkModeKinematics #[lg 0 60 "walking"] fastWalk #[⟨0, 120⟩, ⟨60, 118⟩]).size == 0
-- One minute of it ridden, or unmeasured, and it asserts.
#guard (checkModeKinematics #[lg 0 60 "walking"] fastWalk #[⟨0, 120⟩, ⟨60, 4⟩]).size == 1
#guard (checkModeKinematics #[lg 0 60 "walking"] fastWalk #[⟨0, 120⟩]).size == 1

/-! ### impossible-mode-kinematics, the pedestrian direction -/

-- 278 m in 200 s is 5 km/h — pedestrian pace over a real distance.
private def slowTrain : Array Fix := #[fx 0 0, fx 100 0.00125, fx 200 0.0025]
private def cadence (spm : Float) : Array StepPoint :=
  #[{ ts := 0, steps := spm }, { ts := 60, steps := spm }, { ts := 120, steps := spm },
    { ts := 180, steps := spm }]
#guard (checkVehiclePedestrianRuns #[lg 0 200 "train"] slowTrain (cadence 110)).size == 1
-- All four signals must agree. Cadence separates a walk from a crawling
-- train, and a seated rider shows near-zero steps.
#guard (checkVehiclePedestrianRuns #[lg 0 200 "train"] slowTrain (cadence 5)).size == 0
-- No step data is not zero cadence — it asserts nothing at all.
#guard (checkVehiclePedestrianRuns #[lg 0 200 "train"] slowTrain #[]).size == 0
#guard meanCadenceSpm #[] 0 200 == none
#guard meanCadenceSpm (cadence 60) 0 120 == some 60
-- A window no bucket overlaps is unknown, not zero.
#guard meanCadenceSpm (cadence 60) 100000 100200 == none
-- Train only. Buses and cars genuinely crawl in traffic, where a bumpy
-- ride's phantom wrist-cadence could false-positive.
#guard (checkVehiclePedestrianRuns #[lg 0 200 "bus"] slowTrain (cadence 110)).size == 0
#guard (checkVehiclePedestrianRuns #[lg 0 200 "driving"] slowTrain (cadence 110)).size == 0
-- A brief slow patch is a signal stop: under 90 s never asserts.
#guard (checkVehiclePedestrianRuns #[lg 0 60 "train"] #[fx 0 0, fx 60 0.0025] (cadence 110)).size == 0

/-! ### invalid-rail-triple -/

private def served : LineMembership := #[("Red Line", #["Alpha", "Beta"])]
#guard (checkRailTriples #[lg 0 9 "train" (some "Alpha → Beta · Red Line")] served).size == 0
#guard (checkRailTriples #[lg 0 9 "train" (some "Alpha → Gamma · Red Line")] served).size == 1
-- Both endpoints are checked, so a leg wrong at both ends reports twice.
#guard (checkRailTriples #[lg 0 9 "train" (some "Delta → Gamma · Red Line")] served).size == 2
-- Case and surrounding space do not matter.
#guard (checkRailTriples #[lg 0 9 "train" (some "alpha → BETA · Red Line")] served).size == 0
-- An unknown line cannot assert — absence from the mirror is not evidence.
#guard (checkRailTriples #[lg 0 9 "train" (some "Alpha → Gamma · Blue Line")] served).size == 0
-- And an empty list means unknown, not "serves nothing". Four such entries
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
-- A stay does not relocate you — the chain survives it and still asserts.
#guard (chain [lg 0 9 "train" (some "Alpha → Beta"), lg 9 18 "stationary",
               lg 18 27 "train" (some "Gamma → Delta")]).size == 1
#guard (chain [lg 0 9 "train" (some "Alpha → Beta"), lg 9 18 "sleeping",
               lg 18 27 "train" (some "Gamma → Delta")]).size == 1
-- A walk does — you could legitimately have walked to another station.
#guard (chain [lg 0 9 "train" (some "Alpha → Beta"), lg 9 18 "walking",
               lg 18 27 "train" (some "Gamma → Delta")]).size == 0
#guard (chain [lg 0 9 "train" (some "Alpha → Beta"), lg 9 18 "driving",
               lg 18 27 "train" (some "Gamma → Delta")]).size == 0
-- An undeterminable pair breaks the chain rather than asserting across it.
#guard (chain [lg 0 9 "train" (some "Red Line"), lg 9 18 "train" (some "Gamma → Delta")]).size == 0
#guard (chain [lg 0 9 "train" (some "Alpha → Beta"), lg 9 18 "train" (some "Red Line"),
               lg 18 27 "train" (some "Gamma → Delta")]).size == 0
-- A train that boards and alights at the same station.
#guard (chain [lg 0 9 "train" (some "Alpha → Alpha")]).size == 1
#guard (chain [lg 0 9 "train" (some "Alpha → Alpha")])[0]!.kind == .degenerateTrainLeg
#guard (chain []).size == 0

-- The whole check composes, and each input's absence silences exactly its own
-- invariant — the zero-false-positive rule applied to missing data.
#guard (checkWorldlineFeasibility #[lg 0 60 "walking"] fastWalk #[] #[]).size == 1
#guard (checkWorldlineFeasibility #[lg 0 60 "walking"] #[] #[] #[]).size == 0
#guard (checkWorldlineFeasibility #[lg 0 200 "train"] slowTrain #[] #[]).size == 0
#guard (checkWorldlineFeasibility #[lg 0 200 "train"] slowTrain (cadence 110) #[]).size == 1
#guard (checkWorldlineFeasibility #[lg 0 9 "train" (some "Alpha → Gamma · Red Line")] #[] #[] #[]).size == 0
#guard (checkWorldlineFeasibility #[lg 0 9 "train" (some "Alpha → Gamma · Red Line")] #[] #[] served).size == 1

/-! ### teleport -/

private def af (ts : Int) (lon acc : Float) : AccFix := { ts, lat := 0, lon, accuracyM := acc }
private def stay (s e : Int) (place : String) (at_ : Option Float := none) : Leg :=
  { startTs := s, endTs := e, mode := "stationary", place := some place
    placeAt := at_.map ((0 : Float), ·) }
-- Every fix 10 m sure, all at the café.
private def atCafe : Array AccFix := (Array.range 16).map fun k => af (Int.ofNat k * 60) 0 10

-- The café, then a promenade named 445 m away, then the café: two jumps.
#guard (checkTeleports #[stay 0 300 "Café" (some 0), stay 300 600 "Promenade" (some 0.004),
    stay 600 900 "Café" (some 0)] atCafe).map (·.kind) == #[.teleport, .teleport]
-- Without the asked-for position the stays sit where their fixes are — all at
-- the café — so a name 445 m off is invisible. The position is the claim.
#guard (checkTeleports #[stay 0 300 "Café", stay 300 600 "Promenade", stay 600 900 "Café"]
    atCafe).size == 0
-- The same place twice is no move.
#guard (checkTeleports #[stay 0 300 "Café" (some 0), stay 300 600 "Café" (some 0.004)] atCafe).size == 0
-- A walk between relocates him.
#guard (checkTeleports #[stay 0 300 "Café" (some 0), lg 300 400 "walking",
    stay 400 600 "Promenade" (some 0.004)] atCafe).size == 0
-- Unobserved time can hide the walk: half an hour of `unknown` reaches 7.5 km.
#guard (checkTeleports #[stay 0 300 "Café" (some 0), lg 300 2100 "unknown",
    stay 2100 2400 "Promenade" (some 0.004)] atCafe).size == 0
-- …but a minute of it reaches 250 m, short of 445.
#guard (checkTeleports #[stay 0 300 "Café" (some 0), lg 300 360 "unknown",
    stay 360 600 "Promenade" (some 0.004)] atCafe).size == 1
-- Fixes 300 m unsure cannot tell 445 m from standing still.
#guard (checkTeleports #[stay 0 300 "Café" (some 0), stay 300 600 "Promenade" (some 0.004)]
    ((Array.range 16).map fun k => af (Int.ofNat k * 60) 0 300)).size == 0
-- A stay with no fixes has no noise to judge by, and is not judged.
#guard (checkTeleports #[stay 0 300 "Café" (some 0), stay 300 600 "Promenade" (some 0.004)] #[]).size == 0
-- Sixteen fixes at 10 m place the stay within 10 m, not 2.5.
#guard (stayLocation atCafe).any fun (_, n) => (n - 10).abs < 1e-9
-- The weight is 1/accuracy²: one 10 m fix outweighs a 100 m fix a hundredfold.
#guard match stayLocation #[af 0 0 10, af 60 0.01 100] with
  | some (p, _) => (p.lon - 0.01 / 101).abs < 1e-12 | none => false

end Witnesses

end Verified.Eval.Feasibility

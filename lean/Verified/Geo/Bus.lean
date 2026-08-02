import Verified.Hsmm.FloatScore
/-!
# Bus cluster (port of the pure kernels in `src/geo/bus-route-match.ts` and
`src/geo/bus-evidence.ts`)

Two independent ways to tell a bus from a taxi on the same streets, both
ported here in full:

* **Route matching** (`matchBusRoute`) — anchor a road-vehicle leg's board and
  alight coords to two *in-route-order* stops of a candidate route, then
  corroborate by checking the leg's trace passed the route's *intermediate*
  stops. Anchoring alone is not sufficient: with ~1000 routes mirrored almost
  any short urban hop has some route with two in-order stops near its
  endpoints, which is how a taxi got stamped "bus N22". Corroboration is
  weighted by a speed logistic — a leg too fast to be a bus is discounted, not
  vetoed.
* **Stop-pattern evidence** (`detectBoardingWait`, `detectVehicleDwells`,
  `scoreBusEvidence`) — a bus is boarded at a flag after a 45 s+ standstill and
  dwells mid-leg at fixed public stops; a car dwells at signals. Summed as
  weighted nats with per-signal caps, no vetoes.

The stop/signal *resolution* (`nearbyTransitStops`), the OSM route mirror, and
the two `annotate*` passes that spread `vehicleKind`/`wayName` onto pipeline
records stay with the orchestrator — this module is the decision math they
call, over inputs already resolved.

Exactness: `scoreBusEvidence`, the dwell/wait *detection* (`Int` timestamps,
discrete run-finding), and every ordering decision are EXACT. Distances enter
through `haversineMeters` (atan2) and `pointToSegmentMeters` (`Math.hypot`),
and the speed weight through `Float.exp`, so metre values and scores are
guarded to ≤1 ULP; the *verdicts* they drive are pinned exactly, including
both sides of the speed logistic's decision boundary. UNPROVEN; pinned by the
`#guard`s against Node/V8 (`lean/experiments/bus-refs.mts`).
-/

namespace Verified.Geo.Bus

open Verified.Hsmm.FloatScore (haversineMeters)

/-! ## Shared shapes -/

/-- A geographic point. -/
structure LatLon where
  lat : Float
  lon : Float
  deriving Inhabited, BEq

/-- A timestamped fix (seconds). -/
structure Fix where
  ts : Int
  lat : Float
  lon : Float
  deriving Inhabited, BEq

/-- One stop on a bus route, in route order. -/
structure BusStop where
  name : Option String
  lat : Float
  lon : Float
  seq : Int
  deriving Inhabited, BEq

/-- A candidate route: an ordered stop list mirrored from an OSM `route=bus`
    relation. Each direction is its own relation, hence its own `BusRoute`. -/
structure BusRoute where
  routeRef : String
  routeName : Option String
  osmRelationId : Int
  stops : List BusStop
  deriving Inhabited

/-- A leg's endpoints plus the trace used ONLY to corroborate intermediate
    stops — fixes are measured against stops, never snapped to geometry. -/
structure VehicleLeg where
  board : LatLon
  alight : LatLon
  trace : List LatLon
  /-- Representative speed (km/h); `none` ⇒ neutral (no speed evidence). -/
  speedKmh : Option Float := none
  deriving Inhabited

/-- A successful match: the named route, the boarded/alighted stops, and how
    well the endpoints anchored. -/
structure BusRouteMatch where
  routeRef : String
  routeName : Option String
  osmRelationId : Int
  boardStop : BusStop
  alightStop : BusStop
  boardDistM : Float
  alightDistM : Float
  /-- Stops travelled, inclusive of both ends. A real ride spans ≥ 2. -/
  stopSpan : Int
  deriving Inhabited

/-! ## Calibration (verbatim from the TS) -/

/-- A board/alight coord must fall within this of a stop to anchor to it. -/
def BUS_STOP_ANCHOR_M : Float := 120
/-- An intermediate stop counts as passed within this of the trace polyline. -/
def BUS_STOP_PASS_M : Float := 120
/-- Minimum bus-evidence score (coverage × speed-plausibility) to name a bus. -/
def BUS_MIN_INTERMEDIATE_COVERAGE : Float := 0.6
/-- Speed at which a leg is equally likely bus / not-bus. -/
def BUS_SPEED_MID_KMH : Float := 38
/-- Logistic width: how sharply bus-plausibility falls past the midpoint. -/
def BUS_SPEED_SCALE_KMH : Float := 6

private def INF : Float := 1.0 / 0.0

/-! ## Route matching -/

/-- `P(speed | bus)` as a soft plausibility in `(0, 1]`: ~1 at bus pace,
    decaying smoothly toward 0 as speed climbs. Neutral when absent. -/
def busSpeedPlausibility : Option Float → Float
  | none => 1
  | some speedKmh => 1 / (1 + Float.exp ((speedKmh - BUS_SPEED_MID_KMH) / BUS_SPEED_SCALE_KMH))

/-- Metres from `p` to segment `a`–`b` via a local equirectangular projection
    centred on `p`. Asks "did the trace pass this stop?" without snapping. -/
def pointToSegmentMeters (p a b : LatLon) : Float :=
  let mPerDegLat : Float := 111320
  let mPerDegLon : Float := 111320 * Float.cos (p.lat * 3.141592653589793 / 180)
  let px := p.lon * mPerDegLon
  let py := p.lat * mPerDegLat
  let ax := a.lon * mPerDegLon
  let ay := a.lat * mPerDegLat
  let bx := b.lon * mPerDegLon
  let bY := b.lat * mPerDegLat
  let dx := bx - ax
  let dy := bY - ay
  let len2 := dx * dx + dy * dy
  let t := if len2 == 0 then 0
           else max 0 (min 1 (((px - ax) * dx + (py - ay) * dy) / len2))
  let cx := ax + t * dx
  let cy := ay + t * dy
  -- `Math.hypot`; ≤1 ULP of the naive form at these magnitudes.
  Float.sqrt ((px - cx) * (px - cx) + (py - cy) * (py - cy))

/-- Nearest approach of the trace polyline to `stop`, short-circuiting as soon
    as it is within `passM` (mirrors the TS `break`). -/
private def nearestOnTrace (trace : Array LatLon) (stop : LatLon) (passM : Float) : Float := Id.run do
  let mut nearest := INF
  for i in [0 : trace.size - 1] do
    nearest := min nearest (pointToSegmentMeters stop trace[i]! trace[i + 1]!)
    if decide (nearest ≤ passM) then break
  return nearest

/-- Fraction of the stops strictly between board and alight that the trace
    passes within `passM`. Zero when there are none (a two-stop span has
    nothing to corroborate — the taxi-as-bus failure) or the trace is
    degenerate. A real bus passes ~all of them; a taxi on a different road,
    few. -/
def traceCoverage (trace : List LatLon) (intermediates : List BusStop) (passM : Float) : Float :=
  if intermediates.isEmpty then 0
  else if trace.length < 2 then 0
  else
    let arr := trace.toArray
    let passed := intermediates.foldl (fun acc s =>
      if decide (nearestOnTrace arr ⟨s.lat, s.lon⟩ passM ≤ passM) then acc + 1 else acc) 0
    Float.ofNat passed / Float.ofNat intermediates.length

/-- A stop anchored to an endpoint: the stop, its route-order index, and how
    far the endpoint sat from it. -/
structure Anchor where
  stop : BusStop
  idx : Nat
  distM : Float
  deriving Inhabited

/-- Stops within `anchorM` of `coord`, with their route-order index. -/
def anchorsNear (coord : LatLon) (route : BusRoute) (anchorM : Float) : List Anchor :=
  route.stops.zipIdx.filterMap (fun (stop, idx) =>
    let distM := haversineMeters coord.lat coord.lon stop.lat stop.lon
    if decide (distM ≤ anchorM) then some ⟨stop, idx, distM⟩ else none)

/-- The in-order anchor pair with the smallest combined anchor distance whose
    evidence clears `minScore`, or `none`. Direction is enforced by
    `alight.idx > board.idx`, so a leg ridden the other way matches the
    opposite-direction relation and equal endpoints never match. -/
private def bestPairFor (leg : VehicleLeg) (route : BusRoute) (anchorM stopPassM minScore speedPlausibility : Float) :
    Option (Anchor × Anchor) := Id.run do
  let boardCands := anchorsNear leg.board route anchorM
  let alightCands := anchorsNear leg.alight route anchorM
  if boardCands.isEmpty || alightCands.isEmpty then return none
  let mut best : Option (Anchor × Anchor) := none
  for board in boardCands do
    for alight in alightCands do
      if decide (alight.idx ≤ board.idx) then continue
      -- Evidence = intermediate-stop coverage × speed-plausibility. Coverage
      -- rejects a taxi that anchors two stops but drove a different road (and
      -- a 2-stop span, which has nothing to corroborate); speed-plausibility
      -- discounts a leg too fast to be a bus, weighted rather than vetoing.
      let intermediates := (route.stops.drop (board.idx + 1)).take (alight.idx - board.idx - 1)
      let score := traceCoverage leg.trace intermediates stopPassM * speedPlausibility
      if decide (score < minScore) then continue
      let total := board.distM + alight.distM
      match best with
      | none => best := some (board, alight)
      | some (b, a) => if decide (total < b.distM + a.distM) then best := some (board, alight)
  return best

/-- Find the bus route the leg rode. Across routes the smallest combined
    anchor distance wins; ties keep the earlier route. `none` ⇒ no route's
    stop sequence admits a corroborated in-order pair, and the leg stays
    driving (taxi/car) — never forced onto a route it did not ride. -/
def matchBusRoute (leg : VehicleLeg) (routes : List BusRoute)
    (anchorM : Float := BUS_STOP_ANCHOR_M) (stopPassM : Float := BUS_STOP_PASS_M)
    (minCoverage : Float := BUS_MIN_INTERMEDIATE_COVERAGE) : Option BusRouteMatch := Id.run do
  let speedPlausibility := busSpeedPlausibility leg.speedKmh
  let mut best : Option BusRouteMatch := none
  for route in routes do
    match bestPairFor leg route anchorM stopPassM minCoverage speedPlausibility with
    | none => continue
    | some (b, a) =>
      let cand : BusRouteMatch :=
        { routeRef := route.routeRef, routeName := route.routeName,
          osmRelationId := route.osmRelationId,
          boardStop := b.stop, alightStop := a.stop,
          boardDistM := b.distM, alightDistM := a.distM,
          stopSpan := Int.ofNat a.idx - Int.ofNat b.idx + 1 }
      match best with
      | none => best := some cand
      | some prev =>
        if decide (b.distM + a.distM < prev.boardDistM + prev.alightDistM) then best := some cand
  return best

/-- A timeline-ready label, in the same `From → To · Ref` shape the
    ground-truth bus cells use. Falls back to the bare ref when a stop is
    unnamed. -/
def busRouteLabel (m : BusRouteMatch) : String :=
  match m.boardStop.name, m.alightStop.name with
  | some from_, some to_ => s!"{from_} → {to_} · {m.routeRef}"
  | _, _ => m.routeRef

/-! ## Stop-pattern evidence -/

/-- A stop/signal "at" a dwell: within the urban GPS-noise scale. -/
def TRANSIT_STOP_NEAR_M : Float := 35

/-- Boarding wait gates: shorter is a traffic pause, longer (past the
    lookback) is a prior stay, not a wait for this vehicle. -/
def BOARDING_WAIT_MIN_S : Int := 45
def BOARDING_WAIT_LOOKBACK_S : Int := 5 * 60
/-- Trailing fast pairs within this of the leg start are the pull-away itself,
    not a rolling approach — skipped before the walk-back. -/
def BOARDING_PULLAWAY_TRIM_S : Int := 45

/-- Mid-leg dwell gates: 20 s+ under walking pace. -/
def DWELL_MIN_S : Int := 20
def DWELL_MAX_SPEED_KMH : Float := 3

/-! ### Weights (nats) -/
def BOARDING_AT_STOP_NATS : Float := 1.5
def BOARDING_NO_STOP_DATA_NATS : Float := 0.2
def DWELL_AT_STOP_NATS : Float := 0.8
/-- A dwell near BOTH a stop and a signal is ambiguous — half credit. -/
def DWELL_AT_STOP_AND_SIGNAL_NATS : Float := 0.4
def DWELL_CREDIT_CAP_NATS : Float := 2.4
def MANY_DWELLS_NO_STOP_NATS : Float := -0.8
def MANY_DWELLS_MIN : Nat := 3

/-- Total evidence at/above this labels the leg a bus. -/
def BUS_EVIDENCE_THRESHOLD_NATS : Float := 2.0

/-- Speed between two fixes in km/h; infinite for non-positive `dt` so a
    duplicate timestamp can never read as a standstill. -/
def pairSpeedKmh (a b : Fix) : Float :=
  let dt := b.ts - a.ts
  if decide (dt ≤ 0) then INF
  else (haversineMeters a.lat a.lon b.lat b.lon / Float.ofInt dt) * 3.6

/-- A standstill within a moving leg. -/
structure VehicleDwell where
  startTs : Int
  endTs : Int
  durationS : Int
  lat : Float
  lon : Float
  deriving Inhabited, BEq

/-- Arithmetic mean of a run's coords, summed left-to-right as the TS reduce
    does (float addition is not associative, so the order is load-bearing). -/
private def centroid (run : Array Fix) : Float × Float :=
  let n := Float.ofNat run.size
  (run.foldl (fun s p => s + p.lat) 0 / n, run.foldl (fun s p => s + p.lon) 0 / n)

/--
The standstill immediately preceding `segStartTs` — the would-be boarding
wait. Walks backwards from the leg start through fixes in the lookback window
while consecutive pair speeds stay under walking pace; `none` when the
contiguous standstill is shorter than `BOARDING_WAIT_MIN_S` (rolling approach
= taxi pattern, or no data).
-/
def detectBoardingWait (fixes : List Fix) (segStartTs : Int) : Option (Int × Float × Float) := Id.run do
  -- Strictly BEFORE the leg: the segment's startTs is typically its first
  -- MOVING fix (the pull-away), which must not seed the walk-back.
  let pre := (fixes.filter (fun p =>
    decide (p.ts < segStartTs) && decide (p.ts ≥ segStartTs - BOARDING_WAIT_LOOKBACK_S))).toArray
  if pre.size < 2 then return none
  -- Trim trailing pull-away pairs: classifiers place the boundary one or two
  -- fixes after the vehicle actually moved off. Only pairs within the trim
  -- window may be skipped — beyond it, fast motion means a rolling approach.
  let trimFloor := segStartTs - BOARDING_PULLAWAY_TRIM_S
  let mut last := pre.size - 1
  while last > 0 && decide (pre[last]!.ts ≥ trimFloor)
        && decide (pairSpeedKmh pre[last - 1]! pre[last]! ≥ DWELL_MAX_SPEED_KMH) do
    last := last - 1
  let mut fromIdx := last
  while fromIdx > 0 && decide (pairSpeedKmh pre[fromIdx - 1]! pre[fromIdx]! < DWELL_MAX_SPEED_KMH) do
    fromIdx := fromIdx - 1
  let still := pre.extract fromIdx (last + 1)
  if still.size < 2 then return none
  let durationS := still[still.size - 1]!.ts - still[0]!.ts
  if decide (durationS < BOARDING_WAIT_MIN_S) then return none
  let (lat, lon) := centroid still
  return some (durationS, lat, lon)

/--
Standstill runs inside the moving leg: maximal runs of consecutive pair speeds
under `DWELL_MAX_SPEED_KMH` lasting ≥ `DWELL_MIN_S`. The centroid is where the
orchestrator queries for stop/signal proximity.
-/
def detectVehicleDwells (fixes : List Fix) (startTs endTs : Int) : List VehicleDwell := Id.run do
  -- `samplesInWindow`: inclusive on both ends.
  let inLeg := (fixes.filter (fun p =>
    decide (p.ts ≥ startTs) && decide (p.ts ≤ endTs))).toArray
  let mut dwells : Array VehicleDwell := #[]
  let mut runStart : Option Nat := none
  for i in [1 : inLeg.size + 1] do
    let slow := i < inLeg.size && decide (pairSpeedKmh inLeg[i - 1]! inLeg[i]! < DWELL_MAX_SPEED_KMH)
    if slow then
      if runStart.isNone then runStart := some (i - 1)
    else
      match runStart with
      | none => pure ()
      | some rs =>
        let run := inLeg.extract rs i
        let durationS := run[run.size - 1]!.ts - run[0]!.ts
        if decide (durationS ≥ DWELL_MIN_S) then
          let (lat, lon) := centroid run
          dwells := dwells.push ⟨run[0]!.ts, run[run.size - 1]!.ts, durationS, lat, lon⟩
        runStart := none
  return dwells.toList

/-- Distances from one dwell's centroid to transit furniture, as resolved by
    the orchestrator. `none` = nothing within query radius. -/
structure DwellStopMatch where
  durationS : Int
  nearestBusStopM : Option Float
  nearestSignalM : Option Float
  deriving Inhabited

/-- The evidence a leg presents. -/
structure BusEvidence where
  /-- Duration of the pre-leg standstill, or `none` when the vehicle was
      approached rolling (taxi pattern / no data). -/
  boardingWaitS : Option Int
  boardingNearestBusStopM : Option Float
  dwells : List DwellStopMatch
  deriving Inhabited

/-- Total plus the per-signal parts, for diagnostics. -/
structure BusEvidenceScore where
  total : Float
  boarding : Float
  dwellCredit : Float
  noStopPenalty : Float
  deriving Inhabited, BEq

/-- Within the "at" radius, treating an absent measurement as not-near. -/
private def isNear : Option Float → Bool
  | none => false
  | some m => decide (m ≤ TRANSIT_STOP_NEAR_M)

/-- Sum the weighted evidence. Boarding at a stop is the strongest single
    signal; each stop-coinciding dwell adds, capped so a crawling leg past
    many stops cannot run away; several dwells with no stop near any of them
    is mild taxi evidence. -/
def scoreBusEvidence (ev : BusEvidence) : BusEvidenceScore := Id.run do
  let boarding :=
    match ev.boardingWaitS with
    | none => 0
    | some _ => if isNear ev.boardingNearestBusStopM then BOARDING_AT_STOP_NATS
                else BOARDING_NO_STOP_DATA_NATS
  let mut dwellCredit : Float := 0
  let mut stopDwells : Nat := 0
  for d in ev.dwells do
    let atStop := isNear d.nearestBusStopM
    let atSignal := isNear d.nearestSignalM
    if atStop then
      stopDwells := stopDwells + 1
      dwellCredit := dwellCredit + (if atSignal then DWELL_AT_STOP_AND_SIGNAL_NATS else DWELL_AT_STOP_NATS)
    -- A dwell at a signal only: any road vehicle — no contribution.
  dwellCredit := min dwellCredit DWELL_CREDIT_CAP_NATS
  let noStopPenalty :=
    if ev.dwells.length ≥ MANY_DWELLS_MIN && stopDwells == 0 then MANY_DWELLS_NO_STOP_NATS else 0
  return ⟨boarding + dwellCredit + noStopPenalty, boarding, dwellCredit, noStopPenalty⟩

/-! ## Parity with Node/V8 (`lean/experiments/bus-refs.mts`)

Distances/scores are `atan2`/`hypot`/`exp`-derived ⇒ guarded to ≤1 ULP;
verdicts, orderings, spans and the nats sum are pinned exactly.
-/

private def approx (a b : Float) : Bool := Float.abs (a - b) < 1e-9

private def S (name : String) (lat lon : Float) (seq : Int) : BusStop := ⟨some name, lat, lon, seq⟩

private def route38 : BusRoute :=
  { routeRef := "38", routeName := some "Victoria - Clapton Pond", osmRelationId := 1234,
    stops := [S "Green Park" 51.50675 (-0.14273) 0, S "Hyde Park Corner" 51.50305 (-0.15195) 1,
              S "Grosvenor Place" 51.50043 (-0.14855) 2, S "Wilton Street" 51.49825 (-0.14625) 3,
              S "Victoria Station" 51.49607 (-0.14413) 4,
              S "Vauxhall Bridge Road" 51.49392 (-0.14166) 5] }

private def routeDecoy : BusRoute :=
  { routeRef := "N22", routeName := none, osmRelationId := 5678,
    stops := [S "Green Park" 51.50681 (-0.14266) 0, S "Berkeley Square" 51.50968 (-0.14636) 1,
              S "Mount Street" 51.51033 (-0.15095) 2, S "Victoria Station" 51.49601 (-0.14421) 3] }

private def routeTwin : BusRoute :=
  { routeRef := "C1", routeName := some "Twin", osmRelationId := 9999,
    stops := [S "Twin A" 51.50672 (-0.14280) 0, S "Twin B" 51.50652 (-0.14300) 1,
              S "Mid" 51.50043 (-0.14855) 2, S "Twin Y" 51.49625 (-0.14395) 3,
              S "Twin Z" 51.49600 (-0.14420) 4] }

private def traceOnRoute : List LatLon :=
  [⟨51.5067, -0.1428⟩, ⟨51.5049, -0.1475⟩, ⟨51.5031, -0.1519⟩, ⟨51.5016, -0.1501⟩,
   ⟨51.5004, -0.1486⟩, ⟨51.4993, -0.1474⟩, ⟨51.4982, -0.1463⟩, ⟨51.4971, -0.1452⟩,
   ⟨51.4961, -0.1442⟩]

private def traceDirect : List LatLon :=
  [⟨51.5067, -0.1428⟩, ⟨51.5045, -0.1438⟩, ⟨51.5022, -0.1441⟩, ⟨51.4998, -0.1442⟩,
   ⟨51.4975, -0.1442⟩, ⟨51.4961, -0.1442⟩]

private def tracePartial : List LatLon :=
  [⟨51.5067, -0.1428⟩, ⟨51.5049, -0.1475⟩, ⟨51.5031, -0.1519⟩, ⟨51.5004, -0.1486⟩,
   ⟨51.4990, -0.1440⟩, ⟨51.4961, -0.1442⟩]

private def bd : LatLon := ⟨51.50662, -0.14288⟩
private def al : LatLon := ⟨51.49618, -0.14402⟩

private def leg (trace : List LatLon) (speedKmh : Option Float := none) : VehicleLeg :=
  ⟨bd, al, trace, speedKmh⟩

/-! ### `matchBusRoute` -/

-- On-route trace, no speed evidence: the 38, Green Park → Victoria, span 5.
#guard (matchBusRoute (leg traceOnRoute) [route38]).isSome
#guard ((matchBusRoute (leg traceOnRoute) [route38]).map (·.routeRef)) == some "38"
#guard ((matchBusRoute (leg traceOnRoute) [route38]).map (·.osmRelationId)) == some 1234
#guard ((matchBusRoute (leg traceOnRoute) [route38]).map (·.stopSpan)) == some 5
#guard ((matchBusRoute (leg traceOnRoute) [route38]).bind (·.boardStop.name)) == some "Green Park"
#guard ((matchBusRoute (leg traceOnRoute) [route38]).bind (·.alightStop.name)) == some "Victoria Station"
#guard match matchBusRoute (leg traceOnRoute) [route38] with
       | some m => approx m.boardDistM 17.797005168833643 && approx m.alightDistM 14.408152505796954
       | none => false
#guard ((matchBusRoute (leg traceOnRoute) [route38]).map busRouteLabel)
       == some "Green Park → Victoria Station · 38"

-- Speed is weighted evidence, not a veto: bus pace passes, the logistic's
-- midpoint (plausibility 0.5 < 0.6) does not.
#guard (matchBusRoute (leg traceOnRoute (some 14)) [route38]).isSome
#guard (matchBusRoute (leg traceOnRoute (some 38)) [route38]).isNone
#guard (matchBusRoute (leg traceOnRoute (some 62)) [route38]).isNone

-- The decision boundary of the speed logistic, both sides (coverage = 1).
#guard (matchBusRoute (leg traceOnRoute (some 35.5)) [route38]).isSome
#guard (matchBusRoute (leg traceOnRoute (some 35.56)) [route38]).isSome
#guard (matchBusRoute (leg traceOnRoute (some 35.57)) [route38]).isNone
#guard (matchBusRoute (leg traceOnRoute (some 35.6)) [route38]).isNone
#guard (matchBusRoute (leg traceOnRoute (some 36)) [route38]).isNone
#guard (matchBusRoute (leg traceOnRoute (some 40)) [route38]).isNone

-- The taxi: same endpoints, direct road, misses the intermediate stops.
#guard (matchBusRoute (leg traceDirect) [route38]).isNone
-- The decoy anchors both endpoints but its span has nothing to corroborate.
#guard (matchBusRoute (leg traceOnRoute) [routeDecoy]).isNone
#guard ((matchBusRoute (leg traceOnRoute) [routeDecoy, route38]).map (·.routeRef)) == some "38"
-- Direction, degenerate trace, empty candidate set, unanchored endpoint.
#guard (matchBusRoute ⟨al, bd, traceOnRoute, none⟩ [route38]).isNone
#guard (matchBusRoute (leg [bd]) [route38]).isNone
#guard (matchBusRoute (leg traceOnRoute) []).isNone
#guard (matchBusRoute ⟨⟨51.5100, -0.1400⟩, al, traceOnRoute, none⟩ [route38]).isNone

-- A short in-route hop: one intermediate stop is enough to corroborate.
#guard match matchBusRoute
         ⟨⟨51.50310, -0.15190⟩, ⟨51.49830, -0.14620⟩,
          [⟨51.5031, -0.1519⟩, ⟨51.5016, -0.1501⟩, ⟨51.5004, -0.1486⟩,
           ⟨51.4993, -0.1474⟩, ⟨51.4983, -0.1462⟩], none⟩ [route38] with
       | some m => m.stopSpan == 3 && m.boardStop.name == some "Hyde Park Corner"
                   && m.alightStop.name == some "Wilton Street"
                   && approx m.boardDistM 6.5488813027457731
                   && approx m.alightDistM 6.5490739428154168
       | none => false

-- Partial coverage: this trace passes 2 of the 3 intermediates, so the
-- threshold flips between 0.66 and 0.67.
#guard (matchBusRoute (leg tracePartial) [route38] (minCoverage := 0.66)).isSome
#guard (matchBusRoute (leg tracePartial) [route38] (minCoverage := 0.67)).isNone
#guard (matchBusRoute (leg tracePartial) [route38] (minCoverage := 0.7)).isNone
#guard (matchBusRoute (leg tracePartial) [route38] (stopPassM := 50)).isSome
#guard (matchBusRoute (leg tracePartial) [route38] (stopPassM := 400)).isSome
#guard approx (traceCoverage tracePartial ((route38.stops.drop 1).take 3) BUS_STOP_PASS_M)
       (2.0 / 3.0)
#guard traceCoverage traceOnRoute ((route38.stops.drop 1).take 3) BUS_STOP_PASS_M == 1
#guard traceCoverage traceOnRoute [] BUS_STOP_PASS_M == 0
#guard traceCoverage [bd] ((route38.stops.drop 1).take 3) BUS_STOP_PASS_M == 0

-- Two stops within the anchor radius at BOTH ends: the smallest combined
-- anchor distance wins the pair.
#guard match matchBusRoute (leg traceOnRoute) [routeTwin] with
       | some m => m.boardStop.name == some "Twin A" && m.alightStop.name == some "Twin Y"
                   && m.stopSpan == 4
                   && approx m.boardDistM 12.421737845504852
                   && approx m.alightDistM 9.1688192651490059
       | none => false

-- An unnamed stop falls back to the bare ref.
#guard busRouteLabel ⟨"38", none, 1, ⟨none, 0, 0, 0⟩, S "X" 0 0 1, 0, 0, 2⟩ == "38"

-- The speed logistic itself. `busSpeedPlausibility` is private in the TS, so
-- these references were bisected back out of the shipping `matchBusRoute`
-- (see the harness) rather than recomputed independently.
#guard busSpeedPlausibility none == 1
#guard approx (busSpeedPlausibility (some 14)) 0.98201379003790845
#guard approx (busSpeedPlausibility (some 35.5)) 0.60268533797849166
#guard approx (busSpeedPlausibility (some 38)) 0.50000000000000000
#guard approx (busSpeedPlausibility (some 50)) 0.11920292202211755
#guard approx (busSpeedPlausibility (some 62)) 0.017986209962091559

/-! ### `detectBoardingWait` -/

private def waitFixes : List Fix :=
  [⟨850, 51.5030, -0.1520⟩, ⟨880, 51.50301, -0.15201⟩, ⟨910, 51.50302, -0.15199⟩,
   ⟨940, 51.50300, -0.15200⟩, ⟨970, 51.50303, -0.15202⟩, ⟨990, 51.5035, -0.1521⟩,
   ⟨1000, 51.5040, -0.1522⟩]

-- The pull-away pair is trimmed, so the 120 s standstill behind it is found.
#guard match detectBoardingWait waitFixes 1000 with
       | some (d, lat, lon) => d == 120 && approx lat 51.503011999999998 && approx lon (-0.15200399999999997)
       | none => false
#guard match detectBoardingWait waitFixes 990 with
       | some (d, _, _) => d == 120
       | none => false
-- Rolling approach (taxi pattern), too short, too little data, outside lookback.
#guard (detectBoardingWait [⟨900, 51.500, -0.150⟩, ⟨930, 51.503, -0.152⟩,
                            ⟨960, 51.506, -0.154⟩, ⟨990, 51.509, -0.156⟩] 1000).isNone
#guard (detectBoardingWait [⟨940, 51.5030, -0.1520⟩, ⟨955, 51.50301, -0.15201⟩,
                            ⟨970, 51.50302, -0.15200⟩] 1000).isNone
#guard (detectBoardingWait [⟨950, 51.5030, -0.1520⟩] 1000).isNone
#guard (detectBoardingWait [⟨300, 51.5030, -0.1520⟩, ⟨400, 51.50301, -0.15201⟩] 1000).isNone

/-! ### `detectVehicleDwells` -/

private def legFixes : List Fix :=
  [⟨1000, 51.5040, -0.1522⟩, ⟨1030, 51.5030, -0.1510⟩, ⟨1060, 51.5020, -0.1498⟩,
   ⟨1100, 51.5010, -0.1486⟩, ⟨1130, 51.50101, -0.14861⟩, ⟨1160, 51.50100, -0.14860⟩,
   ⟨1200, 51.4998, -0.1472⟩, ⟨1250, 51.4988, -0.1460⟩, ⟨1265, 51.49881, -0.14601⟩,
   ⟨1300, 51.4975, -0.1450⟩, ⟨1400, 51.4961, -0.1442⟩]

-- One qualifying dwell: the 60 s stand at 1100-1160. The 15 s stand at
-- 1250-1265 is under DWELL_MIN_S.
#guard (detectVehicleDwells legFixes 1000 1400).length == 1
#guard match detectVehicleDwells legFixes 1000 1400 with
       | [d] => d.startTs == 1100 && d.endTs == 1160 && d.durationS == 60
                && approx d.lat 51.501003333333330 && approx d.lon (-0.14860333333333334)
       | _ => false
#guard (detectVehicleDwells legFixes 1000 1150).length == 1
#guard (detectVehicleDwells legFixes 5000 6000).length == 0

/-! ### `scoreBusEvidence` -/

private def D (durationS : Int) (stopM signalM : Option Float) : DwellStopMatch := ⟨durationS, stopM, signalM⟩
private def E (waitS : Option Int) (stopM : Option Float) (dwells : List DwellStopMatch) : BusEvidence :=
  ⟨waitS, stopM, dwells⟩

#guard (scoreBusEvidence (E none none [])).total == 0
#guard (scoreBusEvidence (E (some 90) (some 12) [])).total == 1.5
#guard (scoreBusEvidence (E (some 90) (some 200) [])).total == 0.2
#guard (scoreBusEvidence (E (some 90) none [])).total == 0.2
-- Boarding at a stop plus one stop dwell clears the 2.0 nat threshold.
#guard approx (scoreBusEvidence (E (some 90) (some 12) [D 40 (some 20) none])).total 2.2999999999999998
-- Three stop dwells with no visible boarding also clear it (at the cap).
#guard approx (scoreBusEvidence (E none none
        [D 40 (some 20) none, D 35 (some 15) none, D 25 (some 30) none])).total 2.3999999999999999
-- Stop AND signal is ambiguous: half credit each.
#guard approx (scoreBusEvidence (E none none
        [D 40 (some 20) (some 10), D 35 (some 15) (some 30), D 25 (some 30) (some 20)])).total
       1.2000000000000002
-- The dwell credit is capped, so a crawl past many stops cannot run away.
#guard approx (scoreBusEvidence (E none none
        [D 40 (some 20) none, D 40 (some 20) none, D 40 (some 20) none,
         D 40 (some 20) none, D 40 (some 20) none])).total 2.3999999999999999
-- Several dwells, none at a stop: mild taxi evidence.
#guard approx (scoreBusEvidence (E none none
        [D 40 none (some 10), D 35 (some 200) (some 12), D 25 none none])).total (-0.8)
#guard approx (scoreBusEvidence (E (some 90) (some 12)
        [D 40 none (some 10), D 35 (some 200) (some 12), D 25 none none])).total 0.69999999999999996
-- Two such dwells is under MANY_DWELLS_MIN — no penalty.
#guard (scoreBusEvidence (E none none [D 40 none (some 10), D 35 (some 200) (some 12)])).total == 0
-- The "at" radius is inclusive.
#guard approx (scoreBusEvidence (E (some 90) (some 35) [D 40 (some 35) (some 36)])).total 2.2999999999999998

-- The parts decompose the total.
#guard match scoreBusEvidence (E (some 90) (some 12) [D 40 (some 20) none]) with
       | s => approx s.boarding 1.5 && approx s.dwellCredit 0.8 && s.noStopPenalty == 0

/-! ## `annotateBusEvidence` — the orchestration over the scorer

The pass that turns the evidence into a label. `async` in the TS only because
`nearbyTransitStops` is injected; modelled here as an ordinary function of
`(lat, lon, radiusM)`, which is what lets the whole pass be reference-tested.

The one piece of real logic outside the leaves is the per-dwell resolution:
ask for everything within `TRANSIT_QUERY_RADIUS_M`, keep the requested SUBTYPE,
take the nearest of those. That is NOT "the nearest stop, if it is a bus stop" —
a traffic signal three metres away does not hide a bus stop at thirty.

Exact: no arithmetic of its own beyond the duration test and the threshold
comparison; the ULP story is entirely `scoreBusEvidence`'s.

`TRANSIT_QUERY_RADIUS_M` is pinned by value and cannot be pinned by EFFECT: it
is handed straight to the adapter, so only the adapter can act on it, and a
stub that honoured it would be grading the stub. -/

/-- The `nearbyTransitStops` fields this pass reads. -/
structure TransitStop where
  subtype : String
  distanceM : Float
  deriving Inhabited, BEq, Repr

/-- Query radius for per-dwell stop resolution: a bit beyond
`TRANSIT_STOP_NEAR_M`, so "nothing within 50 m" is a confident `none`. -/
def TRANSIT_QUERY_RADIUS_M : Float := 50

/-- Road-vehicle legs shorter than this are not judged — too little room for
any stop pattern to show. -/
def MIN_LEG_S : Int := 3 * 60

/-- The segment fields this pass reads and the one it writes. -/
structure BusSeg where
  startTs : Int
  endTs : Int
  mode : String
  refinedMode : Option String := none
  vehicleKind : Option String := none
  deriving Inhabited, BEq, Repr

/-- The nearest reported distance among stops of one subtype, or `none` when
that subtype is absent. `Math.min` over the filtered list, so a nearer stop of
another subtype is invisible here. -/
def nearestOfSubtype (stops : Array TransitStop) (subtype : String) : Option Float :=
  let m := stops.filter (·.subtype == subtype)
  if m.isEmpty then none
  else some (m.foldl (fun acc s => min acc s.distanceM) (1.0 / 0.0))

/-- Label a refined-driving leg `vehicleKind := "bus"` when the stop-pattern
evidence clears `BUS_EVIDENCE_THRESHOLD_NATS`. Everything else passes through
untouched — this pass only ever adds a label. -/
def annotateBusEvidence (segments : Array BusSeg) (fixes : List Fix)
    (stopsLookup : Float → Float → Float → Array TransitStop) : Array BusSeg :=
  segments.map fun seg =>
    let effective := seg.refinedMode.getD seg.mode
    if effective ≠ "driving" || decide (seg.endTs - seg.startTs < MIN_LEG_S) then seg
    else
      let nearest (lat lon : Float) (subtype : String) : Option Float :=
        nearestOfSubtype (stopsLookup lat lon TRANSIT_QUERY_RADIUS_M) subtype
      let wait := detectBoardingWait fixes seg.startTs
      let dwells := detectVehicleDwells fixes seg.startTs seg.endTs
      let ev : BusEvidence :=
        { boardingWaitS := wait.map (·.1)
          boardingNearestBusStopM :=
            match wait with
            | some (_, la, lo) => nearest la lo "bus_stop"
            | none => none
          dwells := dwells.map fun d =>
            ⟨d.durationS, nearest d.lat d.lon "bus_stop", nearest d.lat d.lon "traffic_signals"⟩ }
      if decide ((scoreBusEvidence ev).total ≥ BUS_EVIDENCE_THRESHOLD_NATS) then
        { seg with vehicleKind := some "bus" }
      else seg

/-! ### Parity with Node/V8 (`lean/experiments/annotate-bus-evidence-refs.mts`) -/

section AnnotateGuards

/-- A standstill, then a ride at ~40 km/h with two dwells in it. The latitude
ACCUMULATES by repeated `+ 0.003`, exactly as the TS fixture does, so the dwell
centroids land on the same bits. -/
private def busFixes : List Fix := Id.run do
  let mut out : Array Fix := #[]
  for i in [0:10] do
    out := out.push ⟨Int.ofNat (30 * i), 51.5, -0.2⟩
  let mut lat : Float := 51.5
  for i in [0:31] do
    let t : Int := 300 + Int.ofNat (30 * i)
    let dwelling := (decide (t ≥ 480) && decide (t ≤ 540)) || (decide (t ≥ 780) && decide (t ≤ 840))
    if !dwelling then lat := lat + 0.003
    out := out.push ⟨t, lat, -0.2⟩
  return out.toList

private def LEG_START : Int := 300
private def LEG_END : Int := 1200

-- The leaves see exactly what the TS harness printed for the same fixture.
#guard detectBoardingWait busFixes LEG_START == some (270, 51.5, -0.19999999999999998)
#guard (detectVehicleDwells busFixes LEG_START LEG_END).map (·.durationS) == [90, 90]

#guard TRANSIT_QUERY_RADIUS_M == 50
#guard MIN_LEG_S == 180

private def stop (subtype : String) (distanceM : Float) : TransitStop := ⟨subtype, distanceM⟩

/-- The stub answers the SAME list everywhere: what this pass decides is which
subtype it asks for and how it reduces the answer, not where the query lands. -/
private def everywhere (stops : Array TransitStop) : Float → Float → Float → Array TransitStop :=
  fun _ _ _ => stops

private def atStop : Array TransitStop := #[stop "bus_stop" 10]
private def signalsOnly : Array TransitStop := #[stop "traffic_signals" 8]
/-- A NEARER signal alongside a further bus stop. -/
private def mixed : Array TransitStop := #[stop "traffic_signals" 3, stop "bus_stop" 30]
/-- Two bus stops: the nearer is inside the bar, the further is not. -/
private def twoStops : Array TransitStop := #[stop "bus_stop" 40, stop "bus_stop" 12]
/-- Present, but beyond `TRANSIT_STOP_NEAR_M` — near is not the same as there. -/
private def farStop : Array TransitStop := #[stop "bus_stop" 40]

private def drive (mode : String := "driving") (refinedMode : Option String := none)
    (startTs : Int := LEG_START) (endTs : Int := LEG_END) : BusSeg :=
  { startTs, endTs, mode, refinedMode }

private def kinds (segs : Array BusSeg) (stops : Array TransitStop) : Array (Option String) :=
  (annotateBusEvidence segs busFixes (everywhere stops)).map (·.vehicleKind)

#guard kinds #[drive] atStop == #[some "bus"]
-- The leg filter reads the EFFECTIVE mode, both directions.
#guard kinds #[drive "stationary" (some "driving")] atStop == #[some "bus"]
#guard kinds #[drive "walking"] atStop == #[none]
#guard kinds #[drive "driving" (some "train")] atStop == #[none]
-- The duration bar is inclusive: one second under refuses, exactly at it judges.
#guard kinds #[drive (startTs := LEG_START) (endTs := LEG_START + 179)] atStop == #[none]
#guard kinds #[drive (startTs := LEG_START) (endTs := LEG_START + 180)] atStop == #[some "bus"]
-- No stops, and stops of the WRONG subtype, are the same answer: not a bus.
#guard kinds #[drive] #[] == #[none]
#guard kinds #[drive] signalsOnly == #[none]
-- The subtype filter runs BEFORE the nearest reduce: the 3 m signal does not
-- hide the 30 m bus stop.
#guard kinds #[drive] mixed == #[some "bus"]
-- …and the reduce is a MIN, so the 12 m stop beats the 40 m one.
#guard kinds #[drive] twoStops == #[some "bus"]
-- A stop beyond the near bar scores as no stop at all.
#guard kinds #[drive] farStop == #[none]
-- The dwell window is the SEGMENT's, not the day's. Under `mixed` one dwell
-- scores 1.9 and two score 2.3, so a leg cut before the second dwell flips.
#guard kinds #[drive (endTs := 700)] mixed == #[none]
#guard kinds #[drive (endTs := 900)] mixed == #[some "bus"]
-- Non-driving segments pass through in place, so the array keeps its shape.
#guard kinds #[drive, drive "walking"] atStop == #[some "bus", none]

/-! #### Exactly at the threshold

`DWELL_AT_STOP_AND_SIGNAL_NATS` REPLACES the stop credit rather than adding to
it (0.4 instead of 0.8 — a signal is an alternative explanation for the dwell),
so the reachable totals are a coarse grid. The ONLY combination that lands on
exactly `BUS_EVIDENCE_THRESHOLD_NATS` is no boarding wait plus three dwells
scoring 0.8 + 0.8 + 0.4, which sums to exactly 2 in that order. Without it the
`≥`-vs-`>` decision at the bar is unpinned, so the fixture is built for it. -/

/-- Three dwells and NO preceding standstill, so `boarding` is 0. -/
private def barFixes : List Fix := Id.run do
  let mut out : Array Fix := #[]
  let mut lat : Float := 51.5
  for i in [0:41] do
    let t : Int := 300 + Int.ofNat (30 * i)
    let dwelling :=
      (decide (t ≥ 480) && decide (t ≤ 540)) || (decide (t ≥ 780) && decide (t ≤ 840))
        || (decide (t ≥ 1080) && decide (t ≤ 1140))
    if !dwelling then lat := lat + 0.003
    out := out.push ⟨t, lat, -0.2⟩
  return out.toList

private def BAR_END : Int := 1500
private def SIGNAL_FROM_LAT : Float := 51.55

/-- A bus stop everywhere, and a traffic signal only at the LAST dwell. -/
private def perDwell : Float → Float → Float → Array TransitStop :=
  fun lat _ _ =>
    if lat < SIGNAL_FROM_LAT then #[stop "bus_stop" 10]
    else #[stop "bus_stop" 10, stop "traffic_signals" 5]

#guard detectBoardingWait barFixes LEG_START == none
#guard (detectVehicleDwells barFixes LEG_START BAR_END).map (·.lat) == [51.518, 51.539, 51.56]
#guard (annotateBusEvidence #[drive (endTs := BAR_END)] barFixes perDwell).map (·.vehicleKind)
  == #[some "bus"]

end AnnotateGuards

end Verified.Geo.Bus

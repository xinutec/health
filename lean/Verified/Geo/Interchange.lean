import Verified.Hsmm.FloatScore
/-!
# Interchange decomposition kernels (port of the pure exports of `src/geo/interchange-split.ts`)

A train leg whose board/alight share no line is two rides; these leaves find the
watch-timed change and the station it happened at. `spliceInterchanges` (async
OSM line lookups + segment splicing) stays shell; ported here:

* `findInterchangeBurst` — the single mid-leg walking-cadence burst (grouped
  across short pauses, edge-guarded, duration-bounded), or `none` when absent /
  ambiguous. Discrete over integer minutes ⇒ exact.
* `pickInterchange` — among stations on both a board-end and an alight-end line,
  the one whose distance-derived arrival best fits the burst (forward half-plane
  only, endpoints excluded, within the timing-slop cap). Reuses the shared
  `haversineMeters` and `cos` ⇒ ≤1 ULP; the argmin pick is well-separated on
  real data. UNPROVEN; pinned by the `#guard`s against Node/V8.
-/

namespace Verified.Geo.Interchange

open Verified.Hsmm.FloatScore (haversineMeters)

private def pi : Float := 3.141592653589793

/-! ## Burst detection -/
def BURST_MIN_CADENCE : Int := 40
def BURST_JOIN_GAP_MIN : Int := 2
def BURST_MIN_MIN : Float := 2
def BURST_MAX_MIN : Float := 8
def BURST_EDGE_GUARD_S : Int := 3 * 60

structure StepPoint where
  ts : Int
  steps : Int
  deriving Inhabited

structure InterchangeBurst where
  startTs : Int
  endTs : Int
  deriving Inhabited, BEq, Repr

/-- The single watch-timed interchange burst inside a train leg, or `none` when
    there is none / it is ambiguous / it hugs a leg edge. -/
def findInterchangeBurst (steps : List StepPoint) (legStartTs legEndTs : Int) :
    Option InterchangeBurst := Id.run do
  let walk := (steps.filter (fun s =>
    decide (s.ts > legStartTs) && decide (s.ts < legEndTs) && decide (s.steps ≥ BURST_MIN_CADENCE))).map (·.ts)
  let sorted := (walk.toArray.qsort (fun a b => decide (a < b))).toList
  match sorted with
  | [] => return none
  | first :: restTs =>
    let mut bursts : Array InterchangeBurst := #[]
    let mut start := first
    let mut prev := first
    for ts in restTs do
      if decide (ts - prev > BURST_JOIN_GAP_MIN * 60 + 60) then
        bursts := bursts.push ⟨start, prev + 60⟩
        start := ts
      prev := ts
    bursts := bursts.push ⟨start, prev + 60⟩
    let mid := bursts.toList.filter (fun b =>
      decide (b.startTs ≥ legStartTs + BURST_EDGE_GUARD_S) && decide (b.endTs ≤ legEndTs - BURST_EDGE_GUARD_S))
    match mid with
    | [b] =>
      let durMin := Float.ofInt (b.endTs - b.startTs) / 60
      if decide (durMin < BURST_MIN_MIN) || decide (durMin > BURST_MAX_MIN) then return none
      return some b
    | _ => return none

/-! ## Candidate scoring -/
def BOARD_WAIT_S : Float := 3 * 60
def AVG_INTERSTATION_M : Float := 1100
def PER_STOP_S : Float := 120
def MAX_TIMING_SLOP_S : Float := 6 * 60
def ENDPOINT_EXCLUSION_M : Float := 400

structure Station where
  name : String
  lat : Float
  lon : Float
  deriving Inhabited

structure InterchangePick where
  station : String
  lat : Float
  lon : Float
  lineA : String
  lineB : String
  timingSlopS : Float
  deriving Inhabited, BEq, Repr

/-- Pick the interchange station for a board→alight pair with no common line:
    on both a board-end and an alight-end line, forward of the board, off the
    endpoints, arrival-time best matching the burst. `none` when none fits
    within `MAX_TIMING_SLOP_S`. -/
def pickInterchange (boardLat boardLon alightLat alightLon : Float) (legStartTs burstStartTs : Int)
    (burstEndTs : Option Int) (trailFix : Option (Int × Float × Float))
    (linesA linesB : List String) (stationsByLine : List (String × List Station)) :
    Option InterchangePick := Id.run do
  let stationsFor := fun (line : String) => ((stationsByLine.find? (fun p => p.1 == line)).map (·.2)).getD []
  let mut best : Option InterchangePick := none
  for lineA in linesA do
    let aStations := stationsFor lineA
    for lineB in linesB do
      if lineB == lineA then pure ()
      else
        for sb in stationsFor lineB do
          match (aStations.filter (fun s => s.name == sb.name)).getLast? with
          | none => pure ()
          | some sa =>
            if decide (haversineMeters sa.lat sa.lon boardLat boardLon < ENDPOINT_EXCLUSION_M)
              || decide (haversineMeters sa.lat sa.lon alightLat alightLon < ENDPOINT_EXCLUSION_M) then pure ()
            else
              let dot := (sa.lat - boardLat) * (alightLat - boardLat)
                + (sa.lon - boardLon) * (alightLon - boardLon) * (Float.cos (boardLat * pi / 180)) ^ 2
              if decide (dot ≤ 0) then pure ()
              else
                let rideM := haversineMeters boardLat boardLon sa.lat sa.lon
                let expectedTs := Float.ofInt legStartTs + BOARD_WAIT_S + (rideM / AVG_INTERSTATION_M) * PER_STOP_S
                let slop0 := Float.abs (expectedTs - Float.ofInt burstStartTs)
                if decide (slop0 > MAX_TIMING_SLOP_S) then pure ()
                else
                  let slop := match trailFix, burstEndTs with
                    | some (tfTs, tfLat, tfLon), some bEnd =>
                      let ride2M := haversineMeters sa.lat sa.lon tfLat tfLon
                      let expected2 := Float.ofInt bEnd + BOARD_WAIT_S + (ride2M / AVG_INTERSTATION_M) * PER_STOP_S
                      slop0 + Float.abs (expected2 - Float.ofInt tfTs)
                    | _, _ => slop0
                  if best.isNone || decide (slop < (best.getD default).timingSlopS) then
                    best := some ⟨sb.name, sa.lat, sa.lon, lineA, lineB, slop⟩
  return best

/-! ## Parity with Node/V8 (`lean/experiments/interchange-refs.mts`) -/

private def cleanSteps : List StepPoint :=
  [⟨60, 5⟩, ⟨300, 112⟩, ⟨360, 113⟩, ⟨420, 110⟩, ⟨600, 4⟩, ⟨1140, 8⟩]
#guard findInterchangeBurst cleanSteps 0 1200 == some ⟨300, 480⟩
private def twoSteps : List StepPoint := [⟨300, 112⟩, ⟨360, 113⟩, ⟨700, 110⟩, ⟨760, 111⟩]
#guard findInterchangeBurst twoSteps 0 1200 == none
private def edgeSteps : List StepPoint := [⟨60, 112⟩, ⟨120, 113⟩, ⟨180, 110⟩]
#guard findInterchangeBurst edgeSteps 0 1200 == none
#guard findInterchangeBurst [⟨300, 5⟩] 0 1200 == none

private def change : Station := ⟨"Change", 51.52, -0.06⟩
private def wrong : Station := ⟨"Wrong", 51.49, -0.12⟩
private def sbl : List (String × List Station) := [("A", [change, wrong]), ("B", [change, wrong])]
private def approxI (a b : Float) : Bool := Float.abs (a - b) < 1e-9

#guard match pickInterchange 51.5 (-0.1) 51.54 (-0.02) 0 600 none none ["A"] ["B"] sbl with
  | some p => p.station == "Change" && p.lineA == "A" && p.lineB == "B"
      && approxI p.lat 51.52 && approxI p.lon (-0.06) && approxI p.timingSlopS 32.63175599173667
  | none => false
#guard match pickInterchange 51.5 (-0.1) 51.54 (-0.02) 0 600 (some 780) (some (1000, 51.535, -0.03)) ["A"] ["B"] sbl with
  | some p => p.station == "Change" && approxI p.timingSlopS 283.0901158349367
  | none => false
#guard pickInterchange 51.5 (-0.1) 51.54 (-0.02) 0 600 none none ["A"] ["B"]
  [("A", [change]), ("B", [wrong])] == none

end Verified.Geo.Interchange

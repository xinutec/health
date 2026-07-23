import Verified.Hsmm.Geometric
/-!
# Route-rail evidence (implementation-first port of `route-rail-evidence.ts`)

Emission term for `train @ L` on a GPS-null minute: if the bookend fixes are both
near underground L track, L connects them, and the gap fits a plausible ride
(duration + distance windows), boost. The route-graph queries (`edgesNear`, the
per-line BFS connectivity) stay caller-side and arrive as resolved booleans
(`prevHasLine`, `nextHasLine`, `prevUnderground`, `nextUnderground`, `connected`);
this module is the pure decision + the gap gates. The only transcendental is the
gap-distance haversine gate (tested with clearly-separated fixes, so its ≤1-ULP
wobble never flips a verdict); every output is an exact constant. Bit-exact with
TS, pinned by the `#guard`s.
-/

namespace Verified.Hsmm.RouteRail

open Verified.Hsmm.FloatScore (haversineMeters)
open Verified.Hsmm.Emissions (Mode State)
open Verified.Hsmm.Geometric (GpsFix)

def MIN_GAP_DURATION_S : Float := 300      -- 5·60
def MAX_GAP_DURATION_S : Float := 5400     -- 90·60
def MIN_GAP_DISTANCE_M : Float := 1000
def UNDERGROUND_BOOST : Float := 3.5

/-- `buildRouteRailEvidence`'s per-state verdict, over caller-resolved facts. -/
def routeRailEvidence (s : State) (isCovered gpsPresent : Bool) (prev next : Option GpsFix)
    (prevHasLine nextHasLine prevUnderground nextUnderground connected : Bool) : Float :=
  if s.mode != .train then 0.0
  else if isCovered then 0.0
  else match s.lineName with
    | none => 0.0
    | some line =>
      if line == "unknown_rail" then 0.0
      else if gpsPresent then 0.0
      else match prev, next with
        | some p, some n =>
          if n.ts - p.ts < MIN_GAP_DURATION_S then 0.0
          else if n.ts - p.ts > MAX_GAP_DURATION_S then 0.0
          else if haversineMeters p.lat p.lon n.lat n.lon < MIN_GAP_DISTANCE_M then 0.0
          else if !prevHasLine || !nextHasLine then 0.0
          else if !prevUnderground || !nextUnderground then 0.0
          else if !connected then 0.0
          else UNDERGROUND_BOOST
        | _, _ => 0.0

-- Decision-branch parity (constants match the TS routing; UNDERGROUND_BOOST=3.5).
private def fx (ts lat lon : Float) : GpsFix := ⟨ts, lat, lon⟩
private def tr (line : Option String) : State := ⟨.train, none, line⟩
-- ~6.8 km apart, 600 s gap: passes every gate.
private def okPrev : Option GpsFix := some (fx 1000 51.53 (-0.11))
private def okNext : Option GpsFix := some (fx 1600 51.58 (-0.05))

#guard routeRailEvidence (tr (some "Jubilee")) false false okPrev okNext true true true true true == 3.5
#guard routeRailEvidence (tr (some "Jubilee")) true false okPrev okNext true true true true true == 0   -- covered
#guard routeRailEvidence ⟨.walking, none, none⟩ false false okPrev okNext true true true true true == 0 -- not train
#guard routeRailEvidence (tr (some "unknown_rail")) false false okPrev okNext true true true true true == 0
#guard routeRailEvidence (tr (some "Jubilee")) false true okPrev okNext true true true true true == 0   -- gps present
#guard routeRailEvidence (tr (some "Jubilee")) false false (some (fx 1000 51.53 (-0.11))) (some (fx 1200 51.58 (-0.05))) true true true true true == 0 -- gap 200s < 300
#guard routeRailEvidence (tr (some "Jubilee")) false false (some (fx 1000 51.53 (-0.11))) (some (fx 8000 51.58 (-0.05))) true true true true true == 0 -- gap 7000s > 5400
#guard routeRailEvidence (tr (some "Jubilee")) false false (some (fx 1000 51.53 (-0.11))) (some (fx 1600 51.532 (-0.108))) true true true true true == 0 -- ~260 m < 1000
#guard routeRailEvidence (tr (some "Jubilee")) false false okPrev okNext false true true true true == 0 -- line not at prev
#guard routeRailEvidence (tr (some "Jubilee")) false false okPrev okNext true true true false true == 0 -- next not underground
#guard routeRailEvidence (tr (some "Jubilee")) false false okPrev okNext true true true true false == 0 -- not connected

end Verified.Hsmm.RouteRail

import Verified.Hsmm.Emissions
import Verified.Hsmm.Observation
import Verified.Hsmm.Geometric
import Verified.Hsmm.RouteModel
import Verified.Hsmm.Continuity
/-!
# Full HSMM emission composition (implementation-first port of `buildHsmmModel`'s emission)

`emission = baseEmission + geometricFn + routeRailFn + lineProximityFn`, summed
in `buildHsmmModel` order, over the unified route-graph model and the real
observation tensor (`ObsRow`). This is the keystone that proves the ported factors
compose end-to-end: base emission (+ the reacquire-robust speed correction),
geometric feasibility, and the two route-graph factors all consume one `ObsRow`
and the shared model.

Mirrors `buildHsmmModel`'s parameterisation (the caller passes `reacquireRobust`
and per-minute `isCovered`), so it is faithful for whatever flag combination the
served decode runs. Continuity (`continuityContext`) is a further optional additive
term, ported only if the served path enables it. UNPROVEN; pinned by the `#guard`s
(values from Node/V8's factor builders, summed as `buildHsmmModel` does). Route-
graph/geometric factors flow through `haversine`/`pointToPolyline`, so sums are
ULP-close (`approx`), the accepted near-tie class.
-/

namespace Verified.Hsmm.EmissionFull

open Verified.Hsmm.Emissions (Mode State modePriors emissionLogProb reacquireWidenedSpeedStd Observation)
open Verified.Hsmm.Observation (ObsRow Fix)
open Verified.Hsmm.RouteModel (RouteGraphModel routeRailEvidence lineProximityFactor buildRouteGraphModel
  toConnGraph linesInGraph RouteEdge)
open Verified.Hsmm.FloatScore (logNormalPdf)

/-- Adapt an `ObsRow` fix to `Geometric.GpsFix` (ts Int→Float; unix seconds fit
    a Float exactly, and both obs/fix ts convert the same way so deltas hold). -/
private def toGeoFix (f : Fix) : Geometric.GpsFix := ⟨f.ts.toNat.toFloat, f.lat, f.lon⟩

/-- `ObsRow` → the thin `Observation` the base emission consumes. -/
private def toThin (o : ObsRow) : Observation :=
  ⟨o.gps.map (fun g => ⟨g.lat, g.lon, g.speedKmh⟩), o.hr, o.cadence, o.inBed⟩

/-- Base emission + the reacquire-robust correction. The correction replaces the
    stationary speed term's σ with the reacquire-widened σ — expressed additively
    as `(widened − base)` so the committed `emissionLogProb` is reused untouched.
    Fires only under the flag, for a stationary GPS-present minute with a resolved
    reacquire age. -/
def baseEmissionWithReacquire (s : State) (o : ObsRow) (placeCoord : Option (Float × Float))
    (reacquireRobust : Bool) : Float :=
  let base := emissionLogProb s (toThin o) placeCoord
  let corr :=
    if reacquireRobust && s.mode == .stationary then
      match o.gps, o.reacquireAgeMin with
      | some g, some age =>
        let prior := modePriors s.mode
        let widened := reacquireWidenedSpeedStd prior.speedStd (some age.toNat.toFloat) o.railDistM
        logNormalPdf g.speedKmh prior.speedMean widened
          - logNormalPdf g.speedKmh prior.speedMean prior.speedStd
      | _, _ => 0.0
    else 0.0
  base + corr

/-- Full per-cell emission log-probability over the model. `placeCoords` resolves
    `s.placeId`; `isCovered` (train-generator) and `reacquireRobust` are caller
    flags, matching `buildHsmmModel`. `continuity` is the presence-continuity seed
    (`none` when `USE_CONTINUITY_CONTINUATION` is off). -/
def emissionLogProbFull
    (model : RouteGraphModel) (connGraph : RouteConnectivity.Graph) (modeledLines : List String)
    (placeCoords : Std.HashMap Int (Float × Float))
    (reacquireRobust isCovered : Bool) (continuity : Option Continuity.ContinuityContext)
    (s : State) (o : ObsRow) : Float :=
  let placeCoord := match s.placeId with | some pid => placeCoords.get? pid | none => none
  baseEmissionWithReacquire s o placeCoord reacquireRobust
    + Geometric.geometricFeasibility s o.ts.toNat.toFloat
        (o.prevGpsFix.map toGeoFix) (o.nextGpsFix.map toGeoFix) placeCoord
    + routeRailEvidence model connGraph s o isCovered
    + lineProximityFactor model modeledLines s o isCovered
    + Continuity.continuityLogLikelihood s o.gps.isSome
        (o.prevGpsFix.map (fun f => (f.lat, f.lon))) continuity

-- Parity with `buildHsmmModel`'s emission (base+geo+routeRail+lineProx; Node/V8).
private def m : RouteGraphModel := buildRouteGraphModel #[
  (⟨"way:1", [⟨51.50, -0.10⟩, ⟨51.525, -0.075⟩], ["Test Line"], true, "nA", "nMid"⟩ : RouteEdge),
  (⟨"way:2", [⟨51.525, -0.075⟩, ⟨51.55, -0.05⟩], ["Test Line"], true, "nMid", "nB"⟩ : RouteEdge)]
private def cg : RouteConnectivity.Graph := toConnGraph m
private def ml : List String := linesInGraph m
private def pc : Std.HashMap Int (Float × Float) := ({} : Std.HashMap Int (Float × Float)).insert 5 (51.52, -0.13)
private def approxF (a b : Float) : Bool := Float.abs (a - b) < 1e-6

private def obsTrain : ObsRow :=
  { ts := 1600, gps := none, hr := none, cadence := none, hourLocal := 0, dayOfWeekLocal := 0,
    inBed := false, roadDistM := none, railDistM := none, reacquireAgeMin := none,
    prevGpsFix := some ⟨1000, 51.50, -0.10⟩, nextGpsFix := some ⟨1600, 51.55, -0.05⟩ }
private def obsStat : ObsRow :=
  { ts := 1000, gps := some ⟨51.5201, -0.1301, 0⟩, hr := some 70, cadence := some 0, hourLocal := 0,
    dayOfWeekLocal := 0, inBed := false, roadDistM := none, railDistM := none, reacquireAgeMin := none,
    prevGpsFix := some ⟨940, 51.60, -0.30⟩, nextGpsFix := some ⟨1000, 51.5201, -0.1301⟩ }
private def obsWalk : ObsRow :=
  { ts := 1000, gps := some ⟨51.53, -0.12, 5⟩, hr := some 100, cadence := some 100, hourLocal := 0,
    dayOfWeekLocal := 0, inBed := false, roadDistM := none, railDistM := none, reacquireAgeMin := none,
    prevGpsFix := none, nextGpsFix := none }
private def obsReacq : ObsRow :=
  { ts := 1000, gps := some ⟨51.5201, -0.1301, 8⟩, hr := some 70, cadence := some 0, hourLocal := 0,
    dayOfWeekLocal := 0, inBed := false, roadDistM := none, railDistM := none, reacquireAgeMin := some 1,
    prevGpsFix := some ⟨1000, 51.5201, -0.1301⟩, nextGpsFix := some ⟨1000, 51.5201, -0.1301⟩ }
-- Stationary no-fix minute whose most-recent fix is near the prior place → continuity fires.
private def contCtx : Continuity.ContinuityContext := ⟨some 5, some (51.52, -0.13), 3, 0.95⟩
private def obsCont : ObsRow :=
  { ts := 1000, gps := none, hr := none, cadence := none, hourLocal := 0, dayOfWeekLocal := 0,
    inBed := false, roadDistM := none, railDistM := none, reacquireAgeMin := none,
    prevGpsFix := some ⟨900, 51.521, -0.131⟩, nextGpsFix := some ⟨900, 51.521, -0.131⟩ }

#guard approxF (emissionLogProbFull m cg ml pc false false none ⟨.train, none, some "Test Line"⟩ obsTrain) (-1.3928522584398717)
#guard approxF (emissionLogProbFull m cg ml pc false false none ⟨.stationary, some 5, none⟩ obsStat) (-814.4852866803162)
#guard approxF (emissionLogProbFull m cg ml pc false false none ⟨.walking, none, none⟩ obsWalk) (-12.180968195475526)
#guard approxF (emissionLogProbFull m cg ml pc true false none ⟨.stationary, some 5, none⟩ obsReacq) (-7.8254058300548115)
#guard approxF (emissionLogProbFull m cg ml pc false false (some contCtx) ⟨.stationary, some 5, none⟩ obsCont) (-2.173287216286719)

end Verified.Hsmm.EmissionFull

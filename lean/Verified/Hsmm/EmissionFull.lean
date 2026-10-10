import Verified.Hsmm.Emissions
import Verified.Hsmm.Observation
import Verified.Hsmm.Geometric
import Verified.Hsmm.RouteModel
import Verified.Hsmm.Continuity
import Verified.FloatConst
/-!
# Full HSMM emission composition (implementation-first port of `buildHsmmModel`'s emission)

`emission = baseEmission + geometricFn + routeRailFn + lineProximityFn`, summed
in `buildHsmmModel` order, over the unified route-graph model and the real
observation tensor (`ObsRow`). This is the keystone that proves the ported factors
compose end-to-end: base emission (+ the reacquire-robust speed correction),
geometric feasibility, and the two route-graph factors all consume one `ObsRow`
and the shared model.

Mirrors `buildHsmmModel`'s parameterisation (the caller passes `reacquireRobust`),
so it is faithful for whatever flag combination the served decode runs. The
TypeScript also passed the generator's per-minute `isCovered` here and switched
the two line factors OFF on a covered minute, leaving the entry prior as the
only line signal. Since 2026-09-29 (#238) the factors stay live there: measured
on the eleven decoder days, a covered fix-less ride earned nothing per minute
and lost to `stationary` on the mode prior (06-12's Victoria ride shrank to one
minute), and every line the generator vouched at entry scored identically
afterwards, so a line it stopped vouching mid-ride was never charged (05-18,
07-14: the Metropolitan leg came out Hammersmith & City on a tie). Coverage
still reaches the entry and duration terms. Continuity (`continuityContext`) is a further optional additive
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

/-- No correction — hoisted so the branch below does not rebuild a literal per call. -/
private def NO_CORRECTION : Float := 0

/-- Base emission + the reacquire-robust correction. The correction replaces the
    stationary speed term's σ with the reacquire-widened σ — expressed additively
    as `(widened − base)` so the committed `emissionLogProb` is reused untouched.
    Fires only under the flag, for a stationary GPS-present minute with a resolved
    reacquire age. -/
def baseEmissionWithReacquire (s : State) (o : ObsRow) (placeCoord : Option (Float × Float))
    (reacquireRobust : Bool) (priors : Mode → Emissions.ModePrior := modePriors) : Float :=
  let base := emissionLogProb s (toThin o) placeCoord priors
  -- A walk is widened too, and not scaled away on the track: the fix that
  -- ends a dark minute carries the gap's speed whatever it lands on, and on
  -- the track it is steps, not speed, that tell a walk from a ride.
  let corr :=
    if reacquireRobust && (s.mode == .stationary || s.mode == .walking) then
      match o.gps, o.reacquireAgeMin with
      | some g, some age =>
        let prior := priors s.mode
        let rail := if s.mode == .walking then none else o.railDistM
        let gap := o.reacquireGapMin.map fun g => Verified.FloatConst.natToFloat g.toNat
        -- After a short gap the artefact is momentum: a speed above the
        -- prior. A speed below it is a measurement, and keeps the base.
        let momentumOnly := match gap with
          | some gm => gm < Emissions.REACQ_RESET_GAP_MIN
          | none => false
        if momentumOnly && g.speedKmh ≤ prior.speedMean then NO_CORRECTION else
        let widened := reacquireWidenedSpeedStd prior.speedStd
          (some (Verified.FloatConst.natToFloat age.toNat)) rail gap
        -- The wider density is a second component, not a replacement: a
        -- minute the base fits keeps the base (a wider σ is lower near the
        -- mean), and only a minute the base rejects takes the wider one.
        max NO_CORRECTION (logNormalPdf g.speedKmh prior.speedMean widened
          - logNormalPdf g.speedKmh prior.speedMean prior.speedStd)
      | _, _ => 0.0
    else 0.0
  base + corr

/-- One weight per family of decoder terms (`flags.termWeights` sets them for
    the harness, `examples/tune_weights` learns them). A product by `1.0` is
    exact, so a family at `1` sums exactly as before it had a weight. -/
structure TermWeights where
  base : Float := 1.0
  geometric : Float := 1.0
  gap : Float := 1.0
  rail : Float := 1.0
  /-- Learned: a coordinate search on half the 43 narrated days moved it to
      0.75 and nothing else, and on the other half it scored leg modes +2,
      lines +1, stations +1, phantoms unchanged; on all 43, leg modes 278 → 280,
      lines 52 → 53, stations 43 → 45, journeys and phantoms unchanged. The
      search on the first half also went down (0.375, with the duration prior
      at 0.75) and gained nothing on the second. -/
  lineProximity : Float := 0.75
  continuity : Float := 1.0
  entry : Float := 1.0
  chain : Float := 1.0
  duration : Float := 1.0
  segmentEvidence : Float := 1.0
  deriving Inhabited

/-- Full per-cell emission log-probability over the model — the TS
    `buildEmissionFn` closure plus the geometric/rail/line-proximity terms the
    model sums onto it. `placeCoords` resolves `s.placeId`; `reacquireRobust`
    (train-generator) and `reacquireRobust` are caller flags, matching the TS
    `buildHsmmModel`. `continuity` is the presence-continuity seed; the
    production caller always supplies it, and the `none` arm is the chain-start
    and test shape rather than a flag being off (see `Continuity`). -/
def emissionLogProbFullWith
    (modeledLines : List String) (minute : RouteModel.MinuteLines) (railEv : Float)
    (placeCoords : Std.HashMap Int (Float × Float))
    (reacquireRobust : Bool) (continuity : Option Continuity.ContinuityContext)
    (s : State) (o : ObsRow) (priors : Mode → Emissions.ModePrior := modePriors)
    (w : TermWeights := {}) : Float :=
  let placeCoord := match s.placeId with | some pid => placeCoords.get? pid | none => none
  w.base * baseEmissionWithReacquire s o placeCoord reacquireRobust priors
    + w.geometric * Geometric.geometricFeasibility s o.ts.toNat.toFloat
        (o.prevGpsFix.map toGeoFix) (o.nextGpsFix.map toGeoFix) placeCoord priors
    + w.gap * Geometric.gapTerm s o.gps.isSome
        (o.prevGpsFix.map toGeoFix) (o.nextGpsFix.map toGeoFix) priors
    -- The kernels' `isCovered` is the TypeScript gate, held open (see above).
    + w.rail * railEv
    + w.lineProximity * RouteModel.lineProximityFactorWith modeledLines minute s o false
    + w.continuity * Continuity.continuityLogLikelihood s o.gps.isSome
        (o.prevGpsFix.map (fun f => (f.lat, f.lon))) continuity

/-- The per-cell emission with its per-minute facts computed in place — what
    every caller read before #1774 hoisted them, and what the parity guards pin.
    The model build computes `minuteLines` once per minute and the rail
    evidence once per bracketing pair, then calls `emissionLogProbFullWith`. -/
def emissionLogProbFull
    (model : RouteGraphModel) (connGraph : RouteConnectivity.Graph) (modeledLines : List String)
    (placeCoords : Std.HashMap Int (Float × Float))
    (reacquireRobust : Bool) (continuity : Option Continuity.ContinuityContext)
    (s : State) (o : ObsRow) : Float :=
  emissionLogProbFullWith modeledLines (RouteModel.minuteLines model o)
    (routeRailEvidence model connGraph s o false) placeCoords reacquireRobust continuity s o

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

-- The train pays its share of a 40 km/h gap, which its speed prior almost always covers.
#guard approxF (emissionLogProbFull m cg ml pc false none ⟨.train, none, some "Test Line"⟩ obsTrain)
  (-1.3928522584398717 + Geometric.gapTerm ⟨.train, none, some "Test Line"⟩ false
    (obsTrain.prevGpsFix.map toGeoFix) (obsTrain.nextGpsFix.map toGeoFix))
#guard Geometric.gapTerm ⟨.train, none, some "Test Line"⟩ false
    (obsTrain.prevGpsFix.map toGeoFix) (obsTrain.nextGpsFix.map toGeoFix) > -0.05
-- 14 km in the minute before: no ground mode covers it, and no outlier
-- explains 14 km.
#guard approxF (emissionLogProbFull m cg ml pc false none ⟨.stationary, some 5, none⟩ obsStat) (-211.333404464173)
#guard approxF (emissionLogProbFull m cg ml pc false none ⟨.walking, none, none⟩ obsWalk) (-12.180968195475526)
#guard approxF (emissionLogProbFull m cg ml pc true none ⟨.stationary, some 5, none⟩ obsReacq) (-7.8254058300548115)
#guard approxF (emissionLogProbFull m cg ml pc false (some contCtx) ⟨.stationary, some 5, none⟩ obsCont) (-2.185651821103)

end Verified.Hsmm.EmissionFull
